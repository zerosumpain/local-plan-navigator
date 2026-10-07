import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_QUESTION_CHARS = 600;
const MAX_PASSAGES = 6;
const MAX_PASSAGE_CHARS = 1500;
let corpusCache;

export function parseAskBody(body) {
  const value = body && typeof body === 'object' ? body : {};
  const question = String(value.question ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS);
  const ids = [];
  for (const id of Array.isArray(value.ids) ? value.ids : []) {
    if (typeof id !== 'string' || id.length > 160 || !/^[a-z0-9-]+#[A-Za-z0-9._:-]+$/.test(id)) continue;
    if (!ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_PASSAGES) break;
  }
  return { question, ids };
}

export async function loadCorpus(distDir) {
  const path = join(distDir, 'data/corpus.json');
  const { mtimeMs } = await stat(path);
  if (corpusCache?.path === path && corpusCache.mtimeMs === mtimeMs) return corpusCache.byId;
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const byId = new Map(parsed.chunks.map((chunk) => [chunk.id, chunk]));
  corpusCache = { path, mtimeMs, byId };
  return byId;
}

export function pickChunks(ids, byId, siteOrigin = 'https://strangeramblings.com') {
  return ids.map((id) => byId.get(id)).filter(Boolean).map((chunk) => ({
    id: chunk.id,
    title: `${chunk.docTitle} — ${chunk.heading}`,
    text: chunk.text.slice(0, MAX_PASSAGE_CHARS),
    url: `${siteOrigin}/projects/local-plan-navigator${chunk.route}#${chunk.anchor}`,
    sourceType: chunk.kind,
  }));
}

export const SYSTEM_PROMPT = `You help officers in English local planning authorities understand the local plan-making system: the 30-month process, the three gateways, the Town and Country Planning (Local Planning) (England) Regulations 2026, the Environmental Assessment of Plans and Programmes Regulations 2004, the National Planning Policy Framework (August 2026) and the government's guidance. You answer for a prototype at strangeramblings.com/projects/local-plan-navigator, which is not a government service.

RULES:
1. Answer ONLY from the numbered context passages. If they do not answer the question, say so plainly and say what they do cover. Never draw on outside knowledge for a fact, a regulation number, a duration or a date.
2. End every sentence with the number of the passage it comes from, like [1] or [2][3]. Every sentence needs its own citation, even when the previous sentence cites the same passage.
3. Plain British English, short sentences, at most 180 words. No headings, no bullet lists, no preamble.
4. This is not legal advice; say so in one short sentence only if the question asks what an authority is legally allowed to do.
5. If the question is off-topic — anything other than local plan-making in England — decline in one sentence and say what you can help with.`;

export function answerPrompt(question, chunks) {
  const passages = chunks.map((chunk, index) =>
    `[${index + 1}] (${chunk.title}, ${chunk.url})\n${chunk.text.slice(0, 1400)}`,
  ).join('\n\n');
  return `CONTEXT PASSAGES (retrieved from the guidance, regulations and national policy the page found — cite with [n]):\n\n${passages}\n\nQUESTION: ${question}\n\nAnswer using only the context passages above, citing [n] markers. If it is outside local plan-making's scope, decline briefly.`;
}
