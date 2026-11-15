import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createNodeRuntime } from '../src/node/runtime';
import { pagesFixture } from './pages-fixture';
import { assetHash } from '../src/projects/files';
test('Pages hash matches Wrangler reference vector', () =>
  assert.equal(
    assetHash(new TextEncoder().encode('<h1>Hello</h1>'), 'index.html'),
    '8deb79e268ae1932009657bb3e496c87',
  ));
test('real stdio MCP publishes a bounded local folder through scoped tokens and Node HTTP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newbie-agent-')),
    output = path.join(dir, 'dist');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'index.html'), '<h1>MCP version one</h1>');
  fs.writeFileSync(path.join(output, 'main.js'), '/* asset */\n' + ' '.repeat(20000));
  const fixture = pagesFixture(),
    runtime = createNodeRuntime({
      dataDirectory: path.join(dir, 'data'),
      assetsDirectory: 'dist',
      migrationsDirectory: 'migrations',
      port: 0,
      fetcher: fixture.fetcher,
    });
  await new Promise<void>((r) => runtime.server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + (runtime.server.address() as any).port;
  const api = async (route: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + '/api' + route, {
      method,
      headers: {
        Authorization: 'Bearer ' + runtime.env.ADMIN_TOKEN,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result: any = await r.json();
    assert.ok(r.ok, JSON.stringify(result));
    return result;
  };
  let transport: StdioClientTransport | undefined;
  let mcp: Client | undefined;
  try {
    const account = await api('/accounts', 'POST', {
        provider: 'cloudflare',
        name: 'Agent account',
        readonly: false,
        credentials: { apiToken: 'fixture-only', accountId: 'a'.repeat(32) },
      }),
      p = await api('/projects', 'POST', {
        name: 'Agent project',
        accountId: account.account.id,
        requestKey: crypto.randomUUID(),
      }),
      pid = p.project.id;
    await api('/projects/' + pid + '/provision', 'POST', {});
    const issued = await api('/projects/' + pid + '/tokens', 'POST', {
      name: 'MCP test',
      allowRollback: true,
    });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/agent/mcp.ts'],
      cwd: process.cwd(),
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (x): x is [string, string] => typeof x[1] === 'string',
          ),
        ),
        NEWBIE_CLOUD_URL: origin,
        NEWBIE_CLOUD_TOKEN: issued.token,
        NEWBIE_CLOUD_PUBLISH_ROOT: output,
      },
      stderr: 'pipe',
    });
    mcp = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await mcp.connect(transport);
    assert.equal((await mcp.listTools()).tools.length, 5);
    async function tool(name: string, args: Record<string, unknown>) {
      const r = await mcp!.callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r));
      return JSON.parse((r.content as any[])[0].text);
    }
    const first = await tool('publish_static_folder', {
      projectId: pid,
      directory: output,
      requestKey: 'mcp-release-one',
    });
    assert.equal(first.release.status, 'deploying');
    let checked = await tool('project_status', { projectId: pid, releaseId: first.release.id });
    assert.equal(checked.project.current_release, first.release.id);
    assert.equal(checked.releases[0].verification, 'production_passed');
    const replay = await tool('publish_static_folder', {
      projectId: pid,
      directory: output,
      requestKey: 'mcp-release-one',
    });
    assert.equal(replay.release.id, first.release.id);
    assert.equal(fixture.posts, 1);
    fs.writeFileSync(path.join(output, 'index.html'), '<h1>MCP version two</h1>');
    const second = await tool('publish_static_folder', {
      projectId: pid,
      directory: output,
      requestKey: 'mcp-release-two',
    });
    await tool('project_status', { projectId: pid, releaseId: second.release.id });
    await tool('rollback_project', {
      projectId: pid,
      targetReleaseId: first.release.id,
      expectedCurrentReleaseId: second.release.id,
      requestKey: 'mcp-rollback-one',
    });
    assert.equal(
      (await tool('project_status', { projectId: pid })).project.current_release,
      first.release.id,
    );
    assert.equal(
      (
        await mcp.callTool({
          name: 'publish_static_folder',
          arguments: { projectId: pid, directory: dir, requestKey: 'outside-root' },
        })
      ).isError,
      true,
    );
    assert.equal(
      (await mcp.callTool({ name: 'project_status', arguments: { projectId: pid + '/tokens' } }))
        .isError,
      true,
    );
    await api('/projects/' + pid + '/tokens/' + issued.id, 'DELETE');
    assert.equal((await mcp.callTool({ name: 'list_projects', arguments: {} })).isError, true);
  } finally {
    await mcp?.close();
    await transport?.close();
    await runtime.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('newbie-agent-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
