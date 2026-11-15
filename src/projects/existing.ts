import { Cloud } from '../server/providers';
import { decrypt, sha256 } from '../server/crypto';
import { HttpError, now, type Env, type Fetch, type AccountRow } from '../server/types';
import { Pages } from './cloudflare';
import { requirePlugin } from '../plugins/runtime';
import { sourceFetch, bytesLimited } from '../plugins/sources';
import { publicHost } from '../plugins/validation';
import { domainInventory, freshDns } from '../inventory';
import type { Credentials, DnsObservation, ResourceSnapshot, Zone } from '../shared';
export type HostingInput = {
  accountId: string;
  externalId: string;
  kind: 'EdgeOne Makers' | 'Pages';
  role: 'production' | 'retained';
};
type Source = {
  repository: string;
  branch: string;
  commit?: string;
  workflow: string;
  deployScript: string;
  directory: string;
  buildDirectory: string;
};
type Link = {
  id: string;
  project_id: string;
  category: string;
  role: string;
  provider: string;
  account_id: string | null;
  resource_kind: string;
  external_id: string;
  data: string;
  verified_at: string;
};
const message = (e: unknown) => (e instanceof HttpError ? e.message : '读取未完成，请稍后重试');
const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
async function sourceBytes(url: string, fetcher: Fetch, limit: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await sourceFetch(url, fetcher, limit);
    } catch (e) {
      if (attempt === 2 || !(e instanceof HttpError) || !/HTTP 50[0234]/.test(e.message))
        throw new HttpError(
          502,
          'GitHub 源文件读取暂不可用，请核实公开仓库、文件路径与固定提交后重试',
        );
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  throw new HttpError(502, 'GitHub 源文件读取失败');
}
const domains = (values: unknown[]) =>
  [
    ...new Set(
      values
        .map((v) =>
          typeof v === 'string' ? v : ((v as any)?.DomainName ?? (v as any)?.Domain ?? ''),
        )
        .map((v) => String(v).toLowerCase())
        .filter(publicHost),
    ),
  ].slice(0, 100);
