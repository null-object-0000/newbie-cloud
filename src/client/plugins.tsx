import { useEffect, useState } from 'react';
import {
  Package,
  Download,
  RefreshCw,
  Settings,
  Trash2,
  X,
  ExternalLink,
  Search,
} from 'lucide-react';
import type { PluginStatus, PluginResource, PluginManifest } from '../plugins/types';
import type { Api } from './resources';
import './plugins.css';
type Preview = {
  id: string;
  manifest: PluginManifest;
  resolvedSource: string;
  integrity: string;
  reason: string | null;
  previousVersion: string | null;
};
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
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
function sourceLink(source: string) {
  if (source.startsWith('github:')) {
    const v = source.slice(7),
      at = v.lastIndexOf('@');
    return 'https://github.com/' + v.slice(0, at) + '/tree/' + v.slice(at + 1);
  }
  const v = source.slice(4),
    at = v.lastIndexOf('@');
  return 'https://www.npmjs.com/package/' + v.slice(0, at) + '/v/' + v.slice(at + 1);
}
export function PluginCenter({
  api,
  onChanged,
  onResources,
  onAccounts,
}: {
  api: Api;
  onChanged: () => Promise<void>;
  onResources: (id: string) => void;
  onAccounts: () => void;
}) {
  const [items, setItems] = useState<PluginStatus[]>([]),
    [source, setSource] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [filter, setFilter] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null),
    [accept, setAccept] = useState(false),
    [trust, setTrust] = useState(false);
  const [editing, setEditing] = useState<PluginStatus | null>(null),
    [values, setValues] = useState<Record<string, string>>({}),
    [saved, setSaved] = useState<string[]>([]);
  const load = async () => setItems((await api('/plugins')).items);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '插件操作未完成');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(load);
  }, []);
  async function inspect(value = source) {
    const result = await api('/plugins/preview', 'POST', { source: value });
    setPreview(result);
    setAccept(false);
    setTrust(false);
  }
  async function changed() {
    await load();
    await onChanged();
  }
  return (
    <>
      <section className="panel plugin-install-panel">
        <div>
          <span className="service-icon">
            <Package size={24} />
          </span>
          <h2>按需安装与启用能力</h2>
          <p>
            内置插件开箱可用，第三方插件从公开 GitHub / npm
            安装。先预览固定版本与网络声明，再确认安装。
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => inspect());
          }}
        >
          <label>
            GitHub 仓库或 npm 包
            <input
              aria-label="插件来源"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="github:owner/repo@main 或 npm:@scope/plugin@1.0.0"
              required
              maxLength={400}
            />
          </label>
          <button className="primary" disabled={busy}>
            <Download size={16} />
            检查插件
          </button>
        </form>
        <small>
          声明式资源插件可在免费 Workers
          中运行；代码插件需要自托管环境开启可信代码支持。插件只获取你为它单独填写的配置。
        </small>
      </section>
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
      <div className="inventory-toolbar">
        <div className="search">
          <Search size={17} />
          <input
            aria-label="搜索插件"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索能力、插件名称或 ID"
          />
        </div>
        <button className="secondary" disabled={busy} onClick={() => void run(load)}>
          <RefreshCw size={16} />
          刷新清单
        </button>
      </div>
      <div className="plugin-cards">
        {items
          .filter((p) =>
            (p.manifest.name + ' ' + p.manifest.description + ' ' + p.manifest.id)
              .toLowerCase()
              .includes(filter.toLowerCase()),
          )
          .map((p) => (
            <section className="panel plugin-card" key={p.manifest.id}>
              <div className="plugin-card-title">
                <span className="service-icon">
                  <Package size={21} />
                </span>
                <div>
                  <h2>{p.manifest.name}</h2>
                  <small>
                    {p.manifest.id} · {p.manifest.version}
                  </small>
                </div>
                <span className="pill">
                  {p.builtin ? '内置' : p.manifest.kind === 'node' ? '代码插件' : '声明式插件'}
                </span>
              </div>
              <p>{p.manifest.description}</p>
              {p.reason && <p className="plugin-reason">{p.reason}</p>}
              {p.resolvedSource && (
                <a
                  className="plugin-source"
                  href={sourceLink(p.resolvedSource)}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看固定来源
                  <ExternalLink size={13} />
                </a>
              )}
              <div className="plugin-card-actions">
                <span className={p.enabled && p.available ? 'pill green' : 'pill'}>
                  {!p.available ? '当前不可运行' : p.enabled ? '已启用' : '已停用'}
                </span>
                <button
                  className="secondary compact"
                  disabled={busy || (!p.available && !p.enabled)}
                  onClick={() =>
                    void run(async () => {
                      await api('/plugins/' + p.manifest.id, 'PATCH', { enabled: !p.enabled });
                      await changed();
                      setNotice(
                        (p.enabled ? '已停用：' : '已启用：') +
                          p.manifest.name +
                          '。已有账号与资源快照保留。',
                      );
                    })
                  }
                >
                  {p.enabled ? '停用' : '启用'}
                </button>
                {p.builtin && ['cloudflare', 'tencent', 'aliyun'].includes(p.manifest.id) && (
                  <button className="secondary compact" onClick={onAccounts}>
                    连接账号
                  </button>
                )}
                {!p.builtin && (
                  <>
                    <button
                      className="icon-button"
                      title="配置插件"
                      aria-label={'配置 ' + p.manifest.name}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const c = await api('/plugins/' + p.manifest.id + '/config');
                          setValues(c.values);
                          setSaved(c.savedSecrets);
                          setEditing(p);
                        })
                      }
                    >
                      <Settings size={17} />
                    </button>
                    <button
                      className="icon-button"
                      title="检查更新"
                      aria-label={'检查更新 ' + p.manifest.name}
                      disabled={busy}
                      onClick={() => void run(() => inspect(p.source))}
                    >
                      <RefreshCw size={17} />
                    </button>
                    <button
                      className="icon-button danger"
                      title="卸载插件"
                      aria-label={'卸载 ' + p.manifest.name}
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            '卸载 ' + p.manifest.name + ' 并删除它的配置？云账号和云资源不受影响。',
                          )
                        )
                          void run(async () => {
                            await api('/plugins/' + p.manifest.id, 'DELETE');
                            await changed();
                          });
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                    <button
                      className="secondary compact"
                      disabled={!p.enabled || !p.available}
                      onClick={() => onResources(p.manifest.id)}
                    >
                      查看资源
                    </button>
                  </>
                )}
              </div>
            </section>
          ))}
      </div>
      {preview && (
        <Modal
          title="确认安装插件"
          onClose={() => {
            if (!busy) setPreview(null);
          }}
        >
          <h3>
            {preview.manifest.name} · {preview.manifest.version}
          </h3>
          <p>{preview.manifest.description}</p>
          <p className="muted">
            {preview.previousVersion
              ? '将替换版本 ' + preview.previousVersion + '；更新后需重新启用。'
              : '安装后默认停用，完成配置后再启用。'}
          </p>
          <dl className="plugin-preview">
            <dt>固定来源</dt>
            <dd>
              <a href={sourceLink(preview.resolvedSource)} target="_blank" rel="noreferrer">
                {preview.resolvedSource}
              </a>
            </dd>
            <dt>包指纹</dt>
            <dd>{preview.integrity}</dd>
            <dt>声明的网络主机</dt>
            <dd>{preview.manifest.permissions.network.join('、') || '无'}</dd>
            <dt>配置字段</dt>
            <dd>
              {preview.manifest.config
                .map((f) => f.label + (f.secret ? '（加密字段）' : ''))
                .join('、') || '无需配置'}
            </dd>
          </dl>
          {preview.reason && <p className="local-error">{preview.reason}</p>}
          <label className="checkbox">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
            我已核对固定来源和网络声明，同意安装此版本
          </label>
          {preview.manifest.kind === 'node' && (
            <>
              <p className="plugin-reason">
                代码插件在自托管服务器上运行。子进程限制不是恶意代码沙箱，代码仍可能使用运行用户的系统与网络能力；只安装你信任的来源。
              </p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={trust}
                  onChange={(e) => setTrust(e.target.checked)}
                />
                我信任此代码来源，并了解运行权限
              </label>
            </>
          )}
          <div className="modal-actions">
            <button className="secondary" disabled={busy} onClick={() => setPreview(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !accept ||
                (preview.manifest.kind === 'node' && !trust) ||
                (preview.manifest.kind === 'node' &&
                  preview.reason?.includes('需要 Docker') === true)
              }
              onClick={() =>
                void run(async () => {
                  const result = await api('/plugins/install', 'POST', {
                    previewId: preview.id,
                    acceptPermissions: accept,
                    trustCode: trust,
                  });
                  setPreview(null);
                  await changed();
                  setNotice('插件已安装。请按需配置并启用。');
                  setSource('');
                })
              }
            >
              确认安装
            </button>
          </div>
        </Modal>
      )}
      {editing && (
        <Modal title={'配置 ' + editing.manifest.name} onClose={() => setEditing(null)}>
          <form
            className="plugin-config"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api('/plugins/' + editing.manifest.id + '/config', 'POST', { values });
                setEditing(null);
                await changed();
                setNotice('插件配置已加密保存。');
              });
            }}
          >
            {editing.manifest.config.length ? (
              editing.manifest.config.map((f) => (
                <label key={f.key}>
                  {f.label}
                  {f.required ? ' *' : ''}
                  <input
                    type={f.secret ? 'password' : 'text'}
                    value={values[f.key] ?? ''}
                    autoComplete="off"
                    placeholder={
                      f.secret && saved.includes(f.key) ? '已保存，留空保留原值' : (f.default ?? '')
                    }
                    required={f.required && !(f.secret && saved.includes(f.key))}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  />
                </label>
              ))
            ) : (
              <p className="muted">此插件无需额外配置。</p>
            )}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                保存配置
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function PluginResources({ plugin, api }: { plugin: PluginStatus; api: Api }) {
  const [items, setItems] = useState<PluginResource[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [checked, setChecked] = useState('');
  const filtered = items.filter((r) =>
      JSON.stringify(r).toLowerCase().includes(query.toLowerCase()),
    ),
    pages = Math.max(1, Math.ceil(filtered.length / 25)),
    current = Math.min(page, pages);
  async function collect() {
    setBusy(true);
    setError('');
    try {
      const result = await api('/plugins/' + plugin.manifest.id + '/resources', 'POST', {});
      setItems(result.items);
      setChecked(result.checkedAt);
      setPage(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="inventory-toolbar">
        <div className="search">
          <Search size={17} />
          <input
            aria-label="搜索插件资源"
            placeholder="搜索此插件的全部资源"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <button className="primary" disabled={busy} onClick={() => void collect()}>
          <RefreshCw size={16} />
          读取资源
        </button>
      </div>
      <p className="inventory-note">
        {plugin.manifest.description} · {filtered.length} 项
        {checked ? ' · 查询于 ' + new Date(checked).toLocaleString() : ''}
        。结果仅在当前页面展示，不进入离线缓存。
      </p>
      {error && <p className="local-error">{error}</p>}
      <section className="panel">
        <div className="table-scroll">
          <table className="resource-table">
            <thead>
              <tr>
                <th>资源</th>
                <th>类型 / 状态</th>
                <th>域名 / 地域</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice((current - 1) * 25, current * 25).map((r) => (
                <tr key={r.id}>
                  <td className="record-name">
                    {r.name}
                    <small>{r.id}</small>
                  </td>
                  <td>
                    {r.type}
                    <small>{r.status}</small>
                  </td>
                  <td>
                    {r.domain || '—'}
                    <small>{r.region}</small>
                  </td>
                  <td>
                    {r.detail}
                    {r.url && (
                      <a
                        className="icon-button"
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={'打开 ' + r.name}
                      >
                        <ExternalLink size={17} />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!items.length && <div className="inventory-empty">点击“读取资源”运行已启用的插件。</div>}
        <div className="table-footer">
          <span>
            第 {current} / {pages} 页
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
  );
}
