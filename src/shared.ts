export type Provider = 'cloudflare' | 'tencent' | 'aliyun';
export interface CloudRegion {
  id: string;
  name: string;
}
export interface CloudServer {
  id: string;
  name: string;
  provider: 'tencent' | 'aliyun';
  region: string;
  zone: string;
  state: string;
  publicIps: string[];
  privateIps: string[];
  cpu: number;
  memoryMiB: number;
  os: string;
  createdAt: string | null;
  expiresAt: string | null;
  billing: string;
}
export interface LocalCapabilities {
  runtime: 'node' | 'docker';
  docker: boolean;
  dockerWrite: boolean;
}
export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: string[];
  project: string | null;
  service: string | null;
  protected: boolean;
}
export interface ContainerDetail extends ContainerSummary {
  hostname: string;
  restartPolicy: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number;
  health: string | null;
  networks: { name: string; address: string }[];
  mounts: { type: string; source: string; destination: string; readonly: boolean }[];
}
export interface ContainerStats {
  cpuPercent: number | null;
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number | null;
  networkRxBytes: number;
  networkTxBytes: number;
  sampledAt: string;
}
export interface SystemOverview {
  capabilities: LocalCapabilities;
  runtime: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    cpus: number;
    load: number[];
    uptime: number;
    memoryTotal: number;
    memoryFree: number;
    nodeVersion: string;
    containerized: boolean;
  };
  dataDisk: { totalBytes: number; availableBytes: number; usedBytes: number } | null;
  engine: {
    name: string;
    version: string;
    os: string;
    arch: string;
    kernel: string;
    cpus: number;
    memoryTotal: number;
    containers: number;
    running: number;
    stopped: number;
    paused: number;
    storageDriver: string;
  } | null;
  engineError: string | null;
}
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
  domains?: string[];
}
export interface Registration {
  id: string;
  name: string;
  registrar: string;
  expiresAt: string | null;
  autoRenew: boolean | null;
  nameservers: string[];
}
export interface DnsObservation {
  name: string;
  nameservers: string[];
  provider: Provider | null;
  checkedAt: string;
  error?: string;
}
export interface ResourceSnapshot {
  account_id: string;
  kind: string;
  data: any[];
  updated_at: string;
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
