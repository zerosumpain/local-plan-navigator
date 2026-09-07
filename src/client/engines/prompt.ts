// src/client/engines/prompt.ts — how a question and its passages become a prompt.
//
// Shared by the page and by scripts/try-model.mjs, which runs the same prompt
// through a model in Node to check the answers are grounded and sensible.
import type { ChatMessage } from './protocol';

export interface Passage { n: number; source: string; heading: string; text: string }

export const SYSTEM_PROMPT = `You help officers in English local planning authorities understand the local plan-making system. Answer ONLY from the numbered extracts of official guidance and legislation you are given.

Rules:
- Write the answer in your own words: two to five short sentences that directly answer the question. Do not copy the extracts out, do not list them, and do not repeat their headings.
- End each sentence with the number of the extract it comes from, like this: [1] or [2][3].
- If the extracts do not answer the question, say "The extracts I have do not answer this" and say in one sentence what they do cover.
- Never invent a regulation number, a date, a duration or a document name that is not in the extracts.
- Plain British English. No preamble, no headings, no bullet points, no legal advice.`;

export function buildMessages(question: string, passages: Passage[]): ChatMessage[] {
  const extracts = passages.map((p) => `[${p.n}] ${p.source} — ${p.heading}\n${p.text}`).join('\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Extracts:\n${extracts}\n\nQuestion: ${question.trim()}\n\nAnswer in your own words in two to five sentences, ending each with its citation.` },
  ];
}

/** Keep the passages within a budget of roughly `maxChars` characters, longest first trimmed. */
export function fitPassages(passages: Passage[], maxChars = 5200): Passage[] {
  const out = passages.map((p) => ({ ...p }));
  let total = out.reduce((a, p) => a + p.text.length, 0);
  while (total > maxChars && out.length) {
    const longest = out.reduce((a, b) => (a.text.length >= b.text.length ? a : b));
    if (longest.text.length <= 600) { out.pop(); } else { longest.text = longest.text.slice(0, Math.floor(longest.text.length * 0.7)).replace(/\s\S*$/, '') + '…'; }
    total = out.reduce((a, p) => a + p.text.length, 0);
  }
  return out;
}
