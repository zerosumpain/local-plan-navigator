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

// Function words carry no meaning for matching and, under AND matching, make
// a question like "what are the prescribed requirements" demand that every
// passage contain "what" and "are". They are dropped at index and query time.
const STOPWORDS = new Set('a an and are as at be been by can could do does for from has have how i if in into is it its may must of on or our shall should so than that the their them then there these they this to us was we were what when where which who whom why will with would you your'.split(' '));

export const INDEX_OPTIONS = {
  fields: ['text', 'heading'],
  storeFields: ['doc', 'docTitle', 'kind', 'anchor', 'route', 'heading', 'text'],
  processTerm: (term: string) => { const t = term.toLowerCase(); return STOPWORDS.has(t) || t.length < 2 ? null : t; },
  searchOptions: { boost: { heading: 3 }, prefix: true, fuzzy: 0.15, combineWith: 'AND' as const, bm25: { k: 1.2, b: 0.4, d: 0.5 } },
};
export const SEARCH_OPTIONS = INDEX_OPTIONS.searchOptions;

let index: MiniSearch<Chunk> | null = null;
let chunks: Chunk[] = [];
let sources: SourceMeta[] = [];

/** AND results first, topped up with OR results, deduplicated. Exported for the evaluation script. */
export function topUp(idx: MiniSearch<Chunk>, query: string, opts: Record<string, unknown>, limit: number, uniqueAnchors = false) {
  const results = [...idx.search(query, opts)];
  const seen = new Set(results.map((r) => r.id));
  for (const r of idx.search(query, { ...opts, combineWith: 'OR' })) { if (results.length >= limit * 3) break; if (!seen.has(r.id)) { results.push(r); seen.add(r.id); } }
  // One passage per section when asked: a long regulation split into three
  // chunks should not crowd out the other five answers.
  const out: typeof results = [];
  const anchors = new Set<string>();
  for (const r of results) {
    const key = `${r.doc}#${r.anchor}`;
    if (uniqueAnchors && anchors.has(key)) continue;
    anchors.add(key); out.push(r);
    if (out.length >= limit) break;
  }
  return out.map((r) => ({ ...(r as unknown as Chunk), id: String(r.id), score: r.score as number, terms: r.terms as string[] }));
}

/** Fetch the corpus and build the index. `base` is the site's relative prefix. */
export async function loadIndex(base: string): Promise<{ count: number; sources: SourceMeta[] }> {
  if (index) return { count: chunks.length, sources };
  const res = await fetch(`${base}data/corpus.json`);
  if (!res.ok) throw new Error(`corpus.json: HTTP ${res.status}`);
  const data = (await res.json()) as { chunks: Chunk[]; sources: SourceMeta[] };
  chunks = data.chunks;
  sources = data.sources;
  index = new MiniSearch<Chunk>(INDEX_OPTIONS);
  index.addAll(chunks);
  return { count: chunks.length, sources };
}

/**
 * Search. Passages matching every word come first; if there are fewer than
 * asked for, passages matching some of the words top the list up, so a
 * question with one unusual word in it still finds the regulation it is about.
 */
export function search(query: string, opts: { docs?: string[]; limit?: number; uniqueAnchors?: boolean } = {}): Hit[] {
  if (!index) throw new Error('index not loaded');
  const filter = opts.docs?.length ? (r: { doc: string }) => opts.docs!.includes(r.doc) : undefined;
  return topUp(index, query, { filter }, opts.limit ?? 20, opts.uniqueAnchors ?? false);
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
