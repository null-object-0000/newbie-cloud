import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteDatabase } from '../src/node/database';
import { loadKeys } from '../src/node/runtime';
import { createApp } from '../src/server/index';
import { describe, assetPath, validateAssets } from '../src/projects/files';
import type { Env, Fetch } from '../src/server/types';
import { session } from '../src/server/crypto';
import { pagesFixture } from './pages-fixture';
async function environment(fn: (ctx: any) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newbie-project-')),
    keys = loadKeys(dir),
    db = new SqliteDatabase(path.join(dir, 'app.sqlite'), 'migrations'),
    cf = pagesFixture(),
    env: Env = {
      ...keys,
      DB: db.asD1(),
      ASSETS: { fetch: async () => new Response('static') } as Fetcher,
    },
    app = createApp(cf.fetcher);
  async function call(
    route: string,
    method = 'GET',
    data?: unknown,
    token = env.ADMIN_TOKEN,
    raw = false,
  ) {
    const response = await app.fetch(
      new Request('https://app.example/api' + route, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          ...(data !== undefined
            ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }
            : {}),
        },
        body: data === undefined ? undefined : raw ? (data as any) : JSON.stringify(data),
      }),
      env,
    );
    return { status: response.status, body: (await response.json()) as any };
  }
  const account = await call('/accounts', 'POST', {
    name: 'Only account',
    provider: 'cloudflare',
    readonly: false,
    credentials: { apiToken: 'fixture-pages-only-token', accountId: 'a'.repeat(32) },
  });
  assert.equal(account.status, 201);
  async function create(name = 'My website') {
    const response = await call('/projects', 'POST', {
      name,
      accountId: account.body.account.id,
      requestKey: crypto.randomUUID(),
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = response.body.project.id;
    assert.equal(
      (await call('/projects/' + id + '/provision', 'POST', {})).body.project.status,
      'ready',
    );
    return id;
  }
  async function upload(pid: string, text: string) {
    const bytes = new TextEncoder().encode(text),
      asset = await describe(bytes, 'index.html');
    const result = await call('/projects/' + pid + '/releases', 'POST', {
      requestKey: crypto.randomUUID(),
      files: [asset],
      message: text,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const rid = result.body.release.id;
    assert.equal(
      (
        await call(
          '/projects/' + pid + '/releases/' + rid + '/file?path=index.html',
          'PUT',
          bytes,
          env.ADMIN_TOKEN,
          true,
        )
      ).status,
      200,
    );
    return rid;
  }
  try {
    await fn({ env, db, app, cf, call, create, upload, accountId: account.body.account.id });
  } finally {
    db.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('newbie-project-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test('one account completes project creation, publish, verified update and rollback without DNS writes', async () =>
  environment(async ({ call, create, upload, cf }: any) => {
    const pid = await create(),
      rid = await upload(pid, '<h1>version one</h1>');
    const pub = await call(`/projects/${pid}/releases/${rid}/publish`, 'POST', {});
    assert.equal(pub.status, 202);
    assert.equal(pub.body.release.status, 'deploying');
    let result = await call(`/projects/${pid}/releases/${rid}/check`, 'POST', {});
    assert.equal(result.body.project.current_release, rid);
    assert.equal(result.body.releases[0].verification, 'passed');
    const second = await upload(pid, '<h1>version two</h1>');
    await call(`/projects/${pid}/releases/${second}/publish`, 'POST', {});
    await call(`/projects/${pid}/releases/${second}/check`, 'POST', {});
    const rollback = await call(`/projects/${pid}/rollback`, 'POST', {
      requestKey: crypto.randomUUID(),
      targetReleaseId: rid,
      expectedCurrentReleaseId: second,
    });
    assert.equal(rollback.status, 202, JSON.stringify(rollback.body));
    assert.equal(rollback.body.release.status, 'success');
    result = await call('/projects/' + pid);
    assert.equal(result.body.project.current_release, rid);
    assert.equal(cf.posts, 2);
    assert.equal(cf.rollbacks, 1);
  }));
test('lost responses and concurrent publish submissions never automatically repeat production writes', async () =>
  environment(async ({ call, create, upload, cf }: any) => {
    const pid = await create(),
      rid = await upload(pid, 'first');
    cf.loseNext();
    const results = await Promise.all([
      call(`/projects/${pid}/releases/${rid}/publish`, 'POST', {}),
      call(`/projects/${pid}/releases/${rid}/publish`, 'POST', {}),
    ]);
    assert.ok(results.some((r: any) => r.status === 202));
    assert.equal(cf.posts, 1);
    assert.equal((await call('/projects/' + pid)).body.releases[0].status, 'review_required');
    await call(`/projects/${pid}/releases/${rid}/publish`, 'POST', {});
    assert.equal(cf.posts, 1);
    const checked = await call(`/projects/${pid}/releases/${rid}/check`, 'POST', {});
    assert.equal(checked.body.project.current_release, rid);
    assert.equal(checked.body.releases[0].verification, 'passed');
    assert.equal(cf.posts, 1);
    const next = await upload(pid, 'rejected');
    cf.rejectNext();
    const rejected = await call(`/projects/${pid}/releases/${next}/publish`, 'POST', {});
    assert.equal(rejected.body.release.status, 'failed');
    assert.equal((await call('/projects/' + pid)).body.project.active_task, null);
  }));
test('project Agent tokens are hashed, scoped, revocable, expiring and cannot manage credentials or rollback without permission', async () =>
  environment(async ({ env, db, app, call, create, upload }: any) => {
    const pid = await create(),
      other = await create('Other');
    const issued = await call(`/projects/${pid}/tokens`, 'POST', { name: 'Agent', days: 1 });
    assert.equal(issued.status, 201);
    const token = issued.body.token;
    assert.ok(
      !JSON.stringify((await db.prepare('SELECT * FROM agent_tokens').all()).results).includes(
        token,
      ),
    );
    const invoke = (route: string, method = 'GET', data?: any) => call(route, method, data, token);
    assert.equal((await invoke('/projects')).body.items.length, 1);
    assert.equal((await invoke('/projects/' + other)).status, 403);
    assert.equal((await invoke('/accounts')).status, 401);
    assert.equal((await invoke(`/projects/${pid}/tokens`)).status, 403);
    assert.equal((await invoke(`/projects/${pid}/rollback`, 'POST', {})).status, 403);
    const cookie = await session(env.ADMIN_TOKEN);
    assert.equal(
      (
        await app.fetch(
          new Request('https://app.example/api/projects', {
            method: 'POST',
            headers: {
              Cookie: 'nc_session=' + cookie,
              'Content-Type': 'application/json',
              Origin: 'https://evil.example',
            },
            body: '{}',
          }),
          env,
        )
      ).status,
      403,
    );
    await call(`/projects/${pid}/tokens/${issued.body.id}`, 'DELETE');
    assert.equal((await invoke('/projects/' + pid)).status, 401);
    const expired = await call(`/projects/${pid}/tokens`, 'POST', { name: 'Expired' });
    await db
      .prepare('UPDATE agent_tokens SET expires_at=? WHERE id=?')
      .bind('2000-01-01', expired.body.id)
      .run();
    assert.equal(
      (await call('/projects/' + pid, 'GET', undefined, expired.body.token)).status,
      401,
    );
  }));
test('static file policy, incomplete uploads, read-only accounts and external production changes fail closed', async () =>
  environment(async ({ env, db, call, create, upload, cf, accountId }: any) => {
    for (const name of [
      '../index.html',
      '.env',
      '_worker.js',
      'functions/x.js',
      'src/main.ts',
      'a%2findex.html',
      'node_modules/a.js',
    ])
      assert.throws(() => assetPath(name));
    assert.throws(
      () =>
        validateAssets([
          { path: 'main.js', size: 1, hash: 'a'.repeat(32), sha256: 'a'.repeat(64) },
        ]),
      /index.html/,
    );
    const pid = await create(),
      rid = await upload(pid, 'safe');
    cf.projects.values().next().value.canonical_deployment = { id: 'external-version' };
    const blocked = await call(`/projects/${pid}/releases/${rid}/publish`, 'POST', {});
    assert.equal(blocked.body.release.status, 'failed');
    assert.equal(cf.posts, 0);
    await db.prepare('UPDATE accounts SET readonly=1 WHERE id=?').bind(accountId).run();
    assert.equal((await call(`/projects/${pid}/releases`, 'POST', {})).status, 403);
  }));

test('unknown tasks require owner confirmation and remote absence before manual unlock', async () =>
  environment(async ({ call, create, upload, db }: any) => {
    const pid = await create(),
      rid = await upload(pid, 'pending task');
    await db
      .prepare("UPDATE releases SET status='review_required',updated_at=? WHERE id=?")
      .bind('2000-01-01T00:00:00Z', rid)
      .run();
    await db.prepare('UPDATE projects SET active_task=? WHERE id=?').bind(rid, pid).run();
    assert.equal(
      (
        await call(`/projects/${pid}/releases/${rid}/resolve`, 'POST', {
          confirmName: 'wrong',
          confirmRemoteAbsent: true,
        })
      ).status,
      400,
    );
    const done = await call(`/projects/${pid}/releases/${rid}/resolve`, 'POST', {
      confirmName: 'My website',
      confirmRemoteAbsent: true,
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.project.active_task, null);
    assert.equal(done.body.releases[0].status, 'failed');
  }));
