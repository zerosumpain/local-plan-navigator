// scripts/smoke.mjs — every page, in a real browser, plus the tools in use.
//
// For each route in dist/sitemap.json: load it, fail on any console error or
// uncaught exception, check the page has a title, one h1, one main landmark
// and a skip link, and run axe-core, failing on serious or critical
// violations. Then drive the interactive pages: the planner, a checklist, the
// question flow, search, and the Ask page against its mock engine.
//
//   BASE=http://localhost:5177/projects/local-plan-navigator node scripts/smoke.mjs
//
// Playwright is borrowed from the site's install rather than added here: it
// is a 300 MB dependency and this script is the only thing that needs it.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR ?? '/home/john/strange_rambling_svelte/node_modules/playwright');

const base = (process.env.BASE ?? 'http://localhost:5177/projects/local-plan-navigator').replace(/\/$/, '');
const axeSource = await readFile(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const routes = JSON.parse(await readFile(new URL('../dist/sitemap.json', import.meta.url), 'utf8'));
const only = process.env.ONLY ? routes.filter((r) => r.includes(process.env.ONLY)) : routes;

const failures = [];
const note = (ok, what) => { if (!ok) failures.push(what); };
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

let axeViolations = 0, pagesChecked = 0;
for (const route of only) {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const res = await page.goto(base + route, { waitUntil: 'networkidle' });
  note(res?.status() === 200, `${route}: HTTP ${res?.status()}`);
  note(errors.length === 0, `${route}: console errors: ${errors.join(' | ').slice(0, 300)}`);
  const facts = await page.evaluate(() => ({
    title: document.title, h1: document.querySelectorAll('h1').length, main: document.querySelectorAll('main').length,
    skip: !!document.querySelector('a.govuk-skip-link[href="#main-content"]'), lang: document.documentElement.lang,
    banner: !!document.querySelector('.govuk-phase-banner'),
  }));
  note(facts.title.length > 5, `${route}: no title`);
  note(facts.h1 === 1, `${route}: ${facts.h1} h1 elements`);
  note(facts.main === 1, `${route}: ${facts.main} main landmarks`);
  note(facts.skip && facts.banner && facts.lang === 'en', `${route}: missing skip link, phase banner or lang`);
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  });
  const serious = axe.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  axeViolations += serious.length;
  for (const v of serious) failures.push(`${route}: axe ${v.impact} ${v.id} — ${v.help} (${v.nodes} nodes: ${v.targets.join('; ')})`);
  const minor = axe.filter((v) => !(v.impact === 'serious' || v.impact === 'critical'));
  if (minor.length && process.env.VERBOSE) console.log(`  ${route}: minor/moderate: ${minor.map((v) => `${v.id}(${v.nodes})`).join(', ')}`);
  pagesChecked++;
  await page.close();
}
console.log(`pages: ${pagesChecked} checked, ${axeViolations} serious/critical axe violations`);

// --- the tools -----------------------------------------------------------------
async function tool(name, fn) {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  try { await fn(page); note(errors.length === 0, `${name}: console errors: ${errors.join(' | ').slice(0, 300)}`); console.log(`tool ok: ${name}`); }
  catch (e) { failures.push(`${name}: ${String(e).slice(0, 300)}`); }
  await page.close();
}

await tool('planner builds a timetable and flags a broken minimum', async (page) => {
  await page.goto(base + '/planner/', { waitUntil: 'networkidle' });
  await page.fill('#g1-day', '14'); await page.fill('#g1-month', '9'); await page.fill('#g1-year', '2027');
  await page.click('summary:has-text("Adjust the durations")');
  await page.fill('#planWeeks', '7');
  await page.click('button:has-text("Build the timetable")');
  await page.waitForSelector('#planner-output:not([data-example])');
  const h2 = await page.textContent('#planner-output h2');
  if (!h2.includes('14 Sept 2027')) throw new Error('heading did not show the entered date: ' + h2);
  const fails = await page.locator('.lpn-check--fail').count();
  if (fails !== 1) throw new Error(`expected 1 failed check, got ${fails}`);
  const rows = await page.locator('#planner-output tbody tr').count();
  if (rows < 20) throw new Error(`only ${rows} milestone rows`);
  if (!(await page.locator('#planner-output svg.lpn-gantt').count())) throw new Error('no chart');
  await page.fill('#g1-day', '31'); await page.fill('#g1-month', '2');
  await page.click('button:has-text("Build the timetable")');
  await page.waitForSelector('.govuk-error-summary');
});

