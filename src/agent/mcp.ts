import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { client, publish } from './client';
const server = new Server(
  { name: 'newbie-cloud', version: '0.2.0' },
  { capabilities: { tools: {} } },
);
const string = { type: 'string' } as const;
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_projects',
      description: '列出令牌授权的项目。项目令牌不能访问其他项目或云密钥。',
      inputSchema: schema({}, []),
      annotations: { readOnlyHint: true },
    },
    {
      name: 'project_status',
      description: '读取项目与发布记录。传 releaseId 时查询云平台实际结果，不会重复部署。',
      inputSchema: schema({ projectId: string, releaseId: string }, ['projectId']),
      annotations: { readOnlyHint: true },
    },
    {
      name: 'publish_static_folder',
      description:
        '将用户确认的静态构建目录发布到项目正式地址。只允许 NEWBIE_CLOUD_PUBLISH_ROOT 内目录。先征得用户对发布内容的确认；重试使用相同 requestKey，超时后先查询结果。',
      inputSchema: schema(
        { projectId: string, directory: string, requestKey: string, message: string },
        ['projectId', 'directory', 'requestKey'],
      ),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    {
      name: 'rollback_project',
      description:
        '将正式地址恢复到先前成功版本。需要用户确认目标版本，以及令牌具有回滚权限。expectedCurrentReleaseId 必须与用户确认时一致；超时后先查状态。',
      inputSchema: schema(
        {
          projectId: string,
          targetReleaseId: string,
          expectedCurrentReleaseId: string,
          requestKey: string,
        },
        ['projectId', 'targetReleaseId', 'expectedCurrentReleaseId', 'requestKey'],
      ),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const a = request.params.arguments ?? {};
    const get = (name: string, optional = false) => {
      const v = a[name];
      if (typeof v !== 'string' || (!v && !optional)) {
        if (optional && v === undefined) return undefined;
        throw Error('缺少或无效参数 ' + name);
      }
      return v;
    };
    const api = client();
    let result: unknown;
    switch (request.params.name) {
      case 'list_projects':
        result = await api('');
        break;
      case 'project_status': {
        const pid = get('projectId'),
          rid = get('releaseId', true);
        result = rid
          ? await api('/' + pid + '/releases/' + rid + '/check', 'POST', {})
          : await api('/' + pid);
        break;
      }
      case 'publish_static_folder':
        if (!process.env.NEWBIE_CLOUD_PUBLISH_ROOT)
          throw Error('请配置 NEWBIE_CLOUD_PUBLISH_ROOT，限定 Agent 可发布的目录');
        result = await publish(
          get('projectId')!,
          get('directory')!,
          get('requestKey')!,
          get('message', true),
          process.env.NEWBIE_CLOUD_PUBLISH_ROOT,
        );
        break;
      case 'rollback_project':
        result = await api('/' + get('projectId') + '/rollback', 'POST', {
          targetReleaseId: get('targetReleaseId'),
          expectedCurrentReleaseId: get('expectedCurrentReleaseId'),
          requestKey: get('requestKey'),
        });
        break;
      default:
        throw Error('未知工具');
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: e instanceof Error ? e.message : '请求未完成' }],
    };
  }
});
await server.connect(new StdioServerTransport());
