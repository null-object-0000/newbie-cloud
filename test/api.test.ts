import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createApp } from '../src/server/index';
import { decrypt, encrypt } from '../src/server/crypto';
import { Cloud } from '../src/server/providers';
import { recordInput } from '../src/server/validation';
import { saveInventoryPage } from '../src/server/inventory';
import type { Env, Fetch } from '../src/server/types';

const token = 'example-admin-key-for-tests-only-32-characters';
const key = Buffer.alloc(32, 7).toString('base64');
let mf: Miniflare,
  env: Env,
  writes = 0;
let record = {
  id: 'record-one',
  type: 'A',
  name: 'www.example.com',
  content: '192.0.2.1',
  ttl: 300,
  proxied: false,
};
const upstream: Fetch = async (input, init) => {
  const url = new URL(String(input)),
    method = init?.method ?? 'GET';
  assert.equal(
    url.hostname,
    'api.cloudflare.com',
    'credentials must only go to the fixed Cloudflare endpoint',
  );
  assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer example-api-token');
  if (url.pathname === '/client/v4/zones')
    return Response.json({
      success: true,
      result: [{ id: 'zone-one', name: 'example.com', status: 'active' }],
      result_info: { total_pages: 1 },
    });
  if (url.pathname.endsWith('/dns_records/record-one') && method === 'GET')
    return Response.json({ success: true, result: record });
  if (url.pathname.endsWith('/dns_records') && method === 'GET')
    return Response.json({ success: true, result: [record], result_info: { total_pages: 1 } });
  if (method !== 'GET') {
    writes++;
    return Response.json({ success: true, result: { id: 'written-record' } });
  }
  return Response.json({ success: true, result: [] });
};
const app = createApp(upstream);
async function call(
  path: string,
  method = 'GET',
  data?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app.fetch(
    new Request('https://app.example' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    }),
    env,
  );
  return { response, body: (await response.json()) as any };
}
async function add(readonly = true) {
  const result = await call('/api/accounts', 'POST', {
    name: '个人账号',
    provider: 'cloudflare',
    readonly,
    credentials: { apiToken: 'example-api-token', accountId: 'account-example' },
  });
  assert.equal(result.response.status, 201);
  const id = result.body.account.id;
  await call('/api/accounts/' + id + '/sync', 'POST', {});
  const zones = await call('/api/zones');
  return { id, zoneId: zones.body.items[0].id };
}
before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-11-15',
      d1Databases: { DB: 'test-newbie-cloud' },
    }),
  );
  const db = await mf.getD1Database('DB');
  await db.exec(fs.readFileSync('migrations/0001_initial.sql', 'utf8').replaceAll('\n', ' '));
  env = {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: async () => new Response('assets') } as Fetcher,
    ADMIN_TOKEN: token,
    ENCRYPTION_KEY: key,
  };
});
after(async () => mf?.dispose());
beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM operations; DELETE FROM snapshots; DELETE FROM zones; DELETE FROM accounts; DELETE FROM settings;',
  );
  writes = 0;
  record = {
    id: 'record-one',
    type: 'A',
    name: 'www.example.com',
    content: '192.0.2.1',
    ttl: 300,
    proxied: false,
  };
});

