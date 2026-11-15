import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/index';
import type { Env, Fetch, LocalRuntime } from '../server/types';
import { SqliteDatabase } from './database';
import { localRuntime } from './docker';
import { codePluginHost } from './plugin-host';

type Keys = { ADMIN_TOKEN: string; ENCRYPTION_KEY: string };
export function loadKeys(directory: string, provided: Partial<Keys> = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'secrets.json');
  let keys: Keys;
  if (fs.existsSync(filename)) {
    keys = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (Object.entries(provided).some(([key, value]) => value && value !== keys[key as keyof Keys]))
      throw Error('环境密钥与数据卷中的密钥不一致；请使用原密钥或先迁移数据');
  } else {
    if (!!provided.ADMIN_TOKEN !== !!provided.ENCRYPTION_KEY)
      throw Error('ADMIN_TOKEN 和 ENCRYPTION_KEY 必须同时提供');
    if (fs.existsSync(path.join(directory, 'app.sqlite')) && !provided.ENCRYPTION_KEY)
      throw Error('已有数据库缺少密钥文件，请从备份恢复，不能自动更换主密钥');
    keys = provided.ADMIN_TOKEN
      ? (provided as Keys)
      : {
          ADMIN_TOKEN: randomBytes(32).toString('base64url'),
          ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        };
  }
  if (
    typeof keys.ADMIN_TOKEN !== 'string' ||
    keys.ADMIN_TOKEN.length < 32 ||
    keys.ADMIN_TOKEN.length > 512 ||
    keys.ADMIN_TOKEN.startsWith('replace-with-') ||
    !/^[A-Za-z0-9+/]{43}=$/.test(keys.ENCRYPTION_KEY) ||
    Buffer.from(keys.ENCRYPTION_KEY, 'base64').length !== 32
  )
    throw Error('部署密钥格式无效');
  if (!fs.existsSync(filename))
    fs.writeFileSync(filename, JSON.stringify(keys, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'admin-token.txt'), keys.ADMIN_TOKEN + '\n', {
    mode: 0o600,
  });
  return keys;
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
export function assetHandler(directory: string) {
  const root = path.resolve(directory);
  return {
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (!['GET', 'HEAD'].includes(request.method))
        return new Response('Method not allowed', { status: 405 });
      if (url.pathname === '/index.html')
        return new Response(null, { status: 308, headers: { Location: '/' + url.search } });
      let name: string;
      try {
        name = decodeURIComponent(url.pathname);
      } catch {
        return new Response('Invalid path', { status: 400 });
      }
      if (
        name.includes('\\') ||
        name.split('/').some((p) => p.startsWith('.')) ||
        name === '/_headers'
      )
        return new Response('Not found', { status: 404 });
      let file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        if (path.extname(name) || name.startsWith('/api/'))
          return new Response('Not found', { status: 404 });
        file = path.join(root, 'index.html');
      }
      const headers: Record<string, string> = {
        'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': name.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        'X-Robots-Tag': 'noindex, nofollow',
      };
      if (name === '/sw.js') headers['Service-Worker-Allowed'] = '/';
      return new Response(request.method === 'HEAD' ? null : fs.readFileSync(file), { headers });
    },
  } as Fetcher;
}
export function createNodeRuntime(options: {
  dataDirectory: string;
  assetsDirectory: string;
  migrationsDirectory: string;
  port?: number;
  publicOrigin?: string;
  keys?: Partial<Keys>;
  githubToken?: string;
  socket?: string;
  writeEnabled?: boolean;
  containerized?: boolean;
  fetcher?: Fetch;
  local?: LocalRuntime;
  codePlugins?: boolean;
  pluginRunner?: string;
}) {
  const data = path.resolve(options.dataDirectory),
    keys = loadKeys(data, options.keys),
    port = options.port ?? 8080;
  const publicUrl = options.publicOrigin ? new URL(options.publicOrigin) : null;
  if (
    publicUrl &&
    (!['http:', 'https:'].includes(publicUrl.protocol) ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.pathname !== '/' ||
      publicUrl.search ||
      publicUrl.hash)
  )
    throw Error('PUBLIC_ORIGIN 必须是完整站点来源，例如 https://cloud.example.com');
  const db = new SqliteDatabase(path.join(data, 'app.sqlite'), options.migrationsDirectory);
  const env: Env = {
    ...keys,
    DB: db.asD1(),
    ASSETS: assetHandler(options.assetsDirectory),
    GITHUB_TOKEN: options.githubToken,
    PLUGINS: codePluginHost(
      path.join(data, 'plugins'),
      options.pluginRunner ?? path.resolve('server/plugin-runner.mjs'),
      !!options.codePlugins,
    ),
    LOCAL:
      options.local ??
      localRuntime({
        dataDirectory: data,
        socket: options.socket,
        writeEnabled: options.writeEnabled,
        containerized: !!options.containerized,
      }),
  };
  const app = createApp(options.fetcher);
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      if (incoming.url === '/healthz' && incoming.method === 'GET') {
        outgoing.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        outgoing.end('{"ok":true}');
        return;
      }
      const host = incoming.headers.host ?? '';
      let allowed = false;
      try {
        const parsed = new URL('http://' + host);
        allowed = publicUrl
          ? host === publicUrl.host
          : ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.host === host;
      } catch {}
      if (!allowed) {
        outgoing.writeHead(421, { 'Content-Type': 'text/plain' });
        outgoing.end('Unrecognized host; configure PUBLIC_ORIGIN');
        return;
      }
      const base = publicUrl?.origin ?? 'http://' + host;
      const url = new URL(incoming.url ?? '/', base);
      if (!incoming.url?.startsWith('/') || url.origin !== base) {
        outgoing.writeHead(400);
        outgoing.end();
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 16384) {
          outgoing.writeHead(413, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          outgoing.end('{"error":"请求内容过大"}');
          return;
        }
        chunks.push(chunk);
      }
      const response = await app.fetch(
        new Request(url, {
          method: incoming.method,
          headers,
          ...(!['GET', 'HEAD'].includes(incoming.method ?? 'GET')
            ? { body: Buffer.concat(chunks) }
            : {}),
        }),
        env,
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent)
        outgoing.writeHead(500, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
      outgoing.end('{"error":"服务暂时不可用"}');
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return {
    server,
    env,
    db,
    app,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          db.close();
          resolve();
        }),
      ),
  };
}
