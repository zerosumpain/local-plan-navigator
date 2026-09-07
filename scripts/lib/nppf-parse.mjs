// scripts/lib/nppf-parse.mjs — structure the NPPF from the PDF's extracted text.
//
// GOV.UK publishes the August 2026 NPPF as a PDF only ("an accessible version
// will be available soon"). `pdftotext -layout` gives us the words; this file
// gives them back their structure: chapters, the "Plan-making policies" and
// "National decision-making policies" sub-headings, coded policies (PM2, S1,
// HO3…), numbered paragraphs, lettered sub-lists, bullets, footnotes, the
// annexes and the glossary.
//
// It is heuristic and it says so on the page. The rules it relies on, all
// visible in the text:
//   - chapter titles are known from the contents page and appear alone on a line
//   - a policy heading is `CODE: Title` at the start of a line
//   - a paragraph starts `N. ` at column 0; a footnote starts `N ` (no dot)
//     at column 0; a continuation line is indented by one space
//   - sub-items start `a. `, `i. ` or `• `
//   - page numbers sit alone on a line
export function parseNppf(text) {
  const raw = text.replace(/\f/g, '\n').split('\n');
  // 1. The contents page tells us the chapter and annex titles.
  const chapters = [];
  for (const line of raw.slice(0, 120)) {
    let m = line.match(/^\s*(\d{1,2})\.\s+(.+?)\s*\.{3,}\s*\d+\s*$/);
    if (m) chapters.push({ num: m[1], title: m[2].replace(/\s*\([A-Z]{1,2}\d+\s*-\s*\d+\)\s*$/, '').trim(), codes: (m[2].match(/\(([A-Z]{1,2})\d+\s*-\s*\d+\)/) || [])[1] || null });
    m = line.match(/^\s*Annex ([A-F]):\s+(.+?)\s*\.{3,}\s*\d+\s*$/);
    if (m) chapters.push({ annex: m[1], title: m[2].trim() });
  }
  const titleOf = new Map(chapters.map((c) => [c.annex ? `Annex ${c.annex}: ${c.title}` : `${c.num}. ${c.title}`, c]));

  // 2. Find where the body starts: the second "1. Introduction" line.
  let start = raw.findIndex((l, i) => i > 60 && /^\s*1\.\s+Introduction\s*$/.test(l));
  if (start < 0) start = 0;

  // 3. Walk the body, building blocks.
  const out = []; // chapters with blocks
  let chapter = null;
  let policy = null; // current policy code
  let block = null;  // current open block (para / item / footnote / objective)
  let paraNo = 0;    // running paragraph number inside the current heading scope
  const push = () => { if (block) { chapter.blocks.push(block); block = null; } };
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const append = (s) => {
    if (!block) return;
    const t = clean(s);
    if (!t) return;
    // Re-join words hyphenated at a line break ("plan-" + "making").
    if (/-$/.test(block.text) && /^[a-z]/.test(t)) block.text += t;
    else block.text += (block.text ? ' ' : '') + t;
  };
  const isSubheading = (l, next) => /^[A-Z][A-Za-z ,'’()\-]{3,80}$/.test(l) && !/\.$/.test(l) && next != null && /^(\s*\d{1,3}\.\s|\s*[A-Z]{1,2}\d{1,2}:\s|\s*[A-Z][a-z])/.test(next);

  for (let i = start; i < raw.length; i++) {
    const line = raw[i];
    const t = line.trimEnd();
    if (!t.trim()) { continue; }
    if (/^\s*\d{1,3}\s*$/.test(t)) continue; // page number
    const trimmed = t.trim();

    // Chapter / annex heading — sometimes wrapped over two lines in the PDF text
    let ch = titleOf.get(trimmed);
    if (!ch && /^(\d{1,2}\.|Annex [A-F]:)\s/.test(trimmed)) {
      const nextLine = (raw[i + 1] ?? '').trim();
      const joined = clean(trimmed + ' ' + nextLine);
      if (titleOf.get(joined)) { ch = titleOf.get(joined); i++; }
    }
    // Annex F has no heading line in the extracted text — its first table marks it.
    if (!ch && chapter?.annex === 'E' && /^Table 1: Flood zones/i.test(trimmed)) ch = titleOf.get('Annex F: Managing flood risk and coastal change');
    if (ch) {
      push();
      chapter = { id: ch.annex ? `annex-${ch.annex.toLowerCase()}` : `ch-${ch.num}`, num: ch.num ?? null, annex: ch.annex ?? null, title: ch.title, heading: trimmed, blocks: [], footnotes: [] };
      out.push(chapter);
      policy = null; paraNo = 0;
      continue;
    }
    if (!chapter) continue;

    // Policy heading: "PM2: Local plans"
    let m = trimmed.match(/^([A-Z]{1,2}\d{1,2}):\s+(.+)$/);
    if (m && t === trimmed) {
      push();
      policy = m[1]; paraNo = 0;
      chapter.blocks.push({ type: 'policy', code: m[1], title: clean(m[2]) });
      continue;
    }
    // Footnote: "12 Text" at column 0 (no dot after the number)
    m = t.match(/^(\d{1,3}) (\S.*)$/);
    if (m && !/^\d{1,3}\. /.test(t)) {
      push();
      block = { type: 'footnote', n: Number(m[1]), text: clean(m[2]) };
      continue;
    }
    // Numbered paragraph at column 0: "3. Text"
    m = t.match(/^(\d{1,3})\.\s+(.+)$/);
    if (m) {
      push();
      paraNo = Number(m[1]);
      block = { type: 'para', n: paraNo, scope: policy, text: clean(m[2]) };
      continue;
    }
    // Lettered / roman sub-items and bullets (indented)
    m = trimmed.match(/^([a-z])\.\s+(.+)$/);
    if (m) { push(); block = { type: 'item', level: 1, marker: m[1], text: clean(m[2]) }; continue; }
    m = trimmed.match(/^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)\.\s+(.+)$/);
    if (m) { push(); block = { type: 'item', level: 2, marker: m[1], text: clean(m[2]) }; continue; }
    m = trimmed.match(/^•\s+(.+)$/);
    if (m) { push(); block = { type: 'bullet', text: clean(m[1]) }; continue; }
    // Glossary entries in Annex B: "Term: definition"
    if (chapter.annex === 'B') {
      m = trimmed.match(/^([A-Z][^:]{2,70}):\s+(.+)$/);
      if (m && t === trimmed && !block?.type?.startsWith('dl')) { push(); block = { type: 'dl', term: clean(m[1]), text: clean(m[2]) }; continue; }
      if (m && t === trimmed) { push(); block = { type: 'dl', term: clean(m[1]), text: clean(m[2]) }; continue; }
    }
    // Step headings in Annex D ("Step 1: Setting the baseline …") and short subheadings
    if (t === trimmed && /^Step \d+:/.test(trimmed)) { push(); chapter.blocks.push({ type: 'h3', text: clean(trimmed) }); continue; }
    if (t === trimmed && !['C', 'E', 'F'].includes(chapter.annex) && isSubheading(trimmed, raw.slice(i + 1).find((l) => l.trim()))) { push(); chapter.blocks.push({ type: 'h3', text: clean(trimmed) }); policy = policy; continue; }
    // Objective box: indented text straight after a chapter heading, before paragraph 1
    if (!block && chapter.blocks.length === 0 && t !== trimmed) { block = { type: 'objective', text: clean(trimmed) }; continue; }
    // Otherwise a continuation of whatever is open
    if (block) append(trimmed);
    else { block = { type: 'para', n: null, scope: policy, text: clean(trimmed) }; }
  }
  push();

  // 4. Tidy: move footnotes out of the block stream, close hyphen joins.
  for (const c of out) {
    c.footnotes = c.blocks.filter((b) => b.type === 'footnote').sort((a, b) => a.n - b.n);
    c.blocks = c.blocks.filter((b) => b.type !== 'footnote');
    for (const b of c.blocks) if (b.text) b.text = b.text.replace(/(\w)- (\w)/g, '$1-$2');
    for (const f of c.footnotes) f.text = f.text.replace(/(\w)- (\w)/g, '$1-$2');
  }
  return { chapters: out };
}

