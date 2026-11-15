export type BuiltinPluginId =
  | 'cloudflare'
  | 'tencent'
  | 'aliyun'
  | 'domains'
  | 'dns'
  | 'storage'
  | 'services'
  | 'email'
  | 'certificates'
  | 'servers'
  | 'docker'
  | 'host'
  | 'github-deploy';
export interface PluginField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  default?: string;
}
export interface PluginResource {
  id: string;
  name: string;
  type: string;
  status?: string;
  domain?: string;
  region?: string;
  url?: string;
  detail?: string;
}
export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  kind: 'declarative' | 'node' | 'builtin';
  permissions: { network: string[] };
  config: PluginField[];
  entry?: 'plugin.mjs';
  connector?: {
    url: string;
    headers?: Record<string, string>;
    itemsPath?: string;
    fields: Record<string, string>;
  };
  resources?: PluginResource[];
}
export interface PluginPackage {
  manifest: PluginManifest;
  code?: string;
  source: string;
  resolvedSource: string;
  integrity: string;
}
export interface InstalledPlugin extends PluginPackage {
  enabled: boolean;
  installedAt: string;
  configCipher?: string;
}
export interface PluginStatus {
  manifest: PluginManifest;
  enabled: boolean;
  available: boolean;
  reason: string | null;
  builtin: boolean;
  source?: string;
  resolvedSource?: string;
  integrity?: string;
  configured: boolean;
}
/** Code plugins export default { collect(context): Promise<PluginResource[]> }. */
export interface PluginContext {
  config: Readonly<Record<string, string>>;
  fetch: typeof fetch;
}
export interface CodePlugin {
  collect(context: PluginContext): Promise<PluginResource[]> | PluginResource[];
}
