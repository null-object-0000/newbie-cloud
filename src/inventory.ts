import type {
  Account,
  DnsObservation,
  Registration,
  ResourceSnapshot,
  Zone,
  Provider,
} from './shared';

export const providerNames: Record<Provider, string> = {
  cloudflare: 'Cloudflare',
  tencent: '腾讯云',
  aliyun: '阿里云',
};
export function domainName(value: string): string {
  const text = value.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  try {
    return new URL('https://' + text).hostname;
  } catch {
    return text;
  }
}
export function nsProvider(servers: string[]): Provider | null {
  const classify = (ns: string): Provider | null => {
    const name = domainName(ns);
    if (name.endsWith('.cloudflare.com')) return 'cloudflare';
    if (['alidns.com', 'hichina.com'].some((s) => name.endsWith('.' + s))) return 'aliyun';
    if (['dnspod.net', 'dnspod.com', 'dnspod.cn'].some((s) => name.endsWith('.' + s)))
      return 'tencent';
    return null;
  };
  const values = new Set(servers.map(classify));
  return values.size === 1 && !values.has(null) ? [...values][0] : null;
}
export function freshDns(observation?: DnsObservation): boolean {
  return (
    !!observation &&
    !observation.error &&
    observation.nameservers.length > 0 &&
    Date.now() - Date.parse(observation.checkedAt) >= 0 &&
    Date.now() - Date.parse(observation.checkedAt) < 86400000
  );
}
export function dnsState(zone: Zone, accounts: Account[], observations: DnsObservation[]) {
  const observation = observations.find((o) => domainName(o.name) === domainName(zone.name));
  const provider = accounts.find((a) => a.id === zone.accountId)?.provider;
  if (!freshDns(observation) || !observation?.provider) return 'unverified';
  return observation.provider === provider ? 'current' : 'other';
}
export function domainInventory(zones: Zone[], snapshots: ResourceSnapshot[]) {
  const domains = new Map<
    string,
    {
      name: string;
      zones: Zone[];
      registrations: (Registration & { accountId: string; checkedAt: string })[];
    }
  >();
  const ensure = (name: string) => {
    const key = domainName(name);
    if (!domains.has(key)) domains.set(key, { name: key, zones: [], registrations: [] });
    return domains.get(key)!;
  };
  for (const zone of zones) ensure(zone.name).zones.push(zone);
  for (const s of snapshots.filter((s) => s.kind === 'registrations'))
    for (const r of s.data as Registration[])
      ensure(r.name).registrations.push({ ...r, accountId: s.account_id, checkedAt: s.updated_at });
  return [...domains.values()].sort((a, b) => a.name.localeCompare(b.name));
}
// Match the longest known domain boundary, never a substring or a guessed TLD.
export function belongsToDomain(host: string, domain: string, knownDomains: string[]) {
  const name = domainName(host);
  const match = knownDomains
    .map(domainName)
    .filter((d) => name === d || name.endsWith('.' + d))
    .sort((a, b) => b.length - a.length)[0];
  return match === domainName(domain);
}
export function resourceRows(
  snapshots: ResourceSnapshot[],
  category: 'services' | 'certificates' | 'email' | 'records' | 'servers',
) {
  const result = new Map<string, any>();
  // Keep copies on different accounts/platforms; only collapse duplicate observations of the same resource.
  for (const s of [...snapshots].sort((a, b) => a.updated_at.localeCompare(b.updated_at))) {
    if (s.kind !== category && !s.kind.startsWith(category + ':')) continue;
    for (const item of s.data) {
      const key = [
        s.account_id,
        category,
        item.kind ?? '',
        item.id,
        item.domain ?? '',
        category === 'servers' ? (item.region ?? '') : '',
        ['email', 'records'].includes(category) ? s.kind : '',
      ].join('|');
      result.set(key, {
        ...item,
        key,
        accountId: s.account_id,
        checkedAt: s.updated_at,
        zoneId: s.kind.includes(':') ? s.kind.slice(s.kind.indexOf(':') + 1) : undefined,
      });
    }
  }
  return [...result.values()];
}
