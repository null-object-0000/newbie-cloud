import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ChevronRight,
  Globe2,
  Search,
  RefreshCw,
  Plus,
  ExternalLink,
  Code2,
  FileCode2,
  Link as LinkIcon,
} from 'lucide-react';
import {
  domainInventory,
  dnsState,
  freshDns,
  providerNames,
  resourceRows,
  belongsToDomain,
} from '../inventory';
import type { Account, Zone, ResourceSnapshot, DnsObservation } from '../shared';
import type { Project } from './projects';
import { Dialog } from './dialog';
type Data = {
  accounts: Account[];
  zones: Zone[];
  snapshots: ResourceSnapshot[];
  observations: DnsObservation[];
};
const date = (v?: string | null) => (v ? new Date(v).toLocaleDateString('zh-CN') : '—');
export function DomainList({
  accounts,
  zones,
  snapshots,
  observations,
  busy,
  onSync,
  onOpen,
  onAccounts,
  registrationOnly = false,
}: {
  busy: boolean;
  onSync: () => void;
  onOpen: (name: string) => void;
  onAccounts: () => void;
  registrationOnly?: boolean;
} & Data) {
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(1);
  const all = domainInventory(zones, snapshots),
    rows = all.filter((d) =>
      (d.name + ' ' + d.registrations.map((r) => r.registrar).join(' '))
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  const pages = Math.max(1, Math.ceil(rows.length / 25)),
    current = Math.min(page, pages);
  useEffect(() => setPage(1), [query]);
  return (
    <>
      <div className="console-metrics">
        <div>
          <span>域名</span>
          <strong>{all.length}</strong>
          <small>按注册域名归并</small>
        </div>
        <div>
          <span>已读取注册信息</span>
          <strong>{all.filter((d) => d.registrations.length).length}</strong>
          <small>注册商与 DNS 分开识别</small>
        </div>
        <div>
          <span>DNS 已核实</span>
          <strong>
            {all.filter((d) => freshDns(observations.find((o) => o.name === d.name))).length}
          </strong>
          <small>公共 NS 最近 24 小时观测</small>
        </div>
      </div>
      <section className="panel console-list">
        <div className="console-list-toolbar">
          <div className="search">
            <Search size={17} />
            <input
              aria-label="搜索域名"
              placeholder="搜索域名或注册商"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="primary" disabled={busy || !accounts.length} onClick={onSync}>
            <RefreshCw size={16} className={busy ? 'spin' : ''} />
            {busy ? '同步中…' : '同步域名'}
          </button>
        </div>
        <div className="table-scroll">
          <table className="console-table">
            <thead>
              <tr>
                <th>域名</th>
                <th>注册商</th>
                <th>{registrationOnly ? '自动续费' : 'DNS 平台'}</th>
                <th>到期时间</th>
                <th>配置来源</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.slice((current - 1) * 25, current * 25).map((d) => {
                const observation = observations.find((o) => o.name === d.name),
                  known = freshDns(observation);
                return (
                  <tr key={d.name}>
                    <td>
                      <button className="resource-link" onClick={() => onOpen(d.name)}>
                        <Globe2 size={17} />
                        {d.name}
                      </button>
                    </td>
                    <td>
                      {[...new Set(d.registrations.map((r) => r.registrar))].join('、') || (
                        <span className="muted">未同步</span>
                      )}
                    </td>
                    <td>
                      {registrationOnly ? (
                        d.registrations.some((r) => r.autoRenew === true) ? (
                          '已开启'
                        ) : d.registrations.some((r) => r.autoRenew === false) ? (
                          '未开启'
                        ) : (
                          '未返回'
                        )
                      ) : known && observation?.provider ? (
                        <span className="status">
                          <i />
                          {providerNames[observation.provider]}
                        </span>
                      ) : (
                        <span className="pill">待核实 NS</span>
                      )}
                    </td>
                    <td>{date(d.registrations[0]?.expiresAt)}</td>
                    <td>
                      {d.zones.length} 份 DNS 配置<small>{d.registrations.length} 份注册记录</small>
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={'管理 ' + d.name}
                        onClick={() => onOpen(d.name)}
                      >
                        <ChevronRight size={18} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <div className="console-empty">
            <Globe2 size={30} />
            <h3>{all.length ? '没有匹配的域名' : '还没有域名资产'}</h3>
            <p>
              {all.length
                ? '更换搜索词，或清除筛选。'
                : '连接云账号后同步域名，注册信息和 DNS 将归并展示。'}
            </p>
            {!accounts.length && (
              <button className="primary" onClick={onAccounts}>
                连接第一个云账号
              </button>
            )}
          </div>
        )}
        <div className="table-footer">
          <span>{rows.length} 个域名</span>
          <div>
            <button
              className="secondary compact"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              上一页
            </button>
            <span>
              {current} / {pages}
            </span>
            <button
              className="secondary compact"
              disabled={current >= pages}
              onClick={() => setPage(current + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </section>
      <p className="console-footnote">
        域名注册与续费操作仍由注册商处理；这里读取真实资产，不购买或转移域名。
      </p>
    </>
  );
}
export function DomainSummary({
  name,
  accounts,
  zones,
  snapshots,
  observations,
  registrationOnly = false,
  onDns,
  onNavigate,
}: {
  name: string;
  registrationOnly?: boolean;
  onDns: (zoneId: string) => void;
  onNavigate: (view: 'records' | 'email' | 'certificates' | 'services', domain: string) => void;
} & Data) {
  const all = domainInventory(zones, snapshots),
    d = all.find((d) => d.name === name),
    ns = observations.find((o) => o.name === name),
    current = d?.zones.filter((z) => dnsState(z, accounts, observations) === 'current') ?? [];
  const count = (category: 'records' | 'email' | 'certificates' | 'services') =>
    resourceRows(snapshots, category).filter((r) =>
      r.zoneId
        ? d?.zones.some((z) => z.id === r.zoneId)
        : category === 'certificates'
          ? String(r.domain ?? '')
              .split(/[,\s]+/)
              .some((h) =>
                belongsToDomain(
                  h,
                  name,
                  all.map((d) => d.name),
                ),
              )
          : (r.domains ?? []).some((h: string) =>
              belongsToDomain(
                h,
                name,
                all.map((d) => d.name),
              ),
            ),
    ).length;
  if (!d)
    return (
      <div className="panel console-empty">
        <h3>尚未同步该域名</h3>
        <p>请返回所有域名，刷新注册和 DNS 信息。</p>
      </div>
    );
  return (
    <>
      {!registrationOnly && (
        <div className="console-metrics domain-metrics">
          {[
            ['DNS 记录', count('records'), 'records'],
            ['电子邮件', count('email'), 'email'],
            ['SSL / TLS 证书', count('certificates'), 'certificates'],
            ['关联计算资源', count('services'), 'services'],
          ].map(([label, value, view]) => (
            <button key={view} onClick={() => onNavigate(view as any, name)}>
              <span>{label}</span>
              <strong>{value}</strong>
              <small>
                查看详情 <ArrowRight size={13} />
              </small>
            </button>
          ))}
        </div>
      )}
      <div className="console-detail-grid">
        <section className="panel console-detail">
          <div className="panel-title">
            <h2>域名注册</h2>
            <span className="pill">注册商管理</span>
          </div>
          {d.registrations.length ? (
            d.registrations.map((r, i) => (
              <dl className="console-definition" key={i}>
                <dt>注册商</dt>
                <dd>{r.registrar}</dd>
                <dt>来源账号</dt>
                <dd>{accounts.find((a) => a.id === r.accountId)?.name}</dd>
                <dt>到期时间</dt>
                <dd>{date(r.expiresAt)}</dd>
                <dt>自动续费</dt>
                <dd>
                  {r.autoRenew === true
                    ? '已开启'
                    : r.autoRenew === false
                      ? '未开启'
                      : '平台未返回'}
                </dd>
                <dt>最近读取</dt>
                <dd>{date(r.checkedAt)}</dd>
              </dl>
            ))
          ) : (
            <p className="muted">未读取到注册资产，请同步注册商账号。</p>
          )}
        </section>
        <section className="panel console-detail">
          <div className="panel-title">
            <h2>DNS 托管</h2>
            {freshDns(ns) && ns?.provider && (
              <span className="pill green">{providerNames[ns.provider]}</span>
            )}
          </div>
          <dl className="console-definition">
            <dt>名称服务器</dt>
            <dd>{ns?.nameservers?.join('\n') || '尚未查询'}</dd>
            <dt>NS 观测</dt>
            <dd>
              {date(ns?.checkedAt)}
              {!freshDns(ns) && ' · 待核实'}
            </dd>
            <dt>配置来源</dt>
            <dd>{d.zones.length} 份 · 账号与平台分别保留</dd>
          </dl>
          {current.length === 1 && (
            <button className="secondary" onClick={() => onDns(current[0].id)}>
              管理当前 DNS
              <ArrowRight size={15} />
            </button>
          )}
        </section>
      </div>
      {!registrationOnly && (
        <section className="panel console-detail">
          <div className="panel-title">
            <h2>DNS 配置来源</h2>
            <span className="muted">不会合并或覆盖远端记录</span>
          </div>
          <div className="table-scroll">
            <table className="console-table">
              <thead>
                <tr>
                  <th>平台 / 账号</th>
                  <th>生效依据</th>
                  <th>最近同步</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {d.zones.map((z) => {
                  const a = accounts.find((a) => a.id === z.accountId),
                    s = dnsState(z, accounts, observations);
                  return (
                    <tr key={z.id}>
                      <td>
                        {a ? providerNames[a.provider] : '—'}
                        <small>{a?.name}</small>
                      </td>
                      <td>
                        <span className={s === 'current' ? 'pill green' : 'pill'}>
                          {s === 'current' ? 'NS 对应平台' : s === 'other' ? '配置副本' : '待核实'}
                        </span>
                      </td>
                      <td>{date(z.updatedAt)}</td>
                      <td>
                        <button className="secondary compact" onClick={() => onDns(z.id)}>
                          {s === 'other' ? '查看副本' : '查看记录'}
                          <ArrowRight size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
export function ComputeIndex({
  projects,
  accounts,
  snapshots,
  busy,
  onSync,
  onOpen,
  onCreate,
  onImport,
  onAccounts,
  kind = 'all',
  domain = '',
  onClearDomain,
}: {
  projects: Project[];
  accounts: Account[];
  snapshots: ResourceSnapshot[];
  busy: boolean;
  onSync: () => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onImport: (candidate?: { accountId: string; externalId: string }) => void;
  onAccounts: () => void;
  kind?: 'all' | 'Worker' | 'Pages';
  domain?: string;
  onClearDomain?: () => void;
}) {
  const [query, setQuery] = useState(''),
    [provider, setProvider] = useState(''),
    [filter, setFilter] = useState(kind),
    [page, setPage] = useState(1),
    [detail, setDetail] = useState<any>(null);
  useEffect(() => setFilter(kind), [kind]);
  useEffect(() => setPage(1), [query, provider, filter, domain]);
  const raw = resourceRows(snapshots, 'services').filter((r) =>
    ['Worker', 'Pages', 'EdgeOne Makers'].includes(r.kind),
  );
  const owned = (r: any) =>
    projects.find(
      (p) =>
        p.resourceLinks?.some(
          (l) => l.accountId === r.accountId && l.kind === r.kind && l.externalId === r.id,
        ) ||
        (p.management !== 'existing' &&
          r.kind === 'Pages' &&
          p.account_id === r.accountId &&
          p.remote_name === r.id),
    );
  const rows: any[] = [
    ...projects.map((p) => {
      const primary = p.resourceLinks?.find((l) => l.role === 'production'),
        r = raw.find((r) =>
          primary
            ? r.accountId === primary.accountId &&
              r.kind === primary.kind &&
              r.id === primary.externalId
            : r.accountId === p.account_id && r.kind === 'Pages' && r.id === p.remote_name,
        );
      return {
        ...r,
        key: 'project:' + p.id,
        id: primary?.externalId ?? p.remote_name,
        name: p.name,
        accountId: p.account_id,
        type: 'Pages',
        kind: primary?.kind ?? 'Pages',
        domains: r?.domains ?? (p.primaryUrl ? [new URL(p.primaryUrl).hostname] : []),
        status:
          r?.status ??
          (p.current_release ? '已部署' : p.management === 'existing' ? '已接管' : '待发布'),
        projectId: p.id,
        retained: p.resourceLinks?.filter((l) => l.role === 'retained').length ?? 0,
        url: p.primaryUrl ?? r?.url,
      };
    }),
    ...raw
      .filter((r) => !owned(r))
      .map((r) => ({
        ...r,
        type: r.kind === 'Worker' ? 'Worker' : 'Pages',
        projectId: null,
        retained: 0,
      })),
  ];
  const filtered = rows.filter(
    (r) =>
      (kind !== 'all' ? r.type === kind : filter === 'all' || r.type === filter) &&
      (!provider || accounts.find((a) => a.id === r.accountId)?.provider === provider) &&
      (!domain ||
        (r.domains ?? []).some((d: string) => d === domain || d.endsWith('.' + domain))) &&
      [r.name, r.id, ...(r.domains ?? [])].join(' ').toLowerCase().includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 25)),
    current = Math.min(page, pages);
  return (
    <>
      <div className="console-heading-actions">
        <div className="console-segment" aria-label="计算类型">
          {(kind === 'all'
            ? [
                ['all', '全部'],
                ['Worker', 'Workers'],
                ['Pages', 'Pages'],
              ]
            : [[kind, kind === 'Worker' ? 'Workers' : 'Pages']]
          ).map(([v, label]) => (
            <button key={v} aria-pressed={filter === v} onClick={() => setFilter(v as any)}>
              {label}
              <span>{v === 'all' ? rows.length : rows.filter((r) => r.type === v).length}</span>
            </button>
          ))}
        </div>
        <div>
          <button className="secondary" disabled={busy} onClick={() => onImport()}>
            <LinkIcon size={16} />
            接管已有站点
          </button>
          <button className="primary" disabled={busy} onClick={onCreate}>
            <Plus size={16} />
            创建 Pages 站点
          </button>
        </div>
      </div>
      {domain && (
        <div className="console-filter-note">
          关联域名：<strong>{domain}</strong>
          <button className="text-button" onClick={onClearDomain}>
            清除筛选
          </button>
        </div>
      )}
      <section className="panel console-list">
        <div className="console-list-toolbar">
          <div className="search">
            <Search size={17} />
            <input
              aria-label="搜索计算资源"
              placeholder="搜索名称或域名"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            aria-label="计算平台"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">全部平台</option>
            <option value="cloudflare">Cloudflare</option>
            <option value="tencent">腾讯云</option>
            <option value="aliyun">阿里云</option>
          </select>
          <button className="secondary" disabled={busy || !accounts.length} onClick={onSync}>
            <RefreshCw size={16} className={busy ? 'spin' : ''} />
            同步资源
          </button>
        </div>
        <div className="table-scroll">
          <table className="console-table compute-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>状态</th>
                <th>域名</th>
                <th>平台 / 账号</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice((current - 1) * 25, current * 25).map((r) => {
                const account = accounts.find((a) => a.id === r.accountId);
                return (
                  <tr key={r.key}>
                    <td>
                      <button
                        className="resource-link"
                        onClick={() => (r.projectId ? onOpen(r.projectId) : setDetail(r))}
                      >
                        {r.type === 'Worker' ? <Code2 size={18} /> : <FileCode2 size={18} />}
                        <span>
                          {r.name}
                          <small>{r.projectId ? '已纳入管理' : r.id}</small>
                        </span>
                      </button>
                      {r.retained > 0 && (
                        <small className="compute-retained">另有 {r.retained} 份保留资源</small>
                      )}
                    </td>
                    <td>
                      <span className="type-badge">{r.type === 'Worker' ? 'Worker' : 'Pages'}</span>
                      {r.kind === 'EdgeOne Makers' && <small>EdgeOne Makers</small>}
                    </td>
                    <td>
                      <span
                        className={
                          'status ' +
                          (['failed', 'failure', 'Failed'].includes(r.status) ? 'warn' : '')
                        }
                      >
                        <i />
                        {r.status === 'Normal'
                          ? '正常'
                          : r.status === 'success'
                            ? '部署成功'
                            : r.status}
                      </span>
                    </td>
                    <td className="domain-cell">
                      {r.domains?.length ? (
                        r.domains.slice(0, 2).map((d: string) => <span key={d}>{d}</span>)
                      ) : (
                        <span className="muted">未返回绑定</span>
                      )}
                      {r.domains?.length > 2 && <small>另 {r.domains.length - 2} 个</small>}
                    </td>
                    <td>
                      {account ? providerNames[account.provider] : '—'}
                      <small>{account?.name}</small>
                    </td>
                    <td>
                      <button
                        className="secondary compact"
                        onClick={() => (r.projectId ? onOpen(r.projectId) : setDetail(r))}
                      >
                        {r.projectId ? '管理' : '详情'}
                        <ChevronRight size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <div className="console-empty">
            <FileCode2 size={32} />
            <h3>{rows.length ? '没有匹配的应用' : '还没有计算资源'}</h3>
            <p>
              {rows.length
                ? '尝试调整筛选条件。'
                : '连接账号并同步已有资源，或创建一个免费 Pages 站点。'}
            </p>
            {!accounts.length && (
              <button className="secondary" onClick={onAccounts}>
                连接云账号
              </button>
            )}
          </div>
        )}
        <div className="table-footer">
          <span>
            {filtered.length} 项应用 · {raw.length} 份平台资源
          </span>
          <div>
            <button
              className="secondary compact"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              上一页
            </button>
            <span>
              {current} / {pages}
            </span>
            <button
              className="secondary compact"
              disabled={current >= pages}
              onClick={() => setPage(current + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </section>
      {snapshots
        .filter((s) => s.kind === 'issue:services')
        .map((s) => (
          <p className="local-error" key={s.account_id}>
            {accounts.find((a) => a.id === s.account_id)?.name}：{s.data[0]?.message}
            ，保留上次同步结果。
          </p>
        ))}
      {detail && (
        <Dialog title={detail.name} drawer onClose={() => setDetail(null)}>
          <div className="modal-body">
            <span className="type-badge">{detail.kind}</span>
            <dl className="console-definition">
              <dt>资源 ID</dt>
              <dd>{detail.id}</dd>
              <dt>来源账号</dt>
              <dd>{accounts.find((a) => a.id === detail.accountId)?.name}</dd>
              <dt>平台状态</dt>
              <dd>{detail.status}</dd>
              <dt>绑定域名</dt>
              <dd>{detail.domains?.join('\n') || '未返回绑定'}</dd>
              <dt>最近同步</dt>
              <dd>{date(detail.checkedAt)}</dd>
            </dl>
            {detail.url && (
              <a className="secondary" href={detail.url} target="_blank" rel="noreferrer">
                访问站点
                <ExternalLink size={15} />
              </a>
            )}
            {detail.type === 'Pages' ? (
              <div className="drawer-action">
                <p>接管后可关联源码、工作流和域名，保留原部署方式。</p>
                <button
                  className="primary"
                  onClick={() => {
                    onImport({ accountId: detail.accountId, externalId: detail.id });
                    setDetail(null);
                  }}
                >
                  接管此站点
                </button>
              </div>
            ) : (
              <p className="console-footnote">
                当前可读取 Worker 及其绑定信息。代码编辑、发布和回滚请在原平台操作。
              </p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
