import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import type {
  ContainerSummary,
  ContainerDetail,
  ContainerStats,
  LocalCapabilities,
  SystemOverview,
} from '../shared';
import type { LocalRuntime } from '../server/types';
import { HttpError } from '../server/types';

type Json = Record<string, any>;
function containerId(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpError(400, '容器 ID 无效');
  return id;
}
export class DockerEngine {
  private version: string | undefined;
  constructor(
    private socket: string,
    private writeEnabled: boolean,
    private selfId = os.hostname(),
  ) {}
  private request(path: string, method = 'GET', limit = 4 * 1024 * 1024): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socket,
          path,
          method,
          headers: { Host: 'docker', ...(method === 'POST' ? { 'Content-Length': '0' } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let length = 0;
          res.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > limit) {
              req.destroy();
              reject(new HttpError(413, 'Docker 返回内容超过限制，请缩小日志范围'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if ((res.statusCode ?? 500) >= 300) {
              const status =
                res.statusCode === 404
                  ? 404
                  : res.statusCode === 409 || res.statusCode === 304
                    ? 409
                    : 502;
              reject(
                new HttpError(
                  status,
                  status === 404
                    ? '容器不存在或已被移除'
                    : status === 409
                      ? '容器状态不允许此操作，请刷新后重试'
                      : 'Docker Engine 拒绝请求，请检查守护进程和权限',
                ),
              );
              return;
            }
            resolve(Buffer.concat(chunks));
          });
          res.on('error', () =>
            reject(new HttpError(502, 'Docker 响应中断；写入结果需刷新状态核对')),
          );
        },
      );
      req.setTimeout(method === 'POST' ? 25000 : 12000, () => req.destroy());
      req.on('error', () =>
        reject(
          new HttpError(
            502,
            '无法连接本机 Docker Engine；检查 socket 挂载与权限，操作结果不明时请刷新状态核对',
          ),
        ),
      );
      req.end();
    });
  }
  private async json(path: string): Promise<Json> {
    const bytes = await this.request(path);
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new HttpError(502, 'Docker 返回了无效 JSON');
    }
  }
  private async endpoint(path: string) {
    if (!this.version) {
      const version = await this.json('/version');
      if (!/^\d+\.\d+$/.test(version.ApiVersion)) throw new HttpError(502, 'Docker API 版本无效');
      this.version = version.ApiVersion;
    }
    return '/v' + this.version + path;
  }
  private protected(id: string, labels: Json) {
    return (
      labels?.['io.newbie-cloud.role'] === 'control-plane' ||
      (/^[a-f0-9]{12,64}$/.test(this.selfId) && id.startsWith(this.selfId))
    );
  }
  async info() {
    return this.json(await this.endpoint('/info'));
  }
  async containers(): Promise<ContainerSummary[]> {
    const rows = await this.json(await this.endpoint('/containers/json?all=1'));
    if (!Array.isArray(rows)) throw new HttpError(502, 'Docker 容器清单格式无效');
    return rows.map((c: Json) => ({
      id: c.Id,
      name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      created: c.Created,
      ports: (c.Ports ?? []).map(
        (p: Json) =>
          (p.PublicPort ? `${p.IP ?? '0.0.0.0'}:${p.PublicPort} → ` : '') +
          p.PrivatePort +
          '/' +
          p.Type,
      ),
      project: c.Labels?.['com.docker.compose.project'] ?? null,
      service: c.Labels?.['com.docker.compose.service'] ?? null,
      protected: this.protected(c.Id, c.Labels),
    }));
  }
  private async rawInspect(id: string) {
    return this.json(await this.endpoint('/containers/' + containerId(id) + '/json'));
  }
  async inspect(id: string): Promise<ContainerDetail> {
    const c = await this.rawInspect(id);
    return {
      id: c.Id,
      name: c.Name.replace(/^\//, ''),
      image: c.Config.Image,
      state: c.State.Status,
      status: c.State.Status,
      created: Math.floor(Date.parse(c.Created) / 1000),
      ports: Object.entries(c.NetworkSettings?.Ports ?? {}).flatMap(
        ([port, bindings]) =>
          (bindings as Json[] | null)?.map((p) => `${p.HostIp}:${p.HostPort} → ${port}`) ?? [port],
      ),
      project: c.Config.Labels?.['com.docker.compose.project'] ?? null,
      service: c.Config.Labels?.['com.docker.compose.service'] ?? null,
      protected: this.protected(c.Id, c.Config.Labels),
      hostname: c.Config.Hostname,
      restartPolicy: c.HostConfig?.RestartPolicy?.Name ?? 'no',
      startedAt: c.State.StartedAt ?? null,
      finishedAt: c.State.FinishedAt ?? null,
      exitCode: c.State.ExitCode ?? 0,
      health: c.State.Health?.Status ?? null,
      networks: Object.entries(c.NetworkSettings?.Networks ?? {}).map(([name, value]) => ({
        name,
        address: (value as Json).IPAddress ?? '',
      })),
      mounts: (c.Mounts ?? []).map((m: Json) => ({
        type: m.Type,
        source: m.Source,
        destination: m.Destination,
        readonly: !m.RW,
      })),
    };
  }
  async logs(id: string, tail: number) {
    const info = await this.rawInspect(id);
    const bytes = await this.request(
      await this.endpoint(
        '/containers/' +
          containerId(id) +
          '/logs?stdout=1&stderr=1&timestamps=1&follow=0&tail=' +
          tail,
      ),
      'GET',
      512 * 1024,
    );
    let text = '';
    if (info.Config.Tty) text = bytes.toString('utf8');
    else {
      let offset = 0;
      const frames: Buffer[] = [];
      while (offset + 8 <= bytes.length) {
        const length = bytes.readUInt32BE(offset + 4);
        if (
          ![0, 1, 2].includes(bytes[offset]) ||
          bytes[offset + 1] !== 0 ||
          bytes[offset + 2] !== 0 ||
          bytes[offset + 3] !== 0 ||
          offset + 8 + length > bytes.length
        )
          throw new HttpError(502, 'Docker 日志流格式无效');
        frames.push(bytes.subarray(offset + 8, offset + 8 + length));
        offset += 8 + length;
      }
      if (offset !== bytes.length) throw new HttpError(502, 'Docker 日志流未完整返回');
      text = Buffer.concat(frames).toString('utf8');
    }
    // Plain text only: remove terminal control sequences; never render log HTML.
    text = text
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    return { text, truncated: false };
  }
  async stats(id: string): Promise<ContainerStats> {
    const j = await this.json(
      await this.endpoint('/containers/' + containerId(id) + '/stats?stream=false'),
    );
    const cpu = j.cpu_stats ?? {},
      pre = j.precpu_stats ?? {};
    const delta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0),
      system = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
    const memory = j.memory_stats ?? {},
      used = Math.max(
        0,
        (memory.usage ?? 0) -
          (memory.stats?.inactive_file ??
            memory.stats?.total_inactive_file ??
            memory.stats?.cache ??
            0),
      ),
      limit = memory.limit ?? 0;
    const network = Object.values(j.networks ?? {}) as Json[];
    return {
      cpuPercent:
        system > 0 && delta >= 0
          ? (delta / system) * (cpu.online_cpus ?? cpu.cpu_usage?.percpu_usage?.length ?? 1) * 100
          : null,
      memoryBytes: used,
      memoryLimitBytes: limit,
      memoryPercent: limit > 0 ? (used / limit) * 100 : null,
      networkRxBytes: network.reduce((n, v) => n + (v.rx_bytes ?? 0), 0),
      networkTxBytes: network.reduce((n, v) => n + (v.tx_bytes ?? 0), 0),
      sampledAt: new Date().toISOString(),
    };
  }
  async action(
    id: string,
    action: 'start' | 'stop' | 'restart',
    confirmName: string,
    expectedState: string,
  ) {
    if (!this.writeEnabled) throw new HttpError(403, 'Docker 控制未开启');
    if (!['start', 'stop', 'restart'].includes(action))
      throw new HttpError(400, '不支持此容器操作');
    const current = await this.inspect(id);
    if (current.protected) throw new HttpError(403, '不能从管理台停止或重启管理台自身');
    if (current.name !== confirmName) throw new HttpError(400, '请输入完整容器名称确认');
    if (current.state !== expectedState)
      throw new HttpError(409, '容器状态已变化，请刷新后重新确认');
    if (
      (action === 'start' && !['created', 'exited'].includes(current.state)) ||
      (action !== 'start' && current.state !== 'running')
    )
      throw new HttpError(409, '当前状态不支持此操作');
    await this.request(
      await this.endpoint(
        '/containers/' + containerId(id) + '/' + action + (action === 'start' ? '' : '?t=10'),
      ),
      'POST',
    );
  }
}

