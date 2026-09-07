// scripts/shot.mjs — screenshot one or more routes from the local server, at
// desktop and phone widths. A development aid, not part of the build.
//   node scripts/shot.mjs /  /process/  ...
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/john/strange_rambling_svelte/node_modules/playwright');

const base = process.env.BASE ?? 'http://localhost:5177/projects/local-plan-navigator';
const routes = process.argv.slice(2).length ? process.argv.slice(2) : ['/'];
await mkdir('shots', { recursive: true });
const browser = await chromium.launch();
for (const route of routes) {
  const name = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    const res = await page.goto(base + route, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `shots/${name}-${label}.png`, fullPage: process.env.FULL !== '0' });
    console.log(`${route} ${label}: HTTP ${res?.status()} errors=${errors.length}${errors.length ? ' ' + errors.join(' | ') : ''}`);
    await page.close();
  }
}
await browser.close();