function path(v: unknown, fallback: string) {
  const value = v === undefined ? fallback : text(v);
  if (
    !value ||
    value.length > 200 ||
    value.startsWith('/') ||
    value.split('/').some((v) => !v || v === '..') ||
    !/^[A-Za-z0-9_./-]+$/.test(value)
  )
    throw new HttpError(400, '源码路径无效');
  return value;
}
function source(input: any): Source | undefined {
  if (input === undefined || input === null) return undefined;
  if (
    !input ||
    typeof input !== 'object' ||
    !/^[-A-Za-z0-9_]+\/[-A-Za-z0-9_.]+$/.test(input.repository ?? '')
  )
    throw new HttpError(400, '源码仓库格式为 owner/repo');
  const workflow = path(input.workflow, '.github/workflows/deploy-edgeone.yml');
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow))
    throw new HttpError(400, '请提供 GitHub 工作流文件路径');
  const branch = text(input.branch ?? 'main', 100);
  if (!branch || !/^[A-Za-z0-9_./-]+$/.test(branch) || branch.includes('..'))
    throw new HttpError(400, '分支无效');
  const commit = input.commit;
  if (commit !== undefined && !/^[a-f0-9]{40}$/.test(commit))
    throw new HttpError(400, '固定提交需要完整 SHA');
  return {
    repository: input.repository,
    branch,
    ...(commit ? { commit } : {}),
    workflow,
    deployScript: path(input.deployScript, 'scripts/edgeone/deploy.mjs'),
    directory: path(input.directory, '.'),
    buildDirectory: path(input.buildDirectory, 'dist'),
  };
}
async function account(env: Env, id: string) {
  const a = await env.DB.prepare('SELECT * FROM accounts WHERE id=?').bind(id).first<AccountRow>();
  if (!a) throw new HttpError(404, '云账号不存在');
  await requirePlugin(env, a.provider);
  await requirePlugin(env, 'services');
  return {
    row: a,
    credentials: await decrypt<Credentials>(
      a.credentials,
      env.ENCRYPTION_KEY,
      a.id + ':' + a.provider,
    ),
  };
}
function hostingInput(v: any): HostingInput {
  if (
    !v ||
    typeof v.accountId !== 'string' ||
    !['Pages', 'EdgeOne Makers'].includes(v.kind) ||
    !['production', 'retained'].includes(v.role) ||
    typeof v.externalId !== 'string' ||
    !/^[-A-Za-z0-9_]{1,100}$/.test(v.externalId)
  )
    throw new HttpError(400, '托管资源标识、账号或用途无效');
  return { accountId: v.accountId, externalId: v.externalId, kind: v.kind, role: v.role };
}
async function reader(env: Env, h: HostingInput, fetcher: Fetch) {
  const { row, credentials: c } = await account(env, h.accountId);
  if (h.kind === 'Pages') {
    if (row.provider !== 'cloudflare' || !/^[a-f0-9]{32}$/.test(c.accountId ?? ''))
      throw new HttpError(400, 'Cloudflare 账号与资源不匹配');
    const cf = new Pages(c.apiToken!, c.accountId!, fetcher);
    return {
      provider: row.provider,
      workspaceId: null as string | null,
      project: async () => {
        const p = await cf.project(h.externalId);
        if (p.name !== h.externalId) throw new HttpError(409, '远端站点 ID 不匹配');
        return {
          id: p.name,
          name: p.name,
          area: 'global-outside-mainland',
          status: p.canonical_deployment?.latest_stage?.status ?? 'unknown',
          domains: domains(p.domains ?? []),
          currentDeploymentId: p.canonical_deployment?.id ?? null,
          sourceRepository:
            p.source?.config?.owner && p.source?.config?.repo_name
              ? p.source.config.owner + '/' + p.source.config.repo_name
              : null,
        };
      },
      deployments: async () => {
        const rows = await cf.api(cf.root(h.externalId) + '/deployments?page=1&per_page=25');
        if (!Array.isArray(rows)) throw new HttpError(502, 'Pages 部署列表无效');
        return {
          items: rows.map((d: any) => ({
            id: text(d.id),
            status: text(d.latest_stage?.status),
            environment: text(d.environment),
            createdAt: text(d.created_on),
            commit: text(d.deployment_trigger?.metadata?.commit_hash, 64),
          })),
          hasMore: rows.length === 25,
          pageSize: 25,
          total: null,
        };
      },
    };
  }
  if (row.provider !== 'tencent' || !c.workspaceId)
    throw new HttpError(400, '请选择已配置 EdgeOne 工作空间的腾讯云账号');
  const cloud = new Cloud('tencent', c, fetcher);
  const read = async (
    action: 'DescribePagesProjects' | 'DescribePagesDeployments',
    payload: Record<string, unknown>,
  ) => {
    const r = await cloud.tc('teo', 'DescribePagesResources', {
      ZoneId: c.workspaceId,
      Interface: 'pages:' + action,
      Payload: JSON.stringify(payload),
    });
    let result: any;
    try {
      result = typeof r.Result === 'string' ? JSON.parse(r.Result) : r.Result;
    } catch {
      throw new HttpError(502, 'EdgeOne 响应无效');
    }
    if (result?.Code !== undefined && result.Code !== 0 && result.Code !== '0')
      throw new HttpError(502, 'EdgeOne 读取未完成，请检查 DescribePagesResources 权限');
    return result?.Data ?? result;
  };
  return {
    provider: row.provider,
    workspaceId: c.workspaceId,
    project: async () => {
      const data = await read('DescribePagesProjects', {
          Filters: [{ Name: 'ProjectId', Values: [h.externalId] }],
          Offset: 0,
          Limit: 1,
        }),
        p = data?.Projects?.find((p: any) => p.ProjectId === h.externalId);
      if (!p) throw new HttpError(404, '当前工作空间未找到该 EdgeOne 项目');
      return {
        id: h.externalId,
        name: text(p.Name ?? p.ProjectName),
        area: text(p.Area),
        status: text(p.Status),
        domains: domains(p.CustomDomains ?? p.Domains ?? []),
        currentDeploymentId: text(p.ProductionDeploymentId ?? p.DeploymentId) || null,
        sourceRepository: null,
      };
    },
    deployments: async () => {
      const d = await read('DescribePagesDeployments', {
        ProjectId: h.externalId,
        Offset: 0,
        Limit: 50,
        OrderBy: 'CreatedOn',
        OrderType: 'Desc',
      });
      if (!Array.isArray(d?.Deployments)) throw new HttpError(502, 'EdgeOne 部署列表无效');
      return {
        items: d.Deployments.map((r: any) => ({
          id: text(r.DeploymentId),
          status: text(r.Status),
          environment: text(r.Env ?? 'Production'),
          createdAt: text(r.CreatedOn),
          commit: text(r.RepoCommitHash ?? r.CommitHash, 64),
          current: r.UsedInProd === true,
        })),
        total: Number(d.TotalCount ?? d.Deployments.length),
        pageSize: 50,
        hasMore: Number(d.TotalCount ?? 0) > 50 || d.Deployments.length === 50,
      };
    },
  };
}
async function githubJson(s: Source, route: string, env: Env, fetcher: Fetch) {
  const r = await fetcher.call(
    globalThis,
    `https://api.github.com/repos/${s.repository}/${route}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Newbie-Cloud',
        ...(env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + env.GITHUB_TOKEN } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    },
  );
  if (!r.ok) {
    await r.body?.cancel();
    throw new HttpError(502, 'GitHub API 暂不可用（HTTP ' + r.status + '）；可打开原工作流查看。');
  }
  try {
    return JSON.parse(new TextDecoder().decode(await bytesLimited(r.body, 1000000)));
  } catch {
    throw new HttpError(502, 'GitHub 返回格式无效');
  }
}
async function resolveCommit(s: Source, env: Env, fetcher: Fetch) {
  if (s.commit) return s.commit;
  try {
    const data = await githubJson(
        s,
        'commits?sha=' + encodeURIComponent(s.branch) + '&per_page=1',
        env,
        fetcher,
      ),
      sha = data?.[0]?.sha;
    if (/^[a-f0-9]{40}$/.test(sha)) return sha;
  } catch {}
  const feed = new TextDecoder().decode(
      await sourceFetch(
        `https://github.com/${s.repository}/commits/${encodeURIComponent(s.branch)}.atom`,
        fetcher,
        512000,
      ),
    ),
    entry = feed.match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/)?.[1],
    sha = entry?.match(/<id>\s*tag:github\.com,2008:Grit::Commit\/([a-f0-9]{40})\s*<\/id>/)?.[1];
  if (!sha || !entry?.includes(`href="https://github.com/${s.repository}/commit/${sha}"`))
    throw new HttpError(502, '无法核实源码提交，请填写完整提交 SHA');
  return sha;
}
async function verifySource(
  s: Source,
  h: HostingInput,
  workspaceId: string | null,
  env: Env,
  fetcher: Fetch,
) {
  const commit = await resolveCommit(s, env, fetcher),
    base = `https://raw.githubusercontent.com/${s.repository}/${commit}/`;
  const [wf, script] = await Promise.all([
    sourceBytes(base + s.workflow, fetcher, 128000),
    sourceBytes(base + s.deployScript, fetcher, 256000),
  ]);
  const workflow = new TextDecoder().decode(wf),
    code = new TextDecoder().decode(script);
  if (
    !workflow.includes(s.deployScript) ||
    !new RegExp('(?:const|let)\\s+projectId\\s*=\\s*[\'"]' + h.externalId + '[\'"]').test(code) ||
    (workspaceId && !code.includes(workspaceId))
  )
    throw new HttpError(409, '部署工作流或脚本未指向选中的远端项目 / 工作空间；不会按名称关联');
  return {
    ...s,
    commit,
    workflowHash: await sha256(workflow),
    scriptHash: await sha256(code),
    verifiedAt: now(),
    evidence: 'deployment-script-target',
  };
}
async function workflowStatus(s: Source, env: Env, fetcher: Fetch) {
  try {
    const data = await githubJson(
      s,
      `actions/workflows/${encodeURIComponent(s.workflow.split('/').pop()!)}/runs?branch=${encodeURIComponent(s.branch)}&per_page=5`,
      env,
      fetcher,
    );
    if (!Array.isArray(data.workflow_runs)) throw Error();
    return {
      mode: 'runs',
      items: data.workflow_runs.map((r: any) => ({
        id: String(r.id),
        status: text(r.status),
        conclusion: text(r.conclusion) || null,
        commit: text(r.head_sha, 40),
        createdAt: text(r.created_at),
        event: text(r.event),
        url: `https://github.com/${s.repository}/actions/runs/${String(r.id).replace(/\D/g, '')}`,
      })),
    };
  } catch {
    const url = `https://github.com/${s.repository}/actions/workflows/${s.workflow.split('/').pop()!}/badge.svg?branch=${encodeURIComponent(s.branch)}`;
    const svg = new TextDecoder().decode(await sourceFetch(url, fetcher, 64000)),
      label =
        svg.match(/aria-label="([^"]+)"/)?.[1] ?? svg.match(/<title>([^<]+)<\/title>/)?.[1] ?? '';
    const result = label.match(/[:\-]\s*(passing|failing|pending|no status|not found)\s*$/)?.[1];
    if (!result) throw new HttpError(502, '未能读取 GitHub 工作流状态，可通过原链接查看');
    return { mode: 'badge', status: result, items: [] };
  }
}
async function observe(
  env: Env,
  pid: string,
  subject: string,
  value: unknown,
  error: string | null = null,
) {
  const at = now();
  if (error) {
    await env.DB.prepare(
      'INSERT INTO project_observations(project_id,subject,data,error,checked_at) VALUES(?,?,NULL,?,?) ON CONFLICT(project_id,subject) DO UPDATE SET error=excluded.error,checked_at=excluded.checked_at',
    )
      .bind(pid, subject, error, at)
      .run();
    return;
  }
  await env.DB.prepare(
    'INSERT INTO project_observations(project_id,subject,data,error,checked_at,succeeded_at) VALUES(?,?,?,NULL,?,?) ON CONFLICT(project_id,subject) DO UPDATE SET data=excluded.data,error=NULL,checked_at=excluded.checked_at,succeeded_at=excluded.succeeded_at',
  )
    .bind(pid, subject, JSON.stringify(value), at, at)
    .run();
}
export async function linkedSummary(env: Env, rows: any[]) {
  if (!rows.length) return rows;
  const links = (
    await env.DB.prepare(
      "SELECT project_id,account_id,provider,resource_kind,external_id,role,data FROM project_links WHERE category='hosting'",
    ).all<any>()
  ).results;
  return rows.map((p) => ({
    ...p,
    resourceLinks: links
      .filter((l) => l.project_id === p.id)
      .map((l) => ({
        accountId: l.account_id,
        provider: l.provider,
        kind: l.resource_kind,
        externalId: l.external_id,
        role: l.role,
        name: JSON.parse(l.data).name,
      })),
    primaryUrl:
      p.management === 'existing'
        ? (() => {
            const primary = links.find((l) => l.project_id === p.id && l.role === 'production');
            return primary ? JSON.parse(primary.data).primaryUrl : null;
          })()
        : undefined,
  }));
}
export async function linkedDetail(env: Env, pid: string) {
  const links = (
      await env.DB.prepare('SELECT * FROM project_links WHERE project_id=? ORDER BY category,role')
        .bind(pid)
        .all<Link>()
    ).results.map((l) => ({ ...l, data: JSON.parse(l.data) })),
    observations = (
      await env.DB.prepare('SELECT * FROM project_observations WHERE project_id=?')
        .bind(pid)
        .all<any>()
    ).results.map((o) => ({ ...o, data: o.data ? JSON.parse(o.data) : null }));
  const rawZones = (await env.DB.prepare('SELECT * FROM zones').all<any>()).results,
    zones: Zone[] = rawZones.map((z) => ({
      id: z.id,
      accountId: z.account_id,
      externalId: z.external_id,
      name: z.name,
      status: z.status,
      updatedAt: z.updated_at,
    }));
  const snapshots = (
    await env.DB.prepare("SELECT * FROM snapshots WHERE kind='registrations'").all<any>()
  ).results.map((s) => ({ ...s, data: JSON.parse(s.data) })) as ResourceSnapshot[];
  const inventory = domainInventory(zones, snapshots),
    accounts = (await env.DB.prepare('SELECT id,name,provider FROM accounts').all<any>()).results,
    ns = (
      await env.DB.prepare("SELECT value FROM settings WHERE key LIKE 'dns:%'").all<{
        value: string;
      }>()
    ).results.map((r) => JSON.parse(r.value) as DnsObservation);
  const hostnames = [
    ...new Set(
      links
        .filter((l) => l.category === 'hosting' && l.role === 'production')
        .flatMap((l) => l.data.domains as string[]),
    ),
  ];
  const domainLinks = hostnames.map((hostname) => {
    const base = inventory
        .filter((d) => hostname === d.name || hostname.endsWith('.' + d.name))
        .sort((a, b) => b.name.length - a.name.length)[0],
      observed = ns.find((n) => n.name === base?.name);
    return {
      hostname,
      registeredDomain: base?.name ?? null,
      registrations:
        base?.registrations.map((r) => ({
          registrar: r.registrar,
          accountId: r.accountId,
          accountName: accounts.find((a) => a.id === r.accountId)?.name,
          expiresAt: r.expiresAt,
          checkedAt: r.checkedAt,
        })) ?? [],
      dns:
        base?.zones.map((z) => ({
          zoneId: z.id,
          accountId: z.accountId,
          accountName: accounts.find((a) => a.id === z.accountId)?.name,
          provider: accounts.find((a) => a.id === z.accountId)?.provider,
          current:
            !!observed &&
            freshDns(observed) &&
            accounts.find((a) => a.id === z.accountId)?.provider === observed.provider,
          checkedAt: observed?.checkedAt ?? null,
        })) ?? [],
    };
  });
  return {
    links,
    observations,
    domainLinks,
    capabilities: { read: true, refresh: true, upload: false, rollback: false, dnsWrite: false },
    scope: 'association-only',
  };
}
export async function refreshExisting(env: Env, pid: string, fetcher: Fetch) {
  const links = (
      await env.DB.prepare('SELECT * FROM project_links WHERE project_id=?').bind(pid).all<Link>()
    ).results,
    primary = links.find((l) => l.category === 'hosting' && l.role === 'production');
  for (const l of links.filter((l) => l.category === 'hosting')) {
    const h: HostingInput = {
      accountId: l.account_id!,
      externalId: l.external_id,
      kind: l.resource_kind as HostingInput['kind'],
      role: l.role as HostingInput['role'],
    };
    try {
      const read = await reader(env, h, fetcher),
        previous = JSON.parse(l.data);
      if (previous.workspaceId !== read.workspaceId)
        throw new HttpError(409, '工作空间配置已变化，请重新核实关联');
      const p = await read.project();
      await env.DB.prepare('UPDATE project_links SET data=?,verified_at=? WHERE id=?')
        .bind(
          JSON.stringify({
            ...previous,
            ...p,
            primaryUrl: p.domains.includes(previous.primaryDomain)
              ? 'https://' + previous.primaryDomain
              : previous.primaryUrl,
            bindingChanged: !p.domains.includes(previous.primaryDomain),
          }),
          now(),
          l.id,
        )
        .run();
      const deployments = await read.deployments();
      await observe(env, pid, l.id, {
        ...deployments,
        currentDeploymentId:
          p.currentDeploymentId ?? deployments.items.find((d: any) => d.current)?.id ?? null,
      });
    } catch (e) {
      await observe(env, pid, l.id, null, message(e));
    }
  }
  for (const l of links.filter((l) => l.category === 'source')) {
    const s: Source = JSON.parse(l.data);
    try {
      if (!primary) throw new HttpError(409, '缺少正式托管关联');
      const primaryData = JSON.parse(primary.data),
        updated = await verifySource(
          { ...s, commit: undefined },
          {
            accountId: primary.account_id!,
            externalId: primary.external_id,
            kind: primary.resource_kind as any,
            role: 'production',
          },
          primaryData.workspaceId,
          env,
          fetcher,
        );
      await env.DB.prepare('UPDATE project_links SET data=?,verified_at=? WHERE id=?')
        .bind(JSON.stringify(updated), now(), l.id)
        .run();
      await observe(env, pid, l.id, await workflowStatus(updated, env, fetcher));
    } catch (e) {
      await observe(env, pid, l.id, null, message(e));
    }
  }
}
export async function candidates(env: Env) {
  const direct = (
    await env.DB.prepare(
      "SELECT id,account_id,remote_name FROM projects WHERE management='direct'",
    ).all<any>()
  ).results;
  const snapshots = (
      await env.DB.prepare("SELECT * FROM snapshots WHERE kind='services'").all<any>()
    ).results,
    linked = (
      await env.DB.prepare(
        "SELECT account_id,resource_kind,external_id,project_id FROM project_links WHERE category='hosting'",
      ).all<any>()
    ).results;
  return snapshots.flatMap((s) =>
    JSON.parse(s.data)
      .filter((r: any) => ['Pages', 'EdgeOne Makers'].includes(r.kind))
      .map((r: any) => ({
        accountId: s.account_id,
        externalId: r.id,
        kind: r.kind,
        name: r.name,
        domains: r.domains ?? [],
        checkedAt: s.updated_at,
        linkedProjectId:
          linked.find(
            (l) =>
              l.account_id === s.account_id && l.resource_kind === r.kind && l.external_id === r.id,
          )?.project_id ??
          (r.kind === 'Pages'
            ? direct.find((p) => p.account_id === s.account_id && p.remote_name === r.id)?.id
            : undefined) ??
          null,
      })),
  );
}
export async function previewExisting(env: Env, b: any, fetcher: Fetch) {
  if (
    typeof b.name !== 'string' ||
    !b.name.trim() ||
    b.name.length > 80 ||
    !Array.isArray(b.resources) ||
    !b.resources.length ||
    b.resources.length > 6
  )
    throw new HttpError(400, '请填写名称并选择 1–6 个真实托管资源');
  const resources: HostingInput[] = b.resources.map(hostingInput);
  if (resources.filter((h) => h.role === 'production').length !== 1)
    throw new HttpError(400, '必须选择且只选择一个正式托管资源');
  const seen = new Set<string>();
  const verified = [];
  for (const h of resources) {
    const identity = h.accountId + ':' + h.kind + ':' + h.externalId;
    if (seen.has(identity)) throw new HttpError(400, '托管资源重复');
    seen.add(identity);
    const occupied = await env.DB.prepare(
      "SELECT project_id FROM project_links WHERE category='hosting' AND account_id=? AND resource_kind=? AND external_id=?",
    )
      .bind(h.accountId, h.kind, h.externalId)
      .first();
    if (occupied) throw new HttpError(409, '该云资源已经关联到项目');
    if (
      h.kind === 'Pages' &&
      (await env.DB.prepare(
        "SELECT id FROM projects WHERE account_id=? AND remote_name=? AND management='direct'",
      )
        .bind(h.accountId, h.externalId)
        .first())
    )
      throw new HttpError(409, '该 Pages 站点已由现有项目管理');
    const read = await reader(env, h, fetcher),
      p = await read.project();
    const primaryDomain =
      h.role === 'production' ? text(b.primaryDomain).toLowerCase() : (p.domains[0] ?? null);
    if (h.role === 'production' && !p.domains.includes(primaryDomain))
      throw new HttpError(409, '正式域名没有绑定在选定的远端项目上；不会修改绑定或 DNS');
    verified.push({
      ...h,
      ...p,
      externalId: h.externalId,
      provider: read.provider,
      workspaceId: read.workspaceId,
      primaryDomain,
      primaryUrl: primaryDomain ? 'https://' + primaryDomain : null,
      entryPaths:
        h.role === 'production' && Array.isArray(b.entryPaths)
          ? b.entryPaths
              .filter(
                (p: unknown) =>
                  typeof p === 'string' && /^\/[A-Za-z0-9_./-]*$/.test(p) && !p.includes('..'),
              )
              .slice(0, 10)
          : [],
    });
  }
  const primary = verified.find((h) => h.role === 'production')!,
    s = source(b.source),
    verifiedSource = s ? await verifySource(s, primary, primary.workspaceId, env, fetcher) : null;
  const plan = {
      name: b.name.trim(),
      resources: verified,
      source: verifiedSource,
      createdAt: now(),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    },
    id = crypto.randomUUID();
  await env.DB.prepare('DELETE FROM settings WHERE key LIKE ? AND json_extract(value,?)<?')
    .bind('project-import:%', '$.expiresAt', now())
    .run();
  await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
    .bind('project-import:' + id, JSON.stringify(plan))
    .run();
  return { id, plan };
}
export async function confirmExisting(env: Env, b: any, fetcher: Fetch) {
  if (typeof b.previewId !== 'string' || b.confirmAssociationOnly !== true)
    throw new HttpError(400, '请确认仅接管关联，不更改云端配置');
  const previewKey = 'project-import:' + b.previewId;
  const existing = await env.DB.prepare('SELECT * FROM projects WHERE request_key=?')
    .bind(previewKey)
    .first<any>();
  if (existing) return existing;
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
    .bind(previewKey)
    .first<{ value: string }>();
  if (!row) throw new HttpError(409, '预览已使用或不存在');
  const plan = JSON.parse(row.value);
  if (plan.expiresAt < now()) throw new HttpError(409, '接管预览已过期');
  // Recheck the exact identities and binding immediately before local import.
  for (const h of plan.resources) {
    const read = await reader(env, h, fetcher);
    if (read.workspaceId !== h.workspaceId) throw new HttpError(409, '工作空间已变化，请重新预览');
    const p = await read.project();
    if (h.role === 'production' && !p.domains.includes(h.primaryDomain))
      throw new HttpError(409, '正式域名绑定已变化，请重新预览');
  }
  const id = crypto.randomUUID(),
    at = now(),
    primary = plan.resources.find((h: any) => h.role === 'production');
  const insert = env.DB.prepare(
    "INSERT INTO projects(id,account_id,name,remote_name,status,created_at,updated_at,request_key,management,provider) SELECT ?,?,?,?,'linked',?,?,?,'existing',? FROM settings WHERE key=? AND value=?",
  ).bind(
    id,
    primary.accountId,
    plan.name,
    'linked-' + id,
    at,
    at,
    previewKey,
    primary.provider,
    previewKey,
    row.value,
  );
  const statements = [
    insert,
    ...plan.resources.map((h: any) =>
      env.DB.prepare(
        "INSERT INTO project_links(id,project_id,category,role,provider,account_id,resource_kind,external_id,data,verified_at) SELECT ?,?,'hosting',?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM projects WHERE id=?)",
      ).bind(
        crypto.randomUUID(),
        id,
        h.role,
        h.provider,
        h.accountId,
        h.kind,
        h.externalId,
        JSON.stringify(h),
        at,
        id,
      ),
    ),
  ];
  if (plan.source)
    statements.push(
      env.DB.prepare(
        "INSERT INTO project_links(id,project_id,category,role,provider,account_id,resource_kind,external_id,data,verified_at) SELECT ?,?,'source','primary','github',NULL,'workflow',?,?,? WHERE EXISTS(SELECT 1 FROM projects WHERE id=?)",
      ).bind(
        crypto.randomUUID(),
        id,
        plan.source.repository + '#' + plan.source.workflow,
        JSON.stringify(plan.source),
        at,
        id,
      ),
    );
  statements.push(
    env.DB.prepare(
      'DELETE FROM settings WHERE key=? AND EXISTS(SELECT 1 FROM projects WHERE id=?)',
    ).bind(previewKey, id),
  );
  try {
    await env.DB.batch(statements);
  } catch {
    const imported = await env.DB.prepare('SELECT * FROM projects WHERE request_key=?')
      .bind(previewKey)
      .first<any>();
    if (imported) return imported;
    throw new HttpError(409, '资源已被其他操作关联，请刷新查看');
  }
  const p = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(id).first<any>();
  if (!p) throw new HttpError(409, '接管预览已被其他操作使用');
  await env.DB.prepare(
    'INSERT INTO operations(id,account_id,kind,status,summary,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(
      crypto.randomUUID(),
      primary.accountId,
      'project',
      'success',
      '关联已有站点：' + plan.name,
      JSON.stringify({ projectId: id, cloudMutations: 0 }),
      at,
      at,
    )
    .run();
  return p;
}
