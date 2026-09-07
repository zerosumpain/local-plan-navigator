// src/client/retrieval.ts — the search index, shared by Search and Ask.
//
// The corpus (dist/data/corpus.json) is a list of passages with their source,
// heading and anchor. MiniSearch indexes it in the browser in well under a
// second; the index is built once per page and kept. Headings are boosted so a
// query like "prescribed requirements" finds regulation 32 before every
// paragraph that merely mentions it.
import MiniSearch from 'minisearch';

export interface Chunk {
  id: string;
  doc: string;
  docTitle: string;
  kind: string;
  anchor: string;
  route: string;
  heading: string;
  text: string;
}
export interface Hit extends Chunk {
  score: number;
  terms: string[];
}
export interface SourceMeta { id: string; title: string; short: string; kind: string; route: string }

let index: MiniSearch<Chunk> | null = null;
let chunks: Chunk[] = [];
let sources: SourceMeta[] = [];

/** Fetch the corpus and build the index. `base` is the site's relative prefix. */
export async function loadIndex(base: string): Promise<{ count: number; sources: SourceMeta[] }> {
  if (index) return { count: chunks.length, sources };
  const res = await fetch(`${base}data/corpus.json`);
  if (!res.ok) throw new Error(`corpus.json: HTTP ${res.status}`);
  const data = (await res.json()) as { chunks: Chunk[]; sources: SourceMeta[] };
  chunks = data.chunks;
  sources = data.sources;
  index = new MiniSearch<Chunk>({
    fields: ['text', 'heading'],
    storeFields: ['doc', 'docTitle', 'kind', 'anchor', 'route', 'heading', 'text'],
    searchOptions: { boost: { heading: 2 }, prefix: true, fuzzy: 0.15, combineWith: 'AND' },
  });
  index.addAll(chunks);
  return { count: chunks.length, sources };
}

/**
 * Search. Passages matching every word come first; if there are fewer than
 * asked for, passages matching some of the words top the list up, so a
 * question with one unusual word in it still finds the regulation it is about.
 */
export function search(query: string, opts: { docs?: string[]; limit?: number } = {}): Hit[] {
  if (!index) throw new Error('index not loaded');
  const limit = opts.limit ?? 20;
  const filter = opts.docs?.length ? (r: { doc: string }) => opts.docs!.includes(r.doc) : undefined;
  const results = index.search(query, { filter });
  if (results.length < limit) {
    const seen = new Set(results.map((r) => r.id));
    for (const r of index.search(query, { filter, combineWith: 'OR' })) { if (!seen.has(r.id)) { results.push(r); seen.add(r.id); } if (results.length >= limit) break; }
  }
  return results.slice(0, limit).map((r) => ({ ...(r as unknown as Chunk), id: String(r.id), score: r.score, terms: r.terms }));
}

/** A snippet around the first matched term, with the terms wrapped in <mark>. */
export function snippet(text: string, terms: string[], width = 320): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  let start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(width / 3));
  if (start > 0) { const sp = text.lastIndexOf(' ', start); if (sp > 0) start = sp + 1; }
  let piece = text.slice(start, start + width);
  if (start + width < text.length) piece = piece.replace(/\s\S*$/, '') + '…';
  if (start > 0) piece = '…' + piece;
  return highlight(escapeHtml(piece), terms);
}

export function highlight(escaped: string, terms: string[]): string {
  const safe = terms.filter((t) => t.length > 2).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!safe.length) return escaped;
  return escaped.replace(new RegExp(`\\b(${safe.join('|')})\\w*`, 'gi'), '<mark>$&</mark>');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Turn a corpus route ("/reference/x/") into a link from the current page. */
export function hrefFor(base: string, hit: { route: string; anchor: string }): string {
  return `${base}${hit.route.replace(/^\//, '')}#${hit.anchor}`;
}
