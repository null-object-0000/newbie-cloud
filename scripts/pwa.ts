import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function generatePwa(directory: string, templatePath = 'src/service-worker.js') {
  const files = (await readdir(directory, { recursive: true }))
    .map(String)
    .map((name) => name.replaceAll('\\', '/'))
    .filter(
      (name) =>
        ['index.html', 'theme-init.js', 'manifest.webmanifest', 'favicon.svg'].includes(name) ||
        /^assets\/[^/]+\.(js|css)$/.test(name) ||
        /^icons\/[^/]+\.png$/.test(name),
    )
    .sort();
  if (!files.includes('index.html') || !files.includes('manifest.webmanifest'))
    throw new Error('PWA build requires the application shell and manifest');
  const hash = createHash('sha256');
  const template = await readFile(templatePath, 'utf8');
  hash.update(template);
  for (const name of files) {
    hash.update(name);
    hash.update(await readFile(path.join(directory, name)));
  }
  const version = hash.digest('hex').slice(0, 20);
  const urls = files.map((name) => '/' + name);
  await writeFile(
    path.join(directory, 'sw.js'),
    template
      .replace('__BUILD_VERSION__', JSON.stringify(version))
      .replace('__PRECACHE_URLS__', JSON.stringify(urls)),
  );
  return { version, urls };
}
