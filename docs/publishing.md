# 发布静态网页：界面、CLI 与 Agent

只需一个 Cloudflare 账号。Newbie Cloud 将构建好的静态文件发布到你自己账号下的新 Pages 项目，提供 `https://nc-….pages.dev` 正式地址、独立版本地址和平台 HTTPS。不会修改既有项目、DNS 或邮箱，不会创建函数、购买套餐或绑定付费资源。

## 第一次发布

1. 打开「我的项目」→「发布我的第一个网页」。
2. 连接 Cloudflare：填写 Account ID 和限定该账号的 API Token，授予 **Account → Cloudflare Pages → Edit**。发布账号关闭只读；不需要 DNS 编辑权限，也不需要阿里云、腾讯云账号。
3. 填项目名称，创建项目及独立云端站点。
4. 选择一个 HTML、多文件或构建目录。也可以先用内置示例。
5. 核对文件清单和版本说明，点击「确认发布到正式地址」。
6. 等待部署结果。「部署完成」来自平台状态；「访问验证通过」还要求独立版本地址返回 HTTP 200，并且首页 SHA-256 与上传内容相同。首次站点 DNS / 边缘传播可能需要时间，可稍后点击「检查结果」。

React / Vue 等项目应先在本机或 CI 构建，上传 `dist` 等输出目录，根部需有 `index.html`。不是上传源码后在线执行 npm install。当前每版最多 200 文件、单文件 1 MiB、总计 10 MiB；这是本项目为免费控制台设置的边界，低于 Cloudflare 平台上限。

只允许常见静态文件，不接受隐藏目录、`.env`、密钥文件、符号链接、源码类型、node_modules、functions 和 `_worker.js` 等服务端入口。文件名过滤无法识别普通 JSON / JS 中主动写入的秘密，发布前仍需检查构建内容。

Cloudflare 免费套餐及使用条款以[官方说明](https://developers.cloudflare.com/pages/platform/limits/)为准。纯静态路径不启用函数。域名购买与 AI 模型调用不在托管额度中。本版不保证中国大陆访问质量；需要大陆节点时，后续增加 EdgeOne 发布适配。自定义域名仍可使用现有 DNS 管理，自动绑定尚未纳入此流程。

## 更新、回滚与异常

在项目里重新选择完整构建目录，即可发布新版本。文件检查和上传完成后才提交生产部署；未上传完成的版本不会切换线上地址。Cloudflare 保留实际资产，本地数据库仅保留清单、校验值、状态与版本 ID，不保存网页文件副本。

已成功的历史版本可以回滚，需输入项目名称。提交时同时检查当前版本是否仍与确认时一致，并核实云平台当前生产版本；外部控制台修改后不盲目覆盖。外部 API 不支持和本地数据库的分布式原子事务，因此最后检查与平台操作之间仍可能发生竞争。

超时不等于失败。结果不明时保留「待核实」，不自动重复发布或回滚；点击「检查结果」通过远端部署 ID 或本次提交标记查询。查到真实成功后再切换本地当前版本。平台保留策略、手动删除或外部变更可能使历史版本无法回滚。

两分钟后仍未找到结果，所有者可先在云控制台核实，再输入项目名称「结束任务并解锁」。服务端会再次检查远端状态；已找到部署时拒绝结束。手动解锁不能撤销已被云平台接受但尚未显示的操作，所以必须先核实。Agent 无权执行此操作。

## 项目 Agent Token

项目页 →「连接 Agent」→ 生成令牌。令牌只显示一次，数据库只存哈希，默认 30 天、最长 90 天，可随时撤销。默认允许读取项目和发布；回滚需单独授权。不能创建其他项目、获取云账号、管理令牌、修改 DNS 或操作服务器。首次创建云端站点由所有者完成。

项目令牌可在多个支持 MCP 的客户端使用，不需要把 Cloudflare Token 或整个工作台的管理密钥交给 Agent。令牌撤销阻止后续请求，不能撤销已经被云平台接受的部署。

## CLI

在本机准备 Node.js 24，克隆本仓库后运行：

```sh
npm ci
npm run build:agent
```

将 `NEWBIE_CLOUD_URL` 设置为工作台的 HTTPS 来源，将 `NEWBIE_CLOUD_TOKEN` 设置为项目令牌。不要把令牌写进命令参数、Git、截图或共享日志。

```sh
node agent/cli.mjs list
node agent/cli.mjs publish --project PROJECT_ID --directory ./dist --message "更新首页" --request-key unique-release-001
node agent/cli.mjs status --project PROJECT_ID
node agent/cli.mjs status --project PROJECT_ID --release RELEASE_ID
node agent/cli.mjs rollback --project PROJECT_ID --target OLD_RELEASE_ID --expected CURRENT_RELEASE_ID --request-key unique-rollback-001
```

`publish` 返回的是提交结果，不承诺立即上线；随后用 status 查询实际结果。相同发布重试应沿用相同 request-key 和文件内容。上传可重新发送，生产提交只执行一次；CLI 不自动重复网络写入。

所有者使用管理密钥时还可运行 `create --account ACCOUNT_ID --name NAME` 和 `provision --project PROJECT_ID`。Agent 推荐只使用项目令牌。

## MCP

本版提供本机 stdio MCP，使用官方 TypeScript SDK。完成上述构建后，在客户端加入配置（路径替换为本机绝对路径）：

```json
{
  "mcpServers": {
    "newbie-cloud": {
      "command": "node",
      "args": ["/absolute/path/newbie-cloud/agent/mcp.mjs"],
      "env": {
        "NEWBIE_CLOUD_URL": "https://your-control-plane.example.com",
        "NEWBIE_CLOUD_TOKEN": "YOUR_PROJECT_AGENT_TOKEN",
        "NEWBIE_CLOUD_PUBLISH_ROOT": "/absolute/path/my-website"
      }
    }
  }
}
```

工具包括 `list_projects`、`project_status`、`publish_static_folder`、`rollback_project`。MCP 仅允许发布 `NEWBIE_CLOUD_PUBLISH_ROOT` 内的目录，不跟随目录内符号链接。这个目录限制是发布文件的边界，不是运行任意不可信 Agent 的操作系统沙箱。

可对 Agent 说：“检查项目 PROJECT_ID，把已构建的 dist 发布上去；先告诉我文件数量和目标地址，确认后提交，再检查实际部署结果。”

## API

界面、CLI、MCP 共用 `/api/projects`：

| 操作                | 接口                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| 项目列表 / 创建     | `GET /api/projects` / `POST /api/projects`                                                 |
| 项目及最近版本      | `GET /api/projects/:id`                                                                    |
| 准备 / 核实云端站点 | `POST /api/projects/:id/provision` / `reconcile`                                           |
| 创建发布清单        | `POST /api/projects/:id/releases`，files 含 path / size / hash / sha256                    |
| 上传一个文件        | `PUT /api/projects/:id/releases/:rid/file?path=…`，二进制正文                              |
| 提交 / 核实部署     | `POST /api/projects/:id/releases/:rid/publish` / `check`                                   |
| 回滚                | `POST /api/projects/:id/rollback`，targetReleaseId / expectedCurrentReleaseId / requestKey |
| 生成 / 撤销令牌     | `POST /api/projects/:id/tokens` / `DELETE …/tokens/:tokenId`（所有者）                     |

创建、发布清单、回滚要求 requestKey。资产哈希沿用 Wrangler Pages 的 BLAKE3(base64内容 + 扩展名) 截取 32 位十六进制，并额外验证完整 SHA-256；实现见 `src/projects/files.ts`。所有 API 响应不缓存，PWA 不保存项目内容或令牌。
