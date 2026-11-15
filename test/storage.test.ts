import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cloud } from '../src/server/providers';
import { createNodeRuntime } from '../src/node/runtime';
const accountId = 'a'.repeat(32);
test('R2 lists every cursor in each supported jurisdiction without cloud writes or cross-account merging', async () => {
  const calls: string[] = [];
  const cloud = new Cloud(
    'cloudflare',
    { apiToken: 'fixture-r2-token', accountId },
    async (input, init) => {
      const u = new URL(String(input)),
        h = new Headers(init?.headers),
        j = h.get('cf-r2-jurisdiction')!;
      assert.equal(u.origin, 'https://api.cloudflare.com');
      assert.equal(u.pathname, '/client/v4/accounts/' + accountId + '/r2/buckets');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      assert.equal(h.get('Authorization'), 'Bearer fixture-r2-token');
      calls.push(j + ':' + (u.searchParams.get('cursor') ?? ''));
      return Response.json({
        success: true,
        result: {
          buckets: [
            {
              name: j === 'default' && u.searchParams.has('cursor') ? 'second' : 'same',
              location: 'apac',
              storage_class: 'Standard',
              credentials: 'must-not-return',
            },
          ],
        },
        result_info: j === 'default' && !u.searchParams.has('cursor') ? { cursor: 'next' } : {},
      });
    },
  );
  const rows = await cloud.buckets();
  assert.equal(rows.length, 4);
  assert.deepEqual(calls, ['default:', 'default:next', 'eu:', 'us:']);
  assert.ok(!JSON.stringify(rows).includes('must-not-return'));
});
test('R2 rejects repeated cursors, missing identity, malformed responses and redirects', async () => {
  await assert.rejects(
    () => new Cloud('cloudflare', { apiToken: 'fixture' }).buckets(),
    /Account ID/,
  );
  await assert.rejects(
    () =>
      new Cloud('cloudflare', { apiToken: 'fixture', accountId }, async () =>
        Response.json({ success: true, result: { buckets: [] }, result_info: { cursor: 'loop' } }),
      ).buckets(),
    /分页未完成/,
  );
  await assert.rejects(
    () =>
      new Cloud('cloudflare', { apiToken: 'fixture', accountId }, async () =>
        Response.json({ success: true, result: {} }),
      ).buckets(),
    /格式无效/,
  );
  await assert.rejects(
    () =>
      new Cloud(
        'cloudflare',
        { apiToken: 'fixture', accountId },
        async () =>
          new Response('', { status: 302, headers: { Location: 'https://other.invalid' } }),
      ).buckets(),
    /重定向/,
  );
});
test('storage API requires owner auth and CSRF, supports read-only accounts, preserves successful inventory on failure and obeys plugin gates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-storage-'));
  let failed = false,
    requests = 0;
  const runtime = createNodeRuntime({
    dataDirectory: dir,
    assetsDirectory: 'dist',
    migrationsDirectory: 'migrations',
    port: 0,
    fetcher: async (input, init) => {
      requests++;
      assert.equal(init?.method, 'GET');
      if (failed)
        return Response.json(
          { success: false, errors: [{ message: 'permission denied' }] },
          { status: 403 },
        );
      return Response.json({
        success: true,
        result: {
          buckets: [
            { name: 'assets', jurisdiction: new Headers(init?.headers).get('cf-r2-jurisdiction') },
          ],
        },
      });
    },
  });
  const call = async (
    route: string,
    method = 'GET',
    authenticated = true,
    extra: Record<string, string> = {},
  ) => {
    const req = new Request('https://console.example/api' + route, {
      method,
      headers: {
        ...(authenticated ? { Authorization: 'Bearer ' + runtime.env.ADMIN_TOKEN } : {}),
        ...extra,
      },
    });
    return runtime.app.fetch(req, runtime.env);
  };
  try {
    assert.equal((await call('/storage', 'GET', false)).status, 401);
    const at = new Date().toISOString();
    const { encrypt } = await import('../src/server/crypto');
    await runtime.db
      .prepare(
        'INSERT INTO accounts(id,name,provider,readonly,credentials,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        'cf',
        'R2 account',
        'cloudflare',
        1,
        await encrypt(
          { apiToken: 'fixture', accountId },
          runtime.env.ENCRYPTION_KEY,
          'cf:cloudflare',
        ),
        at,
        at,
      )
      .run();
    const { session } = await import('../src/server/crypto');
    const csrf = await runtime.app.fetch(
      new Request('https://console.example/api/storage/cf/sync', {
        method: 'POST',
        headers: {
          Cookie: 'nc_session=' + (await session(runtime.env.ADMIN_TOKEN)),
          Origin: 'https://attacker.invalid',
        },
      }),
      runtime.env,
    );
    assert.equal(csrf.status, 403);
    assert.equal(requests, 0);
    assert.equal((await call('/storage/cf/sync', 'POST')).status, 200);
    let data: any = await (await call('/storage')).json();
    const first = data.items.find((s: any) => s.kind === 'storage:buckets');
    assert.equal(first.data.length, 3);
    failed = true;
    assert.equal((await call('/storage/cf/sync', 'POST')).status, 502);
    data = await (await call('/storage')).json();
    assert.deepEqual(
      data.items.find((s: any) => s.kind === 'storage:buckets'),
      first,
    );
    assert.ok(data.items.some((s: any) => s.kind === 'issue:storage:buckets'));
    await runtime.db
      .prepare('INSERT INTO settings(key,value) VALUES(?,?)')
      .bind('plugins:state', JSON.stringify({ storage: false }))
      .run();
    const previous = requests;
    assert.equal((await call('/storage/cf/sync', 'POST')).status, 403);
    assert.equal(requests, previous);
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
