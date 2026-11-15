import { parseArgs } from 'node:util';
import { client, publish } from './client';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string' },
    directory: { type: 'string' },
    account: { type: 'string' },
    name: { type: 'string' },
    target: { type: 'string' },
    expected: { type: 'string' },
    release: { type: 'string' },
    'request-key': { type: 'string' },
    message: { type: 'string' },
  },
});
function required(value: string | undefined, label: string) {
  if (!value) throw Error('需要 --' + label);
  return value;
}
try {
  const command = positionals[0];
  let result: unknown;
  if (!command || command === 'help') {
    console.log(
      'Newbie Cloud · Node 24\nlist\ncreate --account ID --name 名称 [--request-key KEY]\nprovision --project ID\npublish --project ID --directory ./dist [--request-key KEY] [--message 说明]\nstatus --project ID [--release ID]\nrefresh --project ID（刷新已接管站点）\nrollback --project ID --target RELEASE --expected CURRENT --request-key KEY\n通过环境变量 NEWBIE_CLOUD_URL / NEWBIE_CLOUD_TOKEN 认证。MCP 使用项目专用令牌。',
    );
    process.exit(0);
  }
  const api = client(),
    pid = values.project;
  if (command === 'list') result = await api('');
  else if (command === 'create')
    result = await api('', 'POST', {
      name: required(values.name, 'name'),
      accountId: required(values.account, 'account'),
      requestKey: values['request-key'] ?? crypto.randomUUID(),
    });
  else if (command === 'refresh')
    result = await api('/' + required(pid, 'project') + '/refresh', 'POST', {});
  else if (command === 'provision')
    result = await api('/' + required(pid, 'project') + '/provision', 'POST', {});
  else if (command === 'publish')
    result = await publish(
      required(pid, 'project'),
      required(values.directory, 'directory'),
      values['request-key'] ?? crypto.randomUUID(),
      values.message,
    );
  else if (command === 'status')
    result = values.release
      ? await api(
          '/' + required(pid, 'project') + '/releases/' + values.release + '/check',
          'POST',
          {},
        )
      : await api('/' + required(pid, 'project'));
  else if (command === 'rollback')
    result = await api('/' + required(pid, 'project') + '/rollback', 'POST', {
      targetReleaseId: required(values.target, 'target'),
      expectedCurrentReleaseId: required(values.expected, 'expected'),
      requestKey: required(values['request-key'], 'request-key'),
    });
  else throw Error('未知命令，请运行 help');
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : '操作未完成');
  process.exitCode = 1;
}
