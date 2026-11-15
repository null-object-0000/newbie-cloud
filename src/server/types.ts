import type { Provider } from '../shared';
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  ENCRYPTION_KEY: string;
  GITHUB_TOKEN?: string;
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
