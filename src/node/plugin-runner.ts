import { pathToFileURL } from 'node:url';
// This is a separate process, with a minimal environment and Node's permission
// seat belt. It is NOT a sandbox for hostile code; install only trusted plugins.
const chunks: Buffer[] = [];
let length = 0;
for await (const chunk of process.stdin) {
  length += chunk.length;
  if (length > 64000) process.exit(1);
  chunks.push(Buffer.from(chunk));
}
try {
  const { filename, config, hosts } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const fetchNetwork = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? String(input) : input.url,
    );
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !hosts.includes(url.hostname)
    )
      throw Error('Network declaration does not include this host');
    return fetchNetwork(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  };
  console.log = console.info = console.warn = console.error = () => {};
  const module = await import(pathToFileURL(filename).href),
    plugin = module.default;
  if (typeof plugin?.collect !== 'function') throw Error('Plugin must export collect');
  const items = await plugin.collect(
    Object.freeze({ config: Object.freeze(config), fetch: globalThis.fetch }),
  );
  process.stdout.write(JSON.stringify({ ok: true, items }), () => process.exit(0));
} catch {
  process.stdout.write('{"ok":false}', () => process.exit(1));
}