export function localRuntime(options: {
  dataDirectory: string;
  socket?: string;
  writeEnabled?: boolean;
  containerized: boolean;
  selfId?: string;
}): LocalRuntime {
  const engine = options.socket
    ? new DockerEngine(options.socket, !!options.writeEnabled, options.selfId)
    : null;
  const capabilities: LocalCapabilities = {
    runtime: options.containerized ? 'docker' : 'node',
    docker: !!engine,
    dockerWrite: !!engine && !!options.writeEnabled,
  };
  const required = () => {
    if (!engine) throw new HttpError(503, '未连接 Docker Engine，请按文档显式挂载本机 socket');
    return engine;
  };
  return {
    capabilities,
    async system(): Promise<SystemOverview> {
      let dataDisk: SystemOverview['dataDisk'] = null,
        info: Json | null = null,
        engineError: string | null = null;
      try {
        const s = await fs.statfs(options.dataDirectory);
        dataDisk = {
          totalBytes: s.blocks * s.bsize,
          availableBytes: s.bavail * s.bsize,
          usedBytes: (s.blocks - s.bfree) * s.bsize,
        };
      } catch {}
      if (engine)
        try {
          info = await engine.info();
        } catch (e) {
          engineError = e instanceof HttpError ? e.message : 'Docker 状态读取失败';
        }
      return {
        capabilities,
        runtime: {
          hostname: os.hostname(),
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          cpus: os.availableParallelism(),
          load: os.loadavg(),
          uptime: os.uptime(),
          memoryTotal: os.totalmem(),
          memoryFree: os.freemem(),
          nodeVersion: process.version,
          containerized: options.containerized,
        },
        dataDisk,
        engine: info
          ? {
              name: info.Name,
              version: info.ServerVersion,
              os: info.OperatingSystem,
              arch: info.Architecture,
              kernel: info.KernelVersion,
              cpus: info.NCPU,
              memoryTotal: info.MemTotal,
              containers: info.Containers,
              running: info.ContainersRunning,
              stopped: info.ContainersStopped,
              paused: info.ContainersPaused,
              storageDriver: info.Driver,
            }
          : null,
        engineError,
      };
    },
    containers: () => required().containers(),
    inspect: (id) => required().inspect(id),
    logs: (id, tail) => required().logs(id, tail),
    stats: (id) => required().stats(id),
    action: (id, action, name, state) => required().action(id, action, name, state),
  };
}
