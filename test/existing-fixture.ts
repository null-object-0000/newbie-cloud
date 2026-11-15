import assert from 'node:assert/strict';
import type { Fetch } from '../src/server/types';
export function existingFixture() {
  const projectId = 'makers-site-one',
    domain = 'www.example.com',
    zone = 'zone-workspace';
  let bound = true,
    failDeployments = false,
    wrongScript = false,
    head = 'a'.repeat(40),
    calls: string[] = [];
  const fetcher: Fetch = async (input, init) => {
    const u = new URL(String(input)),
      headers = new Headers(init?.headers);
    calls.push(
      u.hostname === 'teo.tencentcloudapi.com'
        ? JSON.parse(String(init?.body)).Interface
        : u.hostname + u.pathname,
    );
    if (u.hostname === 'teo.tencentcloudapi.com') {
      assert.equal(
        headers.get('X-TC-Action'),
        'DescribePagesResources',
        'Import and refresh must never send a cloud write',
      );
      const b = JSON.parse(String(init?.body));
      assert.equal(b.ZoneId, zone);
      const data = JSON.parse(b.Payload);
      assert.equal(init?.method, 'POST');
      if (b.Interface === 'pages:DescribePagesProjects') {
        assert.deepEqual(data.Filters, [{ Name: 'ProjectId', Values: [projectId] }]);
        return Response.json({
          Response: {
            Result: JSON.stringify({
              Code: 0,
              Data: {
                Projects: [
                  {
                    ProjectId: projectId,
                    Name: 'Site one',
                    Status: 'Normal',
                    Area: 'global',
                    CustomDomains: bound ? [domain] : [],
                    ProductionDeploymentId: 'dp-1',
                    EnvironmentVariables: { PRIVATE: 'must-not-return' },
                  },
                ],
              },
            }),
          },
        });
      }
      assert.equal(b.Interface, 'pages:DescribePagesDeployments');
      if (failDeployments) throw Error('read failed');
      assert.equal(data.Offset, 0);
      return Response.json({
        Response: {
          Result: JSON.stringify({
            Code: 0,
            Data: {
              Deployments: [
                {
                  DeploymentId: 'dp-1',
                  Status: 'Success',
                  Env: 'Production',
                  CreatedOn: '2026-11-15T01:00:00Z',
                  PreviewUrl: 'https://preview.example.com?private=must-not-return',
                  EnvironmentVariables: { SECRET: 'must-not-return' },
                },
              ],
              TotalCount: 1,
            },
          }),
        },
      });
    }
    if (u.hostname === 'raw.githubusercontent.com') {
      assert.equal(headers.has('Authorization'), false);
      return new Response(
        u.pathname.endsWith('.yml')
          ? 'name: deploy\non: [push]\nrun: node scripts/edgeone/deploy.mjs'
          : `const projectId = '${wrongScript ? 'makers-wrong' : projectId}'; const zoneId = '${zone}';`,
      );
    }
    if (u.hostname === 'api.github.com') {
      assert.equal(headers.has('Authorization'), false);
      return Response.json(
        u.pathname.includes('/actions/')
          ? {
              workflow_runs: [
                {
                  id: 11,
                  status: 'completed',
                  conclusion: 'success',
                  head_sha: head,
                  created_at: '2026-11-15T01:00:00Z',
                  event: 'push',
                },
              ],
            }
          : [{ sha: head }],
      );
    }
    if (u.hostname === 'api.cloudflare.com') {
      assert.equal(init?.method, 'GET');
      const name = u.pathname.endsWith('/deployments') ? 'deployments' : 'legacy';
      return Response.json({
        success: true,
        result:
          name === 'deployments'
            ? []
            : {
                name: 'legacy',
                domains: ['legacy.pages.dev', 'example.com'],
                canonical_deployment: { id: 'old', latest_stage: { status: 'success' } },
              },
      });
    }
    throw Error('Unexpected outbound host ' + u.hostname);
  };
  return {
    fetcher,
    projectId,
    domain,
    zone,
    calls,
    setBound(v: boolean) {
      bound = v;
    },
    setWrongScript(v: boolean) {
      wrongScript = v;
    },
    failDeployments(v: boolean) {
      failDeployments = v;
    },
    setHead(v: string) {
      head = v;
    },
  };
}
