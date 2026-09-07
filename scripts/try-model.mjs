// scripts/try-model.mjs — run the Ask page's prompt through a real model in Node.
//
// Retrieval and prompt-building are the same code the page uses; the model
// runs on the CPU through transformers.js's Node backend. It answers whether a
// small model, given the passages the index finds, writes something grounded
// and cited — before anyone downloads it in a browser.
//   node scripts/try-model.mjs "your question"   (defaults to three sample questions)
import { readFile } from 'node:fs/promises';
import MiniSearch from 'minisearch';
import { pipeline, TextStreamer } from '@huggingface/transformers';
import { buildMessages, fitPassages } from '../src/client/engines/prompt.ts';

const modelId = process.env.MODEL ?? 'HuggingFaceTB/SmolLM2-360M-Instruct';
const corpus = JSON.parse(await readFile(new URL('../dist/data/corpus.json', import.meta.url), 'utf8'));
const index = new MiniSearch({ fields: ['text', 'heading'], storeFields: ['doc', 'docTitle', 'anchor', 'route', 'heading', 'text'], searchOptions: { boost: { heading: 2 }, prefix: true, fuzzy: 0.15, combineWith: 'AND' } });
index.addAll(corpus.chunks);
const questions = process.argv.slice(2).length ? process.argv.slice(2) : [
  'How long must the consultation on the proposed local plan last, and what must we publish afterwards?',
  'What are the prescribed requirements the Gateway 3 assessor checks?',
  'Can the examination be paused, and for how long?',
];
console.log(`loading ${modelId}…`);
const t0 = Date.now();
const generator = await pipeline('text-generation', modelId, { dtype: 'q4', progress_callback: (p) => { if (p.status === 'ready') console.log('ready'); } });
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const q of questions) {
  let hits = index.search(q);
  if (hits.length < 6) { const seen = new Set(hits.map((h) => h.id)); for (const h of index.search(q, { combineWith: 'OR' })) { if (!seen.has(h.id)) { hits.push(h); seen.add(h.id); } if (hits.length >= 6) break; } }
  hits = hits.slice(0, 6);
  const passages = fitPassages(hits.map((h, i) => ({ n: i + 1, source: h.docTitle, heading: h.heading, text: h.text })));
  console.log('\n=== ' + q);
  passages.forEach((p) => console.log(`  [${p.n}] ${p.source} › ${p.heading} (${p.text.length} chars)`));
  const messages = buildMessages(q, passages);
  const t1 = Date.now(); let n = 0; let out = '';
  const streamer = new TextStreamer(generator.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: (t) => { n++; out += t; } });
  await generator(messages, { max_new_tokens: 220, do_sample: false, repetition_penalty: 1.1, streamer });
  console.log(`--- answer (${n} tokens, ${((Date.now() - t1) / 1000).toFixed(1)}s):\n${out.trim()}`);
}
