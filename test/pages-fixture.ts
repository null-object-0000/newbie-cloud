import assert from 'node:assert/strict';
import type { Fetch } from '../src/server/types';
export function pagesFixture() {
  const projects = new Map<string, any>(),
    deployments = new Map<string, any>(),
    assets = new Map<string, string>();
  let posts = 0,
    rollbacks = 0,
    lost = false,
    fail = false;
  const ok = (result: unknown) => Response.json({ success: true, result });
  const fetcher: Fetch = async (input, init) => {
    const u = new URL(String(input)),
      method = init?.method ?? 'GET';
    if (u.hostname.endsWith('.pages.dev')) {
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      const d = [...deployments.values()].find((d) => d.url === u.origin);
      assert.ok(d);
      return new Response(Buffer.from(assets.get(d.manifest['/index.html'])!, 'base64'), {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    assert.equal(u.hostname, 'api.cloudflare.com');
    assert.ok(new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '));
    if (u.pathname.endsWith('/assets/upload')) {
      for (const v of JSON.parse(String(init?.body))) assets.set(v.key, v.value);
      return ok({});
    }
    const parts = u.pathname.split('/pages/projects'),
      name = parts[1]?.split('/')[1];
    if (!name) {
      if (method === 'POST') {
        const v = JSON.parse(String(init?.body));
        projects.set(v.name, { ...v, canonical_deployment: null });
        return ok(projects.get(v.name));
      }
      return ok([]);
    }
    const project = projects.get(name);
    if (!project) return Response.json({ success: false }, { status: 404 });
    if (u.pathname.endsWith('/upload-token')) return ok({ jwt: 'fixture-scoped-upload-token' });
    const dm = u.pathname.match(/\/deployments\/([^/]+)(\/rollback)?$/);
    if (dm) {
      const d = deployments.get(dm[1]);
      if (!d) return Response.json({ success: false }, { status: 404 });
      if (dm[2]) {
        rollbacks++;
        project.canonical_deployment = d;
        return ok(d);
      }
      return ok(d);
    }
    if (u.pathname.endsWith('/deployments')) {
      if (method === 'POST') {
        posts++;
        if (fail) return Response.json({ success: false }, { status: 403 });
        const form = init?.body as FormData,
          id = crypto.randomUUID();
        const d = {
          id,
          url: 'https://' + id.slice(0, 8) + '.' + name + '.pages.dev',
          latest_stage: { status: 'success' },
          environment: 'production',
          deployment_trigger: { metadata: { commit_hash: form.get('commit_hash') } },
          manifest: JSON.parse(String(form.get('manifest'))),
        };
        deployments.set(id, d);
        project.canonical_deployment = d;
        if (lost) {
          lost = false;
          throw Error('response lost after acceptance');
        }
        return ok(d);
      }
      return ok(
        [...deployments.values()]
          .filter((d) => d.url.endsWith('.' + name + '.pages.dev'))
          .reverse(),
      );
    }
    return ok(project);
  };
  return {
    fetcher,
    projects,
    deployments,
    get posts() {
      return posts;
    },
    get rollbacks() {
      return rollbacks;
    },
    loseNext() {
      lost = true;
    },
    rejectNext() {
      fail = true;
    },
  };
}
