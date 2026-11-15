import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2),
  get = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'));
const existing = fs.existsSync('wrangler.local.jsonc')
  ? JSON.parse(fs.readFileSync('wrangler.local.jsonc', 'utf8'))
  : null;
const databaseId =
  get('--database-id') ?? process.env.D1_DATABASE_ID ?? existing?.d1_databases[0].database_id;
const accountId = get('--account-id') ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? existing?.account_id;
if (databaseId) {
  if (!/^[a-f0-9-]{36}$/i.test(databaseId)) throw Error('Invalid D1 database ID');
  config.d1_databases[0].database_id = databaseId;
}
if (accountId) {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw Error('Invalid Cloudflare account ID');
  config.account_id = accountId;
}
fs.writeFileSync('wrangler.local.jsonc', JSON.stringify(config, null, 2) + '\n');
if (!args.includes('--config-only')) {
  fs.mkdirSync('.local', { recursive: true });
  if (!fs.existsSync('.local/secrets.json')) {
    if (fs.existsSync('.dev.vars'))
      throw Error(
        'Existing .dev.vars found without .local/secrets.json; back up and reconcile your existing keys before setup.',
      );
    const secrets = {
      ADMIN_TOKEN: randomBytes(32).toString('base64url'),
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    };
    fs.writeFileSync('.local/secrets.json', JSON.stringify(secrets, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    fs.writeFileSync('.local/admin-token.txt', secrets.ADMIN_TOKEN + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    fs.writeFileSync(
      '.dev.vars',
      Object.entries(secrets)
        .map(([k, v]) => k + '=' + v)
        .join('\n') + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    console.log('Generated private local keys. Login key: .local/admin-token.txt (not printed).');
  }
  if (args.includes('--publish-secrets')) {
    if (config.d1_databases[0].database_id.startsWith('00000000-'))
      throw Error('Configure your real D1 database before publishing.');
    const secrets = JSON.parse(fs.readFileSync('.local/secrets.json', 'utf8'));
    for (const name of ['ADMIN_TOKEN', 'ENCRYPTION_KEY']) {
      const result = spawnSync(
        process.execPath,
        [
          'node_modules/wrangler/bin/wrangler.js',
          'secret',
          'put',
          name,
          '--config',
          'wrangler.local.jsonc',
        ],
        { input: secrets[name] + '\n', encoding: 'utf8' },
      );
      if (result.status !== 0) throw Error(result.stderr || result.stdout);
      console.log('Published secret: ' + name);
    }
  }
}
console.log(
  'Local Wrangler config ready. Production credentials and account-specific config are gitignored.',
);
