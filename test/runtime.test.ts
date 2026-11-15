import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSync } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';
import { demoManifest, npmArchive } from './plugin-fixtures';
import { pagesFixture } from './pages-fixture';
import { describe } from '../src/projects/files';

test('native Worker creates a static project, uploads assets, verifies production and keeps Agent scope', async () => {
  const source = buildSync({
      entryPoints: ['src/server/index.ts'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
    }).outputFiles[0].text,
    fixture = pagesFixture(),
    token = 'runtime-project-management-token-123456789';
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: source,
      compatibilityDate: '2026-11-15',
      d1Databases: { DB: 'project-runtime' },
      bindings: { ADMIN_TOKEN: token, ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
      outboundService: async (request) => {
        let body: any;
        if (request.method !== 'GET' && request.method !== 'HEAD')
          body = request.headers.get('Content-Type')?.includes('multipart/form-data')
            ? await request.formData()
            : await request.text();
        const result = await fixture.fetcher(request.url, {
          method: request.method,
          headers: new Headers(Object.fromEntries(request.headers)),
          body,
        });
        return new RuntimeResponse(await result.arrayBuffer(), {
          status: result.status,
          headers: Object.fromEntries(result.headers),
        });
      },
    }),
  );
  try {
    const db = await mf.getD1Database('DB');
    for (const filename of fs
      .readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.exec(fs.readFileSync('migrations/' + filename, 'utf8').replaceAll('\n', ' '));
    async function api(route: string, method = 'GET', body?: unknown, auth = token, raw = false) {
      const r = await mf.dispatchFetch('https://app.example/api' + route, {
        method,
        headers: {
          Authorization: 'Bearer ' + auth,
          'Content-Type': raw ? 'application/octet-stream' : 'application/json',
        },
        ...(body !== undefined ? { body: raw ? (body as any) : JSON.stringify(body) } : {}),
      });
      const b: any = await r.json();
      assert.ok(r.ok, JSON.stringify(b));
      return b;
    }
    const a = await api('/accounts', 'POST', {
        name: 'Worker publishing',
        provider: 'cloudflare',
        readonly: false,
        credentials: { apiToken: 'fixture', accountId: 'a'.repeat(32) },
      }),
      p = await api('/projects', 'POST', {
        name: 'Worker website',
        accountId: a.account.id,
        requestKey: crypto.randomUUID(),
      }),
      pid = p.project.id;
    assert.equal(
      (await api('/projects/' + pid + '/provision', 'POST', {})).project.status,
      'ready',
    );
    const html = new TextEncoder().encode('<h1>Native Worker static publish</h1>'),
      js = new Uint8Array(32768).fill(32),
      assets = [await describe(html, 'index.html'), await describe(js, 'app.js')];
    const r = await api('/projects/' + pid + '/releases', 'POST', {
      requestKey: crypto.randomUUID(),
      files: assets,
    });
    for (const [i, bytes] of [html, js].entries())
      await api(
        `/projects/${pid}/releases/${r.release.id}/file?path=${assets[i].path}`,
        'PUT',
        bytes,
        token,
        true,
      );
    await api(`/projects/${pid}/releases/${r.release.id}/publish`, 'POST', {});
    const checked = await api(`/projects/${pid}/releases/${r.release.id}/check`, 'POST', {});
    assert.equal(checked.project.current_release, r.release.id);
    assert.equal(checked.releases[0].verification, 'production_passed');
    const issued = await api('/projects/' + pid + '/tokens', 'POST', { name: 'Worker Agent' });
    assert.equal((await api('/projects', 'GET', undefined, issued.token)).items.length, 1);
    const denied = await mf.dispatchFetch('https://app.example/api/accounts', {
      headers: { Authorization: 'Bearer ' + issued.token },
    });
    assert.equal(denied.status, 401);
    const many = [
      assets[0],
      ...Array.from({ length: 199 }, (_, i) => ({ ...assets[1], path: 'asset-' + i + '.js' })),
    ];
    assert.ok(
      (
        await api('/projects/' + pid + '/releases', 'POST', {
          requestKey: crypto.randomUUID(),
          files: many,
        })
      ).release.id,
    );
  } finally {
    await mf.dispose();
  }
});

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