test('unauthenticated requests and forged sessions cannot read cloud resources', async () => {
  const response = await app.fetch(new Request('https://app.example/api/accounts'), env);
  assert.equal(response.status, 401);
  const forged = await app.fetch(
    new Request('https://app.example/api/accounts', {
      headers: { Cookie: 'nc_session=forged.signature' },
    }),
    env,
  );
  assert.equal(forged.status, 401);
  const health = await call('/api/health');
  assert.equal(health.body.configured, true);
  assert.ok(!JSON.stringify(health.body).includes(token));
});
test('browser sessions are HttpOnly, same-origin mutations reject CSRF, and logout clears cookies', async () => {
  const response = await app.fetch(
    new Request('https://app.example/api/login', {
      method: 'POST',
      headers: { Origin: 'https://app.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  const attack = await app.fetch(
    new Request('https://app.example/api/accounts', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://attacker.example',
        'Content-Type': 'application/json',
        Authorization: 'Basic fake',
      },
      body: '{}',
    }),
    env,
  );
  assert.equal(attack.status, 403);
  const loggedOut = await app.fetch(
    new Request('https://app.example/api/logout', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://app.example' },
    }),
    env,
  );
  assert.match(loggedOut.headers.get('set-cookie')!, /Max-Age=0/);
});
test('cloud credentials are encrypted at rest and never returned in account or audit responses', async () => {
  const { id } = await add();
  const row = await env.DB.prepare('SELECT credentials FROM accounts WHERE id=?')
    .bind(id)
    .first<{ credentials: string }>();
  assert.ok(!row!.credentials.includes('example-api-token'));
  assert.equal(
    (await decrypt<any>(row!.credentials, key, id + ':cloudflare')).apiToken,
    'example-api-token',
  );
  const all = JSON.stringify([
    (await call('/api/accounts')).body,
    (await call('/api/operations')).body,
  ]);
  assert.ok(!all.includes('example-api-token'));
  assert.ok(!all.includes('credentials'));
  await assert.rejects(decrypt(row!.credentials, key, 'another-account:cloudflare'));
});
test('read-only accounts cannot plan DNS mutations; synchronization only reads upstream', async () => {
  const { zoneId } = await add();
  const result = await call('/api/dns/plan', 'POST', {
    zoneId,
    action: 'create',
    record: { type: 'A', name: 'new', content: '192.0.2.2', ttl: 300 },
  });
  assert.equal(result.response.status, 403);
  assert.equal(writes, 0);
});
test('DNS writes require a stored preview, preserve original state, and a plan executes only once', async () => {
  const { zoneId } = await add(false);
  const preview = await call('/api/dns/plan', 'POST', {
    zoneId,
    action: 'update',
    recordId: 'record-one',
    record: { type: 'A', name: 'www', content: '192.0.2.2', ttl: 600 },
  });
  assert.equal(preview.response.status, 201);
  assert.equal(writes, 0);
  assert.equal(preview.body.plan.before.content, '192.0.2.1');
  assert.equal(preview.body.plan.after.name, 'www.example.com');
  assert.equal((await call('/api/dns/apply/' + preview.body.id, 'POST', {})).response.status, 200);
  assert.equal(writes, 1);
  assert.equal((await call('/api/dns/apply/' + preview.body.id, 'POST', {})).response.status, 409);
  assert.equal(writes, 1);
  const operations = await call('/api/operations');
  assert.equal(operations.body.items.find((o: any) => o.id === preview.body.id).status, 'success');
});
test('MX changes require explicit dependency acknowledgement and matching zone name', async () => {
  const { zoneId } = await add(false);
  const p = await call('/api/dns/plan', 'POST', {
    zoneId,
    action: 'create',
    record: { type: 'MX', name: '@', content: 'mail.example.net', priority: 10, ttl: 600 },
  });
  assert.equal(p.body.plan.protected, true);
  assert.equal((await call('/api/dns/apply/' + p.body.id, 'POST', {})).response.status, 400);
  assert.equal(writes, 0);
  assert.equal(
    (
      await call('/api/dns/apply/' + p.body.id, 'POST', {
        acknowledgeProtected: true,
        confirmDomain: 'wrong.example',
      })
    ).response.status,
    400,
  );
  assert.equal(
    (
      await call('/api/dns/apply/' + p.body.id, 'POST', {
        acknowledgeProtected: true,
        confirmDomain: 'example.com',
      })
    ).response.status,
    200,
  );
  assert.equal(writes, 1);
});
test('external edits, expired previews and account permission changes invalidate approval', async () => {
  const { id, zoneId } = await add(false);
  const p = await call('/api/dns/plan', 'POST', {
    zoneId,
    action: 'delete',
    recordId: 'record-one',
  });
  record.ttl = 600;
  assert.equal((await call('/api/dns/apply/' + p.body.id, 'POST', {})).response.status, 409);
  assert.equal(writes, 0);
  record.ttl = 300;
  await env.DB.prepare('UPDATE operations SET expires_at=? WHERE id=?')
    .bind('2020-01-01T00:00:00Z', p.body.id)
    .run();
  assert.equal((await call('/api/dns/apply/' + p.body.id, 'POST', {})).response.status, 409);
  const q = await call('/api/dns/plan', 'POST', {
    zoneId,
    action: 'delete',
    recordId: 'record-one',
  });
  await call('/api/accounts/' + id, 'PATCH', { readonly: true });
  assert.equal((await call('/api/dns/apply/' + q.body.id, 'POST', {})).response.status, 403);
  assert.equal(writes, 0);
});
test('a provider timeout marks the operation for review and never automatically repeats a write', async () => {
  const { zoneId } = await add(false);
  const p = await call('/api/dns/plan', 'POST', {
    zoneId,
    action: 'delete',
    recordId: 'record-one',
  });
  const failing = createApp(async (input, init) => {
    if (init?.method === 'DELETE') throw Error('network failure');
    return upstream(input, init);
  });
  const request = () =>
    new Request('https://app.example/api/dns/apply/' + p.body.id, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}',
    });
  assert.equal((await failing.fetch(request(), env)).status, 502);
  assert.equal((await failing.fetch(request(), env)).status, 409);
  assert.equal(
    (await env.DB.prepare('SELECT status FROM operations WHERE id=?').bind(p.body.id).first<any>())
      .status,
    'review_required',
  );
});
test('body size and DNS input validation reject unsafe or unsupported mutations', async () => {
  const result = await call('/api/accounts', 'POST', { large: 'x'.repeat(17000) });
  assert.equal(result.response.status, 413);
  assert.throws(() =>
    recordInput(
      { type: 'A', name: 'www', content: '999.1.2.3', ttl: 300 },
      'example.com',
      'cloudflare',
    ),
  );
  assert.throws(() =>
    recordInput(
      { type: 'CNAME', name: 'evil.test.', content: 'target.example', ttl: 300 },
      'example.com',
      'cloudflare',
    ),
  );
  assert.throws(() =>
    recordInput(
      { type: 'NS', name: '@', content: 'https://evil.test/path', ttl: 300 },
      'example.com',
      'cloudflare',
    ),
  );
  assert.equal(
    recordInput(
      { type: 'AAAA', name: '@', content: '2001:db8::1', ttl: 300 },
      'example.com',
      'cloudflare',
    ).content,
    '2001:db8::1',
  );
});
test('Tencent and Alibaba record adapters retain provider-specific line and MX fields', async () => {
  let tcBody: any;
  const tc = new Cloud(
    'tencent',
    { secretId: 'example-id', secretKey: 'example-secret' },
    async (input, init) => {
      assert.equal(new URL(String(input)).hostname, 'dnspod.tencentcloudapi.com');
      tcBody = JSON.parse(String(init?.body));
      assert.match(new Headers(init?.headers).get('Authorization')!, /TC3-HMAC-SHA256/);
      return Response.json({ Response: { RecordId: 9 } });
    },
  );
  await tc.write(
    { external_id: '1', name: 'example.com' },
    'update',
    {
      type: 'MX',
      name: 'mail.example.com',
      content: 'target.example',
      ttl: 600,
      priority: 5,
      line: '10',
    },
    '9',
  );
  assert.equal(tcBody.RecordLineId, '10');
  assert.equal(tcBody.MX, 5);
  assert.equal(tcBody.SubDomain, 'mail');
  let query: URLSearchParams;
  const ali = new Cloud(
    'aliyun',
    { accessKeyId: 'example-id', accessKeySecret: 'example-secret' },
    async (input) => {
      const u = new URL(String(input));
      assert.equal(u.hostname, 'alidns.aliyuncs.com');
      query = u.searchParams;
      return Response.json({ RecordId: '10' });
    },
  );
  await ali.write({ external_id: '1', name: 'example.com' }, 'create', {
    type: 'MX',
    name: 'example.com',
    content: 'mail.example',
    ttl: 600,
    priority: 8,
    line: 'default',
  });
  assert.equal(query!.get('RR'), '@');
  assert.equal(query!.get('Priority'), '8');
  assert.equal(query!.get('Action'), 'AddDomainRecord');
  assert.ok(query!.get('Signature'));
});
test('scheduled inspection is read-only and records missing certificate permissions as a failure', async () => {
  await add();
  const inspecting = createApp(async () =>
    Response.json({ success: false, errors: [{ message: 'permission denied' }] }),
  );
  await inspecting.scheduled({} as ScheduledEvent, env);
  assert.equal(writes, 0);
  const o = await call('/api/operations');
  assert.ok(o.body.items.some((o: any) => o.kind === 'certificate' && o.status === 'failed'));
});
test('AES-GCM detects tampered ciphertext and requires a proper master key', async () => {
  const sealed = await encrypt({ secret: 'example' }, key, 'account');
  assert.deepEqual(await decrypt(sealed, key, 'account'), { secret: 'example' });
  const envelope = JSON.parse(sealed);
  envelope.data = 'AAAA' + envelope.data.slice(4);
  await assert.rejects(decrypt(JSON.stringify(envelope), key, 'account'));
  await assert.rejects(encrypt({}, 'bad-key', 'account'));
});
test('Makers gateway uses zero-based project pagination, a signed action and the required region', async () => {
  const client = new Cloud(
    'tencent',
    { secretId: 'example-id', secretKey: 'example-secret', workspaceId: 'zone-example' },
    async (input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('X-TC-Region'), 'ap-guangzhou');
      assert.match(headers.get('Authorization')!, /SignedHeaders=content-type;host;x-tc-action/);
      const envelope = JSON.parse(String(init?.body));
      assert.equal(JSON.parse(envelope.Payload).Offset, 0);
      return Response.json({
        Response: {
          Result: {
            Projects: [
              { ProjectId: 'example-project', Name: 'Example', Area: 'global', Status: 'online' },
            ],
            TotalCount: 1,
          },
        },
      });
    },
  );
  const projects = await client.services();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'Example');
  const certs = new Cloud(
    'tencent',
    { secretId: 'example-id', secretKey: 'example-secret', workspaceId: 'zone-example' },
    async () =>
      Response.json({
        Response: {
          HostCertificates: [
            {
              Host: 'example.com',
              Mode: 'eofreecert',
              HostCertInfo: [
                { CertId: 'example-cert', Status: 'deployed', ExpireTime: '2030-01-01T00:00:00Z' },
              ],
            },
          ],
        },
      }),
  );
  assert.equal((await certs.certificates()).length, 1);
});
test('GitHub dispatch stays disabled without a token and records dispatch separately from build completion', async () => {
  assert.equal(
    (
      await call('/api/github/dispatch', 'POST', {
        repository: 'owner/repo',
        workflow: 'deploy.yml',
      })
    ).response.status,
    400,
  );
  const dispatcher = createApp(async (input, init) => {
    assert.equal(
      String(input),
      'https://api.github.com/repos/owner/repo/actions/workflows/deploy.yml/dispatches',
    );
    assert.equal(JSON.parse(String(init?.body)).ref, 'main');
    return new Response(null, { status: 204 });
  });
  const response = await dispatcher.fetch(
    new Request('https://app.example/api/github/dispatch', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository: 'owner/repo', workflow: 'deploy.yml', ref: 'main' }),
    }),
    { ...env, GITHUB_TOKEN: 'example-github-token' },
  );
  assert.equal(response.status, 200);
  const ops = await call('/api/operations');
  assert.ok(ops.body.items.some((o: any) => o.kind === 'deploy'));
  assert.ok(!JSON.stringify(ops.body).includes('example-github-token'));
});

