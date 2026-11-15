import { useEffect, useState } from 'react';
import { ArrowRight, ExternalLink, Globe2, RefreshCw, Search } from 'lucide-react';
import type { Account, DnsObservation, ResourceSnapshot, Zone } from '../shared';
import {
  belongsToDomain,
  dnsState,
  domainInventory,
  domainName,
  freshDns,
  providerNames,
  resourceRows,
} from '../inventory';

export type Category = 'registrations' | 'services' | 'certificates' | 'email' | 'records';
export type Api = (url: string, method?: string, data?: unknown) => Promise<any>;
const time = (value?: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
const titles = {
  registrations: '注册域名',
  services: '托管服务',
  certificates: '证书',
  email: '邮箱转发',
  records: 'DNS 记录',
};
export function inventoryJobs(accounts: Account[], zones: Zone[], category: Category) {
  return accounts.flatMap<{ account: Account; zone: Zone | undefined; kind: string }>((account) => {
    if (category === 'email' && account.provider !== 'cloudflare') return [];
    if (
      category === 'records' ||
      category === 'email' ||
      (category === 'certificates' && account.provider === 'cloudflare')
    )
      return zones
        .filter((z) => z.accountId === account.id)
        .map((zone) => ({ account, zone, kind: category + ':' + zone.id }));
    return [{ account, zone: undefined, kind: category }];
  });
}
export async function syncResources(
  accounts: Account[],
  zones: Zone[],
  category: Category,
  api: Api,
  progress: (text: string) => void = () => {},
) {
  const issues: string[] = [];
  let count = 0;
  for (const job of inventoryJobs(accounts, zones, category)) {
    progress(`正在读取${titles[category]}：${job.zone?.name ?? job.account.name}`);
    let cursor: number | null = 1,
      syncId: string | undefined;
    try {
      while (cursor) {
        const result = await api('/accounts/' + job.account.id + '/inventory/' + category, 'POST', {
          cursor,
          syncId,
          zoneId: job.zone?.id,
        });
        cursor = result.nextCursor;
        syncId = result.syncId;
        if (!cursor) count += result.count;
      }
    } catch (e) {
      issues.push(
        (job.zone?.name ?? job.account.name) + '：' + (e instanceof Error ? e.message : '读取失败'),
      );
    }
  }
  return { count, issues };
}

type Common = {
  accounts: Account[];
  zones: Zone[];
  snapshots: ResourceSnapshot[];
  observations: DnsObservation[];
  busy: boolean;
  onOpenZone: (zoneId: string) => void;
};
export function DomainExplorer({
  accounts,
  zones,
  snapshots,
  observations,
  busy,
  onOpenZone,
  onSync,
  onResources,
}: Common & {
  onSync: () => void;
  onResources: (category: 'services' | 'certificates' | 'email' | 'records', name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const domains = domainInventory(zones, snapshots);
  const certificates = resourceRows(snapshots, 'certificates'),
    services = resourceRows(snapshots, 'services'),
    email = resourceRows(snapshots, 'email');
  return (
    <>
      <div className="inventory-toolbar">
        <div className="search">
          <Search size={17} />
          <input
            aria-label="搜索全部域名"
            placeholder="搜索域名、注册商或平台"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="muted">
          {domains.length} 个域名 · {zones.length} 份 DNS 配置
        </span>
        <button className="secondary" onClick={() => onResources('records', '')}>
          全部 DNS 记录
          <ArrowRight size={16} />
        </button>
        <button className="primary" disabled={busy || !accounts.length} onClick={onSync}>
          <RefreshCw size={16} />
          同步全部域名
        </button>
      </div>
      <p className="inventory-note">
        同名域名合并展示；注册、DNS 和托管服务分别识别。DNS 来源依据最近 24 小时内的公共 NS
        查询，配置副本保留供查看。
      </p>
      <div className="domain-cards">
        {domains
          .filter((d) =>
            [
              d.name,
              ...d.registrations.map((r) => r.registrar),
              ...d.zones.map(
                (z) => providerNames[accounts.find((a) => a.id === z.accountId)!.provider],
              ),
            ]
              .join(' ')
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((d) => {
            const observation = observations.find((o) => domainName(o.name) === d.name);
            const current = d.zones.filter(
              (z) => dnsState(z, accounts, observations) === 'current',
            );
            const registeredNs = [...new Set(d.registrations.flatMap((r) => r.nameservers))];
            const known = domains.map((d) => d.name);
            const cs = certificates.filter((c) =>
              String(c.domain)
                .split(/[,\s]+/)
                .some((h) => belongsToDomain(h, d.name, known)),
            );
            const ss = services.filter((s) =>
              (s.domains ?? []).some((h: string) => belongsToDomain(h, d.name, known)),
            );
            const es = email.filter((e) => d.zones.some((z) => z.id === e.zoneId));
            return (
              <section className="panel domain-card" key={d.name}>
                <header className="domain-card-heading">
                  <span className="service-icon">
                    <Globe2 size={23} />
                  </span>
                  <div>
                    <h2>{d.name}</h2>
                    <p>{d.zones.length} 个 DNS 配置来源</p>
                  </div>
                  {current.length === 1 && (
                    <button className="secondary" onClick={() => onOpenZone(current[0].id)}>
                      管理 DNS
                      <ArrowRight size={15} />
                    </button>
                  )}
                </header>
                <div className="domain-facts">
                  <div>
                    <span>注册 / 续费</span>
                    <div>
                      {d.registrations.length ? (
                        d.registrations.map((r) => (
                          <div key={r.accountId + ':' + r.id}>
                            <strong>{r.registrar}</strong>
                            <small>
                              {accounts.find((a) => a.id === r.accountId)?.name} · 到期{' '}
                              {time(r.expiresAt)}
                            </small>
                            {r.autoRenew !== null && (
                              <small>自动续费{r.autoRenew ? '已开启' : '未开启'}</small>
                            )}
                          </div>
                        ))
                      ) : (
                        <strong className="muted">未确认 · 需同步注册域名</strong>
                      )}
                    </div>
                  </div>
                  <div>
                    <span>当前 DNS</span>
                    <div>
                      <strong>
                        {freshDns(observation)
                          ? observation?.provider
                            ? providerNames[observation.provider]
                            : '其他 / 自定义 NS'
                          : '尚未确认'}
                      </strong>
                      <small>
                        {observation?.nameservers.length
                          ? observation.nameservers.join('、')
                          : (observation?.error ?? '尚未查询公共 NS')}
                      </small>
                      {observation && (
                        <small>
                          公共 NS 查询 · {time(observation.checkedAt)}
                          {!freshDns(observation) ? ' · 需重新检查' : ''}
                        </small>
                      )}
                      {!observation && registeredNs.length > 0 && (
                        <small>
                          注册接口配置的 NS：{registeredNs.join('、')}（待公共查询核实）
                        </small>
                      )}
                    </div>
                  </div>
                </div>
                <div className="domain-configs">
                  <span>DNS 配置来源</span>
                  {d.zones.map((z) => {
                    const a = accounts.find((a) => a.id === z.accountId)!,
                      state = dnsState(z, accounts, observations);
                    return (
                      <button
                        className={'domain-source ' + state}
                        key={z.id}
                        onClick={() => onOpenZone(z.id)}
                      >
                        <strong>{providerNames[a.provider]}</strong>
                        <span>
                          {state === 'current'
                            ? '当前 NS 对应平台'
                            : state === 'other'
                              ? '配置副本 · 非当前 DNS'
                              : '未核实'}
                        </span>
                        <small>{a.name}</small>
                        <ArrowRight size={14} />
                      </button>
                    );
                  })}
                  {!d.zones.length && <p className="muted">尚未在已连接账号中发现 DNS 配置</p>}
                </div>
                <footer className="domain-links">
                  <button onClick={() => onResources('services', d.name)}>
                    关联托管服务 {ss.length}
                  </button>
                  <button onClick={() => onResources('certificates', d.name)}>
                    证书 {cs.length}
                  </button>
                  <button onClick={() => onResources('email', d.name)}>转发规则 {es.length}</button>
                </footer>
              </section>
            );
          })}
      </div>
      {!domains.length && (
        <div className="panel inventory-empty">
          连接云账号后，点击“同步全部域名”。注册域名和 DNS 托管区域会自动归并。
        </div>
      )}
      <SourceIssues snapshots={snapshots} category="registrations" accounts={accounts} />
    </>
  );
}

function SourceIssues({
  snapshots,
  category,
  accounts,
}: {
  snapshots: ResourceSnapshot[];
  category: Category;
  accounts: Account[];
}) {
  const issues = snapshots.filter(
    (s) => s.kind === 'issue:' + category || s.kind.startsWith('issue:' + category + ':'),
  );
  if (!issues.length) return null;
  return (
    <details className="source-issues">
      <summary>{issues.length} 个来源最近同步失败，保留上次完整结果</summary>
      {issues.map((s) => (
        <p key={s.account_id + s.kind}>
          {accounts.find((a) => a.id === s.account_id)?.name}：{s.data[0]?.message} ·{' '}
          {time(s.updated_at)}
        </p>
      ))}
    </details>
  );
}

export function ResourceExplorer({
  managedProjects = [],
  onOpenProject,
  accounts,
  zones,
  snapshots,
  observations,
  busy,
  onOpenZone,
  category,
  onSync,
  domainFilter,
  setDomainFilter,
}: Common & {
  managedProjects?: { id: string; account_id: string; remote_name: string }[];
  onOpenProject?: (id: string) => void;
  category: Exclude<Category, 'registrations'>;
  onSync: () => void;
  domainFilter: string;
  setDomainFilter: (name: string) => void;
}) {
  const [account, setAccount] = useState(''),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1);
  const domains = domainInventory(zones, snapshots),
    known = domains.map((d) => d.name);
  useEffect(() => {
    setPage(1);
  }, [account, query, domainFilter, category]);
  const all = resourceRows(snapshots, category);
  const rows = all.filter((r) => {
    if (account && r.accountId !== account) return false;
    if (
      query &&
      !JSON.stringify([
        r.name,
        r.domain,
        r.content,
        r.kind,
        r.actions,
        r.matchers,
        accounts.find((a) => a.id === r.accountId)?.name,
      ])
        .toLowerCase()
        .includes(query.toLowerCase())
    )
      return false;
    if (!domainFilter) return true;
    if (r.zoneId)
      return belongsToDomain(zones.find((z) => z.id === r.zoneId)?.name ?? '', domainFilter, known);
    return (
      category === 'certificates' ? String(r.domain).split(/[,\s]+/) : (r.domains ?? [])
    ).some((h: string) => belongsToDomain(h, domainFilter, known));
  });
  const jobs = inventoryJobs(accounts, zones, category),
    synced = jobs.filter((j) =>
      snapshots.some((s) => s.account_id === j.account.id && s.kind === j.kind),
    ).length;
  const totalPages = Math.max(1, Math.ceil(rows.length / 25)),
    current = Math.min(page, totalPages),
    visible = rows.slice((current - 1) * 25, current * 25);
  return (
    <>
      <div className="inventory-toolbar">
        <label>
          账号范围
          <select
            aria-label="资源账号范围"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="">全部云账号</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          域名范围
          <select
            aria-label="资源域名范围"
            value={domainFilter}
            onChange={(e) => setDomainFilter(e.target.value)}
          >
            <option value="">全部域名</option>
            {domains.map((d) => (
              <option key={d.name}>{d.name}</option>
            ))}
          </select>
        </label>
        <div className="search">
          <Search size={17} />
          <input
            aria-label="搜索全部资源"
            placeholder="搜索全部已同步资源"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="primary" disabled={busy || !jobs.length} onClick={onSync}>
          <RefreshCw size={16} />
          刷新全部{titles[category]}
        </button>
      </div>
      <p className="inventory-note">
        {rows.length} / {all.length} 项资源 · 已取得 {synced} / {jobs.length}{' '}
        个来源的完整快照。默认汇总全部账号；刷新会读取所有页，失败的来源单独提示。
        {category === 'services' &&
          ' 域名关联仅使用平台返回的绑定信息，未返回绑定的项目仍在“全部域名”中展示。'}
        {category === 'records' && ' 不同平台的同名记录保留各自来源，不会混成一条。'}
      </p>
      <SourceIssues snapshots={snapshots} category={category} accounts={accounts} />
      <section className="panel">
        <div className="table-scroll">
          <table className="resource-table">
            <thead>
              <tr>
                <th>
                  {category === 'services'
                    ? '服务 / 项目'
                    : category === 'certificates'
                      ? '证书域名'
                      : category === 'email'
                        ? '转发规则'
                        : '名称 / 类型'}
                </th>
                <th>来源</th>
                <th>
                  {category === 'services'
                    ? '类型 / 绑定域名'
                    : category === 'certificates'
                      ? '状态 / 到期时间'
                      : category === 'email'
                        ? '匹配 / 转发目标'
                        : '记录内容'}
                </th>
                <th>{category === 'records' ? 'DNS 生效情况' : '状态 / 最近同步'}</th>
                <th>查看</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const a = accounts.find((a) => a.id === r.accountId),
                  z = zones.find((z) => z.id === r.zoneId),
                  state = z ? dnsState(z, accounts, observations) : null;
                const managed =
                  category === 'services' && a?.provider === 'cloudflare' && r.kind === 'Pages'
                    ? managedProjects.find(
                        (p) => p.account_id === r.accountId && p.remote_name === r.id,
                      )
                    : undefined;
                return (
                  <tr key={r.key}>
                    <td className="record-name">
                      {r.name || r.domain || (category === 'email' ? '邮箱转发规则' : r.id)}
                      {category === 'records' && (
                        <small>
                          {r.type} · TTL {r.ttl === 1 ? '自动' : r.ttl + 's'}
                        </small>
                      )}
                      {category === 'email' && <small>{z?.name}</small>}
                    </td>
                    <td>
                      <strong>{a ? providerNames[a.provider] : '已移除账号'}</strong>
                      <small>{a?.name}</small>
                    </td>
                    <td>
                      {category === 'services' ? (
                        <>
                          <strong>{r.kind}</strong>
                          <small>{r.detail ?? ''}</small>
                          <small>{r.domains?.join('、') || '平台未返回绑定域名'}</small>
                        </>
                      ) : category === 'certificates' ? (
                        <>
                          {r.status}
                          <small>到期 {time(r.expiresAt)}</small>
                          <small>{r.managed ? '原平台管理证书' : '续期方式需原平台核对'}</small>
                        </>
                      ) : category === 'email' ? (
                        <>
                          <pre>{JSON.stringify(r.matchers, null, 2)}</pre>
                          <pre>→ {JSON.stringify(r.actions, null, 2)}</pre>
                        </>
                      ) : (
                        <>
                          <div className="resource-record-value">{r.content}</div>
                          {r.priority !== undefined && <small>优先级 {r.priority}</small>}
                        </>
                      )}
                    </td>
                    <td>
                      {category === 'records' ? (
                        <span className={state === 'current' ? 'pill green' : 'pill'}>
                          {state === 'current'
                            ? '当前 NS 对应平台'
                            : state === 'other'
                              ? '配置副本 · 非当前 DNS'
                              : 'NS 未核实'}
                        </span>
                      ) : (
                        <>
                          <span>
                            {category === 'email' ? (r.enabled ? '启用' : '停用') : r.status}
                          </span>
                          <small>{time(r.checkedAt)}</small>
                        </>
                      )}
                    </td>
                    <td>
                      {managed && onOpenProject && (
                        <button
                          className="secondary compact"
                          onClick={() => onOpenProject(managed.id)}
                        >
                          管理项目
                          <ArrowRight size={14} />
                        </button>
                      )}
                      {z ? (
                        <button className="secondary compact" onClick={() => onOpenZone(z.id)}>
                          域名配置
                          <ArrowRight size={14} />
                        </button>
                      ) : r.url ? (
                        <a
                          className="icon-button"
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={'打开 ' + r.name}
                        >
                          <ExternalLink size={18} />
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <div className="inventory-empty">
            {all.length
              ? '当前筛选下没有资源，试试选择全部域名和全部云账号。'
              : '尚无已同步资源，点击“刷新全部”读取所有已连接来源。'}
          </div>
        )}
        <div className="table-footer">
          <span>
            {rows.length} 项 · 第 {current} / {totalPages} 页
          </span>
          <div>
            <button
              className="secondary compact"
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
            >
              上一页
            </button>
            <button
              className="secondary compact"
              disabled={current === totalPages}
              onClick={() => setPage(current + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
