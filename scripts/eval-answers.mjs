// scripts/eval-answers.mjs — are the Ask page's answers grounded?
//
// eval-retrieval.mjs checks that the right passages are found. This checks
// what a model then writes from them, end to end, the way the website does
// it: the question goes through the page's retrieval (src/client/retrieval.ts),
// the passages it finds go into the server's prompt (SYSTEM_PROMPT and
// answerPrompt in server/ask.mjs), and the prompt goes to an OpenAI-compatible
// chat completions endpoint. Each answer is then checked:
//
//   every sentence cites   every sentence carries a [n] citation (a one-line
//                          "this is not legal advice", and a short opener such
//                          as "No." or "Usually not.", are allowed without one)
//   nothing left uncited   the looser test: every sentence is followed by a
//                          citation somewhere later in its paragraph, so an
//                          answer that cites once per paragraph passes this
//                          but not the one above
//   citations exist        every [n] is a passage the model was given
//   expected sources       at least one citation is a passage from a source a
//                          good answer has to use
//   declines               a question the guidance does not cover, or that is
//                          not about plan-making, is declined, not answered
//
// The endpoint, model and key come from the environment, so the same run can
// point at another provider (an AI gateway, say):
//
//   LPN_EVAL_BASE_URL   default http://127.0.0.1:5207/v1 (the local Codex bridge);
//                       ".../chat/completions" is added unless it is already there
//   LPN_EVAL_MODEL      default gpt-6-luna
//   LPN_EVAL_API_KEY    default codex-bridge-local, sent as a bearer token
//   LPN_EVAL_SYSTEM_PROMPT_FILE
//                       optional: a file whose text replaces the server's
//                       SYSTEM_PROMPT, to measure a prompt change before
//                       making it in server/ask.mjs
//
//   npm run build && npm run eval:answers
//   npm run eval:answers -- 2 7                  # only questions 2 and 7
//   npm run eval:answers -- --save answers.json  # keep the answers
//   npm run eval:answers -- --from answers.json  # re-check them, no model calls
//
// One request per question, no retries, short answers: a full run is eight
// calls. The exit code is 1 if any check fails.
import { readFile, writeFile } from 'node:fs/promises';
import MiniSearch from 'minisearch';
import { INDEX_OPTIONS, SEARCH_OPTIONS, topUp } from '../src/client/retrieval.ts';
import { SYSTEM_PROMPT, answerPrompt, pickChunks } from '../server/ask.mjs';

const BASE = (process.env.LPN_EVAL_BASE_URL ?? 'http://127.0.0.1:5207/v1').replace(/\/$/, '');
const ENDPOINT = /\/chat\/completions$/.test(BASE) ? BASE : `${BASE}/chat/completions`;
const MODEL = process.env.LPN_EVAL_MODEL ?? 'gpt-6-luna';
const KEY = process.env.LPN_EVAL_API_KEY ?? 'codex-bridge-local';
const PROMPT_FILE = process.env.LPN_EVAL_SYSTEM_PROMPT_FILE;
const SYSTEM = PROMPT_FILE ? (await readFile(PROMPT_FILE, 'utf8')).trim() : SYSTEM_PROMPT;

// `expect` lists sources ("doc") or passages ("doc#anchor"); citing any one
// of them is enough. A question with `decline` must be declined.
const QUESTIONS = [
  { q: 'What should each site allocation in a local plan include?', expect: ['nppf#fn-8'] },
  { q: 'What information should we ask for in a call for sites?', expect: ['site-selection-stage-1'] },
  { q: 'Can we rule out sites in Flood Zone 3 at the start of the site assessment?', expect: ['site-selection-stage-2'] },
  { q: 'Do we have to test the viability of every site we allocate?', expect: ['ppg-viability'] },
  { q: 'Will the examination hearings discuss sites that we decided not to allocate?', expect: ['procedural-guide#7-4-procedure-at-the-hearing-sessions'] },
  { q: 'When must we publish our housing requirement data?', expect: ['planning-data-regulations-2026', 'housing-requirement-data', 'publish-plan-data'] },
  { q: 'What Community Infrastructure Levy rate per square metre should we charge on new homes?', decline: 'not covered' },
  { q: 'What is the best way to cook a Sunday roast?', decline: 'off-topic' },
];

// --- the checks -------------------------------------------------------------

// Full stops that do not end a sentence: "e.g.", and "s. 15C", "reg. 32",
// "para. 3" before a number. "No." on its own is an answer, not "No. 5".
const ABBREVIATIONS = /\b(?:e\.g|i\.e|cf|approx)\.|\b(?:para|paras|reg|regs|s|ss|no|nos|art|sch|ch)\.(?=\s*\d)/gi;

