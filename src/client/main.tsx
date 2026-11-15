import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Cloud,
  Globe2,
  LayoutDashboard,
  Server,
  KeyRound,
  ShieldCheck,
  Mail,
  History,
  Settings,
  Plus,
  RefreshCw,
  ArrowUpRight,
  ArrowRight,
  Search,
  X,
  LogOut,
  LockKeyhole,
  Trash2,
  Pencil,
  Check,
  ChevronRight,
  CloudUpload,
  ExternalLink,
  LoaderCircle,
} from 'lucide-react';
import type {
  Account,
  Zone,
  DnsRecord,
  RecordInput,
  Provider,
  Operation,
  Plan,
  Service,
  Certificate,
  EmailRule,
} from '../shared';
import './style.css';

const providers: Record<Provider, { name: string; short: string; color: string }> = {
  cloudflare: { name: 'Cloudflare', short: 'CF', color: 'orange' },
  tencent: { name: '腾讯云', short: 'TC', color: 'blue' },
  aliyun: { name: '阿里云', short: 'AL', color: 'purple' },
};
const labels: Record<string, string> = {
  planned: '待确认',
  applying: '执行中',
  success: '已完成',
  failed: '未完成',
  review_required: '待核对',
  active: '正常',
  deployed: '已部署',
  pending: '待配置',
  online: '在线',
  process: '处理中',
};
async function api<T = any>(url: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch('/api' + url, {
    method,
    credentials: 'same-origin',
    ...(data !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
      : {}),
  });
  const result: any = await response.json();
  if (!response.ok) throw new Error(result.error ?? '请求未完成');
  return result as T;
}
const time = (value: string | undefined | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查';
const days = (value: string | null) =>
  value ? Math.ceil((Date.parse(value) - Date.now()) / 86400000) : null;
function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <Cloud size={23} />
      </span>
      <div>
        Newbie Cloud<small>个人云管家</small>
      </div>
    </div>
  );
}
function ProviderBadge({ provider }: { provider: Provider }) {
  const p = providers[provider];
  return (
    <span className={'provider ' + p.color}>
      <span>{p.short}</span>
      {p.name}
    </span>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span
      className={
        'status ' + (['failed', 'review_required', 'expired'].includes(value) ? 'warn' : '')
      }
    >
      <i />
      {labels[value] ?? value}
    </span>
  );
}
function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Globe2 size={32} />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={'modal ' + (wide ? 'wide' : '')}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
type Snapshot = { account_id: string; kind: string; data: any[]; updated_at: string };
type View =
  | 'overview'
  | 'accounts'
  | 'dns'
  | 'services'
  | 'email'
  | 'certificates'
  | 'deploy'
  | 'history'
  | 'settings';
