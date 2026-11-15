import { HttpError } from '../server/types';
import type { PluginManifest, PluginResource } from './types';
import { builtinIds } from './catalog';

const fail = (message: string): never => {
  throw new HttpError(400, message);
};
const text = (v: unknown, max: number, label: string) =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail(label + '无效');
export function publicHost(host: string) {
  return (
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) &&
    host.includes('.') &&
    !/^[\d.]+$/.test(host) &&
    !['localhost', 'local', 'internal', 'home', 'lan', 'test'].some(
      (s) => host === s || host.endsWith('.' + s),
    ) &&
    host.length <= 253
  );
}
export function validateManifest(input: unknown): PluginManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('插件清单必须是对象');
  const m = input as any;
  if (m.schemaVersion !== 1) fail('不支持此插件 API 版本');
  const id = text(m.id, 80, '插件 ID');
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id) || builtinIds.has(id))
    fail('插件 ID 无效或与内置插件冲突');
  if (!['declarative', 'node'].includes(m.kind)) fail('插件类型仅支持 declarative / node');
  const result: PluginManifest = {
    schemaVersion: 1,
    id,
    name: text(m.name, 80, '插件名称'),
    version: text(m.version, 64, '插件版本'),
    description: text(m.description, 500, '插件描述'),
    kind: m.kind,
    permissions: { network: [] },
    config: [],
  };
  if (!Array.isArray(m.permissions?.network) || m.permissions.network.length > 10)
    fail('必须声明最多 10 个网络主机');
  result.permissions.network = [
    ...new Set<string>(
      m.permissions.network.map((h: any) => {
        if (typeof h !== 'string' || !publicHost(h))
          fail('网络权限必须是公开域名，不能包含 IP、端口或通配符');
        return h;
      }),
    ),
  ];
  if (!Array.isArray(m.config) || m.config.length > 20) fail('配置字段不能超过 20 个');
  const seen = new Set();
  result.config = m.config.map((f: any) => {
    if (
      !f ||
      !/^[_a-zA-Z][_a-zA-Z0-9]{0,63}$/.test(f.key) ||
      ['__proto__', 'constructor', 'prototype'].includes(f.key) ||
      seen.has(f.key)
    )
      fail('配置字段名无效或重复');
    seen.add(f.key);
    return {
      key: f.key,
      label: text(f.label, 80, '字段名称'),
      secret: f.secret === true,
      required: f.required === true,
      ...(typeof f.default === 'string' && !f.secret ? { default: f.default.slice(0, 2000) } : {}),
    };
  });
  if (m.kind === 'node') {
    if (m.entry !== 'plugin.mjs')
      fail('代码插件必须提供预打包的 plugin.mjs（无需安装依赖或执行脚本）');
    result.entry = 'plugin.mjs';
  } else if (m.connector) {
    const c = m.connector;
    const url = text(c.url, 2048, '连接地址');
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      fail('连接地址必须是完整 HTTPS 地址');
    }
    if (
      u!.protocol !== 'https:' ||
      u!.username ||
      u!.password ||
      (u!.port && u!.port !== '443') ||
      !result.permissions.network.includes(u!.hostname)
    )
      fail('连接地址超出已声明的 HTTPS 网络权限');
    if (/\{\{/.test(u!.origin)) fail('连接地址的主机不能由配置替换');
    const fields: Record<string, string> = {};
    for (const key of ['id', 'name', 'type', 'status', 'domain', 'region', 'url', 'detail'])
      if (c.fields?.[key] !== undefined) {
        if (typeof c.fields[key] !== 'string' || !validPath(c.fields[key]))
          fail('资源字段映射无效');
        fields[key] = c.fields[key];
      }
    if (!fields.id || !fields.name) fail('连接器必须映射 id 和 name');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.headers ?? {})) {
      if (
        !/^[A-Za-z0-9-]{1,64}$/.test(k) ||
        ['host', 'cookie', 'content-length', 'connection', 'proxy-authorization'].includes(
          k.toLowerCase(),
        ) ||
        typeof v !== 'string' ||
        v.length > 4096 ||
        /[\r\n]/.test(v)
      )
        fail('连接器请求头无效');
      headers[k] = v as string;
    }
    if (Object.keys(headers).length > 15) fail('请求头过多');
    if (c.itemsPath !== undefined && !validPath(c.itemsPath)) fail('资源列表路径无效');
    result.connector = { url, headers, fields, ...(c.itemsPath ? { itemsPath: c.itemsPath } : {}) };
  } else result.resources = validateResources(m.resources ?? []);
  return result;
}
export function validPath(path: unknown) {
  return (
    typeof path === 'string' &&
    path.length <= 200 &&
    /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(path) &&
    !path.split('.').some((p) => ['__proto__', 'prototype', 'constructor'].includes(p))
  );
}
export function getPath(data: unknown, path: string) {
  return path
    .split('.')
    .reduce(
      (value: any, key) =>
        value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
          ? value[key]
          : undefined,
      data,
    );
}
export function validateResources(input: unknown): PluginResource[] {
  if (!Array.isArray(input) || input.length > 1000) fail('插件最多返回 1000 项资源');
  const ids = new Set();
  return (input as any[]).map((r: any) => {
    if (!r || typeof r !== 'object') fail('资源格式无效');
    const resource: PluginResource = {
      id: text(r.id, 256, '资源 ID'),
      name: text(r.name, 256, '资源名称'),
      type: typeof r.type === 'string' ? r.type.slice(0, 80) : 'resource',
    };
    if (ids.has(resource.id)) fail('资源 ID 重复');
    ids.add(resource.id);
    for (const key of ['status', 'domain', 'region', 'url', 'detail'] as const)
      if (typeof r[key] === 'string')
        resource[key] = r[key].slice(0, key === 'detail' ? 2000 : 512);
    if (resource.url) {
      try {
        const u = new URL(resource.url);
        if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)
          delete resource.url;
      } catch {
        delete resource.url;
      }
    }
    return resource;
  });
}
