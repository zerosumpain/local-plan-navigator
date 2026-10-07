// scripts/check-plan.mjs — run the plan checker from the command line, on the local Codex bridge.
//
//   node scripts/check-plan.mjs <plan.docx|.pptx|.md|.txt> [--runs 2] [--out dir]
//                               [--bridge http://127.0.0.1:5207] [--model gpt-6-luna]
//
// For development and for measuring consistency. It reads the rubric and the
// corpus the build wrote (run `npm run build` first), checks the plan with a
// `complete` on the bridge, prints the progress, the summary and the number
// and duration of model calls, and writes each report to --out (default
// .cache/checks/). With --runs 2 or more it checks the same file again and
// reports how many statuses differed between the runs, item by item and
// allocation or policy by allocation or policy.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { codexComplete } from '../server/codex-complete.mjs';
import { runCheck } from '../server/checker/pipeline.mjs';
import { readDocument } from '../server/checker/read-document.mjs';
import { loadCorpusFile, loadRubric } from '../server/checker/rubric.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) { console.error('Usage: node scripts/check-plan.mjs <plan file> [--runs 2] [--out dir]'); process.exit(2); }
const runs = Number(opt('runs', 1));
const outDir = path.resolve(opt('out', path.join(root, '.cache/checks')));
const dist = path.join(root, 'dist');

const bridge = codexComplete({ bridgeUrl: opt('bridge', process.env.CODEX_BRIDGE_URL ?? 'http://127.0.0.1:5207'), model: opt('model', process.env.LOCAL_PLAN_NAVIGATOR_MODEL ?? 'gpt-6-luna') });
const [rubric, corpus] = await Promise.all([loadRubric(dist), loadCorpusFile(dist)]);
const doc = readDocument({ name: path.basename(file), bytes: await readFile(file) });
console.log(`${doc.name}: ${doc.type}, ${doc.sections.length} sections, ${doc.words} words`);
await mkdir(outDir, { recursive: true });

const reports = [];
for (let n = 1; n <= runs; n++) {
  const calls = [];
  const replies = [];
  const complete = async (req) => {
    const t = Date.now();
    try { const reply = await bridge(req); replies.push({ prompt: req.user.slice(0, 300), reply }); return reply; } finally { calls.push(Date.now() - t); }
  };
  const t0 = Date.now();
  const report = await runCheck({ document: doc, rubric, corpus, complete, onProgress: (p) => console.log(`  [run ${n}] ${p.step}/${p.total ?? '?'} ${p.message}`) });
  const out = path.join(outDir, `${path.basename(file).replace(/\.[^.]+$/, '')}.run${n}.json`);
  await writeFile(out, JSON.stringify(report, null, 2));
  // The raw replies, for tuning prompts (they never leave this machine).
  await writeFile(out.replace(/\.json$/, '.replies.json'), JSON.stringify(replies, null, 2));
  const c = report.summary.counts;
  console.log(`run ${n}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${report.run.modelCalls} model calls (${report.run.retries} retries, ${report.run.unanswered} unanswered), slowest call ${(Math.max(...calls) / 1000).toFixed(1)}s`);
  console.log(`  met ${c.met}, partly ${c.partly}, not met ${c.missing}, cannot assess ${c['not-assessable']} — ${out}`);
  if (report.run.answerProblems.length) console.log(`  answers that needed a retry or failed: ${report.run.answerProblems.join(' | ')}`);
  for (const s of report.summary.sections) console.log(`  ${s.letter} ${s.title.padEnd(48)} ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  reports.push(report);
}

/** Every status in a report, keyed by item and by item/instance. */
function statuses(report) {
  const out = new Map();
  for (const s of report.sections) for (const i of s.items) {
    out.set(i.id, i.status);
    for (const x of i.instances ?? []) out.set(`${i.id}/${x.id}`, x.status);
  }
  return out;
}
if (reports.length > 1) {
  const [a, ...rest] = reports.map(statuses);
  for (const [k, b] of rest.entries()) {
    const sameShape = JSON.stringify([...a.keys()]) === JSON.stringify([...b.keys()]);
    const diffs = [...a.keys()].filter((key) => a.get(key) !== b.get(key));
    const items = diffs.filter((d) => !d.includes('/'));
    console.log(`\nrun 1 vs run ${k + 2}: same structure ${sameShape ? 'yes' : 'NO'}; ${diffs.length} of ${a.size} statuses differ (${items.length} of ${[...a.keys()].filter((x) => !x.includes('/')).length} item statuses)`);
    for (const d of diffs) console.log(`  ${d}: ${a.get(d)} -> ${b.get(d)}`);
  }
}
