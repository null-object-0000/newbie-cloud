import { useEffect, useState } from 'react';
import { Database, Search, RefreshCw, ChevronRight } from 'lucide-react';
import type { Account, ResourceSnapshot } from '../shared';
import type { Api } from './resources';
import { Dialog } from './dialog';
export function Storage({
  api,
  accounts,
  onAccounts,
}: {
  api: Api;
  accounts: Account[];
  onAccounts: () => void;
}) {
  const [snapshots, setSnapshots] = useState<ResourceSnapshot[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [detail, setDetail] = useState<any>(null),
    [page, setPage] = useState(1);
  const load = async () => setSnapshots((await api('/storage')).items);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => setPage(1), [query]);
  const sources = accounts.filter((a) => a.provider === 'cloudflare'),
    all = snapshots
      .filter((s) => s.kind === 'storage:buckets')
      .flatMap((s) =>
        s.data.map((b) => ({ ...b, accountId: s.account_id, checkedAt: s.updated_at })),
      ),
    rows = all.filter((b) =>
      (b.name + ' ' + accounts.find((a) => a.id === b.accountId)?.name)
        .toLowerCase()
        .includes(query.toLowerCase()),
    ),
    pages = Math.max(1, Math.ceil(rows.length / 25)),
    current = Math.min(page, pages);
  async function sync() {
    setBusy(true);
    setError('');
    const failures: string[] = [];
    try {
      for (const a of sources) {
        try {
          await api('/storage/' + a.id + '/sync', 'POST', {});
        } catch (e) {
          failures.push(a.name + '：' + (e instanceof Error ? e.message : '读取失败'));
        }
      }
      await load();
      setError(failures.join('；'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '清单刷新失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <div className="local-error" role="alert">
          {error}
        </div>
      )}
      <section className="panel console-list">
        <div className="console-list-toolbar">
          <div className="search">
            <Search size={17} />
            <input
              aria-label="搜索存储桶"
              placeholder="搜索存储桶或账号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="pill">R2 · 只读清单</span>
          <button
            className="secondary"
            disabled={busy || !sources.length}
            onClick={() => void sync()}
          >
            <RefreshCw size={16} className={busy ? 'spin' : ''} />
            {busy ? '读取中…' : '同步存储桶'}
          </button>
        </div>
        <div className="table-scroll">
          <table className="console-table">
            <thead>
              <tr>
                <th>存储桶</th>
                <th>平台 / 账号</th>
                <th>位置 / 管辖区</th>
                <th>存储类型</th>
                <th>创建时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.slice((current - 1) * 25, current * 25).map((b) => (
                <tr key={b.accountId + ':' + b.jurisdiction + ':' + b.name}>
                  <td>
                    <button className="resource-link" onClick={() => setDetail(b)}>
                      <Database size={17} />
                      {b.name}
                    </button>
                  </td>
                  <td>
                    Cloudflare R2<small>{accounts.find((a) => a.id === b.accountId)?.name}</small>
                  </td>
                  <td>
                    {b.region || '未返回'}
                    <small>{b.jurisdiction}</small>
                  </td>
                  <td>{b.storageClass || '未返回'}</td>
                  <td>
                    {b.createdAt ? new Date(b.createdAt).toLocaleDateString('zh-CN') : '未返回'}
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={'查看 ' + b.name}
                      onClick={() => setDetail(b)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <div className="console-empty">
            <Database size={32} />
            <h3>
              {all.length
                ? '没有匹配的存储桶'
                : snapshots.some((s) => s.kind === 'storage:buckets')
                  ? '已同步的来源未返回存储桶'
                  : '尚未读取存储桶'}
            </h3>
            <p>连接 Cloudflare 账号，授予 Workers R2 Storage 读取权限后同步。</p>
            {!sources.length && (
              <button className="secondary" onClick={onAccounts}>
                连接云账号
              </button>
            )}
          </div>
        )}
        <div className="table-footer">
          <span>{rows.length} 个存储桶</span>
          <div>
            <button
              className="secondary compact"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              上一页
            </button>
            <span>
              {current} / {pages}
            </span>
            <button
              className="secondary compact"
              disabled={current >= pages}
              onClick={() => setPage(current + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </section>
      {snapshots
        .filter((s) => s.kind === 'issue:storage:buckets')
        .map((s) => (
          <div className="local-error" key={s.account_id}>
            {accounts.find((a) => a.id === s.account_id)?.name}：{s.data[0]?.message}
            。保留上次成功读取的结果。
          </div>
        ))}
      <section className="panel console-detail storage-capabilities">
        <h2>存储接入范围</h2>
        <dl className="console-definition">
          <dt>Cloudflare R2</dt>
          <dd>可读取存储桶清单；需要现有账号已启用 R2。本工具不会代为开通。</dd>
          <dt>阿里云 OSS / S3 兼容</dt>
          <dd>尚未接入，后续通过存储适配器扩展。</dd>
          <dt>对象操作</dt>
          <dd>上传、下载、删除与访问策略暂未开放。</dd>
        </dl>
      </section>
      {detail && (
        <Dialog title={detail.name} drawer onClose={() => setDetail(null)}>
          <div className="modal-body">
            <dl className="console-definition">
              <dt>平台</dt>
              <dd>Cloudflare R2</dd>
              <dt>账号</dt>
              <dd>{accounts.find((a) => a.id === detail.accountId)?.name}</dd>
              <dt>位置</dt>
              <dd>{detail.region || '未返回'}</dd>
              <dt>管辖区</dt>
              <dd>{detail.jurisdiction}</dd>
              <dt>存储类型</dt>
              <dd>{detail.storageClass || '未返回'}</dd>
              <dt>最近读取</dt>
              <dd>{new Date(detail.checkedAt).toLocaleString('zh-CN')}</dd>
            </dl>
            <p className="console-footnote">这里展示存储桶元数据；对象和访问策略请在原平台管理。</p>
          </div>
        </Dialog>
      )}
    </>
  );
}
