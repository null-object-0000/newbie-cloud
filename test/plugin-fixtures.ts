import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
export const demoManifest = {
  schemaVersion: 1,
  id: 'demo.inventory',
  name: 'Demo inventory',
  version: '1.0.0',
  description: 'Test resource plugin',
  kind: 'declarative',
  permissions: { network: [] },
  config: [],
  resources: [{ id: 'demo-one', name: 'Demo resource', type: 'demo', status: 'ready' }],
};
export function npmArchive(manifest: unknown, code?: string) {
  const blocks: Buffer[] = [];
  for (const [name, value] of Object.entries({
    'package/newbie-plugin.json': JSON.stringify(manifest),
    ...(code ? { 'package/plugin.mjs': code } : {}),
  })) {
    const body = Buffer.from(value),
      header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(blocks));
  return { archive, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') };
}
