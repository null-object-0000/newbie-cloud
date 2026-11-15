import type {
  Provider,
  LocalCapabilities,
  ContainerSummary,
  ContainerDetail,
  ContainerStats,
  SystemOverview,
} from '../shared';
export interface LocalRuntime {
  capabilities: LocalCapabilities;
  system(): Promise<SystemOverview>;
  containers(): Promise<ContainerSummary[]>;
  inspect(id: string): Promise<ContainerDetail>;
  logs(id: string, tail: number): Promise<{ text: string; truncated: boolean }>;
  stats(id: string): Promise<ContainerStats>;
  action(
    id: string,
    action: 'start' | 'stop' | 'restart',
    confirmName: string,
    expectedState: string,
  ): Promise<void>;
}
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  ENCRYPTION_KEY: string;
  GITHUB_TOKEN?: string;
  LOCAL?: LocalRuntime;
}
export interface AccountRow {
  id: string;
  name: string;
  provider: Provider;
  readonly: number;
  credentials: string;
  created_at: string;
  updated_at: string;
}
export interface ZoneRow {
  id: string;
  account_id: string;
  external_id: string;
  name: string;
  status: string;
  updated_at: string;
}
export type Fetch = typeof fetch;
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString();
