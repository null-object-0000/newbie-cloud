export interface LinkedResource {
  accountId: string;
  provider: string;
  kind: string;
  externalId: string;
  role: string;
  name?: string;
}
export interface Link {
  id: string;
  category: string;
  role: string;
  provider: string;
  account_id: string | null;
  resource_kind: string;
  external_id: string;
  verified_at: string;
  data: Record<string, any>;
}
export interface Observation {
  subject: string;
  data: any;
  error: string | null;
  checked_at: string;
  succeeded_at: string | null;
}
export interface ExistingDetail {
  links: Link[];
  observations: Observation[];
  domainLinks: {
    hostname: string;
    registeredDomain: string | null;
    registrations: {
      registrar: string;
      accountId: string;
      accountName?: string;
      expiresAt?: string | null;
      checkedAt: string;
    }[];
    dns: {
      zoneId: string;
      accountId: string;
      accountName?: string;
      provider?: string;
      current: boolean;
      checkedAt: string | null;
    }[];
  }[];
  capabilities: {
    read: boolean;
    refresh: boolean;
    upload: boolean;
    rollback: boolean;
    dnsWrite: boolean;
  };
  scope: string;
}
