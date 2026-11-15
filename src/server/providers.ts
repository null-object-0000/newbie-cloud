import type {
  Credentials,
  Provider,
  DnsRecord,
  RecordInput,
  Service,
  Certificate,
  EmailRule,
} from '../shared';
import { base64, hmac, hex, sha256 } from './crypto';
import { HttpError, type Fetch } from './types';
type Json = Record<string, any>;
export interface RemoteZone {
  id: string;
  name: string;
  status: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: number | null;
}
export class Cloud {
  constructor(
    public provider: Provider,
    private credentials: Credentials,
    private fetcher: Fetch = fetch,
  ) {}
  private error(message: string): never {
    for (const value of Object.values(this.credentials))
      if (value && value.length > 3) message = message.replaceAll(value, '[已隐藏]');
    throw new HttpError(502, message.slice(0, 400));
  }
  private async request(url: string, init: RequestInit): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetcher.call(globalThis, url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      this.error('云平台连接失败或超时，请稍后刷新；写入失败时请先核对远端记录，避免重复提交');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      this.error('云平台返回了重定向，已停止请求以保护凭据');
    }
    let json: Json;
    try {
      json = (await response.json()) as Json;
    } catch {
      this.error('云平台返回了无法识别的响应');
    }
    if (!response.ok)
      this.error(
        `云平台 HTTP ${response.status}：${json.message ?? json.Error?.Message ?? json.errors?.[0]?.message ?? '请求失败'}`,
      );
    return json;
  }
  private async cf(route: string, method = 'GET', body?: unknown): Promise<Json> {
    const json = await this.request('https://api.cloudflare.com/client/v4' + route, {
      method,
      headers: {
        Authorization: 'Bearer ' + this.credentials.apiToken,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!json.success)
      this.error(
        'Cloudflare：' + (json.errors?.map((e: Json) => e.message).join('；') ?? '请求失败'),
      );
    return json;
  }
  async tc(service: 'dnspod' | 'teo', action: string, params: Json): Promise<Json> {
    const host = service + '.tencentcloudapi.com',
      version = service === 'dnspod' ? '2021-03-23' : '2022-09-01';
    const timestamp = Math.floor(Date.now() / 1000),
      date = new Date(timestamp * 1000).toISOString().slice(0, 10),
      body = JSON.stringify(params);
    const gateway = action.includes('Pages'),
      signedHeaders = 'content-type;host' + (gateway ? ';x-tc-action' : '');
    const canonical =
      'POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:' +
      host +
      '\n' +
      (gateway ? 'x-tc-action:' + action.toLowerCase() + '\n' : '') +
      '\n' +
      signedHeaders +
      '\n' +
      (await sha256(body));
    const scope = date + '/' + service + '/tc3_request',
      stringToSign =
        'TC3-HMAC-SHA256\n' + timestamp + '\n' + scope + '\n' + (await sha256(canonical));
    const signing = await hmac(
      await hmac(await hmac('TC3' + this.credentials.secretKey, date), service),
      'tc3_request',
    );
    const signature = hex(await hmac(signing, stringToSign));
    const json = await this.request('https://' + host, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': String(timestamp),
        ...(gateway ? { 'X-TC-Region': 'ap-guangzhou' } : {}),
        Authorization: `TC3-HMAC-SHA256 Credential=${this.credentials.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body,
    });
    if (json.Response?.Error)
      this.error('腾讯云 ' + json.Response.Error.Code + '：' + json.Response.Error.Message);
    if (!json.Response) this.error('腾讯云返回格式无效');
    return json.Response;
  }
  async ali(
    action: string,
    params: Json = {},
    service = 'alidns',
    version = '2015-01-09',
  ): Promise<Json> {
    const values: Record<string, string> = {
      Action: action,
      Version: version,
      Format: 'JSON',
      AccessKeyId: this.credentials.accessKeyId!,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomUUID(),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    };
    const encode = (s: string) =>
      encodeURIComponent(s).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
      );
    const canonical = Object.keys(values)
      .sort()
      .map((k) => encode(k) + '=' + encode(values[k]))
      .join('&');
    const signature = base64(
      await hmac(this.credentials.accessKeySecret + '&', 'GET&%2F&' + encode(canonical), 'SHA-1'),
    );
    const host =
      service === 'esa'
        ? 'esa.' + (this.credentials.esaRegion ?? 'cn-hangzhou') + '.aliyuncs.com'
        : service + '.aliyuncs.com';
    const json = await this.request(
      'https://' + host + '/?' + canonical + '&Signature=' + encode(signature),
      { method: 'GET' },
    );
    if (json.Code) this.error('阿里云 ' + json.Code + '：' + json.Message);
    return json;
  }
  async zones(page = 1): Promise<Page<RemoteZone>> {
    const limit = this.provider === 'cloudflare' ? 50 : 100;
    if (this.provider === 'cloudflare') {
      const query = new URLSearchParams({ per_page: String(limit), page: String(page) });
      if (this.credentials.accountId) query.set('account.id', this.credentials.accountId);
      const j = await this.cf('/zones?' + query);
      return {
        items: j.result.map((z: Json) => ({ id: z.id, name: z.name, status: z.status })),
        nextCursor: j.result_info?.total_pages > page ? page + 1 : null,
      };
    }
    if (this.provider === 'tencent') {
      const j = await this.tc('dnspod', 'DescribeDomainList', {
        Offset: (page - 1) * limit,
        Limit: limit,
      });
      return {
        items: (j.DomainList ?? []).map((z: Json) => ({
          id: String(z.DomainId),
          name: z.Name,
          status: z.Status ?? 'active',
        })),
        nextCursor: (j.DomainCountInfo?.AllTotal ?? 0) > page * limit ? page + 1 : null,
      };
    }
    const j = await this.ali('DescribeDomains', { PageNumber: page, PageSize: limit });
    return {
      items: (j.Domains?.Domain ?? []).map((z: Json) => ({
        id: String(z.DomainId),
        name: z.DomainName,
        status: z.DnsServers?.DnsServer?.length ? 'active' : 'unknown',
      })),
      nextCursor: j.TotalCount > page * limit ? page + 1 : null,
    };
  }
  private cfRecord(r: Json): DnsRecord {
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      content: r.content ?? '',
      ttl: r.ttl,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
      ...(r.proxied !== undefined ? { proxied: r.proxied } : {}),
    };
  }
  private tcRecord(r: Json, zone: string): DnsRecord {
    return {
      id: String(r.RecordId ?? r.Id),
      type: r.Type ?? r.RecordType,
      name:
        r.SubDomain === undefined
          ? r.Name === '@'
            ? zone
            : r.Name + '.' + zone
          : r.SubDomain === '@'
            ? zone
            : r.SubDomain + '.' + zone,
      content: r.Value,
      ttl: r.TTL,
      ...((r.Type ?? r.RecordType) === 'MX' ? { priority: r.MX ?? r.MXLevel ?? 0 } : {}),
      line: String(r.LineId ?? r.RecordLineId ?? '0'),
      disabled: r.Status === 'DISABLE',
    };
  }
  private aliRecord(r: Json, zone: string): DnsRecord {
    return {
      id: String(r.RecordId),
      type: r.Type,
      name: r.RR === '@' ? zone : r.RR + '.' + zone,
      content: r.Value,
      ttl: r.TTL,
      ...(r.Type === 'MX' ? { priority: r.Priority ?? 0 } : {}),
      line: r.Line ?? 'default',
      disabled: r.Status === 'DISABLE',
    };
  }
  async records(zone: { external_id: string; name: string }, page = 1): Promise<Page<DnsRecord>> {
    if (this.provider === 'cloudflare') {
      const j = await this.cf(
        `/zones/${encodeURIComponent(zone.external_id)}/dns_records?per_page=100&page=${page}`,
      );
      return {
        items: j.result.map((r: Json) => this.cfRecord(r)),
        nextCursor: j.result_info?.total_pages > page ? page + 1 : null,
      };
    }
    if (this.provider === 'tencent') {
      const j = await this.tc('dnspod', 'DescribeRecordList', {
        Domain: zone.name,
        Offset: (page - 1) * 100,
        Limit: 100,
      });
      return {
        items: (j.RecordList ?? []).map((r: Json) => this.tcRecord(r, zone.name)),
        nextCursor: (j.RecordCountInfo?.TotalCount ?? 0) > page * 100 ? page + 1 : null,
      };
    }
    const j = await this.ali('DescribeDomainRecords', {
      DomainName: zone.name,
      PageNumber: page,
      PageSize: 100,
    });
    return {
      items: (j.DomainRecords?.Record ?? []).map((r: Json) => this.aliRecord(r, zone.name)),
      nextCursor: j.TotalCount > page * 100 ? page + 1 : null,
    };
  }
  async record(zone: { external_id: string; name: string }, id: string): Promise<DnsRecord> {
    if (this.provider === 'cloudflare') {
      const j = await this.cf(
        `/zones/${encodeURIComponent(zone.external_id)}/dns_records/${encodeURIComponent(id)}`,
      );
      return this.cfRecord(j.result);
    }
    if (this.provider === 'tencent') {
      const j = await this.tc('dnspod', 'DescribeRecord', {
        Domain: zone.name,
        RecordId: Number(id),
      });
      return this.tcRecord(j.RecordInfo, zone.name);
    }
    const j = await this.ali('DescribeDomainRecordInfo', { RecordId: id });
    if (j.DomainName !== zone.name) throw new HttpError(403, '记录不属于当前域名');
    return this.aliRecord(j, zone.name);
  }
  async write(
    zone: { external_id: string; name: string },
    action: 'create' | 'update' | 'delete',
    record: RecordInput | null,
    id?: string,
    before?: DnsRecord | null,
  ) {
    if (this.provider === 'cloudflare') {
      const route =
        `/zones/${encodeURIComponent(zone.external_id)}/dns_records` +
        (id ? '/' + encodeURIComponent(id) : '');
      const body = record
        ? {
            type: record.type,
            name: record.name,
            content: record.content,
            ttl: record.ttl,
            ...(record.type === 'MX' ? { priority: record.priority ?? 0 } : {}),
            ...(['A', 'AAAA', 'CNAME'].includes(record.type)
              ? { proxied: record.proxied ?? false }
              : {}),
          }
        : undefined;
      const j = await this.cf(
        route,
        action === 'create' ? 'POST' : action === 'delete' ? 'DELETE' : 'PATCH',
        body,
      );
      return { id: String(j.result.id) };
    }
    const rr = record
      ? record.name === zone.name
        ? '@'
        : record.name.slice(0, -zone.name.length - 1)
      : '';
    if (this.provider === 'tencent') {
      const common: Json = { Domain: zone.name, ...(id ? { RecordId: Number(id) } : {}) };
      if (record)
        Object.assign(common, {
          SubDomain: rr,
          RecordType: record.type,
          RecordLineId: record.line ?? before?.line ?? '0',
          Value: record.content,
          TTL: record.ttl,
          ...(record.type === 'MX' ? { MX: record.priority ?? 0 } : {}),
          ...(before?.disabled ? { Status: 'DISABLE' } : {}),
        });
      const j = await this.tc(
        'dnspod',
        action === 'create'
          ? 'CreateRecord'
          : action === 'delete'
            ? 'DeleteRecord'
            : 'ModifyRecord',
        common,
      );
      return { id: String(j.RecordId ?? id) };
    }
    const common: Json = {
      ...(id ? { RecordId: id } : {}),
      ...(action === 'create' ? { DomainName: zone.name } : {}),
    };
    if (record)
      Object.assign(common, {
        RR: rr,
        Type: record.type,
        Value: record.content,
        TTL: record.ttl,
        Line: record.line ?? before?.line ?? 'default',
        ...(record.type === 'MX' ? { Priority: record.priority ?? 0 } : {}),
      });
    const j = await this.ali(
      action === 'create'
        ? 'AddDomainRecord'
        : action === 'delete'
          ? 'DeleteDomainRecord'
          : 'UpdateDomainRecord',
      common,
    );
    return { id: String(j.RecordId ?? id) };
  }
  async services(): Promise<Service[]> {
    if (this.provider === 'cloudflare') {
      if (!this.credentials.accountId)
        throw new HttpError(400, '查看托管服务需要在账号中填写 Cloudflare Account ID');
      const base = '/accounts/' + encodeURIComponent(this.credentials.accountId);
      const [pages, workers] = await Promise.all([
        this.cf(base + '/pages/projects?per_page=10'),
        this.cf(base + '/workers/scripts'),
      ]);
      return [
        ...pages.result.map((p: Json) => ({
          id: p.name,
          name: p.name,
          kind: 'Pages',
          provider: this.provider,
          status: p.canonical_deployment?.latest_stage?.status ?? 'unknown',
          url: p.domains?.[0] ? 'https://' + p.domains[0] : undefined,
          detail: '前 10 个 Pages 项目',
        })),
        ...workers.result.map((w: Json) => ({
          id: w.id,
          name: w.id,
          kind: 'Worker',
          provider: this.provider,
          status: '已发布',
        })),
      ];
    }
    if (this.provider === 'tencent') {
      if (!this.credentials.workspaceId)
        throw new HttpError(400, '查看 Makers 项目需要填写工作空间 Zone ID');
      const body = {
        ZoneId: this.credentials.workspaceId,
        Interface: 'pages:DescribePagesProjects',
        Payload: JSON.stringify({ Offset: 0, Limit: 100 }),
      };
      const j = await this.tc('teo', 'DescribePagesResources', body);
      const result = typeof j.Result === 'string' ? JSON.parse(j.Result) : j.Result;
      if (result?.Code && result.Code !== 0 && result.Code !== '0')
        this.error('Makers：' + (result.Message ?? result.Code));
      const data = result?.Data ?? result;
      if (!Array.isArray(data?.Projects)) this.error('Makers 项目列表响应格式无法识别');
      return data.Projects.map((p: Json) => ({
        id: p.ProjectId,
        name: p.Name ?? p.ProjectName,
        kind: 'EdgeOne Makers',
        provider: this.provider,
        status: p.Status ?? 'unknown',
        detail: p.Area === 'global' ? '全球可用区（含中国大陆）' : p.Area,
      }));
    }
    const j = await this.ali('ListSites', { PageNumber: 1, PageSize: 100 }, 'esa', '2024-09-10');
    return (j.Sites ?? j.SiteList ?? []).map((s: Json) => ({
      id: String(s.SiteId),
      name: s.SiteName,
      kind: 'ESA',
      provider: this.provider,
      status: s.Status ?? s.SiteStatus ?? 'unknown',
    }));
  }
  async certificates(zone?: { external_id: string; name: string }): Promise<Certificate[]> {
    if (this.provider === 'cloudflare') {
      if (!zone) throw new HttpError(400, '请选择一个 Cloudflare 域名检查证书');
      const j = await this.cf(
        `/zones/${encodeURIComponent(zone.external_id)}/ssl/certificate_packs`,
      );
      return (j.result ?? []).flatMap((p: Json) =>
        (p.certificates ?? []).map((c: Json) => ({
          id: c.id ?? p.id,
          domain: (c.hosts ?? p.hosts ?? [zone.name]).join(', '),
          status: p.status ?? c.status ?? 'unknown',
          expiresAt: c.expires_on ?? null,
          managed: true,
          source: 'Cloudflare 边缘证书',
        })),
      );
    }
    if (this.provider === 'tencent') {
      if (!this.credentials.workspaceId)
        throw new HttpError(400, '需要 Makers / EdgeOne 工作空间 Zone ID');
      const j = await this.tc('teo', 'DescribeHostCertificates', {
        ZoneId: this.credentials.workspaceId,
        Offset: 0,
        Limit: 100,
      });
      if (!Array.isArray(j.HostCertificates)) this.error('腾讯云证书响应格式无法识别');
      return j.HostCertificates.flatMap((h: Json) =>
        (h.HostCertInfo ?? []).map((c: Json) => ({
          id: c.CertId,
          domain: h.Host,
          status: c.Status,
          expiresAt: c.ExpireTime ?? null,
          managed: h.Mode !== 'sslcert',
          source: 'EdgeOne ' + h.Mode,
        })),
      );
    }
    const j = await this.ali(
      'ListUserCertificateOrder',
      { CurrentPage: 1, ShowSize: 100 },
      'cas',
      '2020-04-07',
    );
    return (j.CertificateOrderList ?? []).map((c: Json) => ({
      id: String(c.CertificateId ?? c.OrderId),
      domain: c.Domain ?? c.CommonName ?? '未知域名',
      status: c.Status ?? 'unknown',
      expiresAt: c.EndDate ?? null,
      managed: false,
      source: '阿里云证书服务（不推断续期托管状态）',
    }));
  }
  async email(zone: { external_id: string; name: string }): Promise<EmailRule[]> {
    if (this.provider !== 'cloudflare')
      throw new HttpError(400, 'MVP 的邮箱转发管理仅接入 Cloudflare Email Routing');
    const j = await this.cf(
      `/zones/${encodeURIComponent(zone.external_id)}/email/routing/rules?per_page=50`,
    );
    return (j.result ?? []).map((r: Json) => ({
      id: r.id ?? r.tag,
      name: r.name ?? '',
      enabled: r.enabled,
      matchers: r.matchers,
      actions: r.actions,
    }));
  }
}
export function validateCredentials(provider: Provider, input: unknown): Credentials {
  if (!input || typeof input !== 'object') throw new HttpError(400, '请填写云平台凭据');
  const keys: Record<Provider, string[]> = {
    cloudflare: ['apiToken', 'accountId'],
    tencent: ['secretId', 'secretKey', 'workspaceId'],
    aliyun: ['accessKeyId', 'accessKeySecret', 'esaRegion'],
  };
  const c: Credentials = {};
  for (const key of keys[provider]) {
    const value = (input as Json)[key];
    if (typeof value === 'string' && value.trim()) (c as Json)[key] = value.trim();
  }
  const required =
    provider === 'cloudflare'
      ? ['apiToken']
      : provider === 'tencent'
        ? ['secretId', 'secretKey']
        : ['accessKeyId', 'accessKeySecret'];
  if (required.some((key) => !(c as Json)[key])) throw new HttpError(400, '缺少必要的凭据字段');
  if (c.esaRegion && !['cn-hangzhou', 'ap-southeast-1'].includes(c.esaRegion))
    throw new HttpError(400, 'ESA 地域仅支持 cn-hangzhou 或 ap-southeast-1');
  if (Object.values(c).some((v) => v!.length > 4096)) throw new HttpError(400, '凭据字段过长');
  return c;
}
