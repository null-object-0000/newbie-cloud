import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { HttpError } from '../server/types';
import type { Env } from '../server/types';

export function codePluginHost(
  directory: string,
  runner: string,
  enabled: boolean,
): NonNullable<Env['PLUGINS']> {
  let active = 0;
  return {
    codeEnabled: enabled,
    async collect(code, config, hosts) {
      if (!enabled) throw new HttpError(403, '服务器未开启可信代码插件');
      if (active >= 2) throw new HttpError(429, '代码插件正在执行，请稍后重试');
      const digest = createHash('sha256').update(code).digest('hex'),
        folder = path.join(directory, digest),
        filename = path.join(folder, 'plugin.mjs');
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      try {
        fs.writeFileSync(filename, code, { flag: 'wx', mode: 0o400 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      if (createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== digest)
        throw new HttpError(409, '插件文件完整性校验失败');
      active++;
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--permission',
            '--allow-fs-read=' + folder,
            '--max-old-space-size=64',
            path.resolve(runner),
          ],
          { env: { NODE_ENV: 'production' }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
        );
        const chunks: Buffer[] = [];
        let length = 0,
          settled = false;
        const finish = (error?: Error, value?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            child.kill('SIGKILL');
            reject(error);
          } else resolve(value);
        };
        const timer = setTimeout(
          () => finish(new HttpError(504, '插件执行超时，已停止；不会自动重试')),
          15000,
        );
        child.on('error', () => finish(new HttpError(502, '无法启动插件子进程')));
        child.stdout.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 1000000) {
            finish(new HttpError(413, '插件返回内容超过限制'));
            return;
          }
          chunks.push(chunk);
        });
        child.on('close', (code) => {
          if (settled) return;
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (code !== 0 || !result.ok) throw Error();
            finish(undefined, result.items);
          } catch {
            finish(new HttpError(502, '代码插件执行失败，请检查预打包入口和配置'));
          }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify({ filename, config, hosts }));
      }).finally(() => {
        active--;
      });
    },
  };
}
