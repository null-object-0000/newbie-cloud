import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { generatePwa } from '../scripts/pwa.ts';

test('PWA builds versioned static-only precaches and changes version when the shell changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'newbie-pwa-'));
  try {
    await fs.mkdir(path.join(dir, 'assets'));
    await fs.writeFile(path.join(dir, 'index.html'), '<html>shell</html>');
    await fs.copyFile('public/manifest.webmanifest', path.join(dir, 'manifest.webmanifest'));
    await fs.writeFile(path.join(dir, 'assets/app-123.js'), 'console.log("app")');
    await fs.writeFile(path.join(dir, 'private.json'), '{"secret":"never cache"}');
    const first = await generatePwa(dir);
    assert.deepEqual(first.urls, ['/assets/app-123.js', '/index.html', '/manifest.webmanifest']);
    assert.equal((await generatePwa(dir)).version, first.version);
    await fs.writeFile(path.join(dir, 'index.html'), '<html>updated shell</html>');
    assert.notEqual((await generatePwa(dir)).version, first.version);
    const source = await fs.readFile(path.join(dir, 'sw.js'), 'utf8');
    assert.ok(!source.includes('__BUILD_VERSION__'));
    assert.ok(!source.includes('__PRECACHE_URLS__'));
    const manifest = JSON.parse(await fs.readFile('public/manifest.webmanifest', 'utf8'));
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.scope, '/');
    for (const size of ['192x192', '512x512'])
      assert.ok(manifest.icons.some((i: any) => i.sizes === size));
    assert.ok(manifest.icons.some((i: any) => i.purpose === 'maskable'));
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('newbie-pwa-'));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('service worker never caches API reads/writes or queues failures, and only deletes its own old shell caches', async () => {
  const source = (await fs.readFile('src/service-worker.js', 'utf8'))
    .replace('__BUILD_VERSION__', '"test"')
    .replace('__PRECACHE_URLS__', '["/index.html","/assets/app.js"]');
  const handlers: Record<string, (event: any) => void> = {};
  let network = 0,
    cacheReads = 0,
    skips = 0;
  const removed: string[] = [];
  const self = {
    location: { origin: 'https://app.example' },
    clients: { claim: async () => {} },
    skipWaiting: async () => {
      skips++;
    },
    addEventListener: (name: string, handler: any) => {
      handlers[name] = handler;
    },
  };
  vm.runInNewContext(source, {
    self,
    URL,
    Request,
    Response,
    Set,
    Promise,
    fetch: async () => {
      network++;
      throw Error('offline');
    },
    caches: {
      keys: async () => ['newbie-cloud-shell-old', 'newbie-cloud-shell-test', 'another-app-cache'],
      delete: async (name: string) => {
        removed.push(name);
        return true;
      },
      open: async () => {
        cacheReads++;
        return { match: async () => new Response('static shell') };
      },
    },
  });
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    let response: Promise<Response> | undefined;
    handlers.fetch({
      request: { url: 'https://app.example/api/accounts', method, mode: 'cors' },
      respondWith: (r: Promise<Response>) => {
        response = r;
      },
    });
    assert.ok(response);
    const result = await response;
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(network, 4);
  assert.equal(cacheReads, 0);
  let navigation: Promise<Response> | undefined;
  handlers.fetch({
    request: { url: 'https://app.example/', method: 'GET', mode: 'navigate' },
    respondWith: (r: Promise<Response>) => {
      navigation = r;
    },
  });
  assert.equal(await (await navigation!).text(), 'static shell');
  let activation: Promise<unknown> | undefined;
  handlers.activate({
    waitUntil: (p: Promise<unknown>) => {
      activation = p;
    },
  });
  await activation;
  assert.deepEqual(removed, ['newbie-cloud-shell-old']);
  assert.equal(skips, 0);
  handlers.message({ data: { type: 'ACTIVATE_UPDATE' }, waitUntil: () => {} });
  assert.equal(skips, 1);
});
