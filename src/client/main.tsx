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
  Package,
  Folder as FolderIcon,
  Layers3,
} from 'lucide-react';
import type { Account, Zone, DnsRecord, RecordInput, Provider, Operation, Plan } from '../shared';
import './style.css';
import './inventory.css';
import { AppearancePicker } from './appearance';
import { PwaInstall, PwaProvider } from './pwa';
import { DomainExplorer, ResourceExplorer, syncResources, type Category } from './resources';
import { CloudServers, Containers } from './servers';
import { PluginCenter, PluginResources } from './plugins';
import { Projects } from './projects';
import {
  sectionFor,
  sectionLabels,
  resourceGroups,
  resourceGroup,
  type View,
  type Section,
} from './navigation';
import './navigation.css';
import { viewPlugins } from '../plugins/catalog';
import type { PluginStatus } from '../plugins/types';
import { domainInventory, dnsState, resourceRows } from '../inventory';
import type { DnsObservation, ResourceSnapshot, LocalCapabilities } from '../shared';

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
  window.dispatchEvent(
    new CustomEvent('newbie-cloud-network', { detail: { offline: result.offline === true } }),
  );
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
type Snapshot = ResourceSnapshot;
const navigation: [View, string, typeof Cloud][] = [
  ['projects', '我的项目', FolderIcon],
  ['overview', '资源总览', LayoutDashboard],
  ['accounts', '云账号', Cloud],
  ['dns', '域名总览', Globe2],
  ['records', 'DNS 记录', Search],
  ['services', '站点与函数', Server],
  ['email', '邮箱转发', Mail],
  ['certificates', 'HTTPS 证书', ShieldCheck],
  ['deploy', '已有工作流', CloudUpload],
  ['servers', '服务器', Server],
  ['containers', '本机容器', Server],
  ['history', '操作记录', History],
  ['plugins', '插件中心', Package],
  ['extensions', '扩展资源', Package],
  ['settings', '使用说明', Settings],
];
function App() {
  const [sectionViews, setSectionViews] = useState<Record<Section, View>>({
    projects: 'projects',
    resources: 'overview',
    activity: 'history',
    settings: 'accounts',
  });
  const [managedProjects, setManagedProjects] = useState<
      { id: string; account_id: string; remote_name: string }[]
    >([]),
    [focusedProject, setFocusedProject] = useState('');
  const [activePlugins, setActivePlugins] = useState<string[] | null>(null),
    [pluginStatuses, setPluginStatuses] = useState<PluginStatus[]>([]),
    [resourcePlugin, setResourcePlugin] = useState('');
  const [localCapabilities, setLocalCapabilities] = useState<LocalCapabilities | null>(null);
  const [auth, setAuth] = useState<boolean | null>(null),
    [configured, setConfigured] = useState(true),
    [token, setToken] = useState('');
  const [view, setView] = useState<View>('projects'),
    [accounts, setAccounts] = useState<Account[]>([]),
    [zones, setZones] = useState<Zone[]>([]),
    [operations, setOperations] = useState<Operation[]>([]),
    [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState('');
  const [observations, setObservations] = useState<DnsObservation[]>([]);
  const [dnsDetail, setDnsDetail] = useState(false),
    [resourceDomain, setResourceDomain] = useState('');
  const [zoneId, setZoneId] = useState(''),
    [records, setRecords] = useState<DnsRecord[]>([]),
    [recordPage, setRecordPage] = useState(1),
    [nextPage, setNextPage] = useState<number | null>(null);
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
    selectedAccount = accounts.find((a) => a.id === selectedZone?.accountId);
  async function refresh() {
    const [a, z, o, s, dns, me, plugins, projectList] = await Promise.all([
      api('/accounts'),
      api('/zones'),
      api('/operations'),
      api('/snapshots'),
      api('/dns-observations'),
      api('/me'),
      api('/plugins'),
      api('/projects'),
    ]);
    setAccounts(a.items);
    setZones(z.items);
    setOperations(o.items);
    setSnapshots(s.items);
    setObservations(dns.items);
    setActivePlugins(me.features.plugins ?? null);
    setPluginStatuses(plugins.items);
    setGithubEnabled(me.features.githubDeploy);
    setLocalCapabilities(me.features.local ?? null);
    setManagedProjects(projectList.items ?? []);
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
        setLocalCapabilities(me.features.local ?? null);
        setAuth(true);
        await refresh();
      } catch {
        setAuth(false);
      }
    })();
  }, []);
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
    if (view === 'dns' && dnsDetail) void run(loadRecords);
  }, [auth, view, zoneId, recordPage, dnsDetail]);
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
    if (viewPlugins[v] && activePlugins && !activePlugins.includes(viewPlugins[v])) {
      setNotice('请先在插件中心启用此能力。');
      return;
    }
    setView(v);
    setSectionViews((previous) => ({ ...previous, [sectionFor(v)]: v }));
    setDnsDetail(false);
    setResourceDomain('');
    setQuery('');
    setError('');
    setNotice('');
  };
  const section = sectionFor(view),
    currentGroup = resourceGroup(view);
  const enabledView = (v: View) =>
    (v !== 'plugin-resource' ||
      pluginStatuses.some((p) => p.manifest.id === resourcePlugin && p.enabled && p.available)) &&
    (v !== 'containers' || !!localCapabilities) &&
    (!viewPlugins[v] || !activePlugins || activePlugins.includes(viewPlugins[v]));
  const chooseSection = (s: Section) => {
    let target = sectionViews[s];
    if (!enabledView(target))
      target = s === 'resources' ? 'overview' : s === 'projects' ? 'projects' : 'accounts';
    nav(target);
  };
  const openManagedProject = (id: string) => {
    setFocusedProject(id);
    nav('projects');
  };
  const certificates = resourceRows(snapshots, 'certificates');
  const domains = domainInventory(zones, snapshots);
  const selectedDnsState = selectedZone
    ? dnsState(selectedZone, accounts, observations)
    : 'unverified';
  const dnsBlocked = selectedDnsState === 'other';
  const openZone = (id: string) => {
    if (activePlugins && !activePlugins.includes('dns')) {
      setNotice('请先在插件中心启用 DNS 管理。');
      return;
    }
    chooseZone(id);
    setView('dns');
    setDnsDetail(true);
    setError('');
    setNotice('');
  };
  const openResources = (
    category: 'services' | 'certificates' | 'email' | 'records',
    name: string,
  ) => {
    nav(category);
    setResourceDomain(name);
  };
  async function syncAllResources(category: Category) {
    const result = await syncResources(accounts, zones, category, api, setNotice);
    await refresh();
    setNotice(
      `已读取 ${result.count} 项资源${result.issues.length ? `；${result.issues.length} 个来源失败，详见来源提示` : '，所有来源已完成'}。`,
    );
  }
  async function syncAllDomains() {
    let failures = 0;
    for (const a of accounts) {
      try {
        setNotice('同步 DNS 区域：' + a.name);
        await sync(a.id);
      } catch {
        failures++;
      }
    }
    const registrations = await syncResources(accounts, zones, 'registrations', api, setNotice);
    failures += registrations.issues.length;
    const [z, s] = await Promise.all([api('/zones'), api('/snapshots')]);
    const all = domainInventory(z.items, s.items);
    for (const d of all) {
      setNotice('核实公共 NS：' + d.name);
      try {
        const result = await api('/dns-observations', 'POST', { name: d.name });
        if (result.error) failures++;
      } catch {
        failures++;
      }
    }
    await refresh();
    setNotice(
      `已归并 ${all.length} 个域名${failures ? `；${failures} 个来源或查询未完成，请查看提示` : '，注册与 DNS 来源已核实'}。`,
    );
  }
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
          <div className="login-appearance">
            <PwaInstall />
            <AppearancePicker />
          </div>
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
                  setLocalCapabilities(me.features.local ?? null);
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
        <nav aria-label="主导航">
          {(
            [
              ['projects', FolderIcon],
              ['resources', Layers3],
              ['activity', History],
              ['settings', Settings],
            ] as [Section, typeof Cloud][]
          ).map(([id, Icon]) => (
            <button
              key={id}
              aria-label={sectionLabels[id]}
              aria-current={section === id ? 'page' : undefined}
              title={sectionLabels[id]}
              className={section === id ? 'active' : ''}
              onClick={() => chooseSection(id)}
            >
              <Icon size={19} />
              {sectionLabels[id]}
            </button>
          ))}
        </nav>
        <p className="section-hint">
          发布与维护项目，
          <br />
          按需查看底层资源。
        </p>
        <div className="sidebar-bottom">
          <div className="free-note">
            <span className="green-dot" />
            免费额度优先<small>无需常驻服务器</small>
          </div>
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
            <span className="breadcrumb">{sectionLabels[section]}</span>
            <ChevronRight size={14} />
            <strong>
              {view === 'plugin-resource'
                ? pluginStatuses.find((p) => p.manifest.id === resourcePlugin)?.manifest.name
                : (navigation.find((n) => n[0] === view)?.[1] ?? '使用说明')}
            </strong>
          </div>
          <div className="topbar-actions">
            <PwaInstall />
            <AppearancePicker />
            <span className="owner">
              <span>N</span>个人空间
            </span>
          </div>
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
          {section !== 'activity' && (
            <nav className="section-navigation" aria-label="分区导航">
              {(section === 'resources'
                ? resourceGroups
                    .filter((g) => g.views.some(enabledView))
                    .map((g) => ({
                      id: g.id,
                      label: g.label,
                      selected: currentGroup?.id === g.id,
                      target: g.views.find(enabledView)!,
                    }))
                : section === 'projects'
                  ? (['projects', 'deploy'] as View[]).filter(enabledView).map((v) => ({
                      id: v,
                      label: v === 'projects' ? '网站项目' : '已有工作流',
                      selected: view === v,
                      target: v,
                    }))
                  : section === 'settings'
                    ? (['accounts', 'plugins', 'settings'] as View[]).map((v) => ({
                        id: v,
                        label: navigation.find((n) => n[0] === v)![1],
                        selected: view === v,
                        target: v,
                      }))
                    : []
              ).map((tab) => (
                <button
                  key={tab.id}
                  aria-current={tab.selected ? 'page' : undefined}
                  onClick={() => nav(tab.target)}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          )}
          {section === 'resources' && ['domains', 'compute'].includes(currentGroup?.id ?? '') && (
            <nav className="resource-subnavigation" aria-label="资源分类">
              {currentGroup!.views.filter(enabledView).map((v) => (
                <button
                  key={v}
                  aria-current={view === v ? 'page' : undefined}
                  onClick={() => nav(v)}
                >
                  {navigation.find((n) => n[0] === v)![1]}
                </button>
              ))}
            </nav>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">NEWBIE CLOUD / {sectionLabels[section]}</div>
              <h1>
                {view === 'overview'
                  ? '资源总览'
                  : view === 'plugin-resource'
                    ? pluginStatuses.find((p) => p.manifest.id === resourcePlugin)?.manifest.name
                    : (navigation.find((n) => n[0] === view)?.[1] ?? '使用说明')}
              </h1>
              <p>
                {
                  {
                    projects: '管理在这里创建的网站：发布、更新、验证与回滚。',
                    overview: '汇总所有已连接账号的资产，保留注册商、DNS 和托管平台各自的来源。',
                    accounts: '连接自己的云账号，按实际权限管理资源。',
                    dns: '按域名统一查看注册、DNS 和关联资源；同名域名自动归并。',
                    records: '全部账号的 DNS 记录，保留每条记录的来源和生效情况。',
                    services: '查看各个平台上的站点与边缘托管服务。',
                    email: '查看 Cloudflare 的邮箱转发规则，现有配置保持不变。',
                    certificates: '记录平台证书状态，及时发现即将到期的证书。',
                    deploy: '运行已配置好的 GitHub Actions；执行结果在 GitHub 查看。',
                    servers: '汇总阿里云 ECS、腾讯云 CVM；自托管版还可查看部署主机。',
                    containers: '查看本机 Docker 容器、日志和资源用量，按需确认启停操作。',
                    plugins: '配置工作台能力与第三方插件。插件返回的资源统一在资源区查看。',
                    extensions: '查看已安装插件提供的资源；插件安装与启停在设置中管理。',
                    'plugin-resource': '通过已启用的扩展查看资源。',
                    history: '每一次连接、检查和变更，都有迹可循。',
                    settings: '轻量、单用户、免费额度优先。',
                  }[view]
                }
              </p>
            </div>
            <div className="heading-actions">
              {busy && <LoaderCircle size={19} className="spin" />}
              {!['projects', 'extensions', 'plugin-resource', 'plugins', 'settings'].includes(
                view,
              ) && (
                <button className="secondary" disabled={busy} onClick={() => void run(refresh)}>
                  <RefreshCw size={16} />
                  刷新
                </button>
              )}
              {view === 'accounts' && (
                <button className="primary" onClick={() => setAccountModal(null)}>
                  <Plus size={17} />
                  添加云账号
                </button>
              )}
            </div>
          </div>
          {view === 'projects' && (
            <Projects
              api={api}
              accounts={accounts}
              initialProjectId={focusedProject}
              onProjectChange={setFocusedProject}
              onProjectsChange={setManagedProjects}
              onResources={() => nav('services')}
              onConnect={() => setAccountModal(null)}
              onAccounts={() => nav('accounts')}
            />
          )}
          {view === 'overview' && (
            <>
              <section className="stats">
                {[
                  [Cloud, '已连接账号', accounts.length, '统一查看，独立授权'],
                  [Globe2, '已同步域名', domains.length, `${zones.length} 份 DNS 配置，按域名去重`],
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
                              {zones.filter((z) => z.accountId === a.id).length} 份 DNS 配置
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
                  <p>{zones.filter((z) => z.accountId === a.id).length} 份已同步 DNS 配置</p>
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
          {view === 'dns' && !dnsDetail && (
            <DomainExplorer
              accounts={accounts}
              zones={zones}
              snapshots={snapshots}
              observations={observations}
              busy={busy}
              onOpenZone={openZone}
              onSync={() => void run(syncAllDomains)}
              onResources={openResources}
            />
          )}
          {view === 'dns' && dnsDetail && (
            <>
              <div className="domain-detail-heading">
                <button className="secondary" onClick={() => setDnsDetail(false)}>
                  返回全部域名
                </button>
                <p>
                  {selectedZone?.name} ·{' '}
                  {selectedDnsState === 'current'
                    ? '当前 NS 对应平台'
                    : dnsBlocked
                      ? '配置副本 · 非当前 DNS，仅供查看'
                      : 'NS 尚未核实，请先在域名总览同步检查'}
                </p>
              </div>
              <div className="toolbar">
                <label className="select-label">
                  DNS 配置来源
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
                      disabled={!selectedZone || selectedAccount?.readonly || dnsBlocked || busy}
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
              ) : (
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
                                      dnsBlocked ||
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
                                    disabled={selectedAccount?.readonly || dnsBlocked || busy}
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
              )}
            </>
          )}
          {(['services', 'certificates', 'email', 'records'] as string[]).includes(view) && (
            <ResourceExplorer
              key={view}
              accounts={accounts}
              zones={zones}
              snapshots={snapshots}
              observations={observations}
              busy={busy}
              managedProjects={managedProjects}
              onOpenProject={openManagedProject}
              onOpenZone={openZone}
              category={view as 'services' | 'certificates' | 'email' | 'records'}
              onSync={() => void run(() => syncAllResources(view as Category))}
              domainFilter={resourceDomain}
              setDomainFilter={setResourceDomain}
            />
          )}
          {view === 'plugins' && (
            <PluginCenter
              api={api}
              onChanged={refresh}
              onAccounts={() => nav('accounts')}
              onResources={(id) => {
                setResourcePlugin(id);
                nav('plugin-resource');
              }}
            />
          )}
          {view === 'extensions' && (
            <>
              <div className="navigation-context">
                <p>第三方插件提供的资源集中在这里。安装、配置与启停在设置中完成。</p>
                <button className="secondary" onClick={() => nav('plugins')}>
                  管理插件
                </button>
              </div>
              {!pluginStatuses.some((p) => !p.builtin) ? (
                <Empty
                  title="还没有扩展资源"
                  description="安装资源插件后，就能在这里查看它提供的资产。"
                  action={
                    <button className="secondary" onClick={() => nav('plugins')}>
                      前往插件中心
                    </button>
                  }
                />
              ) : (
                <div className="extension-resource-grid">
                  {pluginStatuses
                    .filter((p) => !p.builtin)
                    .map((p) => (
                      <section className="panel extension-resource-card" key={p.manifest.id}>
                        <Package size={23} />
                        <h2>{p.manifest.name}</h2>
                        <p>{p.manifest.description}</p>
                        <p>
                          {p.reason ?? (p.enabled ? '插件已启用' : '插件已停用，请到设置中启用。')}
                        </p>
                        <button
                          className="secondary"
                          disabled={!p.enabled || !p.available}
                          onClick={() => {
                            setResourcePlugin(p.manifest.id);
                            nav('plugin-resource');
                          }}
                        >
                          查看资源
                        </button>
                      </section>
                    ))}
                </div>
              )}
            </>
          )}
          {view === 'plugin-resource' && (
            <div className="navigation-context">
              <p>当前查看插件提供的资源。</p>
              <button className="secondary" onClick={() => nav('extensions')}>
                返回扩展资源
              </button>
              <button className="secondary" onClick={() => nav('plugins')}>
                插件设置
              </button>
            </div>
          )}
          {view === 'plugin-resource' &&
            pluginStatuses.find((p) => p.manifest.id === resourcePlugin) && (
              <PluginResources
                key={resourcePlugin}
                plugin={pluginStatuses.find((p) => p.manifest.id === resourcePlugin)!}
                api={api}
              />
            )}
          {view === 'servers' && (
            <CloudServers
              accounts={accounts}
              snapshots={snapshots}
              api={api}
              onRefresh={refresh}
              local={!activePlugins || activePlugins.includes('host') ? localCapabilities : null}
            />
          )}
          {view === 'containers' && localCapabilities && (
            <Containers api={api} capabilities={localCapabilities} onChanged={refresh} />
          )}
          {view === 'deploy' && (
            <section className="panel deploy-panel">
              <div className="section-icon">
                <CloudUpload size={28} />
              </div>
              <h2>运行已有 GitHub 工作流</h2>
              <p>
                适用于已经配置 workflow_dispatch
                的仓库。这里仅提交运行请求，不创建网站项目，也不提供该工作流的部署状态或回滚。
              </p>
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
                  运行工作流
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
                  项目区管理通过本平台创建的网站及其发布历史；资源区汇总全部云账号的现有资产。域名按注册商、DNS
                  和关联服务归并，保留来源与同步状态，不会按名称猜测项目归属。
                </p>
                <p>
                  静态项目支持 Cloudflare Pages 发布、更新、验证与回滚。已有 GitHub
                  工作流入口只派发请求，不代表部署完成。不会自动购买产品、迁移现有站点或生成证书私钥。
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
          publishing={view === 'projects' && !accountModal}
          existing={accountModal}
          busy={busy}
          onClose={() => setAccountModal(undefined)}
          onSave={(data) =>
            void run(async () => {
              if (accountModal) await api('/accounts/' + accountModal.id, 'PATCH', data);
              else await api('/accounts', 'POST', data);
              setAccountModal(undefined);
              await refresh();
              setNotice(
                view === 'projects'
                  ? '发布账号已保存。现在可以创建网页项目。'
                  : '云账号已保存。可手动同步域名或读取服务。',
              );
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
  publishing = false,
  existing,
  busy,
  onClose,
  onSave,
}: {
  publishing?: boolean;
  existing: Account | null;
  busy: boolean;
  onClose: () => void;
  onSave: (data: any) => void;
}) {
  const [provider, setProvider] = useState<Provider>(existing?.provider ?? 'cloudflare'),
    [name, setName] = useState(existing?.name ?? ''),
    [readonly, setReadonly] = useState(existing?.readonly ?? !publishing),
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
            {Object.entries(providers)
              .filter(([id]) => !publishing || id === 'cloudflare')
              .map(([id, p]) => (
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
              required={
                !existing &&
                (!['accountId', 'workspaceId', 'esaRegion'].includes(key) ||
                  (publishing && key === 'accountId'))
              }
            />
          </label>
        ))}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={readonly}
            onChange={(e) => setReadonly(e.target.checked)}
          />
          {publishing
            ? '只读连接（发布网页需要关闭；Token 只需 Pages Edit）'
            : '只读连接（建议首次接入保持开启）'}
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
createRoot(document.getElementById('root')!).render(
  <PwaProvider>
    <App />
  </PwaProvider>,
);