/** Split an answer into paragraphs of sentences, keeping a citation that follows a full stop with its sentence. */
export function paragraphs(answer) {
  const text = answer
    .replace(/\*\*|__|`/g, '')
    .replace(ABBREVIATIONS, (m) => m.replace(/\./g, '․')) // one-dot leader: not a sentence end
    .replace(/(\d)\.(\d)/g, '$1․$2');
  return text.split(/\n+/).map((para) => para
    .split(/(?<=[.!?](?:\s*\[\d+\])*)\s+(?=[A-Z“"‘(])/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+\.)\s+/, '').trim())
    .filter((s) => /[A-Za-z]{2}/.test(s))).filter((p) => p.length);
}
export const sentences = (answer) => paragraphs(answer).flat();

const cites = (s) => /\[\d+\]/.test(s);
// A sentence that needs no citation of its own: the legal advice caveat, or
// a short opener that the next sentence explains ("No.", "Usually not.").
const exempt = (s) => /legal advice/i.test(s) || s.split(/\s+/).length < 4;

export const citationsIn = (text) => [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));

const DECLINE = /\b(do(?:es)? not (?:answer|cover|say|set|give|include|contain|address|provide|mention|specify)|don['’]t|doesn['’]t|cannot|can['’]t|unable|not able|not covered|outside (?:\w+ )?scope|only help|not about|no information|nothing in the|isn['’]t covered|not something)\b/i;

export function checkAnswer(item, answer, passages) {
  const cited = citationsIn(answer);
  const checks = [];
  checks.push({ name: 'citations exist', ok: cited.every((n) => n >= 1 && n <= passages.length), detail: cited.filter((n) => n < 1 || n > passages.length).map((n) => `[${n}]`).join(' ') || '' });
  if (item.decline) {
    checks.push({ name: `declines (${item.decline})`, ok: DECLINE.test(answer), detail: '' });
    return checks;
  }
  const paras = paragraphs(answer);
  const bare = paras.flat().filter((s) => !cites(s) && !exempt(s));
  checks.push({ name: 'every sentence cites', ok: bare.length === 0, detail: bare.map((s) => `"${s.slice(0, 90)}"`).join('; ') });
  const orphans = paras.flatMap((p) => p.filter((s, i) => !cites(s) && !exempt(s) && !p.slice(i + 1).some(cites)));
  checks.push({ name: 'nothing left uncited', ok: orphans.length === 0, detail: orphans.map((s) => `"${s.slice(0, 90)}"`).join('; ') });
  const citedIds = [...new Set(cited)].map((n) => passages[n - 1]?.id).filter(Boolean);
  const hit = citedIds.some((id) => item.expect.some((e) => (e.includes('#') ? id === e || id.startsWith(`${e}:`) : id.startsWith(`${e}#`))));
  checks.push({ name: 'expected sources cited', ok: hit, detail: hit ? '' : `cited ${citedIds.join(', ') || 'nothing'}; wanted ${item.expect.join(' or ')}` });
  checks.push({ name: 'not a refusal', ok: !(DECLINE.test(answer) && cited.length === 0), detail: '' });
  return checks;
}

// --- the run ----------------------------------------------------------------

async function ask(question, chunks) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    // As the server sends it, but not streamed, and shorter.
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: answerPrompt(question, chunks) }], temperature: 0.3, max_tokens: 600, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`${ENDPOINT}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return String(body.choices?.[0]?.message?.content ?? '').trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const savePath = option('--save');
  const fromPath = option('--from');
  const only = args.map(Number).filter(Boolean);
  const corpus = JSON.parse(await readFile(new URL('../dist/data/corpus.json', import.meta.url), 'utf8'));
  const byId = new Map(corpus.chunks.map((c) => [c.id, c]));
  const index = new MiniSearch(INDEX_OPTIONS);
  index.addAll(corpus.chunks);
  const earlier = fromPath ? JSON.parse(await readFile(fromPath, 'utf8')) : null;

  console.log(earlier ? `Answer evaluation: re-checking ${fromPath} (${earlier.model}, ${earlier.date})\n` : `Answer evaluation: ${MODEL} at ${ENDPOINT}${PROMPT_FILE ? `, system prompt from ${PROMPT_FILE}` : ''}\n`);
  const saved = { model: MODEL, endpoint: ENDPOINT, systemPrompt: PROMPT_FILE ?? 'server/ask.mjs', date: new Date().toISOString(), answers: [] };
  const tally = {};
  let passed = 0, failed = 0, run = 0;
  for (const [i, item] of QUESTIONS.entries()) {
    if (only.length && !only.includes(i + 1)) continue;
    const before = earlier?.answers.find((a) => a.q === item.q);
    if (earlier && !before) continue;
    run++;
    // The page's retrieval: six passages, one per section.
    const ids = before?.ids ?? topUp(index, item.q, { ...SEARCH_OPTIONS }, 6, true).map((h) => h.id);
    const passages = pickChunks(ids, byId);
    console.log(`${i + 1}. ${item.q}`);
    console.log(`   passages: ${passages.map((p, n) => `[${n + 1}] ${p.id}`).join('  ')}`);
    let answer = before?.answer;
    if (answer == null) {
      try { answer = await ask(item.q, passages); }
      catch (err) { console.log(`   ✗ no answer: ${err.message}\n`); failed++; continue; }
    }
    saved.answers.push({ q: item.q, ids, answer });
    console.log(`   answer: ${answer.replace(/\s+/g, ' ')}`);
    const checks = checkAnswer(item, answer, passages);
    for (const c of checks) {
      console.log(`   ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      tally[c.name] ??= [0, 0];
      tally[c.name][0] += c.ok ? 1 : 0;
      tally[c.name][1]++;
    }
    if (checks.every((c) => c.ok)) passed++; else failed++;
    console.log('');
  }
  for (const [name, [ok, of]] of Object.entries(tally)) console.log(`${String(ok).padStart(3)}/${of}  ${name}`);
  console.log(`\n${passed}/${run} answers pass every check`);
  if (savePath && !earlier) {
    await writeFile(savePath, JSON.stringify(saved, null, 2) + '\n');
    console.log(`answers saved to ${savePath}`);
  }
  process.exit(failed ? 1 : 0);
}
