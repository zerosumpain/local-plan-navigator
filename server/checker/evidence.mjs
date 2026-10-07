// server/checker/evidence.mjs — is a quoted passage really in the document?
//
// A language model asked for evidence will sometimes paraphrase, tidy or
// invent a quote. The report only shows a quote if it is found in the
// uploaded document after normalising the things a copy can innocently
// change: runs of whitespace, curly and straight quotes, the various dashes,
// non-breaking spaces and letter case. What the report then shows is the
// document's own text at that place, never the model's version of it, so
// every quote on the page is verbatim by construction.
//
// A quote with an ellipsis is checked as its pieces, which must all be found,
// in order, in the same section. A quote can be confined to some sections
// (an allocation's evidence must come from that allocation).

const FOLD = new Map([
  ...[...'‘’‚‛′`´'].map((c) => [c, "'"]),
  ...[...'“”„‟″«»'].map((c) => [c, '"']),
  ...[...'‐‑‒–—―−'].map((c) => [c, '-']),
  ...[...'              　\t\r\n\f\v'].map((c) => [c, ' ']),
  ['…', '...'], ['­', ''], ['​', ''], ['‌', ''], ['‍', ''], ['﻿', ''], ['•', ' '],
]);

/** Normalise text, keeping a map from each normalised character back to the original. */
export function normaliseWithMap(text) {
  let out = '';
  const map = [];
  let space = true; // collapse leading whitespace too
  for (let i = 0; i < text.length; i++) {
    let c = FOLD.has(text[i]) ? FOLD.get(text[i]) : text[i];
    if (c === ' ') {
      if (space) continue;
      space = true;
      out += ' '; map.push(i);
      continue;
    }
    for (const ch of c) {
      const lower = ch.toLowerCase();
      out += lower.length === 1 ? lower : ch;
      map.push(i);
    }
    if (c) space = false;
  }
  if (out.endsWith(' ')) { out = out.slice(0, -1); map.pop(); }
  return { norm: out, map };
}

export const normalise = (s) => normaliseWithMap(String(s ?? '')).norm;

/** Build the searchable form of a document's sections once per check. */
export function evidenceIndex(doc) {
  return doc.sections.map((s) => {
    const original = s.heading ? `${s.heading}\n${s.text}` : s.text;
    return { id: s.id, locator: s.locator, original, ...normaliseWithMap(original) };
  });
}

/** The pieces of a quote to look for: trimmed of quote marks, bullets and end punctuation, split at ellipses. */
function pieces(quote) {
  return normalise(quote)
    .split(/\.{3,}/)
    .map((p) => p.replace(/^[\s"'\-*•>:;,.]+/, '').replace(/[\s"'\-*•:;,.]+$/, ''))
    .filter(Boolean);
}

/**
 * Find a quote in the document. Returns { quote, sectionId, locator } with
 * `quote` taken from the document itself, or null if it is not there.
 * `scope` is an optional list of section ids to confine the search to.
 */
export function verifyQuote(index, quote, { scope = null, minLength = 4, maxLength = 1200 } = {}) {
  if (typeof quote !== 'string') return null;
  const parts = pieces(quote);
  if (!parts.length || parts.join('').length < minLength || parts.join(' ').length > maxLength) return null;
  const sections = scope ? index.filter((s) => scope.includes(s.id)) : index;
  for (const s of sections) {
    let from = 0;
    let start = -1;
    let end = -1;
    let ok = true;
    for (const p of parts) {
      const at = s.norm.indexOf(p, from);
      if (at < 0) { ok = false; break; }
      if (start < 0) start = at;
      end = at + p.length;
      from = end;
    }
    if (!ok) continue;
    const text = s.original.slice(s.map[start], s.map[end - 1] + 1).replace(/\s+/g, ' ').trim();
    return { quote: parts.length > 1 ? elide(s, parts, start) : text, sectionId: s.id, locator: s.locator };
  }
  return null;
}

/** For an elided quote, show the document's text of each piece joined by an ellipsis. */
function elide(s, parts, start) {
  const out = [];
  let from = start;
  for (const p of parts) {
    const at = s.norm.indexOf(p, from);
    out.push(s.original.slice(s.map[at], s.map[at + p.length - 1] + 1).replace(/\s+/g, ' ').trim());
    from = at + p.length;
  }
  return out.join(' … ');
}

/**
 * Verify a list of quotes, dropping the ones not found and duplicates.
 * Returns { kept: [{ quote, sectionId, locator }], dropped: number }.
 */
export function verifyQuotes(index, quotes, options = {}) {
  const kept = [];
  let dropped = 0;
  const seen = new Set();
  for (const q of Array.isArray(quotes) ? quotes : []) {
    const found = verifyQuote(index, q, options);
    if (!found) { dropped++; continue; }
    const key = normalise(found.quote);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(found);
  }
  return { kept, dropped };
}
