// scripts/eval-retrieval.mjs — does the index find the right passage?
//
// A handful of questions an officer might ask, each with the anchor a good
// answer must include in its top six. Run after changing the index settings
// in src/client/retrieval.ts; the same settings are mirrored here so the
// numbers mean something.
//   node scripts/eval-retrieval.mjs
import { readFile } from 'node:fs/promises';
import MiniSearch from 'minisearch';
import { INDEX_OPTIONS, SEARCH_OPTIONS, topUp } from '../src/client/retrieval.ts';

const corpus = JSON.parse(await readFile(new URL('../dist/data/corpus.json', import.meta.url), 'utf8'));
// Each case lists the passages that would answer it; any one in the top six counts.
const CASES = [
  ['What are the prescribed requirements the Gateway 3 assessor checks?', ['regulations-2026#reg-32']],
  ['How long must the consultation on the proposed local plan last?', ['regulations-2026#reg-27', 'engaging-the-public#consult-on-the-proposed-local-plan', '30-month-overview#consult-on-the-proposed-local-plan']],
  ['Can the examination be paused, and for how long?', ['regulations-2026#reg-36', 'procedural-guide#9-examination-pauses']],
  ['How much notice must we give before starting to prepare the plan?', ['regulations-2026#reg-21', '30-month-overview#give-at-least-4-months-notice-of-plan-making', 'giving-notice#when-to-give-notice']],
  ['What must the environmental report contain?', ['sea-regulations-2004#schedule-2', 'sea-regulations-2004#reg-12']],
  ['When must the policies map be published after adoption?', ['regulations-2026#reg-85', '30-month-overview#month-30-to-31-adopt-plan-and-publish-policies-map']],
  ['What are the tests of soundness?', ['nppf#PM15']],
  ['What documents do we send at Gateway 3?', ['regulations-2026#reg-17', 'gateway-3#how-to-pass-through-gateway-3', 'regulations-2026#reg-31']],
  ['How does the standard method calculate housing need?', ['nppf#annex-d']],
  ['What goes in the adoption statement?', ['regulations-2026#reg-39']],
  ['Who are the specific consultation bodies?', ['regulations-2026#reg-2', 'regulations-2026#reg-20']],
  ['How long does the Gateway 2 assessment take and what happens in the workshop?', ['procedural-guide#3-5-the-gateway-2-process', 'procedural-guide#gateway-2-process-overview', 'gateway-2#what-happens-during-the-assessment']],
  ['What should the Gateway 1 self-assessment summary cover?', ['regulations-2026#reg-21', 'gateway-1#writing-your-self-assessment-summary', 'gateway-1#getting-ready-for-gateway-1-and-the-30-month-process']],
  ['When do we have to start preparing the next local plan?', ['regulations-2026#reg-18', '30-month-overview#when-to-start-preparing-your-new-plan']],
  ['Do we have to reconsult before Gateway 3 if we change the plan after the consultation?', ['30-month-overview#after-the-consultation', 'gateway-3#if-you-fail-to-pass-gateway-3', 'procedural-guide#3-10-preparation-for-gateway-3']],
  ['How long is the main modifications consultation?', ['procedural-guide#8-main-modifications-to-the-plan']],
];
const index = new MiniSearch(INDEX_OPTIONS);
index.addAll(corpus.chunks);
let hit = 0;
for (const [q, want] of CASES) {
  const hits = topUp(index, q, { ...SEARCH_OPTIONS }, 6, true);
  const ids = hits.map((h) => `${h.doc}#${h.anchor}`);
  const rank = ids.findIndex((id) => want.includes(id));
  if (rank >= 0) hit++;
  console.log(`${rank >= 0 ? `✓ #${rank + 1}` : '✗   '}  ${q}${rank < 0 ? `\n       want one of ${want.join(', ')}; got ${ids.slice(0, 4).join(', ')}` : ''}`);
}
console.log(`\n${hit}/${CASES.length} questions have the right passage in the top 6`);