test('inventory pages only publish a complete snapshot and a failed refresh retains the previous inventory', async () => {
  const { id } = await add();
  await env.DB.prepare('INSERT INTO snapshots VALUES(?,?,?,?)')
    .bind(id, 'services', JSON.stringify([{ id: 'old' }]), new Date().toISOString())
    .run();
  const first = await saveInventoryPage(env, id, 'services', {}, async () => ({
    items: [{ id: 'first' }],
    nextCursor: 2,
    providerCursor: 'next',
  }));
  let stored = await env.DB.prepare('SELECT data FROM snapshots WHERE account_id=? AND kind=?')
    .bind(id, 'services')
    .first<{ data: string }>();
  assert.equal(JSON.parse(stored!.data)[0].id, 'old');
  await assert.rejects(() =>
    saveInventoryPage(env, id, 'services', { cursor: 2, syncId: first.syncId }, async () => {
      throw Error('upstream down');
    }),
  );
  stored = await env.DB.prepare('SELECT data FROM snapshots WHERE account_id=? AND kind=?')
    .bind(id, 'services')
    .first<{ data: string }>();
  assert.equal(JSON.parse(stored!.data)[0].id, 'old');
  const final = await saveInventoryPage(
    env,
    id,
    'services',
    { cursor: 2, syncId: first.syncId },
    async (page, cursor) => {
      assert.equal(page, 2);
      assert.equal(cursor, 'next');
      return { items: [{ id: 'second' }], nextCursor: null };
    },
  );
  assert.equal(final.count, 2);
  stored = await env.DB.prepare('SELECT data FROM snapshots WHERE account_id=? AND kind=?')
    .bind(id, 'services')
    .first<{ data: string }>();
  assert.deepEqual(
    JSON.parse(stored!.data).map((r: any) => r.id),
    ['first', 'second'],
  );
  await assert.rejects(
    () =>
      saveInventoryPage(env, id, 'services', { cursor: 2, syncId: first.syncId }, async () => ({
        items: [],
        nextCursor: null,
      })),
    /失效/,
  );
});

