# Docker 与服务器管理

Newbie Cloud 提供两种部署方式：Workers + D1 适合免费优先的个人云管理；Docker + 本地 SQLite 适合已有服务器、NAS 或 Docker Desktop 的自托管用户。两者共享云平台 API、登录、凭据加密与 DNS 保护逻辑。Docker 版的数据与 Workers D1 分开保存，不会自动搬迁线上账号或配置。

## 启动

需要 Docker Engine / Docker Desktop（Linux 容器）和 Docker Compose v2。在仓库根目录执行：

```sh
docker compose up -d --build
mkdir -p .local
docker compose cp newbie-cloud:/data/admin-token.txt .local/docker-admin-token.txt
```

打开 <http://localhost:8080>，用复制文件中的管理密钥登录。启动日志不打印密钥。Windows PowerShell 可用 `New-Item -ItemType Directory -Force .local` 创建本机目录。

镜像采用 Node.js 24 多阶段构建，运行镜像不包含 npm 依赖、源码或本机凭据。进程默认以 `node` 用户运行，根文件系统只读，数据保存在命名卷 `newbie-data`。首次启动自动生成登录密钥、AES 加密主密钥和 SQLite 数据库；后续启动复用数据卷中的文件并执行新增迁移。无需配置 Cloudflare 账号或 D1。

可将 `docker.env.example` 复制为 `.env` 调整端口、公开来源和可选 GitHub Actions token。`.env` 不进入 Git。云平台凭据仍通过管理台添加，按原规则加密保存。

## 本机 Docker

插件中心支持从 GitHub / npm 安装资源插件。声明式插件默认可用；要运行自己信任的 JavaScript 插件，在 `.env` 设置 `ALLOW_CODE_PLUGINS=true` 后重建容器。每次安装仍需在界面确认来源与执行权限。子进程限制不构成恶意代码沙箱，详见[插件文档](plugins.md)。默认关闭此能力。

默认不挂载 Docker socket。需要查看本机 Docker 时，显式使用第二份 Compose 文件：

```sh
# Linux：使用 socket 实际所属组；Docker Desktop 的 Linux socket 通常为 0。
export DOCKER_GID=$(stat -c %g /var/run/docker.sock)
docker compose -f compose.yml -f compose.docker.yml up -d --build
```

Windows / macOS Docker Desktop 运行上述 Compose 组合时，挂载的是 Docker Linux VM 内的 `/var/run/docker.sock`；无法从 Windows 容器模式读取 Linux 容器。rootless Docker 用户需将覆盖文件中的宿主 socket 路径改为自身 daemon 的 socket，并设置对应组。

登录后可在“本机容器”查看全部运行及停止的容器、Compose 项目、端口、详情、挂载信息、一次性 CPU / 内存 / 网络采样和最近 200 行日志。日志仅按需返回，不持久化，不提供环境变量或完整原始 inspect 数据。

读取模式是默认值。要启用启动、停止和重启，在 `.env` 设置 `DOCKER_WRITE_ENABLED=true`，再运行同一条 Compose 命令重建容器。操作需输入完整容器名称，服务端重新检查权限、当前状态和目标 ID；管理台自身受保护。接口不提供创建容器、删除、prune、exec 或任意 Docker API 代理。超时不重试，应先刷新状态核对结果。

挂载 Docker socket 实际赋予应用宿主机级的 daemon 访问能力，`:ro` 挂载不能使 Docker API 变成只读。应用的读取模式属于应用层控制。只在自己的受信任主机上启用 socket；不要将 daemon 的裸 TCP 接口暴露到网络。默认 Compose 仅将管理台端口绑定到 `127.0.0.1`。

## 服务器清单与部署主机

“服务器”默认汇总已连接阿里云账号的 ECS 与腾讯云账号的 CVM，支持账号、地域与名称 / IP 筛选。点击“同步全部地域”后读取各家地域目录，按地域逐页查询。每个地域独立替换完整快照；某地域失败时保留其上次结果并提示，其他地域继续同步。显示实例状态、公网 / 内网 IP、CPU、内存、系统、计费类型与供应商提供的到期时间。

所需读取权限：

- 阿里云：`ecs:DescribeInstances`；地域目录 `DescribeRegions` 按官方文档无需额外 RAM 授权。
- 腾讯云：`cvm:DescribeRegions`、`cvm:DescribeInstances`。

该清单只读取 ECS / CVM，不自动包含轻量应用服务器、裸金属或其他云产品，也不提供云服务器开关机、重装或 SSH 终端。

Docker / Node 版还可切到“部署主机”，查看运行环境与数据卷所在文件系统。连接 Docker 后另行展示 Engine 所在主机信息；Docker Desktop 下这一主机是 Linux VM。应用容器的 OS 可见内存、系统负载和文件系统容量不当作物理主机配额，界面会分别标注来源。

## HTTPS 与反向代理

公网访问应通过自己的 HTTPS 反向代理，设置：

```env
PUBLIC_ORIGIN=https://cloud.example.com
```

反向代理需保留原始 `Host`；例如 Nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;
}
```

应用只接受配置的主机名。默认未配置时只接受 localhost / 回环地址；不信任客户端自行传入的 X-Forwarded-Host 或 X-Forwarded-Proto。设置 HTTPS 来源后，登录 Cookie 使用 Secure，浏览器写入需匹配该来源。PWA 在 localhost 或 HTTPS 上可安装，离线仍只缓存静态界面。

## 更新、备份与恢复

```sh
git pull
docker compose up -d --build
```

启用了 Docker 覆盖文件时，更新也须带上 `-f compose.yml -f compose.docker.yml`。保留命名数据卷；删除该卷会同时丢失数据库和生成的密钥。

备份前停止应用写入，将整个 `/data` 复制到安全位置，包含 `app.sqlite`、可能存在的 WAL 文件、`secrets.json` 和 `admin-token.txt`。恢复时一起恢复这些文件，并保持 `node` 用户（默认 UID 1000）可读写。缺少密钥而已有数据库时，启动会拒绝自动生成新主密钥，以免已有凭据永久无法解密。环境传入的密钥与卷内密钥不一致也会拒绝启动；轮换加密主密钥需先迁移数据。

每个数据卷运行一个应用实例。当前不是多副本高可用架构。

## 不使用 Docker 的 Node 运行

```sh
npm ci
npm run build
npm run build:node
npm start
```

默认使用仓库根目录的 `data/`，同样自动生成密钥。可通过 `DATA_DIR`、`PORT`、`PUBLIC_ORIGIN` 配置。开发测试可以设置 `DOCKER_SOCKET` 指向本机 Unix socket 或 Windows named pipe，`DOCKER_WRITE_ENABLED=true` 启用控制。定时巡检每 15 分钟执行一次，规则与 Workers Cron 一致。

CI 会构建真实镜像，在临时 Docker 容器中验证 SQLite / 密钥持久化、socket 读取、日志、资源采样、启停和重启、鉴权及自身保护；仅操作带测试标记的临时资源。
