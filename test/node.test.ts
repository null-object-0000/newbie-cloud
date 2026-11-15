import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SqliteDatabase } from '../src/node/database';
import { createNodeRuntime, loadKeys, assetHandler } from '../src/node/runtime';
import { DockerEngine, localRuntime } from '../src/node/docker';
import { createApp } from '../src/server/index';
import type { Env, LocalRuntime } from '../src/server/types';
const rawRequest = (
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>(
    (resolve, reject) => {
      const req = http.request(
        url,
        { method: options.method ?? 'GET', headers: options.headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              text: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(options.body);
    },
  );
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'newbie-node-'));
const remove = (dir: string) => {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('newbie-node-'));
  fs.rmSync(dir, { recursive: true, force: true });
};

test('SQLite adapter persists data, applies migrations once and rolls back failed D1-style batches', async () => {
  const dir = temp(),
    filename = path.join(dir, 'app.sqlite');
  let db = new SqliteDatabase(filename, 'migrations');
  try {
    await db.prepare('INSERT INTO settings VALUES(?,?)').bind('one', 'persisted').run();
    await assert.rejects(() =>
      db.batch([
        db.prepare('INSERT INTO settings VALUES(?,?)').bind('rollback', 'value'),
        db.prepare('INSERT INTO settings VALUES(?,?)').bind('one', 'duplicate'),
      ]),
    );
    assert.equal(
      await db.prepare('SELECT value FROM settings WHERE key=?').bind('rollback').first(),
      null,
    );
    db.close();
    db = new SqliteDatabase(filename, 'migrations');
    assert.equal(
      (
        await db
          .prepare('SELECT value FROM settings WHERE key=?')
          .bind('one')
          .first<{ value: string }>()
      )?.value,
      'persisted',
    );
    assert.equal(
      (await db.prepare('SELECT count(*) AS n FROM _migrations').first<{ n: number }>())?.n,
      1,
    );
  } finally {
    db.close();
    remove(dir);
  }
});

test('Docker startup keys are durable, mismatch is rejected and missing keys never silently replace an existing database', () => {
  const dir = temp();
  try {
    const first = loadKeys(dir);
    assert.deepEqual(loadKeys(dir), first);
    assert.equal(
      fs.readFileSync(path.join(dir, 'admin-token.txt'), 'utf8').trim(),
      first.ADMIN_TOKEN,
    );
    assert.throws(
      () => loadKeys(dir, { ADMIN_TOKEN: 'different-secret-at-least-thirty-two-characters' }),
      /不一致/,
    );
    fs.unlinkSync(path.join(dir, 'secrets.json'));
    fs.writeFileSync(path.join(dir, 'app.sqlite'), 'existing');
    assert.throws(() => loadKeys(dir), /缺少密钥/);
  } finally {
    remove(dir);
  }
});

test('Node HTTP runtime uses the same auth, CSRF, encryption and durable SQLite behavior as the Worker', async () => {
  const dir = temp();
  const assets = path.join(dir, 'static');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'index.html'), '<html>static shell</html>');
  const runtime = createNodeRuntime({
    dataDirectory: path.join(dir, 'data'),
    assetsDirectory: assets,
    migrationsDirectory: 'migrations',
    port: 0,
    fetcher: async () =>
      Response.json({ success: true, result: [], result_info: { total_pages: 1 } }),
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const port = (runtime.server.address() as any).port,
    origin = 'http://127.0.0.1:' + port;
  try {
    const headers = {
      Authorization: 'Bearer ' + runtime.env.ADMIN_TOKEN,
      'Content-Type': 'application/json',
    };
    assert.equal((await fetch(origin + '/api/accounts')).status, 401);
    assert.equal(
      (await rawRequest(origin + '/api/health', { headers: { Host: 'attacker.example' } })).status,
      421,
    );
    const login = await fetch(origin + '/api/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: runtime.env.ADMIN_TOKEN }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    assert.equal(
      (
        await fetch(origin + '/api/accounts', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'https://attacker.example',
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
      403,
    );
    const added = await fetch(origin + '/api/accounts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'local',
        provider: 'cloudflare',
        credentials: { apiToken: 'fixture-cloud-secret-value', accountId: 'fixture-account' },
      }),
    });
    assert.equal(added.status, 201);
    const created: any = await added.json();
    const inventory = await fetch(
      origin + '/api/accounts/' + created.account.id + '/inventory/services',
      { method: 'POST', headers, body: '{}' },
    );
    assert.equal(inventory.status, 200);
    assert.equal(((await inventory.json()) as any).complete, true);
    const raw = runtime.db.sqlite.prepare('SELECT credentials FROM accounts').get()!;
    assert.ok(!String(raw.credentials).includes('fixture-cloud-secret-value'));
    const me: any = await (await fetch(origin + '/api/me', { headers })).json();
    assert.equal(me.features.local.runtime, 'node');
    assert.equal(me.features.local.docker, false);
    const system: any = await (await fetch(origin + '/api/local/system', { headers })).json();
    assert.ok(system.runtime.nodeVersion);
    assert.ok(system.dataDisk.totalBytes > 0);
    assert.equal((await fetch(origin + '/.env')).status, 404);
    assert.equal((await fetch(origin + '/_headers')).status, 404);
    assert.equal(
      (await fetch(origin + '/api/accounts', { headers })).headers.get('Cache-Control'),
      'no-store',
    );
    assert.ok((await (await fetch(origin + '/')).text()).includes('static shell'));
  } finally {
    await runtime.close();
    remove(dir);
  }
});

