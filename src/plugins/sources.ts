import { HttpError, type Fetch } from '../server/types';
import { sha256 } from '../server/crypto';
import { validateManifest } from './validation';
import type { PluginPackage } from './types';
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
export async function bytesLimited(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) throw new HttpError(502, '插件源返回空响应');
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, '插件包超过大小限制');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export async function sourceFetch(url: string, fetcher: Fetch, limit: number) {
  let response: Response;
  try {
    response = await fetcher.call(globalThis, url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: 'application/json, text/plain, application/octet-stream',
        'User-Agent': 'Newbie-Cloud-Plugin-Installer',
      },
    });
  } catch {
    throw new HttpError(502, '无法连接插件源，请稍后重试');
  }
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel();
    throw new HttpError(
      502,
      '插件源 HTTP ' + response.status + '；请核对公开仓库、包名、版本和访问配额',
    );
  }
  return bytesLimited(response.body, limit);
}
export function tarFiles(bytes: Uint8Array) {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((n) => n === 0)) break;
    const string = (start: number, length: number) =>
      decoder.decode(header.subarray(start, start + length)).split('\0')[0];
    const expected = parseInt(string(148, 8).trim(), 8);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expected) throw new HttpError(400, 'npm tar 包校验失败');
    const name = (string(345, 155) ? string(345, 155) + '/' : '') + string(0, 100),
      size = parseInt(string(124, 12).trim() || '0', 8),
      type = string(156, 1);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > bytes.length ||
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      name.includes('\\')
    )
      throw new HttpError(400, 'npm tar 文件路径或长度无效');
    if (!['', '0', '5', 'x', 'g'].includes(type))
      throw new HttpError(400, '插件包不接受链接或特殊文件');
    if (
      ['', '0'].includes(type) &&
      ['package/newbie-plugin.json', 'package/plugin.mjs'].includes(name)
    ) {
      if (files.has(name)) throw new HttpError(400, '插件包包含重复入口文件');
      files.set(name, bytes.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
function json(bytes: Uint8Array) {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new HttpError(400, '插件源没有返回有效 JSON');
  }
}
export async function packageIntegrity(manifest: unknown, code?: string) {
  return 'sha256:' + (await sha256(JSON.stringify(manifest) + '\n' + (code ?? '')));
}
export async function inspectSource(source: string, fetcher: Fetch): Promise<PluginPackage> {
  if (typeof source !== 'string' || source.length > 400) throw new HttpError(400, '插件来源无效');
  source = source.trim();
  if (source.startsWith('https://github.com/')) {
    const url = new URL(source),
      parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    if (
      url.username ||
      url.password ||
      url.search ||
      parts.length < 2 ||
      (parts.length > 2 && parts[2] !== 'tree')
    )
      throw new HttpError(400, '请提供 GitHub 仓库首页或 tree 版本地址');
    source =
      'github:' +
      parts[0] +
      '/' +
      parts[1].replace(/\.git$/, '') +
      '@' +
      (parts.length > 3 ? parts.slice(3).join('/') : url.hash.slice(1) || 'HEAD');
  }
  let manifestBytes: Uint8Array, codeBytes: Uint8Array | undefined, resolvedSource: string;
  if (source.startsWith('github:')) {
    const match = source.match(
      /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_./-]+))?$/,
    );
    if (!match) throw new HttpError(400, 'GitHub 来源格式为 github:owner/repo@版本');
    const [, owner, repo, ref = 'HEAD'] = match;
    const commit = json(
      await sourceFetch(
        `https://api.github.com/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=1`,
        fetcher,
        64000,
      ),
    )?.[0];
    if (typeof commit?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha))
      throw new HttpError(502, 'GitHub 未返回固定提交');
    const base = `https://raw.githubusercontent.com/${owner}/${repo}/${commit.sha}/`;
    manifestBytes = await sourceFetch(base + 'newbie-plugin.json', fetcher, 32000);
    const manifest = validateManifest(json(manifestBytes));
    if (manifest.kind === 'node')
      codeBytes = await sourceFetch(base + 'plugin.mjs', fetcher, 256000);
    resolvedSource = `github:${owner}/${repo}@${commit.sha}`;
  } else if (source.startsWith('npm:')) {
    const raw = source.slice(4),
      at = raw.lastIndexOf('@'),
      name = at > 0 ? raw.slice(0, at) : raw,
      version = at > 0 ? raw.slice(at + 1) : 'latest';
    if (
      !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/.test(name) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,79}$/.test(version)
    )
      throw new HttpError(400, 'npm 来源格式为 npm:包名@版本');
    const metadata = json(
      await sourceFetch(
        'https://registry.npmjs.org/' +
          encodeURIComponent(name) +
          '/' +
          encodeURIComponent(version),
        fetcher,
        128000,
      ),
    );
    let tarball: URL;
    try {
      tarball = new URL(metadata.dist?.tarball);
    } catch {
      throw new HttpError(502, 'npm 缺少包下载地址');
    }
    if (
      tarball!.protocol !== 'https:' ||
      tarball!.hostname !== 'registry.npmjs.org' ||
      tarball!.port ||
      tarball!.username ||
      tarball!.password
    )
      throw new HttpError(400, 'npm 包地址必须来自官方 registry');
    const expected = String(metadata.dist?.integrity ?? '')
      .split(' ')
      .find((s) => s.startsWith('sha512-'))
      ?.slice(7);
    if (!expected) throw new HttpError(400, 'npm 包缺少 SHA-512 完整性信息');
    const archive = await sourceFetch(tarball!.href, fetcher, 2000000);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', archive));
    if (btoa(String.fromCharCode(...hash)) !== expected)
      throw new HttpError(400, 'npm 包完整性校验不匹配');
    const stream = new Blob([archive]).stream().pipeThrough(new DecompressionStream('gzip'));
    const files = tarFiles(await bytesLimited(stream, 4000000));
    manifestBytes = files.get('package/newbie-plugin.json')!;
    if (!manifestBytes || manifestBytes.length > 32000)
      throw new HttpError(400, 'npm 包必须包含有效的 newbie-plugin.json');
    const manifest = validateManifest(json(manifestBytes));
    if (manifest.version !== metadata.version)
      throw new HttpError(400, '插件清单版本必须与 npm 发布版本一致');
    codeBytes = files.get('package/plugin.mjs');
    resolvedSource = 'npm:' + name + '@' + metadata.version;
  } else throw new HttpError(400, '来源仅支持公开 GitHub 仓库或 npm 包');
  const manifest = validateManifest(json(manifestBytes));
  if (manifest.kind === 'node' && (!codeBytes || codeBytes.length > 256000))
    throw new HttpError(400, '代码插件必须包含不超过 256 KB 的 plugin.mjs');
  const code = manifest.kind === 'node' ? decoder.decode(codeBytes) : undefined;
  return {
    manifest,
    code,
    source,
    resolvedSource,
    integrity: await packageIntegrity(manifest, code),
  };
}
