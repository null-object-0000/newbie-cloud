import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, validateAssets, MAX_FILE, MAX_FILES, MAX_TOTAL } from '../projects/files';
export function client(
  base = process.env.NEWBIE_CLOUD_URL,
  token = process.env.NEWBIE_CLOUD_TOKEN,
) {
  if (!base || !token) throw Error('请配置 NEWBIE_CLOUD_URL 和 NEWBIE_CLOUD_TOKEN');
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw Error('工作台地址必须为 HTTPS 来源，本机测试可使用 localhost HTTP');
  return async (endpoint: string, method = 'GET', body?: unknown, raw = false) => {
    if (
      endpoint &&
      !/^\/[a-f0-9-]{36}(?:\/(?:provision|rollback|releases(?:\/[a-f0-9-]{36}(?:\/(?:publish|check|file\?path=[^#]+))?)?))?$/.test(
        endpoint,
      )
    )
      throw Error('项目接口参数无效');
    const response = await fetch(url.origin + '/api/projects' + endpoint, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body !== undefined
          ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }
          : {}),
      },
      body:
        body === undefined
          ? undefined
          : raw
            ? (body as Uint8Array<ArrayBuffer>)
            : JSON.stringify(body),
    });
    const b: any = await response.json();
    if (!response.ok) throw Error(b.error ?? '请求未完成；请查询状态，勿重复提交');
    return b;
  };
}
export async function collect(directory: string, root?: string) {
  const resolved = await fs.realpath(directory);
  if (root) {
    const allowed = await fs.realpath(root),
      relative = path.relative(allowed, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw Error('目录超出 NEWBIE_CLOUD_PUBLISH_ROOT');
  }
  const output: { bytes: Uint8Array; asset: Awaited<ReturnType<typeof describe>> }[] = [];
  let total = 0;
  async function walk(current: string) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name),
        stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) throw Error('发布目录不能包含符号链接');
      if (entry.name.startsWith('.') || entry.name === 'node_modules')
        throw Error('请只选择构建目录，不要发布源码或隐藏文件');
      if (stat.isDirectory()) await walk(filename);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > MAX_TOTAL) throw Error('发布总大小不能超过 10 MiB');
        if (output.length >= MAX_FILES || stat.size > MAX_FILE)
          throw Error('文件数量或单文件大小超出限制');
        const bytes = new Uint8Array(await fs.readFile(filename));
        output.push({
          bytes,
          asset: await describe(bytes, path.relative(resolved, filename).split(path.sep).join('/')),
        });
      } else throw Error('发布目录包含非普通文件');
    }
  }
  await walk(resolved);
  validateAssets(output.map((f) => f.asset));
  return output;
}
export async function publish(
  projectId: string,
  directory: string,
  requestKey: string,
  message = 'Agent 发布',
  root?: string,
) {
  const assets = await collect(directory, root),
    api = client(),
    base = '/' + projectId;
  const result = await api(base + '/releases', 'POST', {
      requestKey,
      message,
      files: assets.map((f) => f.asset),
    }),
    release = result.release;
  if (release.status !== 'uploading') return result;
  for (const f of assets)
    await api(
      base + '/releases/' + release.id + '/file?path=' + encodeURIComponent(f.asset.path),
      'PUT',
      f.bytes,
      true,
    );
  return api(base + '/releases/' + release.id + '/publish', 'POST', {});
}