const navigation: [View, string, typeof Cloud][] = [
  ['overview', '总览', LayoutDashboard],
  ['accounts', '云账号', Cloud],
  ['dns', '域名与 DNS', Globe2],
  ['services', '托管服务', Server],
  ['email', '邮箱转发', Mail],
  ['certificates', 'HTTPS 证书', ShieldCheck],
  ['deploy', '部署', CloudUpload],
  ['history', '操作记录', History],
];
function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [configured, setConfigured] = useState(true),
    [token, setToken] = useState('');
  const [view, setView] = useState<View>('overview'),
    [accounts, setAccounts] = useState<Account[]>([]),
    [zones, setZones] = useState<Zone[]>([]),
    [operations, setOperations] = useState<Operation[]>([]),
    [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState('');
  const [accountId, setAccountId] = useState(''),
    [zoneId, setZoneId] = useState(''),
    [records, setRecords] = useState<DnsRecord[]>([]),
    [recordPage, setRecordPage] = useState(1),
    [nextPage, setNextPage] = useState<number | null>(null),
    [email, setEmail] = useState<EmailRule[]>([]);
  const [accountModal, setAccountModal] = useState<Account | null | undefined>(),
    [recordModal, setRecordModal] = useState<DnsRecord | null | undefined>(),
    [preview, setPreview] = useState<{ id: string; plan: Plan; expiresAt: string } | null>(null),
    [protectedAck, setProtectedAck] = useState(false),
    [confirmDomain, setConfirmDomain] = useState('');
  const [detail, setDetail] = useState<Operation | null>(null),
    [githubEnabled, setGithubEnabled] = useState(false),
    [repository, setRepository] = useState(''),
    [workflow, setWorkflow] = useState('deploy.yml'),
    [branch, setBranch] = useState('main');
  const selectedZone = zones.find((z) => z.id === zoneId),
    selectedAccount = accounts.find((a) => a.id === (selectedZone?.accountId ?? accountId));
  async function refresh() {
    const [a, z, o, s] = await Promise.all([
      api('/accounts'),
      api('/zones'),
      api('/operations'),
      api('/snapshots'),
    ]);
    setAccounts(a.items);
    setZones(z.items);
    setOperations(o.items);
    setSnapshots(s.items);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    (async () => {
      try {
        const health = await api('/health');
        setConfigured(health.configured);
        const me = await api('/me');
        setGithubEnabled(me.features.githubDeploy);
        setAuth(true);
        await refresh();
      } catch {
        setAuth(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (accounts.length && !accountId) setAccountId(accounts[0].id);
  }, [accounts, accountId]);
  useEffect(() => {
    if (view === 'certificates') {
      if (zones.find((z) => z.id === zoneId)?.accountId !== accountId)
        setZoneId(zones.find((z) => z.accountId === accountId)?.id ?? '');
    } else if (zones.length && !zoneId) setZoneId(zones[0].id);
  }, [zones, zoneId, view, accountId]);
  async function loadRecords() {
    if (!zoneId) return;
    const data = await api('/zones/' + encodeURIComponent(zoneId) + '/records?page=' + recordPage);
    setRecords(data.items);
    setNextPage(data.nextCursor);
  }
  useEffect(() => {
    if (!auth || !zoneId) return;
    setError('');
    setRecords([]);
    setEmail([]);
    if (view === 'dns') void run(loadRecords);
    if (view === 'email')
      void run(async () =>
        setEmail((await api('/zones/' + encodeURIComponent(zoneId) + '/email')).items),
      );
  }, [auth, view, zoneId, recordPage]);
  async function sync(id: string) {
    let cursor: number | null = 1,
      total = 0;
    while (cursor) {
      const data: any = await api('/accounts/' + id + '/sync', 'POST', { cursor });
      total += data.count;
      cursor = data.nextCursor;
    }
    await refresh();
    setNotice(`已同步 ${total} 个托管域名。未修改云平台资源。`);
  }
  async function plan(
    action: 'create' | 'update' | 'delete',
    record?: RecordInput,
    recordId?: string,
  ) {
    const result = await api('/dns/plan', 'POST', { zoneId, action, record, recordId });
    setPreview(result);
    setRecordModal(undefined);
    setProtectedAck(false);
    setConfirmDomain('');
    await refresh();
  }
  const chooseZone = (id: string) => {
    setZoneId(id);
    setRecordPage(1);
    setQuery('');
  };
  const nav = (v: View) => {
    setView(v);
    setQuery('');
    setError('');
    setNotice('');
  };
  const certificateSnapshots = snapshots.filter((s) => s.kind.startsWith('certificates'));
  const certificates = certificateSnapshots.flatMap((s) =>
    s.data.map((c: Certificate) => ({ ...c, account_id: s.account_id, checked: s.updated_at })),
  );
  const expiring = certificates.filter((c) => {
    const d = days(c.expiresAt);
    return d !== null && d <= 30;
  }).length;
  if (auth === null)
    return (
      <div className="loading-page">
        <Brand />
        <LoaderCircle className="spin" />
        <p>正在连接你的云工作台…</p>
      </div>
    );
  if (!auth)
    return (
      <main className="login-page">
        <div className="login-card">
          <Brand />
          <div className="eyebrow">YOUR CLOUD, YOUR CONTROL</div>
          <h1>
            把云上的小事，
            <br />
            放到一个地方。
          </h1>
          <p>个人使用 · 免费优先 · 数据留在自己的账号</p>
          {!configured ? (
            <div className="callout">
              请按仓库部署文档配置数据库、ADMIN_TOKEN 和 ENCRYPTION_KEY，然后刷新页面。
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api('/login', 'POST', { token });
                  setToken('');
                  const me = await api('/me');
                  setGithubEnabled(me.features.githubDeploy);
                  setAuth(true);
                  await refresh();
                });
              }}
            >
              <label>
                管理密钥
                <input
                  autoFocus
                  type="password"
                  autoComplete="current-password"
                  placeholder="输入部署时生成的管理密钥"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                />
              </label>
              <button className="primary full" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}
                进入工作台
              </button>
            </form>
          )}
          {error && <div className="error">{error}</div>}
          <small>单用户自托管。云平台密钥仅由后端加密保存。</small>
        </div>
        <div className="login-art">
          <div className="orbit o1" />
          <div className="orbit o2" />
          <div className="orbit o3" />
          <div className="cloud-center">
            <Cloud size={76} />
          </div>
          <span className="floating f1">Cloudflare</span>
          <span className="floating f2">腾讯云</span>
          <span className="floating f3">阿里云</span>
          <div className="art-note">
            一朵云的自由，
            <br />
            不止一种选择。
          </div>
        </div>
      </main>
    );
  return (
    <div className="app">
      <aside className="sidebar">
        <Brand />
        <span className="workspace-label">PERSONAL WORKSPACE</span>
        <nav>
          {navigation.map(([id, label, Icon]) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => nav(id)}>
              <Icon size={18} />
              {label}
              {id === 'accounts' && accounts.length > 0 && (
                <span className="nav-count">{accounts.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="free-note">
            <span className="green-dot" />
            免费额度优先<small>无需常驻服务器</small>
          </div>
          <button onClick={() => nav('settings')} className={view === 'settings' ? 'active' : ''}>
            <Settings size={17} />
            使用说明
          </button>
          <button
            onClick={() =>
              void run(async () => {
                try {
                  await api('/logout', 'POST', {});
                } finally {
                  setAuth(false);
                }
              })
            }
          >
            <LogOut size={17} />
            退出登录
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span className="breadcrumb">我的工作台</span>
            <ChevronRight size={14} />
            <strong>{navigation.find((n) => n[0] === view)?.[1] ?? '使用说明'}</strong>
          </div>
          <span className="owner">
            <span>N</span>个人空间
          </span>
        </header>
        <main className="content">
          {(error || notice) && (
            <div role="status" className={'toast ' + (error ? 'error' : 'success')}>
              <span>{error || notice}</span>
              <button
                className="icon-button"
                onClick={() => {
                  setError('');
                  setNotice('');
                }}
                aria-label="关闭通知"
              >
                <X size={17} />
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">NEWBIE CLOUD / {view.toUpperCase()}</div>
              <h1>
                {view === 'overview'
                  ? '你的云，一目了然。'
                  : (navigation.find((n) => n[0] === view)?.[1] ?? '使用说明')}
              </h1>
              <p>
                {
                  {
                    overview: '域名、解析和托管服务，在一个地方看清。',
                    accounts: '连接自己的云账号，按实际权限管理资源。',
                    dns: '先预览差异，再确认修改。',
                    services: '查看各个平台上的站点与边缘托管服务。',
                    email: '查看 Cloudflare 的邮箱转发规则，现有配置保持不变。',
                    certificates: '记录平台证书状态，及时发现即将到期的证书。',
                    deploy: '将构建和发布交给已有的 GitHub Actions 工作流。',
                    history: '每一次连接、检查和变更，都有迹可循。',
                    settings: '轻量、单用户、免费额度优先。',
                  }[view]
                }
              </p>
            </div>
            <div className="heading-actions">
              {busy && <LoaderCircle size={19} className="spin" />}
              <button className="secondary" disabled={busy} onClick={() => void run(refresh)}>
                <RefreshCw size={16} />
                刷新
              </button>
              {['overview', 'accounts'].includes(view) && (
                <button className="primary" onClick={() => setAccountModal(null)}>
                  <Plus size={17} />
                  添加云账号
                </button>
              )}
            </div>
          </div>
          {view === 'overview' && (
            <>
              <section className="stats">
                {[
                  [Cloud, '已连接账号', accounts.length, '三家云，各自独立'],
                  [Globe2, '已同步域名', zones.length, 'DNS 托管区域'],
                  [ShieldCheck, '已检查证书', certificates.length, '来自平台查询结果'],
                  [
                    History,
                    '近期变更',
                    operations.filter((o) => o.kind === 'dns' && o.status === 'success').length,
                    '已确认执行的 DNS 操作',
                  ],
                ].map(([Icon, label, value, note], i) => {
                  const I = Icon as typeof Cloud;
                  return (
                    <div className="stat" key={i}>
                      <div className="stat-top">
                        <span>{label as string}</span>
                        <I size={18} />
                      </div>
                      <strong>{value as number}</strong>
                      <small>{note as string}</small>
                    </div>
                  );
                })}
              </section>
              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-title">
                    <h2>云账号</h2>
                    <button className="text-button" onClick={() => nav('accounts')}>
                      管理账号
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                  {!accounts.length ? (
                    <Empty
                      title="从连接第一个账号开始"
                      description="添加 API 凭据后，可手动读取资源，不会自动修改 DNS。"
                      action={
                        <button className="secondary" onClick={() => setAccountModal(null)}>
                          <Plus size={16} />
                          连接云账号
                        </button>
                      }
                    />
                  ) : (
                    <div className="account-summary">
                      {accounts.map((a) => (
                        <div className="account-row" key={a.id}>
                          <span className={'provider-logo ' + providers[a.provider].color}>
                            {providers[a.provider].short}
                          </span>
                          <div>
                            <strong>{a.name}</strong>
                            <small>
                              {providers[a.provider].name} ·{' '}
                              {zones.filter((z) => z.accountId === a.id).length} 个域名
                            </small>
                          </div>
                          <span className={'pill ' + (a.readonly ? '' : 'green')}>
                            {a.readonly ? (
                              <>
                                <LockKeyhole size={12} />
                                只读
                              </>
                            ) : (
                              '可写入'
                            )}
                          </span>
                          <button
                            className="icon-button"
                            disabled={busy}
                            onClick={() => void run(() => sync(a.id))}
                            aria-label={'同步 ' + a.name}
                          >
                            <RefreshCw size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
                <section className="panel quiet-panel">
                  <div className="panel-title">
                    <h2>维护状态</h2>
                    <span className="pill">只读巡检</span>
                  </div>
                  <div className="maintenance-icon">
                    <ShieldCheck size={34} />
                  </div>
                  <h3>{expiring ? `${expiring} 张证书临近到期` : '让维护有据可查'}</h3>
                  <p>
                    定时任务每 15
                    分钟检查一个账号。平台托管的证书由原平台续期，这里记录查询结果，不重复申请。
                  </p>
                  <button className="secondary" onClick={() => nav('certificates')}>
                    查看证书
                    <ArrowRight size={15} />
                  </button>
                </section>
              </div>
              <section className="panel">
                <div className="panel-title">
                  <h2>最近操作</h2>
                  <button className="text-button" onClick={() => nav('history')}>
                    全部记录
                    <ArrowUpRight size={15} />
                  </button>
                </div>
                {operations.length ? (
                  <OperationList items={operations.slice(0, 5)} onSelect={setDetail} />
                ) : (
                  <Empty
                    title="这里会记录你的操作"
                    description="连接账号、同步域名或检查证书后，即可查看记录。"
                  />
                )}
              </section>
            </>
          )}
          {view === 'accounts' && (
            <div className="account-cards">
              {accounts.map((a) => (
                <section className="panel account-card" key={a.id}>
                  <div className="panel-title">
                    <ProviderBadge provider={a.provider} />
                    <span className="pill">{a.readonly ? '只读连接' : '允许确认后写入'}</span>
                  </div>
                  <h2>{a.name}</h2>
                  <p>{zones.filter((z) => z.accountId === a.id).length} 个已同步域名</p>
                  <small>添加于 {time(a.createdAt)}</small>
                  <div className="card-actions">
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void run(() => sync(a.id))}
                    >
                      <RefreshCw size={15} />
                      同步域名
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => setAccountModal(a)}
                      aria-label="编辑账号"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      disabled={busy}
                      aria-label="移除连接"
                      onClick={() => {
                        if (confirm('仅移除本地账号连接和缓存，不会删除云平台资源。继续？'))
                          void run(async () => {
                            await api('/accounts/' + a.id, 'DELETE');
                            setAccountId('');
                            setZoneId('');
                            await refresh();
                          });
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </section>
              ))}
              <button className="add-card" onClick={() => setAccountModal(null)}>
                <Plus size={27} />
                <strong>添加云账号</strong>
                <span>Cloudflare / 腾讯云 / 阿里云</span>
              </button>
            </div>
          )}
          {['dns', 'email'].includes(view) && (
            <>
              <div className="toolbar">
                <label className="select-label">
                  当前域名
                  <select value={zoneId} onChange={(e) => chooseZone(e.target.value)}>
                    <option value="">请选择已同步域名</option>
                    {zones.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name} · {accounts.find((a) => a.id === z.accountId)?.name}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedAccount && (
                  <>
                    <ProviderBadge provider={selectedAccount.provider} />
                    <span className="pill">
                      {selectedAccount.readonly ? '账号只读' : '可确认后写入'}
                    </span>
                  </>
                )}
                {view === 'dns' && (
                  <>
                    <div className="search">
                      <Search size={16} />
                      <input
                        aria-label="搜索当前页记录"
                        placeholder="搜索当前页记录"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </div>
                    <button
                      className="primary"
                      disabled={!selectedZone || selectedAccount?.readonly || busy}
                      onClick={() => setRecordModal(null)}
                    >
                      <Plus size={16} />
                      添加记录
                    </button>
                  </>
                )}
              </div>
              {!selectedZone ? (
                <section className="panel">
                  <Empty
                    title="还没有可选择的域名"
                    description="先连接云账号，再手动同步 DNS 托管域名。"
                    action={
                      <button className="secondary" onClick={() => nav('accounts')}>
                        前往云账号
                        <ArrowRight size={15} />
                      </button>
                    }
                  />
                </section>
              ) : view === 'dns' ? (
                <section className="panel table-panel">
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>类型</th>
                          <th>名称</th>
                          <th>记录内容</th>
                          <th>TTL</th>
                          <th>状态</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records
                          .filter((r) =>
                            (r.name + ' ' + r.content + ' ' + r.type)
                              .toLowerCase()
                              .includes(query.toLowerCase()),
                          )
                          .map((r) => (
                            <tr key={r.id}>
                              <td>
                                <span className="record-type">{r.type}</span>
                              </td>
                              <td className="record-name">{r.name}</td>
                              <td>
                                <div className="record-value" title={r.content}>
                                  {r.content}
                                </div>
                                {r.priority !== undefined && <small>优先级 {r.priority}</small>}
                              </td>
                              <td>{r.ttl === 1 ? '自动' : r.ttl + 's'}</td>
                              <td>
                                {r.disabled ? (
                                  <span className="pill">已停用</span>
                                ) : r.proxied ? (
                                  <span className="proxy">
                                    <Cloud size={14} />
                                    代理
                                  </span>
                                ) : (
                                  <span className="muted">仅 DNS</span>
                                )}
                              </td>
                              <td>
                                <div className="row-actions">
                                  <button
                                    className="icon-button"
                                    aria-label={'编辑 ' + r.name}
                                    disabled={
                                      selectedAccount?.readonly ||
                                      !['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'].includes(r.type) ||
                                      busy
                                    }
                                    onClick={() => setRecordModal(r)}
                                  >
                                    <Pencil size={15} />
                                  </button>
                                  <button
                                    className="icon-button danger"
                                    aria-label={'删除 ' + r.name}
                                    disabled={selectedAccount?.readonly || busy}
                                    onClick={() => void run(() => plan('delete', undefined, r.id))}
                                  >
                                    <Trash2 size={15} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  {!records.length && !busy && (
                    <Empty
                      title="当前页没有 DNS 记录"
                      description="可以添加记录，或切换其他域名。"
                    />
                  )}
                  <div className="table-footer">
                    <span>
                      第 {recordPage} 页 · 当前页 {records.length} 条
                    </span>
                    <div>
                      <button
                        className="secondary compact"
                        disabled={recordPage === 1 || busy}
                        onClick={() => setRecordPage((p) => p - 1)}
                      >
                        上一页
                      </button>
                      <button
                        className="secondary compact"
                        disabled={!nextPage || busy}
                        onClick={() => setRecordPage(nextPage!)}
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="panel">
                  {email.length ? (
                    <div className="rule-list">
                      {email.map((r) => (
                        <div className="email-rule" key={r.id}>
                          <Mail size={20} />
                          <div>
                            <strong>{r.name || '邮箱转发规则'}</strong>
                            <pre>{JSON.stringify(r.matchers, null, 2)}</pre>
                            <small>→ {JSON.stringify(r.actions)}</small>
                          </div>
                          <Status value={r.enabled ? 'active' : '已停用'} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title={
                        selectedAccount?.provider === 'cloudflare'
                          ? '尚未读取到转发规则'
                          : '此平台暂未接入邮箱转发'
                      }
                      description="MVP 只读展示 Cloudflare Email Routing 前 50 条规则，不会发送邮件或改变转发目标。"
                    />
                  )}
                </section>
              )}
            </>
          )}
          {['services', 'certificates'].includes(view) && (
            <>
              <div className="toolbar">
                <label className="select-label">
                  云账号
                  <select
                    value={accountId}
                    onChange={(e) => {
                      setAccountId(e.target.value);
                      setZoneId('');
                    }}
                  >
                    <option value="">选择云账号</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                {view === 'certificates' &&
                  accounts.find((a) => a.id === accountId)?.provider === 'cloudflare' && (
                    <label className="select-label">
                      检查域名
                      <select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                        <option value="">请选择</option>
                        {zones
                          .filter((z) => z.accountId === accountId)
                          .map((z) => (
                            <option key={z.id} value={z.id}>
                              {z.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                <button
                  className="primary"
                  disabled={!accountId || busy}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        '/accounts/' + accountId + '/' + view,
                        'POST',
                        view === 'certificates'
                          ? {
                              zoneId:
                                accounts.find((a) => a.id === accountId)?.provider === 'cloudflare'
                                  ? zoneId
                                  : undefined,
                            }
                          : {},
                      );
                      await refresh();
                      setNotice('已更新查询快照。');
                    })
                  }
                >
                  <RefreshCw size={16} />
                  {view === 'certificates' ? '检查证书' : '读取服务'}
                </button>
                <span className="muted small">显示已保存的查询结果，不自动修改云资源</span>
              </div>
              <section className="panel">
                {view === 'services' ? (
                  <div className="service-grid">
                    {snapshots
                      .filter((s) => s.kind === 'services' && s.account_id === accountId)
                      .flatMap((s) =>
                        s.data.map((item: Service) => (
                          <div className="service" key={item.id}>
                            <span className="service-icon">
                              <Server size={22} />
                            </span>
                            <div>
                              <h3>{item.name}</h3>
                              <small>
                                {item.kind} · {item.detail ?? item.status}
                              </small>
                              <p>更新于 {time(s.updated_at)}</p>
                            </div>
                            {item.url && (
                              <a
                                className="icon-button"
                                href={item.url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="打开站点"
                              >
                                <ExternalLink size={17} />
                              </a>
                            )}
                          </div>
                        )),
                      )}
                    {!snapshots.some(
                      (s) => s.kind === 'services' && s.account_id === accountId,
                    ) && (
                      <Empty
                        title="读取你的托管服务"
                        description="支持 Cloudflare Pages / Workers、腾讯 EdgeOne Makers 与阿里云 ESA 站点列表。需要相应 API 的只读权限。"
                      />
                    )}
                  </div>
                ) : (
                  <>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>域名</th>
                            <th>平台状态</th>
                            <th>到期时间</th>
                            <th>续期方式</th>
                            <th>检查时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          {certificates
                            .filter((c) => c.account_id === accountId)
                            .map((c, i) => (
                              <tr key={c.id + i}>
                                <td className="record-name">{c.domain}</td>
                                <td>
                                  <Status value={c.status} />
                                </td>
                                <td
                                  className={
                                    days(c.expiresAt) !== null && days(c.expiresAt)! <= 30
                                      ? 'danger-text'
                                      : ''
                                  }
                                >
                                  {time(c.expiresAt)}
                                  {c.expiresAt && <small>剩余 {days(c.expiresAt)} 天</small>}
                                </td>
                                <td>{c.managed ? '由原平台托管' : '需在原平台核对'}</td>
                                <td>{time(c.checked)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    {!certificates.some((c) => c.account_id === accountId) && (
                      <Empty
                        title="还没有证书查询快照"
                        description="选择账号后检查。查询失败与缺少权限会明确提示，不会标记为正常。"
                      />
                    )}
                  </>
                )}
              </section>
            </>
          )}
          {view === 'deploy' && (
            <section className="panel deploy-panel">
              <div className="section-icon">
                <CloudUpload size={28} />
              </div>
              <h2>派发一次部署</h2>
              <p>调用你已有的 GitHub Actions，构建产物由工作流直接发布到目标云平台。</p>
              {!githubEnabled && (
                <div className="callout">
                  此实例尚未配置 GITHUB_TOKEN。添加仅限目标仓库、具有 Actions 写权限的 token
                  后即可使用。
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (confirm(`向 ${repository} 的 ${workflow} 提交 ${branch} 分支部署？`))
                    void run(async () => {
                      const result = await api('/github/dispatch', 'POST', {
                        repository,
                        workflow,
                        ref: branch,
                      });
                      setNotice('部署请求已提交，可在 GitHub Actions 查看执行结果：' + result.url);
                      await refresh();
                    });
                }}
              >
                <label>
                  GitHub 仓库
                  <input
                    placeholder="owner/repository"
                    value={repository}
                    onChange={(e) => setRepository(e.target.value)}
                    required
                  />
                </label>
                <div className="form-grid">
                  <label>
                    工作流文件
                    <input
                      value={workflow}
                      onChange={(e) => setWorkflow(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    分支或标签
                    <input value={branch} onChange={(e) => setBranch(e.target.value)} required />
                  </label>
                </div>
                <button className="primary" disabled={!githubEnabled || busy}>
                  <CloudUpload size={16} />
                  提交部署请求
                </button>
              </form>
              <small>
                工作流需要配置 workflow_dispatch。提交成功表示 GitHub
                已接收请求，不代表构建已经完成。
              </small>
            </section>
          )}
          {view === 'history' && (
            <section className="panel">
              <div className="panel-title">
                <h2>最近 100 次操作</h2>
                <span className="pill">DNS 计划保留旧值</span>
              </div>
              {operations.length ? (
                <OperationList items={operations} onSelect={setDetail} />
              ) : (
                <Empty title="暂无操作记录" description="同步域名或检查服务后会在这里显示。" />
              )}
            </section>
          )}
          {view === 'settings' && (
            <div className="settings-grid">
              <section className="panel">
                <h2>为个人使用而设计</h2>
                <p>
                  一个管理员、多个云账号，不包含团队或审批流程。只读账号不能在后台执行 DNS 写入。
                </p>
                <h3>免费额度优先</h3>
                <p>
                  管理界面使用静态资源；API 与 D1
                  保存少量配置和操作记录。每次定时巡检只处理一个账号，避免大批量请求。
                </p>
                <h3>凭据和登录</h3>
                <p>
                  云凭据由 AES-GCM 加密后保存。管理密钥和加密主密钥位于 Workers
                  Secrets。更换管理密钥会使已有登录失效；更换加密主密钥前须迁移已有凭据。
                </p>
              </section>
              <section className="panel">
                <h2>MVP 的能力范围</h2>
                <p>
                  支持三家 DNS
                  的读取、创建、修改与删除，写入前必须确认差异。邮箱转发、托管服务与证书目前为查询和监控。
                </p>
                <p>
                  域名列表是 DNS 托管区域，不等同于注册商的全部域名资产。资源列表显示 API
                  首批结果；DNS 记录支持逐页查看。
                </p>
                <p>
                  不自动开通付费产品、不自动迁移站点，不生成或保存证书私钥。证书申请、自动部署与复杂迁移流程将逐步接入。
                </p>
                <a
                  className="text-button"
                  href="https://github.com/null-object-0000/newbie-cloud"
                  target="_blank"
                  rel="noreferrer"
                >
                  开源仓库与部署说明
                  <ArrowUpRight size={15} />
                </a>
              </section>
            </div>
          )}
          <footer className="footer">
            <span>
              Newbie Cloud <b>v0.1.0</b>
            </span>
            <span>自己的账号 · 自己的数据 · 自己做主</span>
          </footer>
        </main>
      </div>
      {accountModal !== undefined && (
        <AccountEditor
          existing={accountModal}
          busy={busy}
          onClose={() => setAccountModal(undefined)}
          onSave={(data) =>
            void run(async () => {
              if (accountModal) await api('/accounts/' + accountModal.id, 'PATCH', data);
              else await api('/accounts', 'POST', data);
              setAccountModal(undefined);
              await refresh();
              setNotice('云账号已保存。可手动同步域名或读取服务。');
            })
          }
        />
      )}
      {recordModal !== undefined && selectedZone && (
        <RecordEditor
          existing={recordModal}
          zone={selectedZone}
          provider={selectedAccount!.provider}
          busy={busy}
          onClose={() => setRecordModal(undefined)}
          onSave={(record) =>
            void run(() => plan(recordModal ? 'update' : 'create', record, recordModal?.id))
          }
        />
      )}
      {preview && (
        <Modal title="确认 DNS 变更" wide onClose={() => setPreview(null)}>
          <div className="modal-body">
            <p className="muted">
              {preview.plan.zoneName} · 预览有效至 {time(preview.expiresAt)}
            </p>
            <div className="diff-grid">
              <div>
                <span>变更前</span>
                <pre>
                  {preview.plan.before ? JSON.stringify(preview.plan.before, null, 2) : '尚无记录'}
                </pre>
              </div>
              <div>
                <span>变更后</span>
                <pre>
                  {preview.plan.after ? JSON.stringify(preview.plan.after, null, 2) : '删除此记录'}
                </pre>
              </div>
            </div>
            {preview.plan.protected && (
              <div className="protected-confirm">
                <p>此记录涉及邮箱、DNS 委派或证书验证，请核对依赖后再修改。</p>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={protectedAck}
                    onChange={(e) => setProtectedAck(e.target.checked)}
                  />
                  我已核对相关服务的用途
                </label>
                <label>
                  输入完整域名确认
                  <input
                    placeholder={preview.plan.zoneName}
                    value={confirmDomain}
                    onChange={(e) => setConfirmDomain(e.target.value)}
                  />
                </label>
              </div>
            )}
            <div className="modal-actions">
              <button className="secondary" onClick={() => setPreview(null)}>
                暂不修改
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  (preview.plan.protected &&
                    (!protectedAck || confirmDomain !== preview.plan.zoneName))
                }
                onClick={() =>
                  void run(async () => {
                    await api('/dns/apply/' + preview.id, 'POST', {
                      acknowledgeProtected: protectedAck,
                      confirmDomain,
                    });
                    setPreview(null);
                    await loadRecords();
                    await refresh();
                    setNotice('DNS 变更已由云平台确认。');
                  })
                }
              >
                <Check size={16} />
                确认应用
              </button>
            </div>
          </div>
        </Modal>
      )}
      {detail && (
        <Modal title={detail.summary} wide onClose={() => setDetail(null)}>
          <div className="modal-body">
            <Status value={detail.status} />
            <p className="muted">{time(detail.created_at)}</p>
            <pre className="detail-json">
              {JSON.stringify(
                {
                  ...(detail.payload ? { plan: JSON.parse(detail.payload) } : {}),
                  ...(detail.result ? { result: JSON.parse(detail.result) } : {}),
                },
                null,
                2,
              )}
            </pre>
          </div>
        </Modal>
      )}
    </div>
  );
}
function OperationList({
  items,
  onSelect,
}: {
  items: Operation[];
  onSelect: (o: Operation) => void;
}) {
  return (
    <div className="operation-list">
      {items.map((o) => (
        <button key={o.id} className="operation" onClick={() => onSelect(o)}>
          <span className="operation-icon">
            {o.kind === 'dns' ? (
              <Globe2 size={17} />
            ) : o.kind === 'certificate' ? (
              <ShieldCheck size={17} />
            ) : (
              <History size={17} />
            )}
          </span>
          <div>
            <strong>{o.summary}</strong>
            <small>{time(o.created_at)}</small>
          </div>
          <Status value={o.status} />
          <ChevronRight size={15} />
        </button>
      ))}
    </div>
  );
}
function AccountEditor({
  existing,
  busy,
  onClose,
  onSave,
}: {
  existing: Account | null;
  busy: boolean;
  onClose: () => void;
  onSave: (data: any) => void;
}) {
  const [provider, setProvider] = useState<Provider>(existing?.provider ?? 'cloudflare'),
    [name, setName] = useState(existing?.name ?? ''),
    [readonly, setReadonly] = useState(existing?.readonly ?? true),
    [credentials, setCredentials] = useState<Record<string, string>>({});
  const fields: Record<Provider, [string, string, string][]> = {
    cloudflare: [
      ['apiToken', 'API Token', 'password'],
      ['accountId', 'Account ID（查看托管服务需要）', 'text'],
    ],
    tencent: [
      ['secretId', 'Secret ID', 'password'],
      ['secretKey', 'Secret Key', 'password'],
      ['workspaceId', 'Makers / EdgeOne 工作空间 Zone ID（可选）', 'text'],
    ],
    aliyun: [
      ['accessKeyId', 'AccessKey ID', 'password'],
      ['accessKeySecret', 'AccessKey Secret', 'password'],
      ['esaRegion', 'ESA 地域（可选，默认 cn-hangzhou）', 'text'],
    ],
  };
  return (
    <Modal title={existing ? '编辑云账号' : '连接云账号'} onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          const next = Object.fromEntries(Object.entries(credentials).filter(([, v]) => v.trim()));
          onSave({
            name,
            provider,
            readonly,
            ...(Object.keys(next).length ? { credentials: next } : {}),
          });
        }}
      >
        <label>
          云平台
          <select
            value={provider}
            disabled={!!existing}
            onChange={(e) => {
              setProvider(e.target.value as Provider);
              setCredentials({});
            }}
          >
            {Object.entries(providers).map(([id, p]) => (
              <option value={id} key={id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          账号名称
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：我的个人账号"
            maxLength={80}
            required
          />
        </label>
        {fields[provider].map(([key, label, type]) => (
          <label key={key}>
            {label}
            <input
              type={type}
              autoComplete="off"
              value={credentials[key] ?? ''}
              onChange={(e) => setCredentials((c) => ({ ...c, [key]: e.target.value }))}
              placeholder={existing ? '留空保留已保存的值' : key === 'workspaceId' ? 'zone-…' : ''}
              required={!existing && !['accountId', 'workspaceId', 'esaRegion'].includes(key)}
            />
          </label>
        ))}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={readonly}
            onChange={(e) => setReadonly(e.target.checked)}
          />
          只读连接（建议首次接入保持开启）
        </label>
        <small className="muted">
          保存账号不会自动修改任何云资源。后端加密保存凭据，页面无法读取已保存的明文。
        </small>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            <KeyRound size={16} />
            保存连接
          </button>
        </div>
      </form>
    </Modal>
  );
}
function RecordEditor({
  existing,
  zone,
  provider,
  busy,
  onClose,
  onSave,
}: {
  existing: DnsRecord | null;
  zone: Zone;
  provider: Provider;
  busy: boolean;
  onClose: () => void;
  onSave: (record: RecordInput) => void;
}) {
  const [record, setRecord] = useState<RecordInput>(
    existing ?? { type: 'A', name: '', content: '', ttl: 300 },
  );
  const update = (value: Partial<RecordInput>) => setRecord((r) => ({ ...r, ...value }));
  return (
    <Modal title={existing ? '编辑 DNS 记录' : '添加 DNS 记录'} onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(record);
        }}
      >
        <div className="form-grid">
          <label>
            记录类型
            <select value={record.type} onChange={(e) => update({ type: e.target.value })}>
              {['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            TTL（秒）
            <input
              type="number"
              value={record.ttl}
              onChange={(e) => update({ ttl: Number(e.target.value) })}
              min={provider === 'cloudflare' ? 1 : 60}
              required
            />
          </label>
        </div>
        <label>
          记录名称
          <input
            value={record.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder={'www 或 @（' + zone.name + '）'}
            required
          />
        </label>
        <label>
          记录内容
          <textarea
            rows={3}
            value={record.content}
            onChange={(e) => update({ content: e.target.value })}
            placeholder={record.type === 'A' ? '例如 192.0.2.1' : '请输入记录值'}
            required
          />
        </label>
        {record.type === 'MX' && (
          <label>
            优先级
            <input
              type="number"
              min="0"
              max="65535"
              value={record.priority ?? 0}
              onChange={(e) => update({ priority: Number(e.target.value) })}
            />
          </label>
        )}
        {provider === 'cloudflare' && ['A', 'AAAA', 'CNAME'].includes(record.type) && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={!!record.proxied}
              onChange={(e) => update({ proxied: e.target.checked })}
            />
            开启 Cloudflare 代理（橙云）
          </label>
        )}
        <small className="muted">
          {provider === 'cloudflare' ? 'TTL 为 1 表示自动。' : '保留现有解析线路。'}
          下一步只生成预览，不会立即写入。
        </small>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            预览变更
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
