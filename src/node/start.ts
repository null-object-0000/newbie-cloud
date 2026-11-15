import fs from 'node:fs';
import { createNodeRuntime } from './runtime';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT 无效');
const runtime = createNodeRuntime({
  port,
  dataDirectory: process.env.DATA_DIR ?? './data',
  assetsDirectory: process.env.ASSETS_DIR ?? './dist',
  migrationsDirectory: process.env.MIGRATIONS_DIR ?? './migrations',
  publicOrigin: process.env.PUBLIC_ORIGIN || undefined,
  keys: { ADMIN_TOKEN: process.env.ADMIN_TOKEN, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY },
  githubToken: process.env.GITHUB_TOKEN,
  socket: process.env.DOCKER_SOCKET || undefined,
  writeEnabled: process.env.DOCKER_WRITE_ENABLED === 'true',
  containerized: process.env.CONTAINER === 'true' || fs.existsSync('/.dockerenv'),
});
let checking = false;
const timer = setInterval(
  async () => {
    if (checking) return;
    checking = true;
    try {
      await runtime.app.scheduled({} as ScheduledEvent, runtime.env);
    } catch {
      console.error('定时巡检未完成，请查看操作记录');
    } finally {
      checking = false;
    }
  },
  15 * 60 * 1000,
);
timer.unref();
runtime.server.listen(port, '0.0.0.0', () =>
  console.log(
    `Newbie Cloud listening on port ${port}. Login key is stored in the data volume: admin-token.txt`,
  ),
);
const shutdown = () => {
  clearInterval(timer);
  void runtime.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
