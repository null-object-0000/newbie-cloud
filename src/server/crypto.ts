import { HttpError } from './types';
const encoder = new TextEncoder();
export const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(
    new Uint8Array(
      bytes instanceof Uint8Array
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : bytes,
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
export const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export const sha256 = async (value: string) =>
  hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
export async function hmac(key: string | Uint8Array, message: string, algorithm = 'SHA-256') {
  const imported = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? encoder.encode(key) : new Uint8Array(key),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(message)));
}
async function encryptionKey(secret: string) {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(secret);
  } catch {
    throw new HttpError(503, '加密主密钥配置无效，请检查部署设置');
  }
  if (bytes.length !== 32) throw new HttpError(503, '加密主密钥必须为 32 字节');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(value: unknown, secret: string, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await encryptionKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return JSON.stringify({ v: 1, iv: base64(iv), data: base64(new Uint8Array(data)) });
}
export async function decrypt<T>(value: string, secret: string, context: string): Promise<T> {
  const envelope = JSON.parse(value);
  if (envelope.v !== 1) throw new HttpError(500, '不支持的凭据格式');
  try {
    return JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode(context) },
          await encryptionKey(secret),
          fromBase64(envelope.data),
        ),
      ),
    );
  } catch {
    throw new HttpError(503, '无法解密云账号，请检查主密钥是否被更换');
  }
}
function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let value = 0;
  for (let i = 0; i < a.length; i++) value |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return value === 0;
}
export async function matches(a: string, b: string) {
  return equal(await sha256(a), await sha256(b));
}
export async function session(secret: string) {
  const payload = base64(
    encoder.encode(JSON.stringify({ exp: Date.now() + 86400000, nonce: crypto.randomUUID() })),
  );
  return payload + '.' + hex(await hmac(secret, payload));
}
export async function authenticated(request: Request, secret: string) {
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer ')) return matches(authorization.slice(7), secret);
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('nc_session='))
    ?.slice(11);
  if (!token) return false;
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length) return false;
  if (!equal(hex(await hmac(secret, payload)), signature)) return false;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64(payload))).exp > Date.now();
  } catch {
    return false;
  }
}
export function sameOrigin(request: Request) {
  if (request.headers.get('authorization')?.startsWith('Bearer ')) return; // Verified separately.
  if (request.headers.get('origin') !== new URL(request.url).origin)
    throw new HttpError(403, '请求来源不匹配');
}
