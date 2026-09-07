// scripts/try-browser-model.mjs — the WebAssembly engine, for real, in a browser.
//
// Opens the Ask page in headless Chromium, picks the SmolLM2 model, clicks
// "Download and start", waits for it to load (a 250 MB download the first
// time), asks a question and waits for the streamed answer. Logs which ONNX
// runtime files were fetched and any console errors. Slow (minutes); not part
// of `npm test`, run by hand when the engine or its dependencies change.
//   BASE=http://localhost:5177/projects/local-plan-navigator node scripts/try-browser-model.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR ?? '/home/john/strange_rambling_svelte/node_modules/playwright');

const base = (process.env.BASE ?? 'http://localhost:5177/projects/local-plan-navigator').replace(/\/$/, '');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = []; const ortRequests = new Set(); let hfBytes = 0;
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', async (r) => {
  const u = r.url();
  if (u.includes('/assets/ort/')) ortRequests.add(`${r.status()} ${u.split('/assets/')[1]}`);
  if (u.includes('huggingface.co') || u.includes('hf.co')) { const len = Number(r.headers()['content-length'] ?? 0); hfBytes += len; }
});
const t0 = Date.now();
await page.goto(base + '/ask/', { waitUntil: 'networkidle' });
console.log('support:', await page.textContent('#model-support'));
await page.check('input[name="mode"][value="local"]');
await page.check('input[name="model"][value="HuggingFaceTB/SmolLM2-360M-Instruct"]');
await page.click('button:has-text("Download and start the model")');
await page.waitForFunction(() => /Model ready/.test(document.querySelector('#model-progress-text')?.textContent ?? ''), null, { timeout: 15 * 60 * 1000 });
console.log(`model ready after ${((Date.now() - t0) / 1000).toFixed(0)}s; ${(hfBytes / 1e6).toFixed(0)} MB from Hugging Face; ort files: ${[...ortRequests].join(', ') || 'none'}`);
await page.fill('#question', 'How long must the consultation on the proposed local plan last, and what must we publish afterwards?');
await page.click('button:has-text("Find the guidance")');
const t1 = Date.now();
await page.waitForFunction(() => document.querySelector('#ask-answer .lpn-answer[aria-busy="false"]'), null, { timeout: 15 * 60 * 1000 });
console.log(`answer in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
console.log('status:', await page.textContent('#ask-status'));
console.log('answer:', (await page.textContent('#answer-text')).trim());
console.log('errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
