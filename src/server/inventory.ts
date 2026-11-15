import type { DnsObservation } from '../shared';
import { domainName, nsProvider } from '../inventory';
import { HttpError, type Env, type Fetch } from './types';

export async function observeDns(name: string, fetcher: Fetch): Promise<DnsObservation> {
  const result: DnsObservation = {
    name: domainName(name),
    nameservers: [],
    provider: null,
    checkedAt: new Date().toISOString(),
  };
  try {
    const response = await fetcher.call(
      globalThis,
      'https://cloudflare-dns.com/dns-query?type=NS&name=' + encodeURIComponent(result.name),
      {
        headers: { Accept: 'application/dns-json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok || response.status >= 300) throw Error('公共 NS 查询失败');
    const data: any = await response.json();
    if (data.Status !== 0 || data.TC) throw Error('公共 DNS 返回未完成或失败的查询');
    result.nameservers = [
      ...new Set<string>(
        (data.Answer ?? [])
          .filter((a: any) => a.type === 2 && domainName(a.name) === result.name)
          .map((a: any) => domainName(a.data)),
      ),
    ].sort();
    if (!result.nameservers.length) throw Error('未查到此域名的 NS；不推断 DNS 托管平台');
    result.provider = nsProvider(result.nameservers);
  } catch (e) {
    result.error = e instanceof Error ? e.message : '公共 NS 查询失败';
  }
  return result;
}

// Page work is staged separately. Incomplete/failed runs never replace a complete snapshot.
export async function saveInventoryPage(
  env: Env,
  accountId: string,
  kind: string,
  input: Record<string, any>,
  load: (
    page: number,
    providerCursor?: string,
  ) => Promise<{ items: any[]; nextCursor: number | null; providerCursor?: string }>,
) {
  const cursor = Number(input.cursor ?? 1),
    pending = 'pending:' + kind;
  if (!Number.isInteger(cursor) || cursor < 1 || cursor > 10000)
    throw new HttpError(400, '分页参数无效');
  let state: { run: string; cursor: number; items: any[]; at: number; providerCursor?: string };
  const saved = await env.DB.prepare('SELECT data FROM snapshots WHERE account_id=? AND kind=?')
    .bind(accountId, pending)
    .first<{ data: string }>();
  if (cursor === 1) state = { run: crypto.randomUUID(), cursor: 1, items: [], at: Date.now() };
  else {
    if (!saved) throw new HttpError(409, '同步任务已失效，请重新同步');
    state = JSON.parse(saved.data);
    if (state.run !== input.syncId || state.cursor !== cursor || Date.now() - state.at > 900000)
      throw new HttpError(409, '分页顺序或同步任务已变化，请重新同步');
  }
  const expected = JSON.stringify(state);
  if (cursor === 1)
    await env.DB.prepare(
      'INSERT INTO snapshots(account_id,kind,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
    )
      .bind(accountId, pending, expected, new Date().toISOString())
      .run();
  const page = await load(cursor, state.providerCursor);
  if (page.providerCursor && page.providerCursor === state.providerCursor)
    throw new HttpError(502, '云平台分页游标没有前进，已停止同步');
  if (page.nextCursor !== null && page.nextCursor <= cursor)
    throw new HttpError(502, '云平台返回了无效分页，已停止同步');
  const items = [...state.items, ...page.items];
  if (new TextEncoder().encode(JSON.stringify(items)).length > 1500000)
    throw new HttpError(413, '此资源集合超过单个快照容量，已保留原快照');
  const at = new Date().toISOString();
  let changes: number;
  if (page.nextCursor) {
    const result = await env.DB.prepare(
      'UPDATE snapshots SET data=?,updated_at=? WHERE account_id=? AND kind=? AND data=?',
    )
      .bind(
        JSON.stringify({
          ...state,
          items,
          cursor: page.nextCursor,
          providerCursor: page.providerCursor,
        }),
        at,
        accountId,
        pending,
        expected,
      )
      .run();
    changes = result.meta.changes;
  } else {
    const result = await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO snapshots(account_id,kind,data,updated_at) SELECT ?,?,?,? FROM snapshots WHERE account_id=? AND kind=? AND data=? ON CONFLICT(account_id,kind) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
      ).bind(accountId, kind, JSON.stringify(items), at, accountId, pending, expected),
      env.DB.prepare('DELETE FROM snapshots WHERE account_id=? AND kind=? AND data=?').bind(
        accountId,
        pending,
        expected,
      ),
    ]);
    changes = result[0].meta.changes;
  }
  if (!changes) throw new HttpError(409, '已有新的同步任务，请刷新后重试');
  return {
    count: items.length,
    nextCursor: page.nextCursor,
    syncId: state.run,
    complete: page.nextCursor === null,
  };
}
