# 插件安装与开发

云厂商、域名、DNS、邮箱、证书、服务器、Docker 和 GitHub 部署均可在「插件中心」按需启停。停用同时限制后端执行，不删除云账号、快照或云资源。登录、账号设置、操作记录和插件中心始终保留。

设计参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的可组合能力思路；这里的插件格式独立，不兼容其 Cordis API。

## 从界面安装

输入 `github:owner/repo@main`、GitHub 仓库地址或 `npm:@scope/package@1.0.0`，点击「检查插件」。公开仓库或 npm 包的根目录必须有 `newbie-plugin.json`。这是专用协议，不会把任意 npm 包自动变成云管理插件。

可以先安装 `github:null-object-0000/newbie-cloud@main` 体验：本仓库根目录提供无网络权限、无需配置的静态示例插件，只有一条文档资源。

预览显示固定来源、SHA-256 包指纹、网络主机和配置字段。GitHub 分支 / 标签固定到提交；npm 标签固定到具体版本，并验证注册表的 SHA-512 tarball 完整性。确认后安装预览的内容，不会再次跟随浮动分支。预览有效期 15 分钟，只能安装一次。

安装与更新后默认停用，配置完成后再启用。从侧栏或「查看资源」进入，点击「读取资源」。检查更新重新预览并要求确认，不静默更新。同 ID 只允许同一仓库 / npm 包的更新。卸载删除插件与其配置，不操作远端资源。

| 类型                | 免费 Workers | Docker / Node                            |
| ------------------- | ------------ | ---------------------------------------- |
| 内置插件            | 支持云管理   | 支持；本机能力另需显式接入 Docker socket |
| 声明式资源插件      | 支持         | 支持                                     |
| JavaScript 资源插件 | 不执行       | 设置 `ALLOW_CODE_PLUGINS=true` 后支持    |

第三方 v1 扩展统一的只读资源列表，尚不提供 DNS 写入适配器、任意后台路由、前端代码注入、定时任务或读取现有云账号凭据的接口。

## 声明式插件

仓库根目录的 `newbie-plugin.json` 示例：

```json
{
  "schemaVersion": 1,
  "id": "example.inventory",
  "name": "我的资源",
  "version": "1.0.0",
  "description": "从个人 API 读取资源",
  "kind": "declarative",
  "permissions": { "network": ["api.example.com"] },
  "config": [{ "key": "token", "label": "API Token", "secret": true, "required": true }],
  "connector": {
    "url": "https://api.example.com/resources",
    "headers": { "Authorization": "Bearer {{config.token}}" },
    "itemsPath": "items",
    "fields": { "id": "id", "name": "name", "type": "type", "detail": "description" }
  }
}
```

接口返回 `{ "items": [{ "id": "a", "name": "网站", "type": "site" }] }` 即可。`itemsPath` 和字段路径为点分 JSON 路径，不支持表达式。请求仅 GET、公共 HTTPS、明确列出的主机，不跟随重定向。不支持通配符、IP、localhost、自定义端口和内网名称。URL 中的 `{{config.key}}` 会编码，header 直接替换并禁止换行。配置不会引用主工作台的密钥。

也可省略 `connector`，提供静态 `resources` 数组，网络列表留空。资源必须有 `id`、`name`、`type`，可选 `status`、`domain`、`region`、`url`、`detail`。ID 不得重复，URL 仅 HTTP(S)，界面按纯文本显示。

## JavaScript 插件

清单改为 `kind: "node"`、`entry: "plugin.mjs"`，省略 connector / 静态资源，根目录放预打包 ESM：

```js
export default {
  async collect({ config, fetch }) {
    const response = await fetch('https://api.example.com/resources', {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!response.ok) throw new Error('资源接口读取失败');
    const body = await response.json();
    return body.items.map((item) => ({ id: item.id, name: item.name, type: 'site' }));
  },
};
```

类型契约见 `src/plugins/types.ts`。只加载 `plugin.mjs`，不执行 npm 生命周期脚本、不运行 npm install、不解析依赖；依赖应提前打进单文件。npm 清单版本必须与注册表版本一致。

**只安装受信任代码。** 每次收集使用独立 Node 子进程、最小环境、文件读取限制、内存上限和 15 秒时限；父进程不传云密钥、管理密钥、加密密钥或 Docker 配置。Node 权限模型是防误用措施，官方明确说明它[不是恶意代码沙箱](https://nodejs.org/download/release/v24.21.0/docs/api/permissions.html)。网络封装也不能阻止恶意代码使用原生模块绕过检查。代码可能利用运行用户的系统 / 网络权限，尤其是主机可访问的 Docker socket。运行不可信代码应另用隔离主机或容器。

## 数据与限制

配置使用独立上下文 AES-GCM 加密。读取秘密字段仅返回「已保存」，空白保存保留原值，资源结果会遮盖这些值。插件访问自己声明的接口时仍会按配置发送其密钥。操作记录不保存配置明文。

资源按需读取，只在当前页面展示，不写入云资源快照或 PWA 缓存。一次最多 1,000 条，超出报错而非截断。声明式响应上限 1 MB、清单 32 KB、代码 256 KB、npm 压缩包 2 MB / 解压 4 MB。安装只读取指定文件，不向磁盘解压任意路径。

主机声明、指纹和来源固定用于审查与防误装，不代表代码经过平台审核。更新保留同来源配置，但需重新核对权限并启用。
