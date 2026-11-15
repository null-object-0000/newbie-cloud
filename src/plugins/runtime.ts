import { decrypt, encrypt } from '../server/crypto';
import { HttpError, now, type Env, type Fetch } from '../server/types';
import { builtinPlugins, builtinIds } from './catalog';
import { inspectSource, packageIntegrity, bytesLimited } from './sources';
import { getPath, validateResources } from './validation';
import type {
  InstalledPlugin,
  PluginManifest,
  PluginPackage,
  PluginStatus,
  PluginResource,
} from './types';

async function read<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
    .bind(key)
    .first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}
async function audit(env: Env, summary: string) {
  const at = now();
  await env.DB.prepare(
    'INSERT INTO operations(id,account_id,kind,status,summary,result,created_at,updated_at) VALUES(?,NULL,?,?,?,?,?,?)',
  )
    .bind(crypto.randomUUID(), 'plugin', 'success', summary, null, at, at)
    .run();
}
async function put(env: Env, key: string, value: unknown) {
  await env.DB.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  )
    .bind(key, JSON.stringify(value))
    .run();
}
export async function requirePlugin(env: Env, id: string) {
  const state = await read<Record<string, boolean>>(env, 'plugins:state');
  if (state?.[id] === false)
    throw new HttpError(
      403,
      '插件已停用：' + (builtinPlugins.find((p) => p.id === id)?.name ?? id),
    );
}
export async function enabledBuiltins(env: Env) {
  const state = (await read<Record<string, boolean>>(env, 'plugins:state')) ?? {};
  return builtinPlugins.filter((p) => state[p.id] !== false).map((p) => p.id);
}
function available(env: Env, m: PluginManifest) {
  if (m.kind === 'node' && !env.PLUGINS?.codeEnabled)
    return env.LOCAL
      ? '需在自托管环境启用 ALLOW_CODE_PLUGINS=true，才可运行可信代码'
      : 'JavaScript 代码插件需要 Docker / Node 自托管版';
  if (m.id === 'docker' && !env.LOCAL) return '本机容器仅在 Docker / Node 自托管版提供';
  if (m.id === 'host' && !env.LOCAL) return '主机概览仅在 Docker / Node 自托管版提供';
  return null;
}
async function config(env: Env, p: InstalledPlugin): Promise<Record<string, string>> {
  return p.configCipher
    ? decrypt<Record<string, string>>(p.configCipher, env.ENCRYPTION_KEY, 'plugin:' + p.manifest.id)
    : {};
}
function filled(m: PluginManifest, c: Record<string, string>) {
  return m.config.every((f) => !f.required || !!(c[f.key] ?? f.default));
}
export async function pluginCatalog(env: Env): Promise<PluginStatus[]> {
  const state = (await read<Record<string, boolean>>(env, 'plugins:state')) ?? {};
  const builtin = builtinPlugins.map((manifest) => {
    const reason = available(env, manifest);
    return {
      manifest,
      builtin: true,
      enabled: state[manifest.id] !== false,
      available: !reason,
      reason,
      configured: true,
    };
  });
  const rows = await env.DB.prepare(
    "SELECT value FROM settings WHERE key LIKE 'plugin-installed:%' ORDER BY key",
  ).all<{ value: string }>();
  const external = await Promise.all(
    rows.results.map(async (row) => {
      const p: InstalledPlugin = JSON.parse(row.value),
        reason = available(env, p.manifest);
      return {
        manifest: p.manifest,
        builtin: false,
        enabled: p.enabled,
        available: !reason,
        reason,
        configured: filled(p.manifest, await config(env, p)),
        source: p.source,
        resolvedSource: p.resolvedSource,
        integrity: p.integrity,
      };
    }),
  );
  return [...builtin, ...external];
}
function substitute(template: string, c: Record<string, string>, encode = false) {
  return template.replace(/\{\{config\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, key) =>
    encode ? encodeURIComponent(c[key] ?? '') : (c[key] ?? ''),
  );
}
export async function collectDeclarative(
  m: PluginManifest,
  c: Record<string, string>,
  fetcher: Fetch,
): Promise<PluginResource[]> {
  if (!m.connector) return validateResources(m.resources ?? []);
  const connector = m.connector,
    url = new URL(substitute(connector.url, c, true));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !m.permissions.network.includes(url.hostname)
  )
    throw new HttpError(403, '连接器地址超出已确认的网络权限');
  const headers: Record<string, string> = { Accept: 'application/json' };
  for (const [key, value] of Object.entries(connector.headers ?? {})) {
    const v = substitute(value, c);
    if (/[\r\n]/.test(v)) throw new HttpError(400, '配置不能在 HTTP 请求头中包含换行');
    headers[key] = v;
  }
  const response = await fetcher.call(globalThis, url.href, {
    method: 'GET',
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel();
    throw new HttpError(502, '资源接口 HTTP ' + response.status + '；已停止重定向');
  }
  let result: any;
  try {
    result = JSON.parse(new TextDecoder().decode(await bytesLimited(response.body, 1000000)));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, '资源接口未返回有效 JSON');
  }
  const rows = connector.itemsPath ? getPath(result, connector.itemsPath) : result;
  if (!Array.isArray(rows)) throw new HttpError(502, '资源接口的列表路径不是数组');
  return validateResources(
    rows.map((r) =>
      Object.fromEntries(
        Object.entries(connector.fields).map(([field, path]) => [
          field,
          String(getPath(r, path) ?? ''),
        ]),
      ),
    ),
  );
}
function redacted(value: any, m: PluginManifest, c: Record<string, string>): any {
  const secrets = m.config.filter((f) => f.secret && !!c[f.key]).map((f) => c[f.key]);
  const scrub = (v: any): any =>
    typeof v === 'string'
      ? secrets.reduce((s, key) => s.replaceAll(key, '[已隐藏]'), v)
      : Array.isArray(v)
        ? v.map(scrub)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
          : v;
  return scrub(value);
}
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
export async function pluginApi(
  request: Request,
  env: Env,
  fetcher: Fetch,
  body: (r: Request) => Promise<Record<string, any>>,
): Promise<Response> {
  const { pathname: p } = new URL(request.url),
    method = request.method;
  if (p === '/api/plugins' && method === 'GET') return json({ items: await pluginCatalog(env) });
  if (p === '/api/plugins/preview' && method === 'POST') {
    const input = await body(request),
      pkg = await inspectSource(input.source, fetcher),
      id = crypto.randomUUID();
    const existing = await read<InstalledPlugin>(env, 'plugin-installed:' + pkg.manifest.id);
    const identity = (s: string) => s.slice(0, s.lastIndexOf('@'));
    if (existing && identity(existing.resolvedSource) !== identity(pkg.resolvedSource))
      throw new HttpError(409, '同名插件来自不同来源，不能覆盖；请先卸载旧插件');
    await env.DB.prepare(
      "DELETE FROM settings WHERE key LIKE 'plugin-preview:%' AND json_extract(value,'$.expiresAt') < ?",
    )
      .bind(now())
      .run();
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM settings WHERE key LIKE 'plugin-preview:%'",
    ).first<{ total: number }>();
    if ((count?.total ?? 0) >= 20) throw new HttpError(429, '待确认预览过多，请完成或等待过期');
    const expiresAt = new Date(Date.now() + 900000).toISOString();
    await put(env, 'plugin-preview:' + id, { pkg, expiresAt });
    return json({
      id,
      manifest: pkg.manifest,
      source: pkg.source,
      resolvedSource: pkg.resolvedSource,
      integrity: pkg.integrity,
      expiresAt,
      reason: available(env, pkg.manifest),
      previousVersion: existing?.manifest.version ?? null,
    });
  }
  if (p === '/api/plugins/install' && method === 'POST') {
    const input = await body(request),
      key = 'plugin-preview:' + String(input.previewId),
      preview = await read<{ pkg: PluginPackage; expiresAt: string }>(env, key);
    if (!preview || preview.expiresAt < now())
      throw new HttpError(409, '安装预览已过期，请重新检查来源');
    if (
      input.acceptPermissions !== true ||
      (preview.pkg.manifest.kind === 'node' && input.trustCode !== true)
    )
      throw new HttpError(400, '请确认插件来源、网络声明和代码信任');
    const pkg = preview.pkg;
    if (pkg.manifest.kind === 'node' && !env.LOCAL)
      throw new HttpError(400, '代码插件需要 Docker / Node 自托管版');
    if ((await packageIntegrity(pkg.manifest, pkg.code)) !== pkg.integrity)
      throw new HttpError(409, '预览完整性校验失败');
    const old = await read<InstalledPlugin>(env, 'plugin-installed:' + pkg.manifest.id);
    if (
      old &&
      old.resolvedSource.slice(0, old.resolvedSource.lastIndexOf('@')) !==
        pkg.resolvedSource.slice(0, pkg.resolvedSource.lastIndexOf('@'))
    )
      throw new HttpError(409, '插件来源已变化，请重新预览');
    const installed: InstalledPlugin = {
      ...pkg,
      enabled: false,
      installedAt: now(),
      ...(old?.configCipher ? { configCipher: old.configCipher } : {}),
    };
    const applied = await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO settings(key,value) SELECT ?,? FROM settings WHERE key=? AND value=? ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value=?',
      ).bind(
        'plugin-installed:' + pkg.manifest.id,
        JSON.stringify(installed),
        key,
        JSON.stringify(preview),
        old ? JSON.stringify(old) : '',
      ),
      env.DB.prepare(
        'DELETE FROM settings WHERE key=? AND EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?)',
      ).bind(key, 'plugin-installed:' + pkg.manifest.id, JSON.stringify(installed)),
    ]);
    if (applied[0].meta.changes !== 1)
      throw new HttpError(409, '预览已使用或插件已变化，请重新检查');
    await audit(env, '安装插件：' + pkg.manifest.id + ' / ' + pkg.manifest.version);
    return json({ ok: true, id: pkg.manifest.id });
  }
  const route = p.match(/^\/api\/plugins\/([a-z0-9.-]+)(?:\/(config|resources))?$/);
  if (route) {
    const id = route[1],
      action = route[2];
    if (builtinIds.has(id)) {
      if (!action && method === 'PATCH') {
        const input = await body(request);
        if (typeof input.enabled !== 'boolean') throw new HttpError(400, '启用状态无效');
        await env.DB.prepare(
          "INSERT INTO settings(key,value) VALUES('plugins:state', json_set('{}', ?, json(?))) ON CONFLICT(key) DO UPDATE SET value=json_set(settings.value, ?, json(?))",
        )
          .bind(
            '$.' + JSON.stringify(id),
            JSON.stringify(input.enabled),
            '$.' + JSON.stringify(id),
            JSON.stringify(input.enabled),
          )
          .run();
        await audit(env, (input.enabled ? '启用插件：' : '停用插件：') + id);
        return json({ ok: true });
      }
      throw new HttpError(400, '内置插件不可卸载；云账号仍在“云账号”中配置');
    }
    const plugin = await read<InstalledPlugin>(env, 'plugin-installed:' + id);
    if (!plugin) throw new HttpError(404, '插件未安装');
    const original = JSON.stringify(plugin);
    const save = async () => {
      const result = await env.DB.prepare('UPDATE settings SET value=? WHERE key=? AND value=?')
        .bind(JSON.stringify(plugin), 'plugin-installed:' + id, original)
        .run();
      if (result.meta.changes !== 1) throw new HttpError(409, '插件已在其他页面更新，请刷新后重试');
    };
    if (!action && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM settings WHERE key=?')
        .bind('plugin-installed:' + id)
        .run();
      await audit(env, '卸载插件：' + id);
      return json({ ok: true });
    }
    if (!action && method === 'PATCH') {
      const input = await body(request);
      if (typeof input.enabled !== 'boolean') throw new HttpError(400, '启用状态无效');
      const reason = available(env, plugin.manifest);
      if (input.enabled && reason) throw new HttpError(400, reason);
      if (input.enabled && !filled(plugin.manifest, await config(env, plugin)))
        throw new HttpError(400, '请先填写必需配置');
      plugin.enabled = input.enabled;
      await save();
      await audit(env, (input.enabled ? '启用插件：' : '停用插件：') + id);
      return json({ ok: true });
    }
    if (action === 'config') {
      const current = await config(env, plugin);
      if (method === 'GET')
        return json({
          values: Object.fromEntries(
            plugin.manifest.config
              .filter((f) => !f.secret)
              .map((f) => [f.key, current[f.key] ?? f.default ?? '']),
          ),
          savedSecrets: plugin.manifest.config
            .filter((f) => f.secret && !!current[f.key])
            .map((f) => f.key),
        });
      if (method === 'POST') {
        const input = await body(request);
        if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values))
          throw new HttpError(400, '配置无效');
        const next: Record<string, string> = {};
        for (const f of plugin.manifest.config) {
          const value = input.values[f.key];
          if (value !== undefined && (typeof value !== 'string' || value.length > 4096))
            throw new HttpError(400, '配置字段过长或格式无效');
          next[f.key] =
            f.secret && !value
              ? (current[f.key] ?? '')
              : (value ?? current[f.key] ?? f.default ?? '');
        }
        if (!filled(plugin.manifest, next)) throw new HttpError(400, '请填写必需配置');
        plugin.configCipher = await encrypt(next, env.ENCRYPTION_KEY, 'plugin:' + id);
        await save();
        await audit(env, '配置插件：' + id);
        return json({ ok: true });
      }
    }
    if (action === 'resources' && method === 'POST') {
      if (!plugin.enabled) throw new HttpError(403, '插件已停用');
      const reason = available(env, plugin.manifest);
      if (reason) throw new HttpError(400, reason);
      const values = await config(env, plugin);
      for (const f of plugin.manifest.config)
        if (values[f.key] === undefined && f.default !== undefined) values[f.key] = f.default;
      if (!filled(plugin.manifest, values)) throw new HttpError(400, '请先完成配置');
      try {
        const rows =
          plugin.manifest.kind === 'node'
            ? validateResources(
                await env.PLUGINS!.collect(
                  plugin.code!,
                  values,
                  plugin.manifest.permissions.network,
                ),
              )
            : await collectDeclarative(plugin.manifest, values, fetcher);
        return json({ items: redacted(rows, plugin.manifest, values), checkedAt: now() });
      } catch (e) {
        throw new HttpError(
          e instanceof HttpError ? e.status : 502,
          String(
            redacted(
              { error: e instanceof HttpError ? e.message : '插件执行失败，请核对插件版本和配置' },
              plugin.manifest,
              values,
            ).error,
          ),
        );
      }
    }
  }
  throw new HttpError(404, '插件接口不存在');
}
export function routePlugin(path: string): string | null {
  if (path.startsWith('/api/plugins')) return null;
  if (path.startsWith('/api/dns/')) return 'dns';
  if (path === '/api/dns-observations') return 'domains';
  if (path.startsWith('/api/local/containers')) return 'docker';
  if (path === '/api/local/system') return 'host';
  if (path === '/api/github/dispatch') return 'github-deploy';
  if (/\/server-regions$/.test(path)) return 'servers';
  if (/\/sync$/.test(path)) return 'domains';
  const inventory = path.match(
    /\/inventory\/(registrations|services|certificates|email|records|servers)$/,
  );
  const action = inventory?.[1] ?? path.match(/\/(records|email|services|certificates)$/)?.[1];
  return action
    ? ((
        {
          registrations: 'domains',
          records: 'dns',
          services: 'services',
          certificates: 'certificates',
          email: 'email',
          servers: 'servers',
        } as Record<string, string>
      )[action] ?? null)
    : null;
}
