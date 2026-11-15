import { useEffect, useState } from 'react';
import { RefreshCw, Search, X, Play, Square, RotateCw, FileText, Server } from 'lucide-react';
import type {
  Account,
  ResourceSnapshot,
  LocalCapabilities,
  SystemOverview,
  ContainerSummary,
  ContainerDetail,
  ContainerStats,
  CloudServer,
} from '../shared';
import { providerNames, resourceRows } from '../inventory';
import type { Api } from './resources';
import './servers.css';

const bytes = (n: number) =>
  n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GiB' : (n / 1024 ** 2).toFixed(1) + ' MiB';
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未提供';
const actions = { start: '启动', stop: '停止', restart: '重启' };
function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

export function DeploymentHost({ api }: { api: Api }) {
  const [data, setData] = useState<SystemOverview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError('');
    try {
      setData(await api('/local/system'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="panel host-panel">
      <header className="panel-title">
        <h2>部署主机与运行环境</h2>
        <button className="secondary" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={16} />
          刷新状态
        </button>
      </header>
      {error && <p className="local-error">{error}</p>}
      {data && (
        <div className="host-body">
          {data.engine && (
            <>
              <h3>Docker Engine 所在主机</h3>
              <p className="inventory-note">
                Docker Desktop 下为 Docker Linux 虚拟机；不把应用容器指标当成物理主机指标。
              </p>
              <dl className="host-facts">
                <div>
                  <dt>名称 / 系统</dt>
                  <dd>
                    {data.engine.name}
                    <small>
                      {data.engine.os} · {data.engine.arch}
                    </small>
                  </dd>
                </div>
                <div>
                  <dt>CPU / 内存</dt>
                  <dd>
                    {data.engine.cpus} 核 / {bytes(data.engine.memoryTotal)}
                  </dd>
                </div>
                <div>
                  <dt>Docker / 存储驱动</dt>
                  <dd>
                    {data.engine.version} / {data.engine.storageDriver}
                  </dd>
                </div>
                <div>
                  <dt>容器状态</dt>
                  <dd>
                    {data.engine.running} 运行 · {data.engine.stopped} 停止 · {data.engine.paused}{' '}
                    暂停
                  </dd>
                </div>
              </dl>
            </>
          )}
          {data.engineError && <p className="local-error">{data.engineError}</p>}
          <h3>{data.runtime.containerized ? '应用容器的运行环境' : '应用所在服务器'}</h3>
          <dl className="host-facts">
            <div>
              <dt>名称 / 系统</dt>
              <dd>
                {data.runtime.hostname}
                <small>
                  {data.runtime.platform} · {data.runtime.release} · {data.runtime.arch}
                </small>
              </dd>
            </div>
            <div>
              <dt>运行时间 / Node.js</dt>
              <dd>
                {Math.floor(data.runtime.uptime / 3600)} 小时 / {data.runtime.nodeVersion}
              </dd>
            </div>
            <div>
              <dt>CPU 并行度 / 系统负载</dt>
              <dd>
                {data.runtime.cpus} / {data.runtime.load.map((v) => v.toFixed(2)).join('、')}
              </dd>
            </div>
            <div>
              <dt>OS 可见内存</dt>
              <dd>
                {bytes(data.runtime.memoryFree)} 可用 / {bytes(data.runtime.memoryTotal)}
                <small>来自 OS 接口，容器配额请查看容器资源用量。</small>
              </dd>
            </div>
            <div>
              <dt>数据卷所在文件系统</dt>
              <dd>
                {data.dataDisk
                  ? `${bytes(data.dataDisk.availableBytes)} 可用 / ${bytes(data.dataDisk.totalBytes)}`
                  : '无法读取'}
                <small>文件系统容量，不等同于容器磁盘配额。</small>
              </dd>
            </div>
          </dl>
          {!data.capabilities.docker && (
            <p className="inventory-note">
              尚未接入本机 Docker。需要时使用 compose.docker.yml 显式挂载
              socket，重新创建管理台容器。
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function CloudServers({
  accounts,
  snapshots,
  api,
  onRefresh,
  local,
}: {
  accounts: Account[];
  snapshots: ResourceSnapshot[];
  api: Api;
  onRefresh: () => Promise<void>;
  local: LocalCapabilities | null;
}) {
  const [tab, setTab] = useState<'cloud' | 'host'>('cloud'),
    [account, setAccount] = useState(''),
    [region, setRegion] = useState(''),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [error, setError] = useState('');
  const rows = resourceRows(snapshots, 'servers') as (CloudServer & {
    key: string;
    accountId: string;
    checkedAt: string;
  })[];
  const regions = [
    ...new Set(
      snapshots.filter((s) => s.kind === 'server-regions').flatMap((s) => s.data.map((r) => r.id)),
    ),
  ].sort();
  const issues = snapshots.filter(
    (s) => s.kind.startsWith('issue:servers:') || s.kind === 'issue:server-regions',
  );
  const jobs = snapshots
      .filter((s) => s.kind === 'server-regions')
      .reduce((n, s) => n + s.data.length, 0),
    complete = snapshots.filter((s) => s.kind.startsWith('servers:')).length;
  const filtered = rows.filter(
    (r) =>
      (!account || r.accountId === account) &&
      (!region || r.region === region) &&
      JSON.stringify([r.id, r.name, r.publicIps, r.privateIps, r.os])
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 25)),
    current = Math.min(page, pages);
  useEffect(() => setPage(1), [account, region, query]);
  async function sync() {
    setBusy(true);
    setError('');
    let total = 0,
      failures = 0,
      done = 0;
    try {
      const jobs: { account: Account; region: string }[] = [];
      for (const a of accounts.filter((a) => a.provider !== 'cloudflare')) {
        try {
          setProgress('读取地域：' + a.name);
          const data = await api('/accounts/' + a.id + '/server-regions');
          for (const r of data.items) jobs.push({ account: a, region: r.id });
        } catch {
          failures++;
        }
      }
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(3, jobs.length) }, async () => {
          for (;;) {
            const job = jobs[index++];
            if (!job) break;
            let cursor: number | null = 1,
              syncId: string | undefined;
            try {
              while (cursor) {
                const result = await api(
                  '/accounts/' + job.account.id + '/inventory/servers',
                  'POST',
                  { region: job.region, cursor, syncId },
                );
                cursor = result.nextCursor;
                syncId = result.syncId;
                if (!cursor) total += result.count;
              }
            } catch {
              failures++;
            } finally {
              done++;
              setProgress(`已检查 ${done} / ${jobs.length} 个地域 · 已读取 ${total} 台`);
            }
          }
        }),
      );
      await onRefresh();
      setProgress(
        `已读取 ${total} 台服务器，检查 ${done} 个地域${failures ? `；${failures} 个来源失败，详见下方提示` : ''}。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '服务器同步失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {local && (
        <div className="server-tabs">
          <button className={tab === 'cloud' ? 'selected' : ''} onClick={() => setTab('cloud')}>
            云服务器
          </button>
          <button className={tab === 'host' ? 'selected' : ''} onClick={() => setTab('host')}>
            部署主机
          </button>
        </div>
      )}
      {tab === 'host' ? (
        <DeploymentHost api={api} />
      ) : (
        <>
          <div className="inventory-toolbar">
            <label>
              账号范围
              <select
                aria-label="服务器账号范围"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              >
                <option value="">全部云账号</option>
                {accounts
                  .filter((a) => a.provider !== 'cloudflare')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              地域
              <select
                aria-label="服务器地域范围"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              >
                <option value="">全部地域</option>
                {regions.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <div className="search">
              <Search size={16} />
              <input
                aria-label="搜索服务器"
                placeholder="搜索名称、IP、实例 ID"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button
              className="primary"
              disabled={busy || !accounts.some((a) => a.provider !== 'cloudflare')}
              onClick={() => void sync()}
            >
              <RefreshCw size={16} />
              同步全部地域
            </button>
          </div>
          <p className="inventory-note">
            ECS / CVM 只读清单 · {filtered.length} 台 · 已取得 {complete} / {jobs}{' '}
            个地域快照。默认汇总全部账号与地域；某地域失败会保留其旧快照。
          </p>
          {progress && (
            <p className="local-progress" role="status">
              {progress}
            </p>
          )}
          {error && <p className="local-error">{error}</p>}
          {issues.length > 0 && (
            <details className="source-issues">
              <summary>{issues.length} 个地域或账号来源未完成</summary>
              {issues.map((s) => (
                <p key={s.account_id + s.kind}>
                  {accounts.find((a) => a.id === s.account_id)?.name} /{' '}
                  {s.kind.replace('issue:', '')}：{s.data[0]?.message}
                </p>
              ))}
            </details>
          )}
          <section className="panel">
            <div className="table-scroll">
              <table className="resource-table">
                <thead>
                  <tr>
                    <th>服务器</th>
                    <th>来源 / 地域</th>
                    <th>状态 / 配置</th>
                    <th>公网 / 内网 IP</th>
                    <th>到期 / 同步时间</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice((current - 1) * 25, current * 25).map((r) => (
                    <tr key={r.key}>
                      <td className="record-name">
                        {r.name}
                        <small>{r.id}</small>
                        <small>{r.os}</small>
                      </td>
                      <td>
                        {providerNames[r.provider]}
                        <small>{accounts.find((a) => a.id === r.accountId)?.name}</small>
                        <small>
                          {r.region} / {r.zone}
                        </small>
                      </td>
                      <td>
                        {r.state}
                        <small>
                          {r.cpu} vCPU · {bytes(r.memoryMiB * 1024 ** 2)}
                        </small>
                        <small>{r.billing}</small>
                      </td>
                      <td>
                        {r.publicIps.join('、') || '无公网 IP'}
                        <small>{r.privateIps.join('、') || '无内网 IP'}</small>
                      </td>
                      <td>
                        {time(r.expiresAt)}
                        <small>同步 {time(r.checkedAt)}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <div className="inventory-empty">
                {jobs
                  ? '当前已同步地域中没有匹配的服务器；请结合来源覆盖和失败提示判断。'
                  : '点击“同步全部地域”读取已连接阿里云和腾讯云账号的服务器清单。'}
              </div>
            )}
            <div className="table-footer">
              <span>
                {filtered.length} 台 · 第 {current} / {pages} 页
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
                  disabled={current === pages}
                  onClick={() => setPage(current + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </>
  );
}

export function Containers({
  api,
  capabilities,
  onChanged,
}: {
  api: Api;
  capabilities: LocalCapabilities;
  onChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState<ContainerSummary[]>([]),
    [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [detail, setDetail] = useState<ContainerDetail | null>(null),
    [stats, setStats] = useState<ContainerStats | null>(null),
    [logs, setLogs] = useState<string | null>(null);
  const [action, setAction] = useState<{
      container: ContainerSummary;
      action: 'start' | 'stop' | 'restart';
    } | null>(null),
    [confirm, setConfirm] = useState('');
  async function load() {
    setBusy(true);
    setError('');
    try {
      setItems((await api('/local/containers')).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (capabilities.docker) void load();
  }, [capabilities.docker]);
  async function inspect(c: ContainerSummary) {
    setBusy(true);
    setError('');
    setStats(null);
    setLogs(null);
    try {
      setDetail(await api('/local/containers/' + c.id));
      if (c.state === 'running')
        try {
          setStats(await api('/local/containers/' + c.id + '/stats'));
        } catch {
          setNotice('容器详情已读取，资源用量暂不可用。');
        }
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  const choose = (container: ContainerSummary, action: 'start' | 'stop' | 'restart') => {
    setAction({ container, action });
    setConfirm('');
    setError('');
  };
  async function apply() {
    if (!action) return;
    setBusy(true);
    setError('');
    try {
      await api('/local/containers/' + action.container.id + '/action', 'POST', {
        action: action.action,
        confirmName: confirm,
        expectedState: action.container.state,
      });
      setAction(null);
      setNotice('Docker 已确认' + actions[action.action] + '请求。');
      setItems((await api('/local/containers')).items);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作结果未确认，请刷新状态核对');
    } finally {
      setBusy(false);
    }
  }
  if (!capabilities.docker)
    return (
      <section className="panel inventory-empty">
        尚未连接 Docker Engine。使用 compose.docker.yml 挂载本机 socket
        后重建应用；默认部署只提供云管理与主机概览。
      </section>
    );
  return (
    <>
      <div className="inventory-toolbar">
        <div className="search">
          <Search size={17} />
          <input
            aria-label="搜索本机容器"
            placeholder="搜索容器、镜像、Compose 项目"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="muted">
          {items.length} 个容器 · {capabilities.dockerWrite ? '控制已开启' : '只读模式'}
        </span>
        <button className="primary" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={16} />
          刷新容器
        </button>
      </div>
      <p className="inventory-note">
        仅管理此部署连接的本机 Docker Engine。查看详情时读取一次资源用量；日志按需读取，不自动保存。
        {!capabilities.dockerWrite && ' 启停控制需显式设置 DOCKER_WRITE_ENABLED=true。'}
      </p>
      {error && (
        <p className="local-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="local-progress" role="status">
          {notice}
        </p>
      )}
      <section className="panel">
        <div className="table-scroll">
          <table className="resource-table">
            <thead>
              <tr>
                <th>容器 / 镜像</th>
                <th>状态</th>
                <th>端口 / Compose</th>
                <th>查看</th>
                <th>控制</th>
              </tr>
            </thead>
            <tbody>
              {items
                .filter((c) =>
                  (c.name + ' ' + c.image + ' ' + c.project)
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((c) => (
                  <tr key={c.id}>
                    <td className="record-name">
                      {c.name}
                      <small>{c.image}</small>
                      <small>
                        {c.id.slice(0, 12)}
                        {c.protected ? ' · 管理台自身' : ''}
                      </small>
                    </td>
                    <td>
                      {c.state}
                      <small>{c.status}</small>
                    </td>
                    <td>
                      {c.ports.join('、') || '未发布端口'}
                      <small>
                        {c.project ?? '无 Compose 项目'}
                        {c.service ? ' / ' + c.service : ''}
                      </small>
                    </td>
                    <td>
                      <button
                        className="secondary compact"
                        disabled={busy}
                        onClick={() => void inspect(c)}
                      >
                        详情与日志
                      </button>
                    </td>
                    <td>
                      <div className="row-actions">
                        {(
                          [
                            ['start', Play],
                            ['stop', Square],
                            ['restart', RotateCw],
                          ] as const
                        ).map(([a, Icon]) => (
                          <button
                            key={a}
                            className="icon-button"
                            title={actions[a]}
                            aria-label={actions[a] + ' ' + c.name}
                            disabled={
                              busy ||
                              !capabilities.dockerWrite ||
                              c.protected ||
                              (a === 'start'
                                ? !['created', 'exited'].includes(c.state)
                                : c.state !== 'running')
                            }
                            onClick={() => choose(c, a)}
                          >
                            <Icon size={17} />
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!items.length && !busy && (
          <div className="inventory-empty">Docker Engine 中没有容器。</div>
        )}
      </section>
      {detail && (
        <Dialog title={'容器：' + detail.name} onClose={() => setDetail(null)}>
          <dl className="host-facts">
            <div>
              <dt>状态 / 健康</dt>
              <dd>
                {detail.state} / {detail.health ?? '无健康检查'}
              </dd>
            </div>
            <div>
              <dt>重启策略</dt>
              <dd>{detail.restartPolicy}</dd>
            </div>
            <div>
              <dt>启动 / 退出</dt>
              <dd>
                {time(detail.startedAt)}
                <small>
                  {time(detail.finishedAt)} · 退出码 {detail.exitCode}
                </small>
              </dd>
            </div>
            <div>
              <dt>网络</dt>
              <dd>
                {detail.networks.map((n) => n.name + ': ' + n.address).join('、') || '无网络'}
              </dd>
            </div>
            {stats && (
              <>
                <div>
                  <dt>CPU</dt>
                  <dd>
                    {stats.cpuPercent === null ? '暂无采样' : stats.cpuPercent.toFixed(1) + '%'}
                  </dd>
                </div>
                <div>
                  <dt>内存</dt>
                  <dd>
                    {bytes(stats.memoryBytes)} / {bytes(stats.memoryLimitBytes)}
                  </dd>
                </div>
                <div>
                  <dt>网络接收 / 发送</dt>
                  <dd>
                    {bytes(stats.networkRxBytes)} / {bytes(stats.networkTxBytes)}
                  </dd>
                </div>
              </>
            )}
          </dl>
          <h3>挂载</h3>
          <pre className="detail-json">
            {detail.mounts
              .map((m) => `${m.source} → ${m.destination} (${m.readonly ? '只读' : '读写'})`)
              .join('\n') || '无挂载'}
          </pre>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError('');
              void api('/local/containers/' + detail.id + '/logs?tail=200')
                .then((data) => setLogs(data.text || '暂无日志'))
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <FileText size={16} />
            读取最近 200 行日志
          </button>
          {logs !== null && <pre className="container-logs">{logs}</pre>}
          {error && <p className="local-error">{error}</p>}
        </Dialog>
      )}
      {action && (
        <Dialog
          title={actions[action.action] + '容器'}
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <p>
            确认{actions[action.action]} <strong>{action.container.name}</strong>。当前状态：
            {action.container.state}。
          </p>
          <label>
            输入完整容器名称确认
            <input
              autoFocus
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={action.container.name}
            />
          </label>
          {error && <p className="local-error">{error}</p>}
          <div className="modal-actions">
            <button className="secondary" disabled={busy} onClick={() => setAction(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy || confirm !== action.container.name}
              onClick={() => void apply()}
            >
              确认{actions[action.action]}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
