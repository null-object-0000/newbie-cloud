import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildSync } from 'esbuild';
import { SqliteDatabase } from '../src/node/database';
import { loadKeys } from '../src/node/runtime';
import { createApp } from '../src/server/index';
import { session } from '../src/server/crypto';
import { inspectSource } from '../src/plugins/sources';
import { validateManifest } from '../src/plugins/validation';
import { codePluginHost } from '../src/node/plugin-host';
import type { Env, Fetch } from '../src/server/types';
import { demoManifest, npmArchive } from './plugin-fixtures';

async function environment(fn: (env: Env, dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newbie-plugin-')),
    keys = loadKeys(dir),
    db = new SqliteDatabase(path.join(dir, 'app.sqlite'), 'migrations');
  try {
    await fn(
      { ...keys, DB: db.asD1(), ASSETS: { fetch: async () => new Response('static') } as Fetcher },
      dir,
    );
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('newbie-plugin-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function call(
  app: ReturnType<typeof createApp>,
  env: Env,
  path: string,
  method = 'GET',
  data?: unknown,
) {
  return app.fetch(
    new Request('https://app.example/api' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + env.ADMIN_TOKEN,
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    env,
  );
}
const github =
  (manifest: unknown, code?: string): Fetch =>
  async (input, init) => {
    const url = new URL(String(input));
    assert.ok(!new Headers(init?.headers).has('Authorization'));
    if (url.hostname === 'api.github.com') return Response.json([{ sha: 'a'.repeat(40) }]);
    assert.equal(url.hostname, 'raw.githubusercontent.com');
    assert.ok(url.pathname.includes('/' + 'a'.repeat(40) + '/'));
    return url.pathname.endsWith('plugin.mjs') ? new Response(code) : Response.json(manifest);
  };
test('GitHub installation pins a commit, requires confirmation, is replay-safe and starts disabled', async () =>
  environment(async (env) => {
    const app = createApp(github(demoManifest));
    assert.equal(
      (await app.fetch(new Request('https://app.example/api/plugins'), env)).status,
      401,
    );
    const cookie = await session(env.ADMIN_TOKEN);
    assert.equal(
      (
        await app.fetch(
          new Request('https://app.example/api/plugins/preview', {
            method: 'POST',
            headers: {
              Cookie: 'nc_session=' + cookie,
              Origin: 'https://evil.example',
              'Content-Type': 'application/json',
            },
            body: '{}',
          }),
          env,
        )
      ).status,
      403,
    );
    const preview: any = await (
      await call(app, env, '/plugins/preview', 'POST', {
        source: 'https://github.com/example/plugin',
      })
    ).json();
    assert.ok(preview.resolvedSource.endsWith('@' + 'a'.repeat(40)));
    assert.ok(!('code' in preview));
    assert.equal(
      (await call(app, env, '/plugins/install', 'POST', { previewId: preview.id })).status,
      400,
    );
    const install = () =>
      call(app, env, '/plugins/install', 'POST', {
        previewId: preview.id,
        acceptPermissions: true,
      });
    const results = await Promise.all([install(), install()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (await call(app, env, '/plugins/demo.inventory/resources', 'POST', {})).status,
      403,
    );
    assert.equal(
      (await call(app, env, '/plugins/demo.inventory', 'PATCH', { enabled: true })).status,
      200,
    );
    const rows: any = await (
      await call(app, env, '/plugins/demo.inventory/resources', 'POST', {})
    ).json();
    assert.equal(rows.items[0].name, 'Demo resource');
    await call(app, env, '/plugins/demo.inventory', 'DELETE');
    assert.equal(
      (await call(app, env, '/plugins/demo.inventory/resources', 'POST', {})).status,
      404,
    );
  }));
test('npm archives verify integrity, use a fixed version and never execute package scripts', async () => {
  const pkg = npmArchive(demoManifest),
    metadata = {
      version: '1.0.0',
      dist: {
        tarball: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
        integrity: pkg.integrity,
      },
      scripts: { install: 'must never execute' },
    };
  const fetcher: Fetch = async (input) =>
    String(input).endsWith('.tgz') ? new Response(pkg.archive) : Response.json(metadata);
  const result = await inspectSource('npm:demo@latest', fetcher);
  assert.equal(result.resolvedSource, 'npm:demo@1.0.0');
  assert.equal(result.manifest.id, 'demo.inventory');
  await assert.rejects(
    () =>
      inspectSource('npm:demo@latest', async (input) =>
        String(input).endsWith('.tgz')
          ? new Response(Buffer.from('tampered'))
          : Response.json(metadata),
      ),
    /完整性/,
  );
  assert.throws(() => validateManifest({ ...demoManifest, id: 'cloudflare' }), /冲突/);
  for (const host of ['localhost', '127.0.0.1', '*.example.com', 'service.internal'])
    assert.throws(() => validateManifest({ ...demoManifest, permissions: { network: [host] } }));
});
test('declarative plugin configuration is encrypted and redacted, and requests remain confined to declared HTTPS hosts', async () =>
  environment(async (env) => {
    const secret = 'fixture-"plugin-secret\nline',
      manifest = {
        ...demoManifest,
        resources: undefined,
        permissions: { network: ['api.example.com'] },
        config: [{ key: 'token', label: 'API token', required: true, secret: true }],
        connector: {
          url: 'https://api.example.com/resources',
          headers: { Authorization: 'Bearer {{config.token}}' },
          itemsPath: 'items',
          fields: { id: 'id', name: 'name', detail: 'detail' },
        },
      };
    const app = createApp(async (input, init) => {
      if (new URL(String(input)).hostname !== 'api.example.com')
        return github(manifest)(input, init);
      assert.equal(init?.redirect, 'manual');
      assert.ok(new Headers(init?.headers).get('Authorization')?.includes('fixture-'));
      return Response.json({
        items: [{ id: 'one', name: 'Resource', detail: 'fixture-"plugin-secret' }],
      });
    });
    const p: any = await (
      await call(app, env, '/plugins/preview', 'POST', { source: 'github:example/plugin' })
    ).json();
    await call(app, env, '/plugins/install', 'POST', { previewId: p.id, acceptPermissions: true });
    assert.equal(
      (await call(app, env, '/plugins/demo.inventory', 'PATCH', { enabled: true })).status,
      400,
    );
    const validSecret = secret.split('\n')[0];
    await call(app, env, '/plugins/demo.inventory/config', 'POST', {
      values: { token: validSecret },
    });
    const raw = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
      .bind('plugin-installed:demo.inventory')
      .first<{ value: string }>();
    assert.ok(!raw!.value.includes(validSecret));
    const configuration: any = await (
      await call(app, env, '/plugins/demo.inventory/config')
    ).json();
    assert.ok(!configuration.values.token);
    assert.deepEqual(configuration.savedSecrets, ['token']);
    await call(app, env, '/plugins/demo.inventory', 'PATCH', { enabled: true });
    const result = await call(app, env, '/plugins/demo.inventory/resources', 'POST', {});
    assert.equal(result.status, 200);
    assert.equal(((await result.json()) as any).items[0].detail, '[已隐藏]');
    assert.ok(!(await (await call(app, env, '/plugins')).text()).includes(validSecret));
  }));
test('disabled built-in providers and features reject execution without removing accounts or making cloud requests', async () =>
  environment(async (env) => {
    let calls = 0;
    const app = createApp(async () => {
      calls++;
      return Response.json({ success: true, result: [] });
    });
    const created: any = await (
      await call(app, env, '/accounts', 'POST', {
        name: 'Account',
        provider: 'cloudflare',
        readonly: false,
        credentials: { apiToken: 'fixture-token' },
      })
    ).json();
    await call(app, env, '/plugins/cloudflare', 'PATCH', { enabled: false });
    assert.equal(
      (await call(app, env, '/accounts/' + created.account.id + '/sync', 'POST', {})).status,
      403,
    );
    assert.equal(calls, 0);
    assert.equal(((await (await call(app, env, '/accounts')).json()) as any).items.length, 1);
    await call(app, env, '/plugins/dns', 'PATCH', { enabled: false });
    assert.equal((await call(app, env, '/dns/plan', 'POST', {})).status, 403);
    await app.scheduled({} as ScheduledEvent, env);
    assert.equal(calls, 0);
  }));
test('code plugin runner has a minimal environment, a filesystem seat belt and a per-call lifecycle', async () =>
  environment(async (env, dir) => {
    const runner = path.join(dir, 'runner.mjs');
    buildSync({
      entryPoints: ['src/node/plugin-runner.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      outfile: runner,
    });
    const host = codePluginHost(path.join(dir, 'artifacts'), runner, true);
    const code = `import fs from 'node:fs'; export default {collect({config}) { let denied=false; try { fs.readFileSync(config.path); } catch { denied=true; } setInterval(()=>{},1000); return [{id:'code-one',name:process.env.ADMIN_TOKEN||'clean environment',type:'test',status:denied?'file denied':'unsafe'}]; }};`;
    const result: any = await host.collect(code, { path: path.join(dir, 'secrets.json') }, []);
    assert.equal(result[0].name, 'clean environment');
    assert.equal(result[0].status, 'file denied');
    await assert.rejects(
      () => codePluginHost(path.join(dir, 'artifacts'), runner, false).collect(code, {}, []),
      /未开启/,
    );
    const manifest = {
      ...demoManifest,
      id: 'demo.code',
      kind: 'node',
      entry: 'plugin.mjs',
      resources: undefined,
    };
    const app = createApp(github(manifest, code));
    const preview: any = await (
      await call(app, env, '/plugins/preview', 'POST', { source: 'github:example/code' })
    ).json();
    assert.ok(preview.reason.includes('Docker'));
    assert.equal(
      (
        await call(app, env, '/plugins/install', 'POST', {
          previewId: preview.id,
          acceptPermissions: true,
          trustCode: true,
        })
      ).status,
      400,
    );
  }));
