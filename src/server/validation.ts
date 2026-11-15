import type { RecordInput, DnsRecord, Provider } from '../shared';
import { HttpError } from './types';
export const editableTypes = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'];
export function recordInput(value: unknown, zone: string, provider: Provider): RecordInput {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'DNS 记录不能为空');
  const r = value as Record<string, unknown>;
  const type = String(r.type ?? '').toUpperCase();
  if (!editableTypes.includes(type)) throw new HttpError(400, 'MVP 暂不支持修改此记录类型');
  let name = String(r.name ?? '')
    .trim()
    .toLowerCase();
  if (name === '@') name = zone;
  else if (name.endsWith('.')) {
    name = name.slice(0, -1);
    if (name !== zone && !name.endsWith('.' + zone))
      throw new HttpError(400, '记录名称不属于当前域名');
  } else if (name !== zone && !name.endsWith('.' + zone)) name += '.' + zone;
  if (
    name.length > 253 ||
    !/^([a-z0-9_-]+|\*)(\.[a-z0-9_-]+)+$/.test(name) ||
    name.split('.').some((s) => s.length > 63)
  )
    throw new HttpError(400, '记录名称无效');
  const rawContent = String(r.content ?? ''),
    content = type === 'TXT' ? rawContent : rawContent.trim();
  if (!content.trim() || new TextEncoder().encode(content).length > 4096)
    throw new HttpError(400, '记录内容为空或过长');
  if (
    type === 'A' &&
    (!/^\d{1,3}(\.\d{1,3}){3}$/.test(content) || content.split('.').some((s) => Number(s) > 255))
  )
    throw new HttpError(400, '请输入有效的 IPv4 地址');
  if (type === 'AAAA') {
    try {
      if (!content.includes(':') || content.includes('[') || content.includes(']')) throw Error();
      new URL('https://[' + content + ']/');
    } catch {
      throw new HttpError(400, '请输入有效的 IPv6 地址');
    }
  }
  if (
    ['CNAME', 'NS', 'MX'].includes(type) &&
    (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/i.test(content) || content.length > 254)
  )
    throw new HttpError(400, '目标必须是域名，不能包含协议或路径');
  const ttl = Number(r.ttl);
  if (
    !Number.isInteger(ttl) ||
    !((provider === 'cloudflare' && ttl === 1) || (ttl >= 60 && ttl <= 86400))
  )
    throw new HttpError(400, 'TTL 须为 60–86400 秒；Cloudflare 可用 1 表示自动');
  const result: RecordInput = { type, name, content, ttl };
  if (type === 'MX') {
    const priority = Number(r.priority ?? 0);
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535)
      throw new HttpError(400, 'MX 优先级无效');
    result.priority = priority;
  }
  if (provider === 'cloudflare' && ['A', 'AAAA', 'CNAME'].includes(type))
    result.proxied = r.proxied === true;
  if (r.line !== undefined) {
    if (typeof r.line !== 'string' || r.line.length > 100) throw new HttpError(400, '解析线路无效');
    result.line = r.line;
  }
  return result;
}
export function protectedRecord(r: RecordInput | DnsRecord | null) {
  return (
    !!r &&
    (r.type === 'MX' ||
      r.type === 'NS' ||
      r.type === 'SOA' ||
      r.type === 'CAA' ||
      /(^|\.)(_domainkey|_dmarc|_dnsauth|_acme-challenge)(\.|$)/i.test(r.name) ||
      (r.type === 'TXT' && /^\s*"?v=(spf1|DKIM1|DMARC1)/i.test(r.content)))
  );
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
