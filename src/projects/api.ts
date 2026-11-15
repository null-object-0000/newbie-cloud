import { authenticated, decrypt, sha256, sameOrigin } from '../server/crypto';
import { HttpError, now, type Env, type Fetch, type AccountRow } from '../server/types';
import { requirePlugin } from '../plugins/runtime';
import { bytesLimited } from '../plugins/sources';
import { assetHash, base64Bytes, sha, validateAssets, MAX_FILE, type Asset } from './files';
import { Pages, PagesRejected } from './cloudflare';
type Project = {
  id: string;
  account_id: string;
  name: string;
  remote_name: string;
  status: string;
  current_release: string | null;
  active_task: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  request_key: string;
};
type Release = {
  id: string;
  project_id: string;
  kind: string;
  target_release: string | null;
  status: string;
  external_id: string | null;
  url: string | null;
  message: string;
  error: string | null;
  verification: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
  request_key: string;
};
type FileRow = {
  path: string;
  hash: string;
  sha256: string;
  size: number;
  content_type: string;
  uploaded: number;
};
type Agent = { id: string; project_id: string; allow_rollback: number };
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
const key = (v: unknown) => {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(v))
    throw new HttpError(400, '需要 8–100 位 requestKey，用于防止重复提交');
  return v;
};
async function input(r: Request) {
  if (!r.headers.get('Content-Type')?.startsWith('application/json'))
    throw new HttpError(415, '请求必须为 JSON');
  try {
    const b = JSON.parse(new TextDecoder().decode(await bytesLimited(r.body, 128000)));
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw Error();
    return b as Record<string, any>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'JSON 格式无效');
  }
}
const problem = (e: unknown) =>
  e instanceof HttpError ? e.message : '任务未完成，请检查结果后再操作';
