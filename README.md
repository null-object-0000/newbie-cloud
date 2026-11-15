# Newbie Cloud

**个人云管家：单用户、免费优先、Serverless。** 在自己的 Cloudflare 账号部署一套面板，统一查看 Cloudflare、腾讯云和阿里云的域名、DNS、托管服务、邮箱转发与证书状态。

React 静态界面 + Cloudflare Workers API + D1。无需常驻服务器、Redis、消息队列或团队系统。每位使用者消耗自己云账号的额度。

登录页及管理台右上角的外观按钮支持浅色、深色和跟随系统，可搭配无主色、蓝色、墨绿、紫罗兰四种主题色。偏好保存在当前浏览器，刷新后自动恢复；跟随系统会实时响应系统外观变化。

## v0.1 MVP

| 能力                                                   | 状态                                                      |
| ------------------------------------------------------ | --------------------------------------------------------- |
| 多账号、独立只读开关、加密凭据                         | 可用                                                      |
| Cloudflare DNS、腾讯云 DNSPod、阿里云 DNS              | 读取、分页、创建、更新、删除                              |
| DNS 变更预览                                           | 15 分钟有效；应用前重新核对远端旧值；同一计划仅执行一次   |
| 邮箱 / 委派 / 证书验证记录保护                         | 额外确认用途并输入完整域名                                |
| Cloudflare Pages / Workers、EdgeOne Makers、阿里云 ESA | 读取已有服务列表                                          |
| Cloudflare Email Routing                               | 只读展示普通转发规则，前 50 条                            |
| 平台证书状态与到期时间                                 | 手动查询 + 每 15 分钟轮询一个账号                         |
| GitHub Actions 部署入口                                | 配置可选 GITHUB_TOKEN 后派发已有 workflow_dispatch 工作流 |
| 操作记录                                               | 保留 DNS 原值和计划，显示最近 100 条                      |

服务与证书列表当前读取首批结果（Cloudflare Pages 10 个，腾讯 / 阿里相关接口最多 100 条），DNS 域名及记录支持分页。域名清单是 **DNS 托管区域**，不是域名注册商的完整资产；同步只合并缓存，不自动删除未返回的域名。

这是可运行的个人 MVP，不承诺代码跨云运行，也不执行自动迁移、购买产品、自动切换 DNS 或私钥签发。已托管证书由原云平台续期；这里观察平台返回的状态，不等同于独立探测所有源站 TLS。自管证书的 ACME 申请、部署和续期执行器属于后续工作。

## 本地运行

需要 Node.js 24 和 npm。

```sh
npm ci
npm run setup
npm run build
npm run db:local
npm run dev:api
```

打开 Wrangler 输出的本地地址。登录密钥在 `.local/admin-token.txt`。日常前端开发可另外运行 `npm run dev`，Vite 会把 `/api` 转发到本地 8787 端口。

`npm run check` 执行类型检查、前端构建及真实本地 D1 集成测试；测试只使用模拟云 API，不修改线上 DNS。

## 部署到自己的 Cloudflare 账号

1. Fork 仓库，安装依赖并登录 Cloudflare：

```sh
npm ci
npm run setup
npx wrangler login
npx wrangler d1 create newbie-cloud
```

2. 用上一步返回的 D1 ID 生成私有部署配置：

```sh
npm run setup -- --database-id YOUR_D1_DATABASE_ID --account-id YOUR_CLOUDFLARE_ACCOUNT_ID
npx wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc
npm run build
npx wrangler deploy --config wrangler.local.jsonc
npm run setup -- --publish-secrets
```

3. 打开部署输出的 workers.dev 地址，用 `.local/admin-token.txt` 中的管理密钥登录。首次接入建议保持账号只读，再手动同步域名或读取服务。部署不需要改变已有域名 DNS。

保存好 `.local/secrets.json`：其中的 ENCRYPTION_KEY 用于解密已有云凭据；更换它之前需迁移数据。更换 ADMIN_TOKEN 会撤销已有登录。两个值均由 setup 随机生成，脚本不打印明文。上述私有文件、`.dev.vars`、本地 Wrangler 配置均不进入 Git。

可选：添加一个仅限目标仓库、具有 Actions 写权限的 fine-grained GitHub token 到 Workers Secret `GITHUB_TOKEN`，可从面板提交已有部署工作流。GitHub 接收请求不代表构建成功，执行结果仍在 GitHub Actions 查询。

## 自动部署本项目

默认 CI 仅构建与测试，不接触云凭据。若要自动部署自己的实例，在自己的 Fork 中配置：

- Repository Variables：`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`。
- Repository Secret：`CLOUDFLARE_API_TOKEN`，限制到自己的账号和本项目，提供 Workers Scripts 写入及 D1 所需权限。

配置后 main 的 push 或手动运行 CI 会在检查通过后部署。ADMIN_TOKEN / ENCRYPTION_KEY 仍保存在 Workers Secrets，CI 不生成或替换生产密钥。PR 工作流不会获得部署凭据。

## 云 API 权限

只读连接与供应商自身权限同时生效，前端关闭按钮不是唯一限制。服务能力独立：缺少 DNS 权限的腾讯云账号仍可单独查询已授权的 Makers 服务，账号保存时不强制要求所有产品权限。

| 平台       | 读取 DNS                                                                | DNS 写入（可选）                                        | 额外的查询能力                                                                                          |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Cloudflare | Zone Read、DNS Read                                                     | DNS Edit                                                | Pages Read、Workers Scripts Read；证书及 Email Routing Rules Read 按需要授权；查看托管服务需 Account ID |
| 腾讯云     | dnspod:DescribeDomainList、DescribeRecordList、DescribeRecord           | CreateRecord、ModifyRecord、DeleteRecord                | teo:DescribePagesResources、DescribeHostCertificates；Makers 需工作空间 Zone ID                         |
| 阿里云     | alidns:DescribeDomains、DescribeDomainRecords、DescribeDomainRecordInfo | AddDomainRecord、UpdateDomainRecord、DeleteDomainRecord | esa:ListSites、yundun-cert:ListUserCertificateOrder，按产品分别授权                                     |

不要把个人完整账号密钥放入公开源码、Issue、日志或示例配置。平台固定各家 API 主机，禁止凭据通过自定义端点或跨域重定向发送。

## 免费运行的边界

默认只使用 Workers Static Assets、Workers、D1 和一个 Cron Trigger，没有付费资源开通步骤。云平台额度、产品资格和价格仍以自己的账号为准，软件不保证所有用量始终为零费用。后台不构建项目、不压缩或代理大文件；部署交给已有 CI。

- [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [静态资源计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)

证书巡检默认每 15 分钟只处理一个账号（Cloudflare 每次一个域名），不会轮询忙等，不会触发自动续签或写 DNS。30 天前的非 DNS 操作记录定期清理；DNS 变更记录保留。外部写入发生超时或结果不明时，计划标记为待核对，不自动重放。

## 开源与后续方向

MIT 许可。欢迎为 DNS 供应商、平台托管证书、部署流程与本地执行器贡献适配。

后续优先：资源与项目关联、完整分页、邮箱规则的预览式编辑、GitHub 部署结果跟踪、ACME 执行器、带检查点的跨云迁移与恢复、Flowlet 凭据集成。保持单用户与免费优先。
