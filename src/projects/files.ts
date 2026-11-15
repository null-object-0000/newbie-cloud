import { blake3 } from '@noble/hashes/blake3.js';
export const MAX_FILE = 1024 * 1024,
  MAX_TOTAL = 10 * 1024 * 1024,
  MAX_FILES = 200;
export type Asset = {
  path: string;
  size: number;
  hash: string;
  sha256: string;
  contentType: string;
};
const types: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  csv: 'text/csv',
  pdf: 'application/pdf',
  webmanifest: 'application/manifest+json',
  wasm: 'application/wasm',
};
export function assetPath(path: unknown): string {
  if (
    typeof path !== 'string' ||
    path.length > 240 ||
    !path ||
    /[\\?#%\x00-\x1f\x7f]/.test(path) ||
    path.startsWith('/') ||
    path
      .split('/')
      .some((s) => !s || s.startsWith('.') || ['node_modules', 'functions'].includes(s)) ||
    path.toLowerCase().includes('_worker') ||
    !types[path.split('.').pop()!.toLowerCase()]
  )
    throw Error('只接受静态构建产物；文件路径或类型不支持：' + String(path).slice(0, 120));
  return path;
}
export function contentType(path: string) {
  return types[path.split('.').pop()!.toLowerCase()];
}
export function base64Bytes(bytes: Uint8Array) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192)
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
export function assetHash(bytes: Uint8Array, path: string) {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : '';
  return Array.from(blake3(new TextEncoder().encode(base64Bytes(bytes) + ext)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
export async function sha(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export async function describe(bytes: Uint8Array, path: string): Promise<Asset> {
  assetPath(path);
  if (bytes.length > MAX_FILE) throw Error('单文件不能超过 1 MiB');
  return {
    path,
    size: bytes.length,
    hash: assetHash(bytes, path),
    sha256: await sha(bytes),
    contentType: contentType(path),
  };
}
export function validateAssets(input: unknown): Asset[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_FILES)
    throw Error('请选择 1–200 个静态文件');
  const seen = new Set<string>();
  let total = 0;
  const files = input.map((v: any) => {
    const path = assetPath(v?.path);
    if (
      seen.has(path) ||
      !Number.isInteger(v.size) ||
      v.size < 0 ||
      v.size > MAX_FILE ||
      !/^[a-f0-9]{32}$/.test(v.hash) ||
      !/^[a-f0-9]{64}$/.test(v.sha256)
    )
      throw Error('文件清单无效、重复或超过 1 MiB');
    seen.add(path);
    total += v.size;
    return { path, size: v.size, hash: v.hash, sha256: v.sha256, contentType: contentType(path) };
  });
  if (!seen.has('index.html')) throw Error('发布目录根部需要 index.html，请选择构建输出目录');
  if (total > MAX_TOTAL) throw Error('发布总大小不能超过 10 MiB');
  return files;
}
