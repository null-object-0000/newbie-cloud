import { useEffect, useRef, useState } from 'react';
import {
  Folder,
  Plus,
  Upload,
  ExternalLink,
  RefreshCw,
  ArrowLeft,
  RotateCcw,
  KeyRound,
  Trash2,
  X,
  Check,
  Terminal,
} from 'lucide-react';
import type { Account } from '../shared';
import type { Api } from './resources';
import { describe, validateAssets, type Asset } from '../projects/files';
import './projects.css';
import { ExistingSite, ImportSite } from './existing-projects';
import type { LinkedResource, ExistingDetail } from '../projects/types';
export type Project = {
  id: string;
  name: string;
  account_id: string;
  remote_name: string;
  status: string;
  current_release: string | null;
  active_task: string | null;
  error: string | null;
  management?: 'direct' | 'existing';
  provider?: string;
  primaryUrl?: string | null;
  resourceLinks?: LinkedResource[];
};
type Release = {
  id: string;
  kind: string;
  status: string;
  message: string;
  url: string | null;
  verification: string | null;
  verified_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  target_release: string | null;
};
type Detail = { project: Project; url: string; releases: Release[]; linked?: ExistingDetail };
const labels: Record<string, string> = {
  new: '待创建站点',
  provisioning: '创建中',
  ready: '站点就绪',
  uploading: '待上传 / 提交',
  submitting: '正在提交',
  deploying: '部署中',
  success: '部署完成',
  failed: '部署失败',
  review_required: '待核实',
  cancelled: '已取消',
};
const date = (s: string) => new Date(s).toLocaleString('zh-CN', { hour12: false });
const id = () => crypto.randomUUID();
const sample =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的第一个网站</title><style>body{font:18px/1.8 system-ui;max-width:720px;margin:12vh auto;padding:24px;background:#f5f7fb;color:#17243d}h1{font-size:40px}a{color:#245be8}</style><h1>你好，世界 ☁️</h1><p>这是我用 Newbie Cloud 发布的第一个静态网站。</p><p>更新这个文件，就能发布下一个版本。</p></html>';
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal wide" role="dialog" aria-modal="true" aria-label={title}>
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
export function Projects({
  initialProjectId = '',
  onProjectChange,
  onProjectsChange,
  onResources,
  api,
  accounts,
  onConnect,
  onAccounts,
}: {
  initialProjectId?: string;
  onProjectChange?: (id: string) => void;
  onProjectsChange?: (items: Project[]) => void;
  onResources?: () => void;
  api: Api;
  accounts: Account[];
  onConnect: () => void;
  onAccounts: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]),
    [detail, setDetail] = useState<Detail | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [accountId, setAccountId] = useState('');
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<{ file: File; asset: Asset }[]>([]),
    [message, setMessage] = useState(''),
    [rollback, setRollback] = useState<Release | null>(null),
    [resolving, setResolving] = useState<Release | null>(null),
    [confirm, setConfirm] = useState(''),
    [agents, setAgents] = useState(false),
    [tokens, setTokens] = useState<any[]>([]),
    [tokenName, setTokenName] = useState('我的 Agent'),
    [allowRollback, setAllowRollback] = useState(false),
    [token, setToken] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const attempts = useRef(0),
    activeId = useRef<string | null>(null);
  const available = accounts.filter((a) => a.provider === 'cloudflare' && !a.readonly);
  const load = async () => {
    const items = (await api('/projects')).items;
    setProjects(items);
    onProjectsChange?.(items);
  };
  async function open(projectId: string) {
    activeId.current = projectId;
    setDetail(await api('/projects/' + projectId));
    onProjectChange?.(projectId);
    setSelected([]);
    setError('');
    setNotice('');
    setPending(null);
  }
  async function reload() {
    await load();
    if (activeId.current) setDetail(await api('/projects/' + activeId.current));
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(async () => {
      await load();
      if (initialProjectId) await open(initialProjectId);
    });
    return () => {
      activeId.current = null;
    };
  }, []);
  async function checkRelease(rid: string) {
    const pid = activeId.current;
    if (!pid) return;
    const next: Detail = await api('/projects/' + pid + '/releases/' + rid + '/check', 'POST', {});
    if (activeId.current !== pid) return;
    setDetail(next);
    const r = next.releases.find((r) => r.id === rid);
    if (r?.status === 'success' && r.verification === 'production_passed')
      setNotice('部署已完成，访问验证通过。');
    if (
      !r ||
      ['failed', 'cancelled', 'review_required'].includes(r.status) ||
      (r.status === 'success' && ['passed', 'production_passed'].includes(r.verification ?? ''))
    )
      setPending(null);
  }
  useEffect(() => {
    if (!pending || !detail || attempts.current >= 20) return;
    const timer = setTimeout(() => {
      attempts.current++;
      void checkRelease(pending).catch((e) => {
        setError(e.message);
        setPending(null);
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, [pending, detail]);
  async function choose(list: File[], folder = false) {
    setSelected([]);
    if (list.reduce((size, f) => size + f.size, 0) > 10 * 1024 * 1024)
      throw Error('发布总大小不能超过 10 MiB');
    if (list.length > 200) throw Error('一次最多 200 个文件');
    let root = '';
    if (folder && list[0]?.webkitRelativePath)
      root = list[0].webkitRelativePath.split('/')[0] + '/';
    const next = [];
    for (const file of list) {
      const path = folder ? file.webkitRelativePath.slice(root.length) : file.name;
      next.push({ file, asset: await describe(new Uint8Array(await file.arrayBuffer()), path) });
    }
    validateAssets(next.map((x) => x.asset));
    setSelected(next);
    setNotice('文件已检查。确认下方清单后点击发布。');
  }
  async function publish() {
    if (!detail || !selected.length) return;
    const pid = detail.project.id;
    const result = await api('/projects/' + pid + '/releases', 'POST', {
      requestKey: id(),
      message: message || '更新静态网页',
      files: selected.map((x) => x.asset),
    });
    const rid = result.release.id;
    for (let i = 0; i < selected.length; i++) {
      setNotice('上传 ' + (i + 1) + ' / ' + selected.length + '：' + selected[i].asset.path);
      const response = await fetch(
        '/api/projects/' +
          pid +
          '/releases/' +
          rid +
          '/file?path=' +
          encodeURIComponent(selected[i].asset.path),
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: selected[i].file,
        },
      );
      if (!response.ok) {
        const b: any = await response.json();
        throw Error(b.error ?? '上传失败，可重新选择文件发布；尚未切换线上版本');
      }
    }
    const sent = await api('/projects/' + pid + '/releases/' + rid + '/publish', 'POST', {});
    setSelected([]);
    setMessage('');
    setNotice('发布任务已提交，正在查询真实部署结果。');
    await reload();
    attempts.current = 0;
    if (!['failed', 'review_required'].includes(sent.release.status)) setPending(rid);
  }
  const project = detail?.project;
  if (detail?.linked && project)
    return (
      <ExistingSite
        project={project}
        detail={detail.linked}
        api={api}
        accounts={accounts}
        onBack={() => {
          activeId.current = null;
          onProjectChange?.('');
          setDetail(null);
          void run(load);
        }}
        onUpdated={async () => {
          setDetail(await api('/projects/' + project.id));
          await load();
        }}
      />
    );
  return (
    <>
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
      {!detail ? (
        <>
          <p className="project-scope-note">
            新建网站可直接发布到 Cloudflare Pages；已有站点可接管源码、自动部署、域名和资源关联。
            {onResources && (
              <>
                已有的云端网站、Workers 和 EdgeOne 服务，可到
                <button onClick={onResources}>资源 → 站点与函数</button>查看。
              </>
            )}
          </p>
          {!projects.length && (
            <section className="panel project-hero">
              <div>
                <span className="eyebrow">从一个网页开始</span>
                <h2>做好的网页，现在就上线。</h2>
                <p>
                  连接一个 Cloudflare 账号，上传 HTML 或构建目录，获得带 HTTPS
                  的免费托管地址。更新与回滚都在同一个项目里完成。
                </p>
                <div className="project-actions">
                  <button className="secondary" disabled={busy} onClick={() => setImporting(true)}>
                    接管已有站点
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      setCreating(true);
                      setAccountId(available[0]?.id ?? '');
                    }}
                  >
                    <Plus size={18} />
                    {projects.length ? '新建网页项目' : '发布我的第一个网页'}
                  </button>
                  <a
                    className="secondary"
                    href="https://developers.cloudflare.com/pages/platform/limits/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看免费额度
                    <ExternalLink size={15} />
                  </a>
                </div>
              </div>
              <div className="project-steps">
                <span>01　连接一个账号</span>
                <span>02　选择静态文件</span>
                <span>03　发布并验证链接</span>
              </div>
            </section>
          )}
          {!!projects.length && (
            <div className="inventory-toolbar">
              <h2>
                网站列表 <small>（{projects.length}）</small>
              </h2>
              <div className="project-actions" style={{ marginTop: 0 }}>
                <button className="secondary" disabled={busy} onClick={() => setImporting(true)}>
                  接管已有站点
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    setCreating(true);
                    setAccountId(available[0]?.id ?? '');
                  }}
                >
                  <Plus size={17} />
                  新建网站项目
                </button>
                <button className="secondary" disabled={busy} onClick={() => void run(load)}>
                  <RefreshCw size={16} />
                  刷新项目
                </button>
              </div>
            </div>
          )}
          {!!projects.length && (
            <div className="project-grid">
              {projects.map((p) => (
                <button
                  className="panel project-card"
                  key={p.id}
                  onClick={() => void run(() => open(p.id))}
                >
                  <Folder size={25} />
                  <h3>{p.name}</h3>
                  <span className="pill">
                    {p.management === 'existing'
                      ? '已接管 · 原流程部署'
                      : p.current_release
                        ? '已有线上版本'
                        : labels[p.status]}
                  </span>
                  <p>{p.primaryUrl ?? p.remote_name + '.pages.dev'}</p>
                  <small>
                    {accounts.find((a) => a.id === p.account_id)?.name ??
                      p.provider ??
                      'Cloudflare'}{' '}
                    · {p.management === 'existing' ? '已有站点' : '静态网页'}
                  </small>
                  <span className="project-card-link">管理项目 →</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="project-top">
            <button
              className="secondary"
              onClick={() => {
                activeId.current = null;
                onProjectChange?.('');
                setNotice('');
                setError('');
                setDetail(null);
                setPending(null);
                setSelected([]);
                void run(load);
              }}
            >
              <ArrowLeft size={17} />
              全部项目
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setAgents(true);
                  setToken('');
                  setTokens((await api('/projects/' + project!.id + '/tokens')).items);
                })
              }
            >
              <Terminal size={17} />
              连接 Agent
            </button>
          </div>
          <section className="panel project-summary">
            <div>
              <span className="eyebrow">CLOUDFLARE PAGES · 免费静态托管</span>
              <h2>{project!.name}</h2>
              <p>
                {accounts.find((a) => a.id === project!.account_id)?.name} ·{' '}
                {labels[project!.status]}
              </p>
            </div>
            <div>
              <a className="project-live-link" href={detail.url} target="_blank" rel="noreferrer">
                {detail.url}
                <ExternalLink size={17} />
              </a>
              <small>
                {project!.current_release ? '正式地址指向当前版本' : '首次部署成功后可访问'} · HTTPS
                由平台管理
              </small>
            </div>
          </section>
          {project!.error && <p className="local-error">{project!.error}</p>}
          {project!.status !== 'ready' ? (
            <section className="panel project-publish">
              <h3>先准备云端站点</h3>
              <p>只创建本项目的免费 Pages 站点，不修改已有站点或 DNS。</p>
              <div className="project-actions">
                <button
                  className="primary"
                  disabled={busy || project!.status === 'provisioning'}
                  onClick={() =>
                    void run(async () => {
                      setDetail(await api('/projects/' + project!.id + '/provision', 'POST', {}));
                      await load();
                    })
                  }
                >
                  创建云端站点
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setDetail(await api('/projects/' + project!.id + '/reconcile', 'POST', {})),
                    )
                  }
                >
                  核实创建结果
                </button>
              </div>
            </section>
          ) : (
            <section className="panel project-publish">
              <h3>{project!.current_release ? '发布更新' : '选择你的网页'}</h3>
              <p>
                上传已构建的静态文件，根目录需有 index.html。单文件 ≤ 1 MiB，合计 ≤ 10 MiB，最多 200
                个文件；不上传源码、密钥或服务端函数。
              </p>
              <div className="project-actions">
                <label className={'secondary upload-label' + (busy ? ' disabled' : '')}>
                  <Upload size={17} />
                  选择 HTML / 多个文件
                  <input
                    disabled={busy}
                    type="file"
                    multiple
                    aria-label="选择静态文件"
                    onChange={(e) => {
                      const list = Array.from(e.target.files ?? []);
                      e.target.value = '';
                      if (list.length) void run(() => choose(list));
                    }}
                  />
                </label>
                <label className={'secondary upload-label' + (busy ? ' disabled' : '')}>
                  <Folder size={17} />
                  选择构建目录
                  <input
                    disabled={busy}
                    type="file"
                    multiple
                    {...({ webkitdirectory: '', directory: '' } as any)}
                    aria-label="选择构建目录"
                    onChange={(e) => {
                      const list = Array.from(e.target.files ?? []);
                      e.target.value = '';
                      if (list.length) void run(() => choose(list, true));
                    }}
                  />
                </label>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      choose([new File([sample], 'index.html', { type: 'text/html' })]),
                    )
                  }
                >
                  试用示例网页
                </button>
              </div>
              {selected.length > 0 && (
                <div className="project-file-review">
                  <h4>
                    准备发布 {selected.length} 个文件 ·{' '}
                    {(selected.reduce((s, x) => s + x.asset.size, 0) / 1024).toFixed(1)} KiB
                  </h4>
                  <ul>
                    {selected.slice(0, 8).map((x) => (
                      <li key={x.asset.path}>
                        {x.asset.path}
                        <span>{(x.asset.size / 1024).toFixed(1)} KiB</span>
                      </li>
                    ))}
                  </ul>
                  {selected.length > 8 && <small>另有 {selected.length - 8} 个文件</small>}
                  <label>
                    版本说明
                    <input
                      aria-label="版本说明"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      maxLength={200}
                      placeholder="例如：更新个人介绍"
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy || !!project!.active_task}
                    onClick={() => void run(publish)}
                  >
                    <Upload size={17} />
                    {busy ? '正在发布…' : '确认发布到正式地址'}
                  </button>
                </div>
              )}
            </section>
          )}
          <section className="panel project-history">
            <div className="inventory-toolbar">
              <h3>发布记录</h3>
              <span className="muted">保留最近 100 条记录</span>
            </div>
            {project!.active_task && (
              <p className="local-progress">有任务正在处理或等待核实。查询结果不会重复发布。</p>
            )}
            {!detail.releases.length && (
              <p className="muted">发布后，可在这里看部署结果、验证访问和回滚。</p>
            )}
            {detail.releases.map((r) => (
              <article className="project-release" key={r.id}>
                <div>
                  <strong>{r.kind === 'rollback' ? '回滚任务' : r.message}</strong>
                  <span className={r.status === 'success' ? 'pill green' : 'pill'}>
                    {labels[r.status] ?? r.status}
                  </span>
                  {project!.current_release === r.id && (
                    <span className="pill green">当前线上版本</span>
                  )}
                  <small>
                    {date(r.created_at)} · {r.id.slice(0, 8)}
                  </small>
                  {r.error && <p className="local-error">{r.error}</p>}
                  {r.status === 'success' && (
                    <p className="project-verified">
                      {['passed', 'production_passed'].includes(r.verification ?? '') ? (
                        <>
                          <Check size={15} />
                          {r.verification === 'production_passed'
                            ? '访问验证通过，正式地址与上传版本一致'
                            : '版本地址验证通过，首页内容与上传版本一致'}
                        </>
                      ) : (
                        '部署已完成；' +
                        (r.verification === 'pending_production'
                          ? '版本地址验证通过，正式地址传播中，可稍后重新检查'
                          : r.verification === 'mismatch'
                            ? '首页内容校验不一致，请核实平台设置'
                            : '访问尚未验证通过，可稍后重新检查')
                      )}
                      {r.verified_at && <small>{date(r.verified_at)}</small>}
                    </p>
                  )}
                </div>
                <div className="project-actions">
                  {r.url && (
                    <a className="secondary compact" href={r.url} target="_blank" rel="noreferrer">
                      版本地址
                      <ExternalLink size={14} />
                    </a>
                  )}
                  {r.status !== 'uploading' && (
                    <button
                      className="secondary compact"
                      disabled={busy}
                      onClick={() => void run(() => checkRelease(r.id))}
                    >
                      <RefreshCw size={14} />
                      检查结果
                    </button>
                  )}
                  {['review_required', 'submitting'].includes(r.status) && (
                    <button
                      className="secondary compact"
                      disabled={busy || Date.now() - Date.parse(r.updated_at) < 120000}
                      onClick={() => {
                        setResolving(r);
                        setConfirm('');
                      }}
                    >
                      核实后结束任务
                    </button>
                  )}
                  {r.status === 'success' &&
                    r.kind === 'publish' &&
                    r.id !== project!.current_release &&
                    project!.current_release && (
                      <button
                        className="secondary compact"
                        disabled={busy || !!project!.active_task}
                        onClick={() => {
                          setRollback(r);
                          setConfirm('');
                        }}
                      >
                        <RotateCcw size={14} />
                        回滚到此版本
                      </button>
                    )}
                </div>
              </article>
            ))}
          </section>
        </>
      )}
      {importing && (
        <ImportSite
          api={api}
          accounts={accounts}
          onClose={() => setImporting(false)}
          onImported={async (pid) => {
            setImporting(false);
            await api('/projects/' + pid + '/refresh', 'POST', {});
            await load();
            await open(pid);
          }}
        />
      )}
      {creating && (
        <Dialog
          title="创建静态网页项目"
          onClose={() => {
            if (!busy) setCreating(false);
          }}
        >
          <p>第一版使用 Cloudflare Pages，不需要购买域名，也不需要连接其他云平台。</p>
          {!available.length ? (
            <div className="project-onboarding">
              <h3>只需连接一个发布账号</h3>
              <ol>
                <li>在 Cloudflare 获取 Account ID。</li>
                <li>创建仅限该账号的 API Token，授予 Account → Cloudflare Pages → Edit。</li>
                <li>保存连接，发布账号关闭只读。无需 DNS 编辑权限。</li>
              </ol>
              <a
                href="https://dash.cloudflare.com/profile/api-tokens"
                target="_blank"
                rel="noreferrer"
              >
                打开 Cloudflare 创建 Token ↗
              </a>
              <div className="project-actions">
                <button
                  className="primary"
                  onClick={() => {
                    setCreating(false);
                    onConnect();
                  }}
                >
                  连接 Cloudflare
                </button>
                {accounts.some((a) => a.provider === 'cloudflare') && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setCreating(false);
                      onAccounts();
                    }}
                  >
                    编辑现有账号
                  </button>
                )}
              </div>
            </div>
          ) : (
            <form
              className="project-create"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const result = await api('/projects', 'POST', {
                    name,
                    accountId,
                    requestKey: id(),
                  });
                  setCreating(false);
                  setName('');
                  await load();
                  await open(result.project.id);
                  setDetail(await api('/projects/' + result.project.id + '/provision', 'POST', {}));
                });
              }}
            >
              <label>
                项目名称
                <input
                  aria-label="项目名称"
                  autoFocus
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="我的个人主页"
                />
              </label>
              <label>
                发布账号
                <select
                  aria-label="发布账号"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  required
                >
                  {available.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">
                使用免费 Pages 静态托管，不启用函数或付费资源。平台额度与条款仍以你的账号为准。
              </p>
              <button className="primary" disabled={busy}>
                创建项目并准备站点
              </button>
            </form>
          )}
        </Dialog>
      )}
      {resolving && detail && (
        <Dialog
          title="结束结果未知的任务"
          onClose={() => {
            if (!busy) setResolving(null);
          }}
        >
          <p>
            请先到 Cloudflare
            控制台核实：本次发布未创建部署，或回滚未发生。结束后将解锁项目，允许重新发布；不会重复提交旧操作。
          </p>
          <p>
            如果远端操作稍后生效，可能需要再次核对线上版本。输入项目名称「{project!.name}
            」确认已经检查。
          </p>
          <input
            aria-label="确认结束任务的项目名称"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setResolving(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy || confirm !== project!.name}
              onClick={() =>
                void run(async () => {
                  setDetail(
                    await api(
                      '/projects/' + project!.id + '/releases/' + resolving.id + '/resolve',
                      'POST',
                      { confirmName: confirm, confirmRemoteAbsent: true },
                    ),
                  );
                  setResolving(null);
                })
              }
            >
              确认结束并解锁
            </button>
          </div>
        </Dialog>
      )}
      {rollback && detail && (
        <Dialog
          title="确认回滚"
          onClose={() => {
            if (!busy) setRollback(null);
          }}
        >
          <p>
            将正式地址恢复到 {date(rollback.created_at)} 的版本。输入项目名称「{project!.name}
            」确认。
          </p>
          <input
            aria-label="确认回滚项目名称"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setRollback(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy || confirm !== project!.name}
              onClick={() =>
                void run(async () => {
                  const result = await api('/projects/' + project!.id + '/rollback', 'POST', {
                    targetReleaseId: rollback.id,
                    expectedCurrentReleaseId: project!.current_release,
                    requestKey: id(),
                  });
                  setRollback(null);
                  await reload();
                  attempts.current = 0;
                  setPending(result.release.id);
                })
              }
            >
              确认回滚
            </button>
          </div>
        </Dialog>
      )}
      {agents && project && (
        <Dialog
          title="连接 Agent"
          onClose={() => {
            setAgents(false);
            setToken('');
          }}
        >
          <p>
            令牌仅能读取和发布本项目，不能访问其他项目、云密钥、DNS 或服务器。最长有效期 90 天；默认
            30 天。
          </p>
          <form
            className="project-create"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const b = await api('/projects/' + project.id + '/tokens', 'POST', {
                  name: tokenName,
                  allowRollback,
                });
                setToken(b.token);
                setTokens((await api('/projects/' + project.id + '/tokens')).items);
              });
            }}
          >
            <label>
              令牌名称
              <input
                value={tokenName}
                required
                maxLength={80}
                onChange={(e) => setTokenName(e.target.value)}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={allowRollback}
                onChange={(e) => setAllowRollback(e.target.checked)}
              />
              允许回滚本项目
            </label>
            <button className="primary" disabled={busy}>
              <KeyRound size={16} />
              生成项目令牌
            </button>
          </form>
          {token && (
            <div className="project-token">
              <strong>令牌仅显示这一次，请保存到本机环境变量。</strong>
              <textarea aria-label="新 Agent Token" readOnly value={token} />
              <button
                className="secondary"
                onClick={() =>
                  void navigator.clipboard.writeText(token).then(() => setNotice('已复制项目令牌'))
                }
              >
                复制令牌
              </button>
            </div>
          )}
          <p>
            CLI / MCP 使用 <code>NEWBIE_CLOUD_URL</code> 和 <code>NEWBIE_CLOUD_TOKEN</code>{' '}
            环境变量。项目 ID：<code>{project.id}</code>
          </p>
          <a
            href="https://github.com/null-object-0000/newbie-cloud/blob/main/docs/publishing.md"
            target="_blank"
            rel="noreferrer"
          >
            查看 CLI / MCP 配置与操作示例 ↗
          </a>
          {tokens.map((t) => (
            <div className="project-agent" key={t.id}>
              <span>
                {t.name} · {t.revoked ? '已撤销' : '有效至 ' + date(t.expires_at)}
              </span>
              <button
                className="icon-button"
                aria-label={'撤销令牌 ' + t.name}
                disabled={busy || !!t.revoked}
                onClick={() =>
                  void run(async () => {
                    await api('/projects/' + project.id + '/tokens/' + t.id, 'DELETE');
                    setTokens((await api('/projects/' + project.id + '/tokens')).items);
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </Dialog>
      )}
    </>
  );
}
