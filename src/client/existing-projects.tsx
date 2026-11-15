import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  RefreshCw,
  GitBranch,
  Globe2,
  Server,
  X,
  Link as LinkIcon,
  Check,
} from 'lucide-react';
import type { Account } from '../shared';
import type { Project } from './projects';
import type { ExistingDetail } from '../projects/types';
import type { Api } from './resources';
import './existing-projects.css';
const date = (s?: string | null) =>
  s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '尚未读取';
const area = (s: string) =>
  ({
    global: '全球（含中国大陆）',
    mainland: '中国大陆',
    overseas: '全球（不含中国大陆）',
    'global-outside-mainland': 'Cloudflare 全球网络',
  })[s] ?? s;
const state = (s: string) =>
  ({
    Success: '部署成功',
    success: '成功',
    Failed: '部署失败',
    failure: '失败',
    Normal: '正常',
    completed: '已完成',
    in_progress: '运行中',
    queued: '排队中',
    passing: '通过',
    failing: '失败',
    pending: '处理中',
  })[s] ?? s;
function Out({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink size={14} />
    </a>
  );
}
function Modal({
  onClose,
  children,
  title = '接管已有站点',
}: {
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
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
export function ExistingSite({
  project,
  detail,
  api,
  accounts,
  onBack,
  onUpdated,
}: {
  project: Project;
  detail: ExistingDetail;
  api: Api;
  accounts: Account[];
  onBack: () => void;
  onUpdated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [agents, setAgents] = useState(false),
    [tokens, setTokens] = useState<any[]>([]),
    [token, setToken] = useState('');
  async function agentAction(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const hosting = detail.links.filter((l) => l.category === 'hosting'),
    primary = hosting.find((l) => l.role === 'production'),
    source = detail.links.find((l) => l.category === 'source'),
    repo = source?.data.repository;
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      await api('/projects/' + project.id + '/refresh', 'POST', {});
      await onUpdated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="project-top">
        {' '}
        <button className="secondary" onClick={onBack}>
          <ArrowLeft size={17} />
          全部项目
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void agentAction(async () => {
              setToken('');
              setTokens((await api('/projects/' + project.id + '/tokens')).items);
              setAgents(true);
            })
          }
        >
          连接只读 Agent
        </button>
        <button className="primary" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw className={busy ? 'spin' : ''} size={17} />
          {busy ? '正在核实…' : '刷新关联与部署状态'}
        </button>
      </div>
      {agents && (
        <Modal
          title="连接只读 Agent"
          onClose={() => {
            setAgents(false);
            setToken('');
          }}
        >
          <p>
            令牌只允许读取与刷新此项目的关联和部署状态，不允许上传、重建、回滚或修改 DNS。默认 30
            天有效，可随时撤销。
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void agentAction(async () => {
                const r = await api('/projects/' + project.id + '/tokens', 'POST', {
                  name: '站点查询 Agent',
                });
                setToken(r.token);
                setTokens((await api('/projects/' + project.id + '/tokens')).items);
              })
            }
          >
            生成只读项目令牌
          </button>
          {token && (
            <div className="project-token">
              <strong>令牌仅显示这一次</strong>
              <textarea aria-label="只读 Agent Token" value={token} readOnly />
              <button
                className="secondary"
                onClick={() => void navigator.clipboard.writeText(token)}
              >
                复制令牌
              </button>
            </div>
          )}
          <p>
            项目 ID：<code>{project.id}</code>。CLI 使用 status / refresh；MCP 使用 project_status /
            refresh_project。
          </p>
          <Out href="https://github.com/null-object-0000/newbie-cloud/blob/main/docs/publishing.md">
            配置 CLI / MCP
          </Out>
          {tokens.map((t) => (
            <div className="project-agent" key={t.id}>
              <span>
                {t.name} · {t.revoked ? '已撤销' : '有效至 ' + date(t.expires_at)}
              </span>
              <button
                className="secondary compact"
                disabled={busy || !!t.revoked}
                onClick={() =>
                  void agentAction(async () => {
                    await api('/projects/' + project.id + '/tokens/' + t.id, 'DELETE');
                    setTokens((await api('/projects/' + project.id + '/tokens')).items);
                  })
                }
              >
                撤销
              </button>
            </div>
          ))}
        </Modal>
      )}
      {error && (
        <p className="local-error" role="alert">
          {error}
        </p>
      )}
      <section className="panel project-summary">
        <div>
          <span className="eyebrow">已有站点 · 已接管关联</span>
          <h2>{project.name}</h2>
          <p>继续使用原 GitHub / 云平台部署流程</p>
        </div>
        <div>
          {primary?.data.primaryUrl && (
            <Out href={primary.data.primaryUrl}>{primary.data.primaryDomain}</Out>
          )}
          <small>{primary && area(primary.data.area)} · DNS 与邮箱配置保持原状</small>
        </div>
      </section>
      <div className="navigation-context">
        <p>
          当前接管源码、部署状态、域名及底层资源关联。此处只读取原平台，不会重新部署、改绑定、上传覆盖或回滚。
        </p>
      </div>
      <div className="existing-overview">
        <section className="panel existing-source">
          <GitBranch size={23} />
          <h3>源码与自动部署</h3>
          {source ? (
            <>
              <Out href={'https://github.com/' + repo}>{repo}</Out>
              <dl>
                <dt>源码目录</dt>
                <dd>{source.data.directory}</dd>
                <dt>构建输出</dt>
                <dd>{source.data.buildDirectory}</dd>
                <dt>分支</dt>
                <dd>{source.data.branch}</dd>
                <dt>核实的提交</dt>
                <dd>
                  <Out href={`https://github.com/${repo}/commit/${source.data.commit}`}>
                    {String(source.data.commit).slice(0, 12)}
                  </Out>
                </dd>
                <dt>部署工作流</dt>
                <dd>
                  <Out
                    href={`https://github.com/${repo}/actions/workflows/${source.data.workflow.split('/').pop()}`}
                  >
                    {source.data.workflow}
                  </Out>
                </dd>
                <dt>部署脚本</dt>
                <dd>
                  <Out
                    href={`https://github.com/${repo}/blob/${source.data.commit}/${source.data.deployScript}`}
                  >
                    {source.data.deployScript}
                  </Out>
                </dd>
              </dl>
              <p className="existing-evidence">
                <Check size={15} />
                部署脚本中的远端项目 ID 与正式资源一致
              </p>
              <small>核实于 {date(source.verified_at)}</small>
            </>
          ) : (
            <p>尚未关联源码。</p>
          )}
        </section>
        <section className="panel existing-hosting">
          <Server size={23} />
          <h3>底层托管资源</h3>
          {hosting.map((h) => (
            <article key={h.id}>
              <strong>{h.data.name}</strong>
              <span className="pill">
                {h.role === 'production' ? '正式托管' : '保留资源 · 手动关联'}
              </span>
              <p>
                {accounts.find((a) => a.id === h.account_id)?.name} · {h.resource_kind}
              </p>
              <dl>
                <dt>资源 ID</dt>
                <dd>{h.external_id}</dd>
                {h.data.workspaceId && (
                  <>
                    <dt>工作空间</dt>
                    <dd>{h.data.workspaceId}</dd>
                  </>
                )}
                <dt>加速区域</dt>
                <dd>{area(h.data.area)}</dd>
                <dt>平台状态</dt>
                <dd>{state(h.data.status)}</dd>
                <dt>绑定域名</dt>
                <dd>{h.data.domains?.join('、') || '未返回绑定'}</dd>
              </dl>
              {h.data.bindingChanged && (
                <p className="local-error">
                  原正式域名绑定已变化，请到云平台核实。原关联已保留，未自动改绑。
                </p>
              )}
              <small>读取于 {date(h.verified_at)}</small>
            </article>
          ))}
        </section>
      </div>
      <section className="panel existing-domains">
        <Globe2 size={23} />
        <h3>域名、DNS 与注册商</h3>
        {detail.domainLinks.length ? (
          detail.domainLinks.map((d) => (
            <article key={d.hostname}>
              <h4>
                <Out href={'https://' + d.hostname}>{d.hostname}</Out>
              </h4>
              <p>托管绑定由云平台确认；注册域名：{d.registeredDomain ?? '未同步'}</p>
              <div className="existing-domain-columns">
                <div>
                  <strong>注册与续费</strong>
                  {d.registrations.length ? (
                    d.registrations.map((r, i) => (
                      <p key={i}>
                        {r.registrar} · {r.accountName}
                        <small>
                          到期 {date(r.expiresAt)} · 读取于 {date(r.checkedAt)}
                        </small>
                      </p>
                    ))
                  ) : (
                    <p>尚未读取注册信息</p>
                  )}
                </div>
                <div>
                  <strong>DNS 配置来源</strong>
                  {d.dns.length ? (
                    d.dns.map((z) => (
                      <p key={z.zoneId}>
                        {z.accountName}
                        <span className={z.current ? 'pill green' : 'pill'}>
                          {z.current ? '最近 NS 观测对应平台' : '配置副本 / NS 待核实'}
                        </span>
                        <small>NS 观测于 {date(z.checkedAt)}</small>
                      </p>
                    ))
                  ) : (
                    <p>尚未同步 DNS 区域</p>
                  )}
                </div>
              </div>
              {primary?.data.entryPaths?.length > 0 && (
                <p>
                  其他入口：
                  {(primary?.data.entryPaths ?? []).map((p: string) => (
                    <Out key={p} href={'https://' + d.hostname + p}>
                      {p}
                    </Out>
                  ))}
                </p>
              )}
            </article>
          ))
        ) : (
          <p>未读取到正式域名绑定。</p>
        )}
        <small>此处展示已有注册和 DNS 信息，不添加、修改或删除任何记录。</small>
      </section>
      <section className="panel existing-history">
        <h3>云端部署记录</h3>
        <p>
          最近最多 50 条；云端部署状态与 GitHub
          工作流状态分别核实。没有提交信息时不推测线上源码版本。
        </p>
        {hosting.map((h) => {
          const o = detail.observations.find((o) => o.subject === h.id);
          return (
            <article key={h.id}>
              <h4>
                {h.data.name} · {h.role === 'production' ? '正式托管' : '保留资源'}
              </h4>
              {o?.error && <p className="local-error">{o.error}，保留上次成功读取结果。</p>}
              {!o?.data ? (
                <p className="muted">尚未读取部署记录，请刷新。</p>
              ) : (
                <>
                  <small>
                    读取于 {date(o.succeeded_at)} ·{' '}
                    {o.data.total === null ? '平台未返回总数' : `共 ${o.data.total} 条`}
                    {o.data.hasMore ? '，此处展示最近 50 条' : ''}
                  </small>
                  <div className="table-scroll">
                    <table className="resource-table">
                      <thead>
                        <tr>
                          <th>部署</th>
                          <th>环境</th>
                          <th>状态</th>
                          <th>时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {o.data.items.map((d: any) => (
                          <tr key={d.id}>
                            <td>
                              {d.id}
                              {(h.data.currentDeploymentId ?? o.data.currentDeploymentId) ===
                                d.id && <small>平台标记的当前版本</small>}
                              {d.commit && <small>{d.commit}</small>}
                            </td>
                            <td>{d.environment}</td>
                            <td>{state(d.status)}</td>
                            <td>{date(d.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </article>
          );
        })}
      </section>
      {source && (
        <section className="panel existing-workflow">
          <h3>GitHub 工作流运行</h3>
          {(() => {
            const o = detail.observations.find((o) => o.subject === source.id);
            return (
              <>
                {o?.error && <p className="local-error">{o.error}</p>}
                {o?.data?.mode === 'badge' ? (
                  <p>
                    工作流徽章观测：{state(o.data.status)} · {date(o.succeeded_at)}
                    。徽章不提供具体运行记录或线上版本信息。
                  </p>
                ) : o?.data?.items?.length ? (
                  <div className="table-scroll">
                    <table className="resource-table">
                      <thead>
                        <tr>
                          <th>运行</th>
                          <th>提交</th>
                          <th>状态</th>
                          <th>时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {o.data.items.map((r: any) => (
                          <tr key={r.id}>
                            <td>
                              <Out href={r.url}>#{r.id}</Out>
                              <small>{r.event}</small>
                            </td>
                            <td>{r.commit?.slice(0, 12)}</td>
                            <td>{state(r.conclusion ?? r.status)}</td>
                            <td>{date(r.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>可打开原工作流查看运行详情。</p>
                )}
              </>
            );
          })()}
          <Out
            href={`https://github.com/${repo}/actions/workflows/${source.data.workflow.split('/').pop()}`}
          >
            打开原工作流
          </Out>
        </section>
      )}
    </>
  );
}
type Candidate = {
  accountId: string;
  externalId: string;
  kind: string;
  name: string;
  domains: string[];
  linkedProjectId: string | null;
};
export function ImportSite({
  api,
  accounts,
  onClose,
  onImported,
}: {
  api: Api;
  accounts: Account[];
  onClose: () => void;
  onImported: (id: string) => Promise<void>;
}) {
  const [items, setItems] = useState<Candidate[]>([]),
    [selected, setSelected] = useState(''),
    [name, setName] = useState(''),
    [domain, setDomain] = useState(''),
    [repo, setRepo] = useState(''),
    [workflow, setWorkflow] = useState('.github/workflows/deploy-edgeone.yml'),
    [script, setScript] = useState('scripts/edgeone/deploy.mjs'),
    [directory, setDirectory] = useState('.'),
    [output, setOutput] = useState('dist'),
    [preview, setPreview] = useState<any>(null),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(async () => setItems((await api('/projects/import/candidates')).items));
  }, []);
  const candidates = items.filter((i) => !i.linkedProjectId),
    chosen = candidates.find((_, i) => String(i) === selected);
  return (
    <Modal
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        只保存本工作台的项目关联，保留原部署、域名、DNS
        和邮箱配置。候选资源来自已同步清单，预览时会向云平台核实真实 ID 与域名绑定。
      </p>
      {error && (
        <p className="local-error" role="alert">
          {error}
        </p>
      )}
      {preview ? (
        <>
          <h3>{preview.plan.name}</h3>
          <dl className="plugin-preview">
            <dt>正式资源</dt>
            <dd>
              {preview.plan.resources[0].name} · {preview.plan.resources[0].externalId}
            </dd>
            <dt>正式域名</dt>
            <dd>{preview.plan.resources[0].primaryDomain}</dd>
            <dt>源码</dt>
            <dd>{preview.plan.source?.repository ?? '未设置'}</dd>
            <dt>核实提交</dt>
            <dd>{preview.plan.source?.commit ?? '未设置'}</dd>
          </dl>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            确认仅建立关联，不触发部署或更改云端配置
          </label>
          <div className="modal-actions">
            <button className="secondary" disabled={busy} onClick={() => setPreview(null)}>
              返回修改
            </button>
            <button
              className="primary"
              disabled={busy || !confirm}
              onClick={() =>
                void run(async () => {
                  const r = await api('/projects/import/confirm', 'POST', {
                    previewId: preview.id,
                    confirmAssociationOnly: true,
                  });
                  await onImported(r.project.id);
                })
              }
            >
              确认接管
            </button>
          </div>
        </>
      ) : (
        <form
          className="project-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (!chosen) return;
            void run(async () => {
              setPreview(
                await api('/projects/import/preview', 'POST', {
                  name,
                  primaryDomain: domain,
                  resources: [
                    {
                      accountId: chosen.accountId,
                      externalId: chosen.externalId,
                      kind: chosen.kind,
                      role: 'production',
                    },
                  ],
                  ...(repo
                    ? {
                        source: {
                          repository: repo,
                          branch: 'main',
                          workflow,
                          deployScript: script,
                          directory,
                          buildDirectory: output,
                        },
                      }
                    : {}),
                }),
              );
              setConfirm(false);
            });
          }}
        >
          <label>
            已有托管资源
            <select
              aria-label="已有托管资源"
              required
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                const c = candidates[Number(e.target.value)];
                setName(c?.name ?? '');
                setDomain(c?.domains[0] ?? '');
              }}
            >
              <option value="">选择已同步的站点</option>
              {candidates.map((c, i) => (
                <option key={c.accountId + c.externalId} value={i}>
                  {c.name} · {accounts.find((a) => a.id === c.accountId)?.name}
                </option>
              ))}
            </select>
          </label>
          {!candidates.length && (
            <p>请先到「资源 → 站点与函数」读取云平台资源，或检查它是否已被接管。</p>
          )}
          <label>
            项目名称
            <input
              aria-label="接管项目名称"
              required
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            正式域名
            <select
              aria-label="正式域名"
              required
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            >
              <option value="">选择已绑定的域名</option>
              {chosen?.domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            GitHub 源码仓库（可选）
            <input
              aria-label="源码仓库"
              placeholder="owner/repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
          </label>
          {repo && (
            <>
              <p className="muted">
                当前核实 main 分支；部署脚本需明确写出选中资源的 projectId，不会执行脚本。
              </p>
              <label>
                部署工作流
                <input value={workflow} onChange={(e) => setWorkflow(e.target.value)} required />
              </label>
              <label>
                部署脚本
                <input value={script} onChange={(e) => setScript(e.target.value)} required />
              </label>
              <div className="form-grid">
                <label>
                  源码目录
                  <input
                    value={directory}
                    onChange={(e) => setDirectory(e.target.value)}
                    required
                  />
                </label>
                <label>
                  构建目录
                  <input value={output} onChange={(e) => setOutput(e.target.value)} required />
                </label>
              </div>
            </>
          )}
          <button className="primary" disabled={busy || !chosen}>
            <LinkIcon size={16} />
            {busy ? '正在核实…' : '预览关联'}
          </button>
        </form>
      )}
    </Modal>
  );
}
