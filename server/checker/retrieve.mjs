// server/checker/retrieve.mjs — which parts of the plan each check reads.
//
// The model never sees the whole plan. Each section is cut into passages of
// at most a few thousand characters, and for each check a small BM25 search
// over the passages, with headings weighted three times and a bonus for each
// keyword phrase found whole, picks the most relevant ones until the
// check's character budget is spent. Ties go to the earlier passage and the
// chosen passages are returned in document order, so the same document always
// yields the same extracts. This bounds the cost of a check: a 300-page plan
// sends the model about as much text per check as a 30-page one.

const STOP = new Set('a an and are as at be been by can could do does for from has have how if in into is it its may must of on or our shall should so than that the their them then there these they this to was we were what when where which who will with would'.split(' '));
const PART_TARGET = 2800;

/** Lower-case word stems, without function words. Deliberately crude, but stable. */
export function terms(text) {
  const out = [];
  for (let w of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(w) || w.length < 2) continue;
    if (w.length > 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
    else if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    else if (w.length > 6 && w.endsWith('ing')) w = w.slice(0, -3);
    out.push(w);
  }
  return out;
}

/** Cut text into pieces of about `target` characters at line, then sentence, boundaries. */
export function splitText(text, target = PART_TARGET) {
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const line of text.split('\n')) {
    if (line.length > target) {
      push();
      let piece = '';
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        if (piece && piece.length + sentence.length > target) { out.push(piece.trim()); piece = ''; }
        piece += (piece ? ' ' : '') + sentence;
        while (piece.length > target * 1.5) { out.push(piece.slice(0, target)); piece = piece.slice(target); }
      }
      if (piece.trim()) out.push(piece.trim());
      continue;
    }
    if (cur && cur.length + line.length + 1 > target) push();
    cur += (cur ? '\n' : '') + line;
  }
  push();
  return out;
}

/** Passages for a document, with the statistics BM25 needs. */
export function passageIndex(doc) {
  const passages = [];
  for (const s of doc.sections) {
    const parts = s.text ? splitText(s.text) : [''];
    parts.forEach((text, k) => {
      if (!text && !s.heading) return;
      const tf = new Map();
      for (const t of terms(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of terms(s.heading)) tf.set(t, (tf.get(t) ?? 0) + 3);
      passages.push({ n: passages.length, sectionId: s.id, locator: s.locator + (parts.length > 1 ? ` (part ${k + 1} of ${parts.length})` : ''), heading: s.heading, text, lower: `${s.heading}\n${text}`.toLowerCase(), tf, length: [...tf.values()].reduce((a, b) => a + b, 0) });
    });
  }
  const df = new Map();
  for (const p of passages) for (const t of p.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = passages.reduce((a, p) => a + p.length, 0) / Math.max(1, passages.length);
  return { passages, df, avg, n: passages.length };
}

/** BM25 score of each passage for the query; phrases found whole score a bonus. */
function scores(index, keywords) {
  const qterms = [...new Set(keywords.flatMap(terms))];
  const phrases = keywords.map((k) => k.toLowerCase()).filter((k) => k.includes(' '));
  return index.passages.map((p) => {
    let s = 0;
    for (const t of qterms) {
      const f = p.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (index.n - index.df.get(t) + 0.5) / (index.df.get(t) + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (p.length / index.avg)));
    }
    for (const ph of phrases) if (p.lower.includes(ph)) s += 2;
    return s;
  });
}

/**
 * The passages most relevant to `keywords`, within `budget` characters, in
 * document order. `require` adds passages from these section ids first.
 */
export function retrieve(index, keywords, { budget = 12000, max = 12, require = [] } = {}) {
  const chosen = new Map();
  let used = 0;
  for (const p of index.passages) {
    if (!require.includes(p.sectionId) || chosen.has(p.n)) continue;
    if (used + p.text.length > budget && chosen.size) continue;
    chosen.set(p.n, p); used += p.text.length + p.locator.length;
  }
  const s = scores(index, keywords);
  const ranked = index.passages.map((p, i) => ({ p, s: s[i] })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.p.n - b.p.n);
  for (const { p } of ranked) {
    if (chosen.size >= max) break;
    if (chosen.has(p.n)) continue;
    if (used + p.text.length > budget) continue;
    chosen.set(p.n, p); used += p.text.length + p.locator.length;
  }
  return [...chosen.values()].sort((a, b) => a.n - b.n);
}

/** Merge several retrievals, keeping document order and a total budget. */
export function mergePassages(lists, budget) {
  const all = new Map();
  for (const list of lists) for (const p of list) all.set(p.n, p);
  const out = [];
  let used = 0;
  // Earlier lists are the priority when the budget is tight: take each list's
  // passages in turn, round-robin, until the budget is used.
  const queues = lists.map((l) => [...l]);
  const taken = new Set();
  while (queues.some((q) => q.length)) {
    for (const q of queues) {
      const p = q.shift();
      if (!p || taken.has(p.n)) continue;
      if (used + p.text.length > budget) continue;
      taken.add(p.n); used += p.text.length;
    }
  }
  for (const n of [...taken].sort((a, b) => a - b)) out.push(all.get(n));
  return out;
}

/** The `k` passages scoring highest for `keywords`, best first (ties to the earlier passage). */
export function rankPassages(index, keywords, k) {
  const s = scores(index, keywords);
  return index.passages.map((p, i) => ({ p, s: s[i] })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.n - b.p.n).slice(0, k).map((x) => x.p);
}