test('PUBLIC_ORIGIN controls HTTPS cookies and forwarded headers cannot override the trusted origin', async () => {
  const dir = temp();
  const runtime = createNodeRuntime({
    dataDirectory: dir,
    assetsDirectory: 'dist',
    migrationsDirectory: 'migrations',
    publicOrigin: 'https://cloud.example.test',
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (runtime.server.address() as any).port;
  try {
    const login = await rawRequest(origin + '/api/login', {
      method: 'POST',
      headers: {
        Host: 'cloud.example.test',
        Origin: 'https://cloud.example.test',
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'http',
      },
      body: JSON.stringify({ token: runtime.env.ADMIN_TOKEN }),
    });
    assert.equal(login.status, 200);
    assert.ok(login.headers['set-cookie']?.some((v) => v.includes('; Secure')));
    assert.equal(
      (
        await rawRequest(origin + '/api/health', {
          headers: { Host: 'attacker.test', 'X-Forwarded-Host': 'cloud.example.test' },
        })
      ).status,
      421,
    );
  } finally {
    await runtime.close();
    remove(dir);
  }
});

test('Docker adapter uses a local socket, redacts inspect secrets, decodes logs and guards container actions', async () => {
  const dir = temp(),
    socket =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\newbie-test-' + process.pid + '-' + Date.now()
        : path.join(dir, 'engine.sock');
  const id = 'a'.repeat(64),
    self = 'b'.repeat(64);
  let state = 'running',
    posts = 0;
  const frame = (text: Buffer) => {
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(text.length, 4);
    return Buffer.concat([header, text]);
  };
  const docker = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/version') {
      res.end(JSON.stringify({ ApiVersion: '1.55' }));
      return;
    }
    if (req.url?.includes('/containers/json')) {
      res.end(
        JSON.stringify([
          {
            Id: id,
            Names: ['/example'],
            Image: 'fixture:latest',
            State: state,
            Status: 'Up',
            Created: 1,
            Labels: {},
            Ports: [],
          },
        ]),
      );
      return;
    }
    if (req.url?.endsWith('/json')) {
      res.end(
        JSON.stringify({
          Id: req.url.includes(self) ? self : id,
          Name: '/example',
          Created: new Date().toISOString(),
          Config: {
            Image: 'fixture',
            Hostname: 'fixture',
            Tty: false,
            Env: ['PASSWORD=do-not-return'],
            Labels: {},
          },
          HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
          State: { Status: state },
          NetworkSettings: { Ports: {}, Networks: {} },
          Mounts: [],
        }),
      );
      return;
    }
    if (req.url?.includes('/logs?')) {
      assert.ok(!req.url.includes('follow=1'));
      const text = Buffer.from('中文日志\n');
      res.end(Buffer.concat([frame(text.subarray(0, 2)), frame(text.subarray(2))]));
      return;
    }
    if (req.url?.includes('/stats?')) {
      res.end(
        JSON.stringify({
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000, online_cpus: 2 },
          precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
          memory_stats: { usage: 200, limit: 1000, stats: { inactive_file: 50 } },
          networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
        }),
      );
      return;
    }
    if (req.method === 'POST') {
      posts++;
      state = req.url?.includes('/stop') ? 'exited' : 'running';
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((resolve) => docker.listen(socket, resolve));
  try {
    const engine = new DockerEngine(socket, true, self);
    assert.equal((await engine.containers()).length, 1);
    assert.ok(!JSON.stringify(await engine.inspect(id)).includes('do-not-return'));
    assert.equal((await engine.logs(id, 200)).text, '中文日志\n');
    assert.equal((await engine.stats(id)).cpuPercent, 40);
    assert.equal((await engine.stats(id)).memoryBytes, 150);
    await assert.rejects(
      () => new DockerEngine(socket, false).action(id, 'stop', 'example', 'running'),
      /未开启/,
    );
    await assert.rejects(() => engine.action(id, 'stop', 'wrong', 'running'), /名称/);
    await assert.rejects(() => engine.action(id, 'stop', 'example', 'exited'), /状态已变化/);
    await assert.rejects(() => engine.action(self, 'stop', 'example', 'running'), /管理台自身/);
    await assert.rejects(() => engine.inspect('../containers/evil'), /ID 无效/);
    assert.equal(posts, 0);
    await engine.action(id, 'stop', 'example', 'running');
    assert.equal(posts, 1);
    assert.equal(state, 'exited');
  } finally {
    await new Promise<void>((resolve) => docker.close(() => resolve()));
    remove(dir);
  }
});

test('local container routes require authentication, CSRF and an explicitly enabled write capability', async () => {
  const dir = temp(),
    keys = loadKeys(dir),
    db = new SqliteDatabase(path.join(dir, 'app.sqlite'), 'migrations');
  let calls = 0;
  const local = {
    ...localRuntime({ dataDirectory: dir, containerized: true }),
    capabilities: { runtime: 'docker', docker: true, dockerWrite: false },
    action: async () => {
      calls++;
    },
  } as LocalRuntime;
  const env = { ...keys, DB: db.asD1(), LOCAL: local, ASSETS: assetHandler('dist') } as Env,
    app = createApp(),
    url = 'https://app.example/api/local/containers/' + 'a'.repeat(64) + '/action';
  try {
    assert.equal((await app.fetch(new Request(url, { method: 'POST' }), env)).status, 401);
    assert.equal(
      (
        await app.fetch(
          new Request(url, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + keys.ADMIN_TOKEN,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ action: 'stop', confirmName: 'a', expectedState: 'running' }),
          }),
          env,
        )
      ).status,
      403,
    );
    assert.equal(calls, 0);
    assert.equal(
      (
        await app.fetch(
          new Request('https://app.example/api/local/system', {
            headers: { Authorization: 'Bearer ' + keys.ADMIN_TOKEN },
          }),
          { ...env, LOCAL: undefined },
        )
      ).status,
      404,
    );
  } finally {
    db.close();
    remove(dir);
  }
});