/** Render one parsed chapter to HTML with GOV.UK classes and stable anchors. */
export function renderNppfChapter(c, esc) {
  const h = [];
  let listOpen = 0; // nesting depth of open <ol>
  let policy = null;
  let inDl = false;
  const closeLists = (to = 0) => { while (listOpen > to) { h.push('</li></ol>'); listOpen--; } };
  const closeDl = () => { if (inDl) { h.push('</dl>'); inDl = false; } };
  h.push(`<h2 class="govuk-heading-l" id="${c.id}">${esc(c.heading)}</h2>`);
  for (const b of c.blocks) {
    if (b.type === 'objective') { closeLists(); closeDl(); h.push(`<div class="govuk-inset-text">${esc(b.text)}</div>`); continue; }
    if (b.type === 'h3') { closeLists(); closeDl(); h.push(`<h3 class="govuk-heading-m" id="${slug(b.text)}">${esc(b.text)}</h3>`); continue; }
    if (b.type === 'policy') { closeLists(); closeDl(); policy = b.code; h.push(`<h3 class="govuk-heading-m lpn-policy" id="${b.code}"><span class="lpn-policy__code">${b.code}</span>: ${esc(b.title)}</h3>`); continue; }
    if (b.type === 'para') {
      closeLists(); closeDl();
      const id = b.n != null ? (policy ? `${policy}-${b.n}` : `${c.id}-${b.n}`) : '';
      h.push(`<p class="govuk-body lpn-para"${id ? ` id="${id}"` : ''}>${b.n != null ? `<span class="lpn-para__n">${b.n}.</span> ` : ''}${esc(b.text)}</p>`);
      continue;
    }
    if (b.type === 'item') {
      closeDl();
      if (listOpen === 0) { h.push('<ol class="govuk-list lpn-sublist"><li>'); listOpen = 1; }
      else if (b.level > listOpen) { h.push('<ol class="govuk-list lpn-sublist lpn-sublist--roman"><li>'); listOpen++; }
      else { closeLists(b.level); h.push('</li><li>'); }
      h.push(`<span class="lpn-marker">${b.marker}.</span> ${esc(b.text)}`);
      continue;
    }
    if (b.type === 'bullet') { closeLists(); closeDl(); h.push(`<ul class="govuk-list govuk-list--bullet"><li>${esc(b.text)}</li></ul>`); continue; }
    if (b.type === 'dl') { closeLists(); if (!inDl) { h.push('<dl class="govuk-summary-list lpn-glossary">'); inDl = true; } h.push(`<div class="govuk-summary-list__row" id="${slug(b.term)}"><dt class="govuk-summary-list__key">${esc(b.term)}</dt><dd class="govuk-summary-list__value">${esc(b.text)}</dd></div>`); continue; }
  }
  closeLists(); closeDl();
  if (c.footnotes.length) {
    h.push('<h3 class="govuk-heading-s">Footnotes</h3><ol class="govuk-list lpn-footnotes">');
    for (const f of c.footnotes) h.push(`<li id="fn-${f.n}"><span class="lpn-marker">${f.n}</span> ${esc(f.text)}</li>`);
    h.push('</ol>');
  }
  return h.join('\n');
}

/** Plain-text chunks of a chapter for the search index: one per policy or heading scope. */
export function chunkNppfChapter(c) {
  const chunks = [];
  let current = { anchor: c.id, heading: c.heading, parts: [] };
  const flush = () => { if (current.parts.length) chunks.push({ anchor: current.anchor, heading: current.heading, text: current.parts.join('\n') }); };
  for (const b of c.blocks) {
    if (b.type === 'policy') { flush(); current = { anchor: b.code, heading: `${c.heading} › ${b.code}: ${b.title}`, parts: [] }; continue; }
    if (b.type === 'h3') { flush(); current = { anchor: slug(b.text), heading: `${c.heading} › ${b.text}`, parts: [] }; continue; }
    if (b.type === 'para') current.parts.push((b.n != null ? `${b.n}. ` : '') + b.text);
    else if (b.type === 'item') current.parts.push(`${b.marker}. ${b.text}`);
    else if (b.type === 'bullet') current.parts.push(`• ${b.text}`);
    else if (b.type === 'objective') current.parts.push(b.text);
    else if (b.type === 'dl') current.parts.push(`${b.term}: ${b.text}`);
  }
  flush();
  return chunks;
}

export function slug(s) {
  return String(s).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