async function project(env: Env, id: string) {
  const p = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(id).first<Project>();
  if (!p) throw new HttpError(404, '项目不存在');
  return p;
}
async function release(env: Env, p: Project, id: string) {
  const r = await env.DB.prepare('SELECT * FROM releases WHERE id=? AND project_id=?')
    .bind(id, p.id)
    .first<Release>();
  if (!r) throw new HttpError(404, '发布记录不存在');
  return r;
}
async function cloud(env: Env, p: Project, fetcher: Fetch, write = false) {
  await requirePlugin(env, 'cloudflare');
  await requirePlugin(env, 'services');
  const a = await env.DB.prepare('SELECT * FROM accounts WHERE id=?')
    .bind(p.account_id)
    .first<AccountRow>();
  if (!a || a.provider !== 'cloudflare') throw new HttpError(400, '请选择一个 Cloudflare 账号');
  if (write && a.readonly)
    throw new HttpError(403, '账号当前只读；请为发布使用独立的 Pages Edit Token，并显式关闭只读');
  const c = await decrypt<Record<string, string>>(
    a.credentials,
    env.ENCRYPTION_KEY,
    a.id + ':' + a.provider,
  );
  if (!/^[a-f0-9]{32}$/.test(c.accountId ?? ''))
    throw new HttpError(400, '请在云账号中填写 Cloudflare Account ID');
  return new Pages(c.apiToken, c.accountId, fetcher);
}
async function audit(env: Env, p: Project, r: Release, status: string) {
  const at = now();
  await env.DB.prepare(
    'INSERT INTO operations(id,account_id,kind,status,summary,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(
      crypto.randomUUID(),
      p.account_id,
      'publish',
      status,
      (r.kind === 'rollback' ? '回滚：' : '发布：') + p.name,
      JSON.stringify({ projectId: p.id, releaseId: r.id, status: r.status }),
      at,
      at,
    )
    .run();
}
async function files(env: Env, id: string) {
  return (
    await env.DB.prepare('SELECT * FROM release_files WHERE release_id=? ORDER BY path')
      .bind(id)
      .all<FileRow>()
  ).results;
}
const commit = async (id: string) => (await sha256(id)).slice(0, 40);
function deploymentUrl(raw: unknown, p: Project) {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (
      u.protocol === 'https:' &&
      !u.port &&
      !u.username &&
      !u.password &&
      (u.hostname === p.remote_name + '.pages.dev' ||
        u.hostname.endsWith('.' + p.remote_name + '.pages.dev')) &&
      u.pathname === '/'
    )
      return u.origin;
  } catch {}
  return null;
}
async function finish(
  env: Env,
  p: Project,
  r: Release,
  status: string,
  error: string | null = null,
  current?: string,
) {
  const at = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE releases SET status=?,error=?,updated_at=? WHERE id=?').bind(
      status,
      error,
      at,
      r.id,
    ),
    env.DB.prepare(
      'UPDATE projects SET active_task=NULL,current_release=COALESCE(?,current_release),updated_at=? WHERE id=? AND active_task=?',
    ).bind(current ?? null, at, p.id, r.id),
  ]);
  r.status = status;
  r.error = error;
  await audit(
    env,
    p,
    r,
    status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'review_required',
  );
}
async function verify(env: Env, p: Project, r: Release, fetcher: Fetch, production = false) {
  if (!r.url) return;
  let status = 'pending';
  try {
    const index = (await files(env, r.kind === 'rollback' ? r.target_release! : r.id)).find(
      (f) => f.path === 'index.html',
    );
    if (!index) return;
    const response = await fetcher.call(globalThis, r.url + '/', {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (response.status === 200) {
      const content = await bytesLimited(response.body, MAX_FILE);
      status = (await sha(content)) === index.sha256 ? 'passed' : 'mismatch';
    } else {
      await response.body?.cancel();
      status = 'http_' + response.status;
    }
    if (status === 'passed' && production) {
      status = 'pending_production';
      try {
        const live = await fetcher.call(globalThis, 'https://' + p.remote_name + '.pages.dev/', {
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (live.status === 200) {
          if ((await sha(await bytesLimited(live.body, MAX_FILE))) === index.sha256)
            status = 'production_passed';
        } else await live.body?.cancel();
      } catch {}
    }
  } catch {
    status = 'pending';
  }
  await env.DB.prepare('UPDATE releases SET verification=?,verified_at=? WHERE id=?')
    .bind(status, now(), r.id)
    .run();
}
async function check(env: Env, p: Project, r: Release, fetcher: Fetch) {
  const cf = await cloud(env, p, fetcher);
  if (r.kind === 'rollback') {
    if (r.status === 'success') {
      await verify(env, p, r, fetcher, p.current_release === r.target_release);
      return;
    }
    const remote = await cf.project(p.remote_name),
      target = await release(env, p, r.target_release!);
    if (remote.canonical_deployment?.id === target.external_id) {
      r.url = target.url;
      await env.DB.prepare('UPDATE releases SET external_id=?,url=? WHERE id=?')
        .bind(target.external_id, target.url, r.id)
        .run();
      await finish(env, p, r, 'success', null, target.id);
      await verify(env, p, r, fetcher, true);
    }
    return;
  }
  if (r.status === 'uploading' || r.status === 'cancelled' || r.status === 'failed') return;
  let remote = r.external_id
    ? await cf.deployment(p.remote_name, r.external_id)
    : await cf.find(p.remote_name, await commit(r.id));
  if (!remote) return;
  const url = deploymentUrl(remote.url, p);
  if (!url || typeof remote.id !== 'string')
    throw new HttpError(502, '云平台返回了无法核实的部署地址');
  await env.DB.prepare('UPDATE releases SET external_id=?,url=?,updated_at=? WHERE id=?')
    .bind(remote.id, url, now(), r.id)
    .run();
  r.external_id = remote.id;
  r.url = url;
  const stage = remote.latest_stage?.status;
  if (stage === 'success') {
    const current = await cf.project(p.remote_name);
    const isCurrent = current.canonical_deployment?.id === remote.id;
    if (r.status !== 'success')
      await finish(env, p, r, 'success', null, isCurrent ? r.id : undefined);
    await verify(env, p, r, fetcher, isCurrent);
  } else if (['failure', 'canceled', 'cancelled'].includes(stage)) {
    if (r.status !== 'failed')
      await finish(env, p, r, 'failed', '云平台部署失败，请检查静态文件或平台限制');
  } else if (r.status !== 'deploying')
    await env.DB.prepare(
      "UPDATE releases SET status='deploying',error=NULL,updated_at=? WHERE id=?",
    )
      .bind(now(), r.id)
      .run();
}
async function detail(env: Env, p: Project) {
  return {
    project: p,
    url: 'https://' + p.remote_name + '.pages.dev',
    releases: (
      await env.DB.prepare(
        'SELECT * FROM releases WHERE project_id=? ORDER BY created_at DESC LIMIT 100',
      )
        .bind(p.id)
        .all<Release>()
    ).results,
  };
}
export async function projectsApi(request: Request, env: Env, fetcher: Fetch) {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  const admin = await authenticated(request, env.ADMIN_TOKEN);
  let agent: Agent | null = null;
  if (!admin) {
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
    if (token?.startsWith('nc_agent_'))
      agent = await env.DB.prepare(
        'SELECT id,project_id,allow_rollback FROM agent_tokens WHERE token_hash=? AND revoked=0 AND expires_at>?',
      )
        .bind(await sha256(token), now())
        .first<Agent>();
    if (!agent) throw new HttpError(401, '请登录或使用有效的项目 Agent Token');
  }
  if (!['GET', 'HEAD'].includes(method)) sameOrigin(request);
  if (path === '/api/projects' && method === 'GET')
    return json({
      items: agent
        ? (await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(agent.project_id).all())
            .results
        : (await env.DB.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()).results,
      limits: { files: 200, fileBytes: MAX_FILE, totalBytes: 10485760 },
      provider: 'cloudflare-pages',
    });
  if (path === '/api/projects' && method === 'POST') {
    if (!admin) throw new HttpError(403, '项目令牌不能创建其他项目');
    const b = await input(request),
      requestKey = key(b.requestKey);
    const existing = await env.DB.prepare('SELECT * FROM projects WHERE request_key=?')
      .bind(requestKey)
      .first<Project>();
    if (existing) {
      if (existing.name !== b.name?.trim() || existing.account_id !== b.accountId)
        throw new HttpError(409, 'requestKey 已用于不同的项目请求');
      return json(await detail(env, existing));
    }
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80)
      throw new HttpError(400, '项目名称需要 1–80 个字符');
    const id = crypto.randomUUID(),
      at = now();
    const p: Project = {
      id,
      account_id: b.accountId,
      name: b.name.trim(),
      remote_name: 'nc-' + id.replaceAll('-', '').slice(0, 24),
      status: 'new',
      current_release: null,
      active_task: null,
      error: null,
      created_at: at,
      updated_at: at,
      request_key: requestKey,
    };
    const cf = await cloud(env, p, fetcher, true);
    await cf.api(cf.root() + '?per_page=1');
    await env.DB.prepare(
      'INSERT INTO projects(id,account_id,name,remote_name,status,created_at,updated_at,request_key) VALUES(?,?,?,?,?,?,?,?)',
    )
      .bind(id, p.account_id, p.name, p.remote_name, 'new', at, at, requestKey)
      .run();
    return json(await detail(env, p), 201);
  }
  const match = path.match(/^\/api\/projects\/([a-f0-9-]{36})(?:\/(.*))?$/);
  if (!match) throw new HttpError(404, '项目接口不存在');
  if (agent && agent.project_id !== match[1]) throw new HttpError(403, '此令牌只能操作授权项目');
  let p = await project(env, match[1]);
  const action = match[2] ?? '';
  if (!action && method === 'GET') return json(await detail(env, p));
  if (action === 'provision' && method === 'POST') {
    if (!admin) throw new HttpError(403, '首次创建云端站点需由项目所有者操作');
    const cf = await cloud(env, p, fetcher, true);
    const claimed = await env.DB.prepare(
      "UPDATE projects SET status='provisioning',error=NULL,updated_at=? WHERE id=? AND status IN ('new','review_required')",
    )
      .bind(now(), p.id)
      .run();
    if (!claimed.meta.changes) throw new HttpError(409, '站点已就绪或创建中，请刷新核实');
    try {
      const remote = await cf.provision(p.remote_name);
      if (remote.name !== p.remote_name || remote.source)
        throw new HttpError(409, '远端项目类型不匹配');
      await env.DB.prepare("UPDATE projects SET status='ready',error=NULL,updated_at=? WHERE id=?")
        .bind(now(), p.id)
        .run();
    } catch (e) {
      await env.DB.prepare(
        "UPDATE projects SET status='review_required',error=?,updated_at=? WHERE id=?",
      )
        .bind(problem(e), now(), p.id)
        .run();
    }
    return json(await detail(env, await project(env, p.id)));
  }
  if (action === 'reconcile' && method === 'POST') {
    let remote: any;
    try {
      remote = await (await cloud(env, p, fetcher)).project(p.remote_name);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404 && p.status !== 'ready') {
        await env.DB.prepare(
          "UPDATE projects SET status='review_required',error=?,updated_at=? WHERE id=?",
        )
          .bind('远端暂未发现站点。请核实创建结果后，手动重新创建。', now(), p.id)
          .run();
        return json(await detail(env, await project(env, p.id)));
      }
      throw e;
    }
    if (remote.name !== p.remote_name || remote.source)
      throw new HttpError(409, '远端项目类型不匹配');
    await env.DB.prepare("UPDATE projects SET status='ready',error=NULL,updated_at=? WHERE id=?")
      .bind(now(), p.id)
      .run();
    return json(await detail(env, await project(env, p.id)));
  }
  if (action === 'tokens') {
    if (!admin) throw new HttpError(403, '只有所有者可以管理 Agent Token');
    if (method === 'GET')
      return json({
        items: (
          await env.DB.prepare(
            'SELECT id,name,allow_rollback,expires_at,revoked,created_at FROM agent_tokens WHERE project_id=? ORDER BY created_at DESC',
          )
            .bind(p.id)
            .all()
        ).results,
      });
    if (method === 'POST') {
      const b = await input(request);
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80)
        throw new HttpError(400, '请填写令牌名称');
      const days = Number(b.days ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 90)
        throw new HttpError(400, '有效期为 1–90 天');
      const token =
          'nc_agent_' +
          Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        id = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO agent_tokens(id,project_id,name,token_hash,allow_rollback,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',
      )
        .bind(
          id,
          p.id,
          b.name.trim(),
          await sha256(token),
          b.allowRollback === true ? 1 : 0,
          new Date(Date.now() + days * 86400000).toISOString(),
          now(),
        )
        .run();
      return json({ id, token }, 201);
    }
  }
  const revoke = action.match(/^tokens\/([a-f0-9-]{36})$/);
  if (revoke && method === 'DELETE') {
    if (!admin) throw new HttpError(403, '只有所有者可以撤销令牌');
    await env.DB.prepare('UPDATE agent_tokens SET revoked=1 WHERE id=? AND project_id=?')
      .bind(revoke[1], p.id)
      .run();
    return json({ ok: true });
  }
  if (action === 'releases' && method === 'POST') {
    await cloud(env, p, fetcher, true);
    if (p.status !== 'ready') throw new HttpError(409, '请先创建并确认云端站点');
    const b = await input(request),
      requestKey = key(b.requestKey);
    const existing = await env.DB.prepare(
      'SELECT * FROM releases WHERE project_id=? AND request_key=?',
    )
      .bind(p.id, requestKey)
      .first<Release>();
    let assets: Asset[];
    try {
      assets = validateAssets(b.files);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (existing) {
      const previous = await files(env, existing.id);
      const signature = (list: { path: string; size: number; sha256: string; hash: string }[]) =>
        JSON.stringify(
          list
            .map((f) => [f.path, f.size, f.sha256, f.hash])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        );
      if (existing.kind !== 'publish' || signature(previous) !== signature(assets))
        throw new HttpError(409, 'requestKey 已用于不同的发布内容');
      return json({ release: existing });
    }
    const id = crypto.randomUUID(),
      at = now(),
      message = typeof b.message === 'string' ? b.message.slice(0, 200) : '更新静态网页';
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO releases(id,project_id,message,created_at,updated_at,request_key) VALUES(?,?,?,?,?,?)',
      ).bind(id, p.id, message, at, at, requestKey),
      env.DB.prepare(
        "INSERT INTO release_files(release_id,path,hash,sha256,size,content_type) SELECT ?,json_extract(value,'$.path'),json_extract(value,'$.hash'),json_extract(value,'$.sha256'),json_extract(value,'$.size'),json_extract(value,'$.contentType') FROM json_each(?)",
      ).bind(id, JSON.stringify(assets)),
    ]);
    return json({ release: await release(env, p, id) }, 201);
  }
  const route = action.match(/^releases\/([a-f0-9-]{36})(?:\/(file|publish|check|resolve))?$/);
  if (route) {
    let r = await release(env, p, route[1]),
      part = route[2];
    if (!part && method === 'GET') return json({ release: r, files: await files(env, r.id) });
    if (part === 'resolve' && method === 'POST') {
      if (!admin) throw new HttpError(403, '只有所有者可以结束结果未知的任务');
      const b = await input(request);
      if (b.confirmName !== p.name || b.confirmRemoteAbsent !== true)
        throw new HttpError(400, '请先核实云控制台并确认完整项目名称');
      if (
        !['submitting', 'review_required'].includes(r.status) ||
        Date.now() - Date.parse(r.updated_at) < 120000
      )
        throw new HttpError(409, '仅可手动结束超过两分钟且结果未知的任务，请先检查结果');
      const cf = await cloud(env, p, fetcher);
      if (
        r.kind === 'publish' &&
        (r.external_id || (await cf.find(p.remote_name, await commit(r.id))))
      )
        throw new HttpError(409, '已找到远端部署，请检查结果，不能标记未部署');
      if (r.kind === 'rollback') {
        const target = await release(env, p, r.target_release!),
          remote = await cf.project(p.remote_name);
        if (remote.canonical_deployment?.id === target.external_id)
          throw new HttpError(409, '远端已经回滚，请检查结果');
      }
      await finish(env, p, r, 'failed', '所有者核实云控制台后结束未知任务；未重复提交云端操作');
      return json(await detail(env, await project(env, p.id)));
    }
    if (part === 'file' && method === 'PUT') {
      const cf = await cloud(env, p, fetcher, true);
      if (r.kind !== 'publish' || r.status !== 'uploading')
        throw new HttpError(409, '此版本不再接受文件');
      const f = (await files(env, r.id)).find((f) => f.path === url.searchParams.get('path'));
      if (!f) throw new HttpError(400, '文件不在已确认清单中');
      const bytes = await bytesLimited(request.body, MAX_FILE);
      if (
        bytes.length !== f.size ||
        (await sha(bytes)) !== f.sha256 ||
        assetHash(bytes, f.path) !== f.hash
      )
        throw new HttpError(400, '文件大小或校验值不匹配');
      if (!f.uploaded) {
        await cf.upload(p.remote_name, f.hash, base64Bytes(bytes), f.content_type);
        await env.DB.prepare('UPDATE release_files SET uploaded=1 WHERE release_id=? AND path=?')
          .bind(r.id, f.path)
          .run();
      }
      return json({ ok: true });
    }
    if (part === 'publish' && method === 'POST') {
      const cf = await cloud(env, p, fetcher, true);
      if (r.kind !== 'publish' || r.status !== 'uploading') return json({ release: r });
      const fs = await files(env, r.id);
      if (fs.some((f) => !f.uploaded)) throw new HttpError(409, '文件尚未全部上传');
      const claimed = await env.DB.batch([
        env.DB.prepare(
          "UPDATE projects SET active_task=? WHERE id=? AND active_task IS NULL AND current_release IS ? AND EXISTS(SELECT 1 FROM releases WHERE id=? AND status='uploading')",
        ).bind(r.id, p.id, p.current_release, r.id),
        env.DB.prepare(
          "UPDATE releases SET status='submitting',updated_at=? WHERE id=? AND status='uploading' AND EXISTS(SELECT 1 FROM projects WHERE id=? AND active_task=?)",
        ).bind(now(), r.id, p.id, r.id),
      ]);
      if (!claimed[0].meta.changes)
        throw new HttpError(409, '有发布或回滚任务待核实，或线上版本已变化，请刷新查看结果');
      let submitted = false;
      try {
        const remote = await cf.project(p.remote_name);
        const current = p.current_release ? await release(env, p, p.current_release) : null;
        if ((remote.canonical_deployment?.id ?? null) !== (current?.external_id ?? null))
          throw new HttpError(409, '线上版本已被其他控制台修改，请先核实，不会覆盖');
        submitted = true;
        const d = await cf.publish(
          p.remote_name,
          fs,
          await commit(r.id),
          'Newbie Cloud ' + r.id + ' ' + r.message,
        );
        if (typeof d.id !== 'string') throw new HttpError(502, '云平台未返回部署 ID');
        await env.DB.prepare(
          "UPDATE releases SET status='deploying',external_id=?,url=?,error=NULL,updated_at=? WHERE id=?",
        )
          .bind(d.id, deploymentUrl(d.url, p), now(), r.id)
          .run();
      } catch (e) {
        if (submitted && !(e instanceof PagesRejected)) {
          await env.DB.prepare(
            "UPDATE releases SET status='review_required',error=?,updated_at=? WHERE id=?",
          )
            .bind(problem(e), now(), r.id)
            .run();
        } else await finish(env, p, r, 'failed', problem(e));
      }
      return json({ release: await release(env, p, r.id) }, 202);
    }
    if (part === 'check' && method === 'POST') {
      await check(env, p, r, fetcher);
      return json(await detail(env, await project(env, p.id)));
    }
  }
  if (action === 'rollback' && method === 'POST') {
    if (agent && !agent.allow_rollback) throw new HttpError(403, '此 Agent Token 未授权回滚');
    const cf = await cloud(env, p, fetcher, true),
      b = await input(request),
      requestKey = key(b.requestKey);
    const existing = await env.DB.prepare(
      'SELECT * FROM releases WHERE project_id=? AND request_key=?',
    )
      .bind(p.id, requestKey)
      .first<Release>();
    if (existing) {
      if (existing.kind !== 'rollback' || existing.target_release !== b.targetReleaseId)
        throw new HttpError(409, 'requestKey 已用于不同的回滚请求');
      return json({ release: existing });
    }
    if (
      typeof b.expectedCurrentReleaseId !== 'string' ||
      p.current_release !== b.expectedCurrentReleaseId ||
      b.targetReleaseId === p.current_release
    )
      throw new HttpError(409, '当前版本已变化，请刷新并重新确认回滚');
    const target = await release(env, p, b.targetReleaseId);
    if (target.status !== 'success' || target.kind !== 'publish' || !target.external_id)
      throw new HttpError(400, '仅能回滚到本项目成功发布的版本');
    const id = crypto.randomUUID(),
      at = now();
    const locked = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO releases(id,project_id,kind,target_release,status,message,created_at,updated_at,request_key) SELECT ?,?,'rollback',?,'submitting',?,?,?,? FROM projects WHERE id=? AND active_task IS NULL AND current_release=?",
      ).bind(
        id,
        p.id,
        target.id,
        '回滚到 ' + target.id,
        at,
        at,
        requestKey,
        p.id,
        p.current_release,
      ),
      env.DB.prepare(
        'UPDATE projects SET active_task=? WHERE id=? AND active_task IS NULL AND current_release=? AND EXISTS(SELECT 1 FROM releases WHERE id=?)',
      ).bind(id, p.id, p.current_release, id),
    ]);
    if (!locked[0].meta.changes) throw new HttpError(409, '已有任务在执行或当前版本已变化');
    const r = await release(env, p, id);
    let submitted = false;
    try {
      const current = await release(env, p, p.current_release!),
        remote = await cf.project(p.remote_name);
      if (remote.canonical_deployment?.id !== current.external_id)
        throw new HttpError(409, '线上版本已被外部修改，请先核实');
      const previous = await cf.deployment(p.remote_name, target.external_id);
      if (previous.latest_stage?.status !== 'success' || previous.environment !== 'production')
        throw new HttpError(409, '目标版本在云平台上不可回滚');
      submitted = true;
      await cf.rollback(p.remote_name, target.external_id);
      await check(env, p, r, fetcher);
    } catch (e) {
      if (submitted && !(e instanceof PagesRejected))
        await env.DB.prepare(
          "UPDATE releases SET status='review_required',error=?,updated_at=? WHERE id=?",
        )
          .bind(problem(e), now(), r.id)
          .run();
      else await finish(env, p, r, 'failed', problem(e));
    }
    return json({ release: await release(env, p, id) }, 202);
  }
  throw new HttpError(404, '项目接口不存在');
}