test('a newer inventory refresh prevents an older in-flight page from replacing its results', async () => {
  const { id } = await add();
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const old = saveInventoryPage(env, id, 'services', {}, async () => {
    entered();
    await gate;
    return { items: [{ id: 'outdated' }], nextCursor: null };
  });
  await started;
  await saveInventoryPage(env, id, 'services', {}, async () => ({
    items: [{ id: 'new' }],
    nextCursor: null,
  }));
  const rejected = assert.rejects(old, /新的同步任务/);
  unblock();
  await rejected;
  const stored = await env.DB.prepare('SELECT data FROM snapshots WHERE account_id=? AND kind=?')
    .bind(id, 'services')
    .first<{ data: string }>();
  assert.equal(JSON.parse(stored!.data)[0].id, 'new');
});

test('inventory endpoints remain authenticated, restrict NS lookups to known domains and block writes to a non-current DNS platform', async () => {
  const { id, zoneId } = await add(false);
  const observer = createApp(async (input, init) => {
    if (new URL(String(input)).hostname === 'cloudflare-dns.com')
      return Response.json({
        Status: 0,
        Answer: [{ name: 'example.com.', type: 2, data: 'ns1.alidns.com.' }],
      });
    return upstream(input, init);
  });
  const send = async (path: string, data: unknown) =>
    observer.fetch(
      new Request('https://app.example' + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
      env,
    );
  assert.equal(
    (await observer.fetch(new Request('https://app.example/api/dns-observations'), env)).status,
    401,
  );
  assert.equal((await send('/api/dns-observations', { name: 'unknown.example' })).status, 404);
  assert.equal((await send('/api/dns-observations', { name: 'example.com' })).status, 200);
  assert.equal(
    (
      await send('/api/dns/plan', {
        zoneId,
        action: 'create',
        record: { type: 'A', name: 'www.example.com', content: '192.0.2.1', ttl: 300 },
      })
    ).status,
    409,
  );
  assert.equal(writes, 0);
  assert.equal(
    (await call('/api/accounts/' + id + '/inventory/certificates', 'POST', {})).response.status,
    400,
  );
  const inventory = await call('/api/accounts/' + id + '/inventory/services', 'POST', {});
  assert.equal(inventory.response.status, 200);
  assert.equal(inventory.body.complete, true);
  const snapshots = await call('/api/snapshots');
  assert.ok(snapshots.body.items.every((s: any) => !s.kind.startsWith('pending:')));
});

test('DNS apply rechecks public NS evidence after the preview was approved', async () => {
  const { zoneId } = await add(false);
  const plan = await call('/api/dns/plan', 'POST', {
    zoneId,
    action: 'create',
    record: { type: 'A', name: 'www.example.com', content: '192.0.2.1', ttl: 300 },
  });
  assert.equal(plan.response.status, 201);
  await env.DB.prepare('INSERT INTO settings VALUES(?,?)')
    .bind(
      'dns:example.com',
      JSON.stringify({
        name: 'example.com',
        nameservers: ['ns1.alidns.com'],
        provider: 'aliyun',
        checkedAt: new Date().toISOString(),
      }),
    )
    .run();
  const result = await call('/api/dns/apply/' + plan.body.id, 'POST', {});
  assert.equal(result.response.status, 409);
  assert.equal(writes, 0);
});
