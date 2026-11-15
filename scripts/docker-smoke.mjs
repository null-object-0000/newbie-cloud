import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const image = process.env.TEST_DOCKER_IMAGE ?? 'newbie-cloud:ci';
const marker = randomBytes(6).toString('hex'),
  prefix = 'newbie-smoke-' + marker,
  app = prefix + '-app',
  fixture = prefix + '-fixture',
  volume = prefix + '-data';
const docker = (args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const label = 'io.newbie-cloud.test=' + marker;
const socket = '/var/run/docker.sock',
  gid = String(fs.statSync(socket).gid);
let origin, token;
async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + '/healthz')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error('Container did not become ready');
}
function start() {
  docker([
    'run',
    '-d',
    '--name',
    app,
    '--label',
    label,
    '--label',
    'io.newbie-cloud.role=control-plane',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--group-add',
    gid,
    '-p',
    '127.0.0.1::8080',
    '-v',
    volume + ':/data',
    '-v',
    socket + ':' + socket,
    '-e',
    'DOCKER_SOCKET=' + socket,
    '-e',
    'DOCKER_WRITE_ENABLED=true',
    image,
  ]);
  origin = 'http://' + docker(['port', app, '8080/tcp']).split('\n')[0];
}
async function api(path, method = 'GET', data) {
  const r = await fetch(origin + '/api' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { status: r.status, body: await r.json() };
}
function removeContainer(name) {
  let inspect;
  try {
    inspect = JSON.parse(docker(['inspect', name]))[0];
  } catch {
    return;
  }
  assert.equal(inspect.Config.Labels['io.newbie-cloud.test'], marker);
  assert.ok(name.startsWith(prefix + '-'));
  docker(['rm', '-f', '-v', name]);
}
try {
  docker(['volume', 'create', '--label', label, volume]);
  docker([
    'run',
    '-d',
    '--name',
    fixture,
    '--label',
    label,
    '-e',
    'PRIVATE_TEST_VALUE=not-in-inspect-output',
    '--entrypoint',
    'node',
    image,
    '-e',
    "console.log('docker-fixture');setInterval(()=>{},1000)",
  ]);
  start();
  await ready();
  token = docker([
    'exec',
    app,
    'node',
    '-e',
    "process.stdout.write(require('node:fs').readFileSync('/data/admin-token.txt','utf8').trim())",
  ]);
  assert.equal((await fetch(origin + '/api/local/containers')).status, 401);
  assert.ok((await api('/plugins')).body.items.some((p) => p.manifest.id === 'docker'));
  // Exercise the bundled runner inside the actual non-root, read-only image.
  docker([
    'exec',
    app,
    'node',
    '-e',
    "const fs=require('node:fs');fs.mkdirSync('/data/plugin-smoke',{recursive:true});fs.writeFileSync('/data/plugin-smoke/plugin.mjs',`export default {collect({config}){setInterval(()=>{},1000);return [{id:'image',name:config.name,type:'demo',detail:String(process.env.DOCKER_SOCKET)}]}}`)",
  ]);
  const codeResult = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      app,
      'node',
      '--permission',
      '--allow-fs-read=/data/plugin-smoke',
      '/app/server/plugin-runner.mjs',
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify({
        filename: '/data/plugin-smoke/plugin.mjs',
        config: { name: 'Image plugin' },
        hosts: [],
      }),
      timeout: 10000,
    },
  );
  const collected = JSON.parse(codeResult);
  assert.equal(collected.ok, true);
  assert.equal(collected.items[0].name, 'Image plugin');
  const system = await api('/local/system');
  assert.equal(system.status, 200);
  assert.ok(system.body.engine.version);
  assert.equal(system.body.capabilities.runtime, 'docker');
  const containers = await api('/local/containers');
  const target = containers.body.items.find((c) => c.name === fixture),
    self = containers.body.items.find((c) => c.name === app);
  assert.ok(target);
  assert.ok(self.protected);
  const detail = await api('/local/containers/' + target.id);
  assert.equal(detail.status, 200);
  assert.ok(!JSON.stringify(detail.body).includes('not-in-inspect-output'));
  assert.ok(
    (await api('/local/containers/' + target.id + '/logs?tail=200')).body.text.includes(
      'docker-fixture',
    ),
  );
  assert.equal((await api('/local/containers/' + target.id + '/stats')).status, 200);
  assert.equal(
    (
      await api('/local/containers/' + self.id + '/action', 'POST', {
        action: 'stop',
        confirmName: app,
        expectedState: 'running',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api('/local/containers/' + target.id + '/action', 'POST', {
        action: 'stop',
        confirmName: 'wrong',
        expectedState: 'running',
      })
    ).status,
    400,
  );
  for (const [action, state] of [
    ['stop', 'running'],
    ['start', 'exited'],
    ['restart', 'running'],
  ]) {
    const result = await api('/local/containers/' + target.id + '/action', 'POST', {
      action,
      confirmName: fixture,
      expectedState: state,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(
      (await api('/local/containers/' + target.id)).body.state,
      action === 'stop' ? 'exited' : 'running',
    );
  }
  assert.equal(
    (
      await api('/accounts', 'POST', {
        name: 'persistence-fixture',
        provider: 'cloudflare',
        credentials: { apiToken: 'fake-test-only-token' },
      })
    ).status,
    201,
  );
  removeContainer(app);
  start();
  await ready();
  const after = docker([
    'exec',
    app,
    'node',
    '-e',
    "process.stdout.write(require('node:fs').readFileSync('/data/admin-token.txt','utf8').trim())",
  ]);
  assert.equal(after, token);
  assert.equal((await api('/accounts')).body.items.length, 1);
  console.log(
    JSON.stringify({
      imageStarted: true,
      sqlitePersistence: true,
      secretPersistence: true,
      localEngine: true,
      inspect: true,
      logs: true,
      stats: true,
      startStopRestart: true,
      selfProtection: true,
      authentication: true,
      bundledPluginRunner: true,
    }),
  );
} finally {
  removeContainer(fixture);
  removeContainer(app);
  let metadata;
  try {
    metadata = JSON.parse(docker(['volume', 'inspect', volume]))[0];
  } catch {}
  if (metadata) {
    assert.equal(metadata.Labels['io.newbie-cloud.test'], marker);
    assert.ok(volume.startsWith(prefix + '-'));
    docker(['volume', 'rm', volume]);
  }
}