await tool('checklist ticks persist across a reload', async (page) => {
  await page.goto(base + '/checklists/gateway-1-readiness/', { waitUntil: 'networkidle' });
  await page.check('#g1-tt-published'); await page.check('#g1-pass-summary');
  const text = await page.textContent('[data-progress]');
  if (!text.startsWith('2 of')) throw new Error('progress text wrong: ' + text);
  await page.reload({ waitUntil: 'networkidle' });
  if (!(await page.isChecked('#g1-tt-published'))) throw new Error('tick lost on reload');
  page.once('dialog', (d) => d.accept());
  await page.click('button:has-text("Clear my ticks")');
  if (await page.isChecked('#g1-tt-published')) throw new Error('reset did not clear');
});

await tool('question flow reaches a result and rejects no answer', async (page) => {
  await page.goto(base + '/where-am-i/system/', { waitUntil: 'networkidle' });
  await page.click('button:has-text("Continue")');
  await page.waitForSelector('.govuk-error-summary');
  await page.check('input[value="new"]'); await page.click('button:has-text("Continue")');
  await page.waitForURL('**/where-am-i/gateway1/');
  await page.check('input[value="yes"]'); await page.click('button:has-text("Continue")');
  await page.waitForURL('**/where-am-i/submitted/');
  await page.check('input[value="no"]'); await page.click('button:has-text("Continue")');
  await page.waitForURL('**/where-am-i/consultations/');
  await page.check('input[value="content"]'); await page.click('button:has-text("Continue")');
  await page.waitForURL('**/where-am-i/gateway2/');
  await page.check('input[value="no"]'); await page.click('button:has-text("Continue")');
  await page.waitForURL('**/where-am-i/result/gateway-2-next/');
  const h1 = await page.textContent('h1');
  if (!h1.includes('Gateway 2')) throw new Error('unexpected result page: ' + h1);
});

await tool('search finds regulation 32 for "prescribed requirements"', async (page) => {
  await page.goto(base + '/search/?q=prescribed+requirements', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.lpn-result').length > 0, null, { timeout: 20000 });
  const first = await page.locator('.lpn-result').first().textContent();
  if (!/32|prescribed/i.test(first)) throw new Error('first result unexpected: ' + first.slice(0, 120));
  const status = await page.textContent('#search-status');
  if (!/result/.test(status)) throw new Error('status wrong: ' + status);
});

await tool('ask page retrieves passages and streams a mock answer with citations', async (page) => {
  await page.goto(base + '/ask/?engine=mock', { waitUntil: 'networkidle' });
  await page.fill('#question', 'How long is the consultation on the proposed local plan?');
  await page.click('button:has-text("Find the guidance")');
  await page.waitForFunction(() => document.querySelectorAll('#ask-passages .lpn-result').length > 0, null, { timeout: 20000 });
  const n = await page.locator('#ask-passages .lpn-result').count();
  if (n < 3) throw new Error(`only ${n} passages`);
  await page.click('button:has-text("Download and start the model")');
  await page.waitForFunction(() => document.querySelector('#ask-answer .lpn-answer[aria-busy="false"]'), null, { timeout: 20000 });
  const links = await page.locator('#answer-text a[href^="#passage-"]').count();
  if (links < 2) throw new Error(`answer has ${links} citation links`);
  const status = await page.textContent('#ask-status');
  if (!/tokens/.test(status)) throw new Error('status did not report tokens: ' + status);
});

await tool('reference anchors resolve and highlight', async (page) => {
  await page.goto(base + '/reference/regulations-2026/part-4/#reg-32', { waitUntil: 'networkidle' });
  const text = await page.textContent('#reg-32');
  if (!text.includes('prescribed requirements')) throw new Error('reg-32 section not found');
  await page.goto(base + '/reference/nppf/2-plan-making-policies/#PM15', { waitUntil: 'networkidle' });
  const pm15 = await page.textContent('#PM15');
  if (!pm15.includes('Examining local plans')) throw new Error('PM15 anchor not found');
});

await browser.close();
if (failures.length) { console.log(`\n${failures.length} FAILURES:`); for (const f of failures) console.log('  ✗ ' + f); process.exit(1); }
console.log('smoke: all good');
