import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteDatabase } from '../src/node/database';
import { loadKeys } from '../src/node/runtime';
import { createApp } from '../src/server/index';
import type { Env } from '../src/server/types';
import { existingFixture } from './existing-fixture';
async function setup(fn: (ctx: any) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newbie-existing-')),
    keys = loadKeys(dir),
    db = new SqliteDatabase(path.join(dir, 'app.sqlite'), 'migrations'),
    fixture = existingFixture(),
    env: Env = {
      ...keys,
      DB: db.asD1(),
      ASSETS: { fetch: async () => new Response('') } as Fetcher,
    },
    app = createApp(fixture.fetcher);
  async function call(route: string, method = 'GET', data?: unknown, token = env.ADMIN_TOKEN) {
    const r = await app.fetch(
      new Request('https://app.example/api' + route, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      env,
    );
    return { status: r.status, body: (await r.json()) as any };
  }
  const tc = await call('/accounts', 'POST', {
      provider: 'tencent',
      name: 'Tencent read only',
      readonly: true,
      credentials: { secretId: 'fake-id', secretKey: 'fake-key', workspaceId: fixture.zone },
    }),
    cf = await call('/accounts', 'POST', {
      provider: 'cloudflare',
      name: 'Cloudflare DNS',
      readonly: true,
      credentials: { apiToken: 'fake-cf-token', accountId: 'a'.repeat(32) },
    }),
    ali = await call('/accounts', 'POST', {
      provider: 'aliyun',
      name: 'Alibaba registrar',
      readonly: true,
      credentials: { accessKeyId: 'fake-ak', accessKeySecret: 'fake-sk' },
    });
  const tcId = tc.body.account.id,
    cfId = cf.body.account.id,
    aliId = ali.body.account.id;
  await db
    .prepare(
      'INSERT INTO zones(id,account_id,external_id,name,status,updated_at) VALUES(?,?,?,?,?,?)',
    )
    .bind('zone-cf', cfId, 'remote-zone', 'example.com', 'active', new Date().toISOString())
    .run();
  await db
    .prepare('INSERT INTO snapshots(account_id,kind,data,updated_at) VALUES(?,?,?,?)')
    .bind(
      aliId,
      'registrations',
      JSON.stringify([
        { name: 'example.com', registrar: '阿里云', expiresAt: '2030-01-01T00:00:00Z' },
      ]),
      new Date().toISOString(),
    )
    .run();
  await db
    .prepare('INSERT INTO settings(key,value) VALUES(?,?)')
    .bind(
      'dns:example.com',
      JSON.stringify({
        name: 'example.com',
        provider: 'cloudflare',
        nameservers: ['a.ns.cloudflare.com'],
        checkedAt: new Date().toISOString(),
      }),
    )
    .run();
  const input = {
    name: 'Existing site',
    primaryDomain: fixture.domain,
    resources: [
      {
        accountId: tcId,
        externalId: fixture.projectId,
        kind: 'EdgeOne Makers',
        role: 'production',
      },
      { accountId: cfId, externalId: 'legacy', kind: 'Pages', role: 'retained' },
    ],
    source: {
      repository: 'owner/site',
      commit: 'a'.repeat(40),
      branch: 'main',
      workflow: '.github/workflows/deploy-edgeone.yml',
      deployScript: 'scripts/edgeone/deploy.mjs',
      directory: '.',
      buildDirectory: 'dist',
    },
  };
  try {
    await fn({ call, env, db, fixture, input });
  } finally {
    db.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('newbie-existing-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test('existing sites link pinned source, real hosting IDs, bound domains, registrar and DNS using only remote reads', async () =>
  setup(async ({ call, db, fixture, input }: any) => {
    const before = JSON.stringify((await db.prepare('SELECT * FROM zones').all()).results);
    const preview = await call('/projects/import/preview', 'POST', input);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.plan.source.commit, 'a'.repeat(40));
    assert.equal(
      (await call('/projects/import/confirm', 'POST', { previewId: preview.body.id })).status,
      400,
    );
    const imported = await call('/projects/import/confirm', 'POST', {
      previewId: preview.body.id,
      confirmAssociationOnly: true,
    });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const pid = imported.body.project.id;
    assert.equal(imported.body.project.management, 'existing');
    assert.equal(imported.body.linked.links.length, 3);
    assert.equal(imported.body.url, 'https://www.example.com');
    const domains = imported.body.linked.domainLinks;
    assert.equal(domains[0].registrations[0].registrar, '阿里云');
    assert.equal(domains[0].dns[0].current, true);
    const refreshed = await call('/projects/' + pid + '/refresh', 'POST', {});
    assert.equal(refreshed.status, 200);
    const all = JSON.stringify(refreshed.body);
    assert.ok(!all.includes('must-not-return'));
    assert.equal(
      refreshed.body.linked.observations.find((o: any) => o.data?.items?.[0]?.id === 'dp-1').data
        .items[0].status,
      'Success',
    );
    assert.equal((await call('/projects')).body.items[0].resourceLinks.length, 2);
    assert.equal(JSON.stringify((await db.prepare('SELECT * FROM zones').all()).results), before);
    const replay = await call('/projects/import/confirm', 'POST', {
      previewId: preview.body.id,
      confirmAssociationOnly: true,
    });
    assert.equal(replay.body.project.id, pid);
    assert.equal((await call('/projects/import/preview', 'POST', input)).status, 409);
    for (const action of ['provision', 'reconcile', 'releases', 'rollback'])
      assert.equal((await call('/projects/' + pid + '/' + action, 'POST', {})).status, 409);
  }));
test('bad source targets and changed domain bindings reject import before creating a project', async () =>
  setup(async ({ call, db, fixture, input }: any) => {
    fixture.setWrongScript(true);
    assert.equal((await call('/projects/import/preview', 'POST', input)).status, 409);
    assert.equal((await db.prepare('SELECT count(*) n FROM projects').first()).n, 0);
    fixture.setWrongScript(false);
    const p = await call('/projects/import/preview', 'POST', input);
    fixture.setBound(false);
    assert.equal(
      (
        await call('/projects/import/confirm', 'POST', {
          previewId: p.body.id,
          confirmAssociationOnly: true,
        })
      ).status,
      409,
    );
    assert.equal((await db.prepare('SELECT count(*) n FROM projects').first()).n, 0);
  }));
test('failed refresh preserves observations and source target drift never rebinds the project', async () =>
  setup(async ({ call, fixture, input }: any) => {
    const p = await call('/projects/import/preview', 'POST', input),
      imported = await call('/projects/import/confirm', 'POST', {
        previewId: p.body.id,
        confirmAssociationOnly: true,
      }),
      pid = imported.body.project.id;
    let r = await call('/projects/' + pid + '/refresh', 'POST', {});
    const old = r.body.linked.observations.find((o: any) => o.data?.items?.[0]?.id === 'dp-1');
    fixture.failDeployments(true);
    fixture.setHead('b'.repeat(40));
    fixture.setWrongScript(true);
    r = await call('/projects/' + pid + '/refresh', 'POST', {});
    const preserved = r.body.linked.observations.find((o: any) => o.subject === old.subject);
    assert.ok(preserved.error);
    assert.deepEqual(preserved.data, old.data);
    assert.equal(
      r.body.linked.links.find((l: any) => l.category === 'source').data.commit,
      'a'.repeat(40),
    );
    assert.equal(
      r.body.linked.links.find((l: any) => l.role === 'production').external_id,
      fixture.projectId,
    );
  }));
test('existing-project Agent tokens can read and refresh only their project, never redeploy or request rollback', async () =>
  setup(async ({ call, input }: any) => {
    const p = await call('/projects/import/preview', 'POST', input),
      imported = await call('/projects/import/confirm', 'POST', {
        previewId: p.body.id,
        confirmAssociationOnly: true,
      }),
      pid = imported.body.project.id;
    assert.equal(
      (await call('/projects/' + pid + '/tokens', 'POST', { name: 'invalid', allowRollback: true }))
        .status,
      400,
    );
    const issued = await call('/projects/' + pid + '/tokens', 'POST', { name: 'read agent' });
    assert.equal(issued.status, 201);
    const token = issued.body.token;
    assert.equal((await call('/projects/' + pid + '/refresh', 'POST', {}, token)).status, 200);
    assert.equal((await call('/projects/' + pid + '/releases', 'POST', {}, token)).status, 409);
    assert.equal((await call('/accounts', 'GET', undefined, token)).status, 401);
    assert.equal((await call('/projects/import/candidates', 'GET', undefined, token)).status, 403);
  }));
