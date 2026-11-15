export type Provider = 'cloudflare' | 'tencent' | 'aliyun';
export interface Account {
  id: string;
  name: string;
  provider: Provider;
  readonly: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface Zone {
  id: string;
  accountId: string;
  externalId: string;
  name: string;
  status: string;
  updatedAt?: string;
}
export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
  line?: string;
  disabled?: boolean;
}
export interface RecordInput {
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
  line?: string;
}
export interface Service {
  id: string;
  name: string;
  kind: string;
  provider: Provider;
  status: string;
  url?: string;
  detail?: string;
}
export interface Certificate {
  id: string;
  domain: string;
  status: string;
  expiresAt: string | null;
  managed: boolean;
  source: string;
}
export interface EmailRule {
  id: string;
  name: string;
  enabled: boolean;
  matchers: unknown;
  actions: unknown;
}
export interface Operation {
  id: string;
  account_id: string | null;
  zone_id: string | null;
  kind: string;
  status: string;
  summary: string;
  payload?: string;
  result?: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
}
export interface Credentials {
  apiToken?: string;
  accountId?: string;
  secretId?: string;
  secretKey?: string;
  workspaceId?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  esaRegion?: string;
}
export interface Plan {
  accountId: string;
  zoneId: string;
  zoneName: string;
  action: 'create' | 'update' | 'delete';
  recordId?: string;
  before: DnsRecord | null;
  after: RecordInput | null;
  protected: boolean;
}
