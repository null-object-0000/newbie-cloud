import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSync } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';
import { demoManifest, npmArchive } from './plugin-fixtures';

test('native Worker installs an integrity-checked npm archive and reads declarative resources', async () => {
  const source = buildSync({
    entryPoints: ['src/server/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  }).outputFiles[0].text;
  const token = 'worker-plugin-fixture-token-1234567890';
  const { archive, integrity } = npmArchive(demoManifest);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: source,
      compatibilityDate: '2026-11-15',
      d1Databases: { DB: 'plugin-runtime' },
      bindings: { ADMIN_TOKEN: token, ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
      outboundService: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.hostname, 'registry.npmjs.org');
        return url.pathname.endsWith('.tgz')
          ? new RuntimeResponse(archive)
          : RuntimeResponse.json({
              version: '1.0.0',
              dist: {
                integrity,
                tarball: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
              },
            });
      },
    }),
  );
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(fs.readFileSync('migrations/0001_initial.sql', 'utf8').replaceAll('\n', ' '));
    async function call(path: string, method = 'GET', data?: unknown) {
      const r = await mf.dispatchFetch('https://app.example/api/plugins' + path, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      const body: any = await r.json();
      assert.ok(r.ok, JSON.stringify(body));
      return body;
    }
    const preview = await call('/preview', 'POST', { source: 'npm:fixture@1.0.0' });
    await call('/install', 'POST', { previewId: preview.id, acceptPermissions: true });
    await call('/demo.inventory', 'PATCH', { enabled: true });
    const result = await call('/demo.inventory/resources', 'POST', {});
    assert.equal(result.items[0].name, 'Demo resource');
    await call('/demo.inventory', 'DELETE');
  } finally {
    await mf.dispose();
  }
});

test('the bundled Worker performs real runtime fetches, D1 encryption and previewed DNS writes', async () => {
  const source = buildSync({
    entryPoints: ['src/server/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  }).outputFiles[0].text;
  const token = 'runtime-test-management-key-not-for-production';
  let writes = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: source,
      compatibilityDate: '2026-11-15',
      d1Databases: { DB: 'runtime-database' },
      bindings: { ADMIN_TOKEN: token, ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64') },
      outboundService: async (request) => {
        assert.equal(new URL(request.url).hostname, 'api.cloudflare.com');
        assert.equal(request.headers.get('Authorization'), 'Bearer example-token');
        if (request.method !== 'GET') {
          writes++;
          return RuntimeResponse.json({ success: true, result: { id: 'created-record' } });
        }
        return RuntimeResponse.json({
          success: true,
          result: [{ id: 'zone-test', name: 'example.com', status: 'active' }],
          result_info: { total_pages: 1 },
        });
      },
    }),
  );
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(fs.readFileSync('migrations/0001_initial.sql', 'utf8').replaceAll('\n', ' '));
    async function call(path: string, method = 'GET', data?: unknown) {
      const response = await mf.dispatchFetch('https://app.example/api' + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      return { status: response.status, body: (await response.json()) as any };
    }
    const saved = await call('/accounts', 'POST', {
      name: 'Runtime account',
      provider: 'cloudflare',
      readonly: false,
      credentials: { apiToken: 'example-token' },
    });
    assert.equal(saved.status, 201);
    const synced = await call('/accounts/' + saved.body.account.id + '/sync', 'POST', {});
    assert.equal(synced.status, 200);
    assert.equal(synced.body.count, 1);
    const zones = await call('/zones');
    const plan = await call('/dns/plan', 'POST', {
      zoneId: zones.body.items[0].id,
      action: 'create',
      record: { type: 'A', name: 'www', content: '192.0.2.9', ttl: 300 },
    });
    assert.equal(plan.status, 201);
    assert.equal(writes, 0);
    assert.equal((await call('/dns/apply/' + plan.body.id, 'POST', {})).status, 200);
    assert.equal(writes, 1);
    assert.equal((await call('/dns/apply/' + plan.body.id, 'POST', {})).status, 409);
    assert.equal(writes, 1);
  } finally {
    await mf.dispose();
  }
});
