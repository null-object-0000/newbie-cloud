import type { Account, Credentials, Operation, Plan, Provider, DnsObservation } from '../shared';
import { domainName, freshDns } from '../inventory';
import { observeDns, saveInventoryPage } from './inventory';
import { authenticated, decrypt, encrypt, matches, sameOrigin, session, sha256 } from './crypto';
import { Cloud, validateCredentials } from './providers';
import { canonical, protectedRecord, recordInput } from './validation';
import { HttpError, now, type AccountRow, type Env, type Fetch, type ZoneRow } from './types';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
const publicAccount = (r: AccountRow): Account => ({
  id: r.id,
  name: r.name,
  provider: r.provider,
  readonly: !!r.readonly,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const publicZone = (z: ZoneRow) => ({
  id: z.id,
  accountId: z.account_id,
  externalId: z.external_id,
  name: z.name,
  status: z.status,
  updatedAt: z.updated_at,
});
const cookie = (value: string, request: Request, maxAge = 86400) =>
  `nc_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
const configured = (env: Env) =>
  !!env.ADMIN_TOKEN &&
  env.ADMIN_TOKEN.length >= 32 &&
  !env.ADMIN_TOKEN.startsWith('replace-with-') &&
  /^[A-Za-z0-9+/]{43}=$/.test(env.ENCRYPTION_KEY ?? '');
async function body(request: Request): Promise<Record<string, any>> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new HttpError(415, '请求内容必须为 JSON');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请求内容为空');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 16384) {
      await reader.cancel();
      throw new HttpError(413, '请求内容过大');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'JSON 格式无效');
  }
}
const accountContext = (row: AccountRow) => row.id + ':' + row.provider;
async function account(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM accounts WHERE id=?')
    .bind(id)
    .first<AccountRow>();
  if (!row) throw new HttpError(404, '云账号不存在');
  return row;
}
async function zone(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM zones WHERE id=?').bind(id).first<ZoneRow>();
  if (!row) throw new HttpError(404, '域名不存在，请先同步');
  return row;
}
async function cloud(env: Env, row: AccountRow, fetcher: Fetch) {
  return new Cloud(
    row.provider,
    await decrypt<Credentials>(row.credentials, env.ENCRYPTION_KEY, accountContext(row)),
    fetcher,
  );
}
async function assertDnsSource(env: Env, row: AccountRow, z: ZoneRow) {
  const observed = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
    .bind('dns:' + domainName(z.name))
    .first<{ value: string }>();
  const dns: DnsObservation | undefined = observed ? JSON.parse(observed.value) : undefined;
  if (freshDns(dns) && dns?.provider && dns.provider !== row.provider)
    throw new HttpError(409, '此区域不是公共 NS 当前指向的平台，仅可查看配置，不能执行 DNS 写入');
}
async function log(
  env: Env,
  accountId: string | null,
  kind: string,
  summary: string,
  status = 'success',
  result: unknown = null,
) {
  const id = crypto.randomUUID(),
    at = now();
  await env.DB.prepare(
    'INSERT INTO operations(id,account_id,kind,status,summary,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      accountId,
      kind,
      status,
      summary,
      result === null ? null : JSON.stringify(result),
      at,
      at,
    )
    .run();
  return id;
}
async function snapshot(env: Env, accountId: string, kind: string, data: unknown) {
  await env.DB.prepare(
    'INSERT INTO snapshots(account_id,kind,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
  )
    .bind(accountId, kind, JSON.stringify(data), now())
    .run();
}

export function createApp(fetcher: Fetch = fetch) {
  async function api(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url),
      p = url.pathname,
      method = request.method;
    if (p === '/api/health')
      return json({ name: 'Newbie Cloud', version: '0.1.0', configured: configured(env) });
    if (!configured(env))
      throw new HttpError(503, '请先配置 ADMIN_TOKEN 和 ENCRYPTION_KEY 两个部署密钥');
    if (p === '/api/login' && method === 'POST') {
      sameOrigin(request);
      const input = await body(request);
      if (
        typeof input.token !== 'string' ||
        input.token.length > 512 ||
        !(await matches(input.token, env.ADMIN_TOKEN))
      )
        throw new HttpError(401, '管理密钥不正确');
      const response = json({ ok: true });
      response.headers.set('Set-Cookie', cookie(await session(env.ADMIN_TOKEN), request));
      return response;
    }
    if (!(await authenticated(request, env.ADMIN_TOKEN))) throw new HttpError(401, '请先登录');
    if (!['GET', 'HEAD'].includes(method)) sameOrigin(request);
    if (p === '/api/me')
      return json({ authenticated: true, features: { githubDeploy: !!env.GITHUB_TOKEN } });
    if (p === '/api/dns-observations' && method === 'GET') {
      const rows = await env.DB.prepare("SELECT value FROM settings WHERE key LIKE 'dns:%'").all<{
        value: string;
      }>();
      return json({ items: rows.results.map((r) => JSON.parse(r.value)) });
    }
    if (p === '/api/dns-observations' && method === 'POST') {
      const input = await body(request),
        name = domainName(String(input.name ?? ''));
      if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name) || !name.includes('.'))
        throw new HttpError(400, '域名格式无效');
      let known = !!(await env.DB.prepare('SELECT id FROM zones WHERE LOWER(name)=?')
        .bind(name)
        .first());
      if (!known) {
        const rows = await env.DB.prepare(
          "SELECT data FROM snapshots WHERE kind='registrations'",
        ).all<{ data: string }>();
        known = rows.results.some((r) =>
          JSON.parse(r.data).some((d: any) => domainName(d.name) === name),
        );
      }
      if (!known) throw new HttpError(404, '请先同步已连接账号中的域名');
      const result = await observeDns(name, fetcher);
      await env.DB.prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
        .bind('dns:' + name, JSON.stringify(result))
        .run();
      return json(result);
    }
    const inventoryRoute = p.match(
      /^\/api\/accounts\/([^/]+)\/inventory\/(registrations|services|certificates|email|records)$/,
    );
    if (inventoryRoute && method === 'POST') {
      const row = await account(env, inventoryRoute[1]),
        category = inventoryRoute[2],
        input = await body(request);
      let target: ZoneRow | undefined;
      if (input.zoneId) {
        target = await zone(env, String(input.zoneId));
        if (target.account_id !== row.id) throw new HttpError(403, '域名不属于当前账号');
      }
      if (
        (category === 'records' ||
          category === 'email' ||
          (category === 'certificates' && row.provider === 'cloudflare')) &&
        !target
      )
        throw new HttpError(400, '此资源需要指定域名；全部刷新会逐个检查所有域名');
      const kind = category + (target ? ':' + target.id : '');
      try {
        const client = await cloud(env, row, fetcher);
        const result = await saveInventoryPage(env, row.id, kind, input, (page, providerCursor) =>
          category === 'registrations'
            ? client.registrations(page, providerCursor)
            : category === 'services'
              ? client.servicesPage(page)
              : category === 'email'
                ? client.emailPage(target!, page)
                : category === 'records'
                  ? client.records(target!, page)
                  : client.certificatesPage(target, page),
        );
        if (result.complete) {
          await env.DB.prepare('DELETE FROM snapshots WHERE account_id=? AND kind=?')
            .bind(row.id, 'issue:' + kind)
            .run();
          await log(
            env,
            row.id,
            'inventory',
            '同步资源：' + row.name + ' / ' + category,
            'success',
            { count: result.count },
          );
        }
        return json(result);
      } catch (error) {
        await snapshot(env, row.id, 'issue:' + kind, [
          {
            message:
              error instanceof HttpError ? error.message : '资源同步失败，已保留上次完整快照',
          },
        ]);
        throw error;
      }
    }
    if (p === '/api/logout' && method === 'POST') {
      const response = json({ ok: true });
      response.headers.set('Set-Cookie', cookie('', request, 0));
      return response;
    }
    if (p === '/api/accounts' && method === 'GET')
      return json({
        items: (
          await env.DB.prepare('SELECT * FROM accounts ORDER BY created_at').all<AccountRow>()
        ).results.map(publicAccount),
      });
    if (p === '/api/accounts' && method === 'POST') {
      const input = await body(request);
      if (!['cloudflare', 'tencent', 'aliyun'].includes(input.provider))
        throw new HttpError(400, '不支持的云平台');
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 80) throw new HttpError(400, '账号名称须为 1–80 个字符');
      const provider = input.provider as Provider,
        credentials = validateCredentials(provider, input.credentials),
        id = crypto.randomUUID(),
        at = now();
      const encrypted = await encrypt(credentials, env.ENCRYPTION_KEY, id + ':' + provider);
      await env.DB.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?)')
        .bind(id, name, provider, input.readonly !== false ? 1 : 0, encrypted, at, at)
        .run();
      await log(env, id, 'account', '添加云账号：' + name);
      return json({ account: publicAccount(await account(env, id)) }, 201);
    }
    const accountRoute = p.match(/^\/api\/accounts\/([^/]+)(?:\/(sync|services|certificates))?$/);
    if (accountRoute) {
      const row = await account(env, accountRoute[1]),
        action = accountRoute[2];
      if (!action && method === 'PATCH') {
        const input = await body(request);
        let name = row.name,
          readonly = row.readonly,
          encrypted = row.credentials;
        if (input.name !== undefined) {
          if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)
            throw new HttpError(400, '账号名称无效');
          name = input.name.trim();
        }
        if (input.readonly !== undefined) {
          if (typeof input.readonly !== 'boolean') throw new HttpError(400, '只读设置无效');
          readonly = input.readonly ? 1 : 0;
        }
        if (input.credentials) {
          const old = await decrypt<Credentials>(
            row.credentials,
            env.ENCRYPTION_KEY,
            accountContext(row),
          );
          const next = validateCredentials(row.provider, { ...old, ...input.credentials });
          encrypted = await encrypt(next, env.ENCRYPTION_KEY, accountContext(row));
        }
        await env.DB.prepare(
          'UPDATE accounts SET name=?,readonly=?,credentials=?,updated_at=? WHERE id=?',
        )
          .bind(name, readonly, encrypted, now(), row.id)
          .run();
        await log(env, row.id, 'account', '更新云账号：' + name);
        return json({ account: publicAccount(await account(env, row.id)) });
      }
      if (!action && method === 'DELETE') {
        await env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(row.id).run();
        return json({ ok: true });
      }
      if (action === 'sync' && method === 'POST') {
        const input = await body(request),
          cursor = Number(input.cursor ?? 1);
        if (!Number.isInteger(cursor) || cursor < 1 || cursor > 1000)
          throw new HttpError(400, '分页参数无效');
        const data = await (await cloud(env, row, fetcher)).zones(cursor),
          at = now();
        if (data.items.length)
          await env.DB.batch(
            data.items.map((z) =>
              env.DB.prepare(
                'INSERT INTO zones(id,account_id,external_id,name,status,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,external_id) DO UPDATE SET name=excluded.name,status=excluded.status,updated_at=excluded.updated_at',
              ).bind(row.id + ':' + z.id, row.id, z.id, z.name, z.status, at),
            ),
          );
        await log(env, row.id, 'sync', '同步域名：' + row.name, 'success', {
          count: data.items.length,
          page: cursor,
          nextCursor: data.nextCursor,
        });
        return json({ count: data.items.length, nextCursor: data.nextCursor });
      }
      if (action === 'services' && method === 'POST') {
        const items = await (await cloud(env, row, fetcher)).services();
        await snapshot(env, row.id, 'services', items);
        await log(env, row.id, 'inspect', '刷新托管服务：' + row.name);
        return json({ items });
      }
      if (action === 'certificates' && method === 'POST') {
        const input = await body(request);
        let target: ZoneRow | undefined;
        if (input.zoneId) {
          target = await zone(env, String(input.zoneId));
          if (target.account_id !== row.id) throw new HttpError(403, '域名不属于当前账号');
        }
        const items = await (await cloud(env, row, fetcher)).certificates(target);
        await snapshot(env, row.id, 'certificates' + (target ? ':' + target.id : ''), items);
        await log(env, row.id, 'certificate', '检查证书：' + (target?.name ?? row.name));
        return json({ items });
      }
    }
    if (p === '/api/zones' && method === 'GET')
      return json({
        items: (
          await env.DB.prepare('SELECT * FROM zones ORDER BY name').all<ZoneRow>()
        ).results.map(publicZone),
      });
    const zoneRoute = p.match(/^\/api\/zones\/(.+)\/(records|email)$/);
    if (zoneRoute && method === 'GET') {
      const z = await zone(env, decodeURIComponent(zoneRoute[1])),
        row = await account(env, z.account_id),
        client = await cloud(env, row, fetcher);
      if (zoneRoute[2] === 'email') return json({ items: await client.email(z) });
      const page = Number(url.searchParams.get('page') ?? 1);
      if (!Number.isInteger(page) || page < 1 || page > 1000)
        throw new HttpError(400, '分页参数无效');
      return json(await client.records(z, page));
    }
    if (p === '/api/dns/plan' && method === 'POST') {
      const input = await body(request);
      const z = await zone(env, String(input.zoneId)),
        row = await account(env, z.account_id);
      if (row.readonly) throw new HttpError(403, '此账号为只读，不能生成 DNS 写入计划');
      await assertDnsSource(env, row, z);
      if (!['create', 'update', 'delete'].includes(input.action))
        throw new HttpError(400, '操作类型无效');
      const client = await cloud(env, row, fetcher),
        id = crypto.randomUUID(),
        at = now();
      const before =
        input.action === 'create' ? null : await client.record(z, String(input.recordId));
      if (before?.disabled && input.action === 'update')
        throw new HttpError(400, '此记录已停用，请先在原平台核对状态后再编辑');
      const after =
        input.action === 'delete' ? null : recordInput(input.record, z.name, row.provider);
      if (after && row.provider !== 'cloudflare')
        after.line = before?.line ?? after.line ?? (row.provider === 'aliyun' ? 'default' : '0');
      const plan: Plan & { accountVersion: string } = {
        accountId: row.id,
        accountVersion: row.updated_at + '|' + (await sha256(row.credentials)),
        zoneId: z.id,
        zoneName: z.name,
        action: input.action,
        recordId: before?.id,
        before,
        after,
        protected: protectedRecord(before) || protectedRecord(after),
      };
      const expires = new Date(Date.now() + 15 * 60000).toISOString();
      await env.DB.prepare(
        'INSERT INTO operations(id,account_id,zone_id,kind,status,summary,payload,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
        .bind(
          id,
          row.id,
          z.id,
          'dns',
          'planned',
          `${input.action} ${after?.type ?? before?.type} ${after?.name ?? before?.name}`,
          JSON.stringify(plan),
          at,
          at,
          expires,
        )
        .run();
      return json({ id, plan, expiresAt: expires }, 201);
    }
    const apply = p.match(/^\/api\/dns\/apply\/([^/]+)$/);
    if (apply && method === 'POST') {
      const input = await body(request),
        op = await env.DB.prepare('SELECT * FROM operations WHERE id=? AND kind=?')
          .bind(apply[1], 'dns')
          .first<Operation>();
      if (!op || !op.payload) throw new HttpError(404, '写入计划不存在');
      if (op.status !== 'planned') throw new HttpError(409, '此计划已处理，不能重复执行');
      if (!op.expires_at || op.expires_at < now())
        throw new HttpError(409, '预览已过期，请重新生成');
      const plan = JSON.parse(op.payload) as Plan & { accountVersion: string },
        row = await account(env, plan.accountId),
        z = await zone(env, plan.zoneId);
      if (row.readonly) throw new HttpError(403, '此账号已设为只读');
      await assertDnsSource(env, row, z);
      if (row.updated_at + '|' + (await sha256(row.credentials)) !== plan.accountVersion)
        throw new HttpError(409, '云账号设置已变化，请重新预览');
      if (plan.protected && (input.acknowledgeProtected !== true || input.confirmDomain !== z.name))
        throw new HttpError(400, '此记录关联邮箱、委派或证书验证，请确认用途并输入完整域名');
      const client = await cloud(env, row, fetcher);
      if (plan.before) {
        const current = await client.record(z, plan.before.id);
        if (canonical(current) !== canonical(plan.before))
          throw new HttpError(409, '远端记录在预览后已变化，请刷新并重新预览');
      }
      const claimed = await env.DB.prepare(
        'UPDATE operations SET status=?,updated_at=? WHERE id=? AND status=? AND expires_at>?',
      )
        .bind('applying', now(), op.id, 'planned', now())
        .run();
      if (claimed.meta.changes !== 1) throw new HttpError(409, '此计划正在执行或已过期');
      try {
        const result = await client.write(z, plan.action, plan.after, plan.recordId, plan.before);
        await env.DB.prepare('UPDATE operations SET status=?,result=?,updated_at=? WHERE id=?')
          .bind('success', JSON.stringify(result), now(), op.id)
          .run();
        return json({ ok: true, result });
      } catch (error) {
        await env.DB.prepare('UPDATE operations SET status=?,result=?,updated_at=? WHERE id=?')
          .bind(
            'review_required',
            JSON.stringify({
              message:
                error instanceof HttpError ? error.message : '操作结果未确认，请核对云平台记录',
            }),
            now(),
            op.id,
          )
          .run();
        throw error;
      }
    }
    if (p === '/api/operations' && method === 'GET')
      return json({
        items: (
          await env.DB.prepare('SELECT * FROM operations ORDER BY created_at DESC LIMIT 100').all()
        ).results,
      });
    if (p === '/api/snapshots' && method === 'GET')
      return json({
        items: (
          await env.DB.prepare(
            "SELECT account_id,kind,data,updated_at FROM snapshots WHERE kind NOT LIKE 'pending:%' ORDER BY updated_at DESC",
          ).all()
        ).results.map((r: any) => ({ ...r, data: JSON.parse(r.data) })),
      });
    if (p === '/api/github/dispatch' && method === 'POST') {
      if (!env.GITHUB_TOKEN)
        throw new HttpError(
          400,
          '请先在 Workers Secrets 配置 GITHUB_TOKEN，仅需目标仓库 Actions 写权限',
        );
      const input = await body(request),
        repository = String(input.repository ?? ''),
        workflow = String(input.workflow ?? ''),
        ref = String(input.ref ?? 'main');
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
        !/^[-A-Za-z0-9_.]+\.ya?ml$/.test(workflow) ||
        !/^[-A-Za-z0-9_./]{1,128}$/.test(ref)
      )
        throw new HttpError(400, '仓库、工作流文件名或分支格式无效');
      const response = await fetcher.call(
        globalThis,
        `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
        {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: 'Bearer ' + env.GITHUB_TOKEN,
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Newbie-Cloud',
          },
          body: JSON.stringify({ ref }),
        },
      );
      if (response.status !== 204)
        throw new HttpError(
          502,
          'GitHub 未接受部署请求，请检查仓库权限、分支及 workflow_dispatch 配置',
        );
      const link = `https://github.com/${repository}/actions`;
      await log(env, null, 'deploy', '提交部署：' + repository + ' / ' + workflow, 'success', {
        url: link,
        ref,
      });
      return json({ ok: true, url: link });
    }
    throw new HttpError(404, '接口不存在');
  }
  return {
    async fetch(request: Request, env: Env) {
      const url = new URL(request.url);
      let response: Response;
      try {
        response = url.pathname.startsWith('/api/')
          ? await api(request, env)
          : await env.ASSETS.fetch(request);
      } catch (e) {
        response = json(
          {
            error:
              e instanceof HttpError ? e.message : '服务暂时不可用，请检查数据库迁移与部署配置',
          },
          e instanceof HttpError ? e.status : 500,
        );
      }
      const headers = new Headers(response.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'same-origin');
      headers.set('X-Frame-Options', 'DENY');
      headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      return new Response(response.body, { status: response.status, headers });
    },
    async scheduled(_event: ScheduledEvent, env: Env) {
      // One read-only cloud request group per tick. Never deploy or mutate DNS in cron.
      const rows = (await env.DB.prepare('SELECT * FROM accounts ORDER BY id').all<AccountRow>())
        .results;
      if (!rows.length) return;
      const offset = Number(
          (
            await env.DB.prepare("SELECT value FROM settings WHERE key='cron_cursor'").first<{
              value: string;
            }>()
          )?.value ?? 0,
        ),
        row = rows[offset % rows.length];
      await env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES('cron_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
        .bind(String(offset + 1))
        .run();
      const count =
        row.provider === 'cloudflare'
          ? ((
              await env.DB.prepare('SELECT COUNT(*) AS total FROM zones WHERE account_id=?')
                .bind(row.id)
                .first<{ total: number }>()
            )?.total ?? 0)
          : 0;
      const target =
        row.provider === 'cloudflare' && count
          ? await env.DB.prepare(
              'SELECT * FROM zones WHERE account_id=? ORDER BY id LIMIT 1 OFFSET ?',
            )
              .bind(row.id, Math.floor(offset / rows.length) % count)
              .first<ZoneRow>()
          : undefined;
      if (row.provider === 'cloudflare' && !target) return;
      try {
        const page = await (await cloud(env, row, fetcher)).certificatesPage(target ?? undefined);
        // A sampled cron check must never overwrite the complete inventory with a first page.
        if (!page.nextCursor)
          await snapshot(env, row.id, 'certificates' + (target ? ':' + target.id : ''), page.items);
        await log(env, row.id, 'certificate', '定时检查：' + (target?.name ?? row.name));
      } catch (e) {
        await log(env, row.id, 'certificate', '定时检查未完成：' + row.name, 'failed', {
          message: e instanceof HttpError ? e.message : '云平台请求未完成',
        });
      }
      await env.DB.prepare(
        "DELETE FROM operations WHERE kind!='dns' AND created_at < datetime('now','-30 days')",
      ).run();
    },
  };
}
export default createApp();
