import { HttpError, type Fetch } from '../server/types';
import { bytesLimited } from '../plugins/sources';
export class PagesRejected extends HttpError {}
export class Pages {
  constructor(
    private token: string,
    private accountId: string,
    private fetcher: Fetch,
  ) {}
  async api(path: string, method = 'GET', body?: BodyInit, token = this.token) {
    let r: Response;
    try {
      r = await this.fetcher.call(globalThis, 'https://api.cloudflare.com/client/v4' + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new HttpError(504, '云平台响应超时；请检查结果，不会自动重复提交');
    }
    let b: any;
    try {
      b = JSON.parse(new TextDecoder().decode(await bytesLimited(r.body, 1500000)));
    } catch {
      throw new HttpError(502, '云平台返回无法解析的结果，请检查任务状态');
    }
    if (!r.ok || b.success === false) {
      if (r.status === 404) throw new PagesRejected(404, '远端项目或版本不存在');
      const ErrorClass = r.status < 500 ? PagesRejected : HttpError;
      throw new ErrorClass(
        r.status === 403 || r.status === 401 ? 403 : 502,
        'Cloudflare 请求未完成（HTTP ' +
          r.status +
          '，代码 ' +
          String(b.errors?.[0]?.code ?? 'unknown') +
          '）。请检查 Pages Edit 权限、账号和套餐限制。',
      );
    }
    return b.result;
  }
  root(name?: string) {
    return '/accounts/' + this.accountId + '/pages/projects' + (name ? '/' + name : '');
  }
  async project(name: string) {
    return this.api(this.root(name));
  }
  async provision(name: string) {
    try {
      return await this.project(name);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
    }
    return this.api(this.root(), 'POST', JSON.stringify({ name, production_branch: 'main' }));
  }
  async upload(name: string, key: string, value: string, contentType: string) {
    const { jwt } = await this.api(this.root(name) + '/upload-token');
    if (typeof jwt !== 'string') throw new HttpError(502, '云平台未返回上传凭据');
    await this.api(
      '/pages/assets/upload',
      'POST',
      JSON.stringify([{ key, value, base64: true, metadata: { contentType } }]),
      jwt,
    );
  }
  async publish(
    name: string,
    files: { path: string; hash: string }[],
    commit: string,
    message: string,
  ) {
    const form = new FormData();
    form.set('branch', 'main');
    form.set('commit_hash', commit);
    form.set('commit_message', message);
    form.set(
      'manifest',
      JSON.stringify(Object.fromEntries(files.map((f) => ['/' + f.path, f.hash]))),
    );
    return this.api(this.root(name) + '/deployments', 'POST', form);
  }
  async deployment(name: string, id: string) {
    return this.api(this.root(name) + '/deployments/' + encodeURIComponent(id));
  }
  async find(name: string, commit: string) {
    for (let page = 1; page <= 10; page++) {
      const list = await this.api(this.root(name) + '/deployments?page=' + page + '&per_page=25');
      if (!Array.isArray(list)) throw new HttpError(502, '部署列表无效');
      const found = list.find((d: any) => d.deployment_trigger?.metadata?.commit_hash === commit);
      if (found) return found;
      if (list.length < 25) return null;
    }
    throw new HttpError(409, '部署记录过多，请到 Cloudflare 核实结果');
  }
  async rollback(name: string, id: string) {
    return this.api(
      this.root(name) + '/deployments/' + encodeURIComponent(id) + '/rollback',
      'POST',
    );
  }
}
