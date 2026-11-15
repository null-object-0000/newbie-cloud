import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Reuse the existing vector mark; no external fonts or image services required.
const svg = await fs.readFile('public/favicon.svg', 'utf8');
const cloud = svg.match(/<path\b[^>]*\/>/)?.[0];
if (!cloud) throw new Error('Missing cloud mark in favicon.svg');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}),
});
try {
  await fs.mkdir('public/icons', { recursive: true });
  for (const [name, size, scale] of [
    ['icon-192', 192, 1],
    ['icon-512', 512, 1],
    ['maskable-512', 512, 0.78],
    ['apple-touch-icon', 180, 1],
  ]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>html,body{margin:0}svg{display:block;width:100%;height:100%}</style><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#1b57df"/><g transform="translate(20 20) scale(${scale}) translate(-20 -20)">${cloud}</g></svg>`,
    );
    await page.screenshot({ path: `public/icons/${name}.png` });
    await page.close();
  }
} finally {
  await browser.close();
}
