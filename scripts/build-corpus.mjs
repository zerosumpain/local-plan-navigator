// scripts/build-corpus.mjs — the government texts, structured three ways.
//
// From the files in content/sources/ (Markdown for the GOV.UK guides and the
// legislation, extracted text for the NPPF) it produces:
//
//   corpus.pages    reference pages: one per source, or one per Part /
//                   chapter for the two long ones, each with an anchor on
//                   every section so a citation can link straight to it
//   corpus.anchors  doc id -> anchor -> route, so the content data can say
//                   { doc: "regulations-2026", anchor: "reg-32" } and the
//                   templates resolve it
//   corpus.chunks   search units of a few hundred words, each carrying its
//                   source, heading and anchor — written to dist/data/corpus.json
//                   for the search and ask pages
//
// Section ids are stable and readable: reg-32, part-4, schedule-2, PM15,
// HO3-1, and for guidance the heading's slug.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { markdownToHtml } from './lib/markdown.mjs';
import { parseNppf, renderNppfChapter, chunkNppfChapter, slug } from './lib/nppf-parse.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CHUNK_TARGET = 900; // characters — roughly 150 words, a good retrieval unit

export async function buildCorpus({ root, dist }) {
  const { sources } = JSON.parse(await readFile(path.join(root, 'content/sources.json'), 'utf8'));
  const pages = [];
  const chunks = [];
  const anchors = {};
  const sourceMeta = [];

  for (const src of sources) {
    const text = await readFile(path.join(root, 'content/sources', src.file), 'utf8');
    anchors[src.id] = {};
    const meta = { ...src };
    if (src.parser === 'nppf') {
      buildNppf(src, text, { pages, chunks, anchors: anchors[src.id] });
    } else {
      const { frontmatter, body } = splitFrontmatter(text);
      Object.assign(meta, { title: src.title ?? frontmatter.title, url: src.url ?? frontmatter.url, updated: src.updated ?? (frontmatter.updated || '').slice(0, 10), publisher: src.publisher ?? frontmatter.publisher });
      buildMarkdown(meta, body, { pages, chunks, anchors: anchors[src.id] });
    }
    sourceMeta.push({ id: src.id, title: meta.title, short: src.short, kind: src.kind, publisher: meta.publisher, url: meta.url, updated: meta.updated, route: `/reference/${src.id}/`, note: src.note ?? null });
  }

  await mkdir(path.join(dist, 'data'), { recursive: true });
  await writeFile(path.join(dist, 'data/corpus.json'), JSON.stringify({ built: new Date().toISOString().slice(0, 10), sources: sourceMeta, chunks }));
  return { pages, chunks, anchors, sources: sourceMeta, meta: { chunkCount: chunks.length, sourceCount: sources.length } };
}

function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { frontmatter: {}, body: text };
  const frontmatter = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) frontmatter[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { frontmatter, body: text.slice(m[0].length) };
}

/** Split Markdown into sections at headings; give each a stable id. */
function sectionise(body, kind) {
  const lines = body.split('\n');
  const sections = [];
  let cur = { level: 0, heading: '', id: 'top', lines: [] };
  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (m) {
      sections.push(cur);
      const heading = m[2].replace(/\\\./g, '.').replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
      cur = { level: m[1].length, heading, id: sectionId(heading, kind), lines: [] };
    } else cur.lines.push(line);
  }
  sections.push(cur);
  return sections.filter((s) => s.heading || s.lines.some((l) => l.trim()));
}

function sectionId(heading, kind) {
  if (kind === 'legislation') {
    let m = heading.match(/^(\d+)\.\s/); if (m) return `reg-${m[1]}`;
    m = heading.match(/^Part (\d+)\b/i); if (m) return `part-${m[1]}`;
    m = heading.match(/^SCHEDULE (\d+)\b/i); if (m) return `schedule-${m[1]}`;
    if (/^Schedule\b/i.test(heading)) return 'schedule';
    if (/^Explanatory Note/i.test(heading)) return 'explanatory-note';
    if (/^(\d+)\.\s*$/.test(heading)) return `para-${heading.replace(/\D/g, '')}`;
  }
  return slug(heading) || 'section';
}

function buildMarkdown(src, body, { pages, chunks, anchors }) {
  const sections = sectionise(body, src.kind);
  // Where to split into pages: legislation by Part (level-2 headings), else one page.
  const units = [];
  if (src.split === 'part') {
    let unit = null;
    for (const s of sections) {
      if (s.level <= 2) { unit = { id: s.id, title: s.heading, sections: [] }; units.push(unit); }
      if (!unit) { unit = { id: 'preamble', title: 'Preamble', sections: [] }; units.push(unit); }
      unit.sections.push(s);
    }
  } else units.push({ id: null, title: src.title, sections });

  const usedIds = new Set();
  for (const unit of units) {
    const route = unit.id ? `/reference/${src.id}/${unit.id}/` : `/reference/${src.id}/`;
    const html = [];
    const toc = [];
    for (const s of unit.sections) {
      // Keep ids unique within a doc (a heading can repeat, e.g. "Definitions").
      let id = s.id; let n = 2; while (usedIds.has(id)) id = `${s.id}-${n++}`; usedIds.add(id); s.id = id;
      anchors[id] = route;
      const bodyHtml = markdownToHtml(s.lines.join('\n'));
      if (s.heading) {
        const size = { 1: 'l', 2: 'l', 3: 'm', 4: 's' }[s.level] || 's';
        html.push(`<section id="${id}" class="lpn-section"><h${Math.max(2, s.level)} class="govuk-heading-${size}">${esc(s.heading)}</h${Math.max(2, s.level)}>${bodyHtml}</section>`);
        if (s.level <= 3) toc.push({ id, heading: s.heading, level: s.level });
      } else html.push(bodyHtml);
      // Chunks
      const plain = mdToPlain(s.lines.join('\n'));
      for (const [k, part] of splitText(plain).entries()) {
        if (!part.trim()) continue;
        chunks.push({ id: `${src.id}#${id}${k ? ':' + k : ''}`, doc: src.id, docTitle: src.short, kind: src.kind, anchor: id, route, heading: s.heading || src.title, text: part });
      }
    }
    pages.push({ id: 'reference', route, template: 'reference', title: unit.id ? `${unit.title} – ${src.short}` : src.title, source: src, unitTitle: unit.title, html: html.join('\n'), toc, units: units.map((u) => ({ id: u.id, title: u.title, route: u.id ? `/reference/${src.id}/${u.id}/` : route })) });
  }
  if (src.split === 'part') {
    // An index page for the split document.
    pages.push({ id: 'reference', route: `/reference/${src.id}/`, template: 'reference-index', title: src.title, source: src, units: units.map((u) => ({ id: u.id, title: u.title, route: `/reference/${src.id}/${u.id}/`, sections: u.sections.filter((s) => s.level === 3).map((s) => ({ id: s.id, heading: s.heading })) })) });
  }
}

function buildNppf(src, text, { pages, chunks, anchors }) {
  const { chapters } = parseNppf(text);
  const units = chapters.map((c) => ({ id: c.annex ? `annex-${c.annex.toLowerCase()}` : `${c.num}-${slug(c.title)}`, title: c.heading, chapter: c }));
  for (const u of units) {
    const route = `/reference/nppf/${u.id}/`;
    const c = u.chapter;
    anchors[c.id] = route;
    for (const b of c.blocks) {
      if (b.type === 'policy') anchors[b.code] = route;
      if (b.type === 'h3') anchors[slug(b.text)] = route;
      if (b.type === 'dl') anchors[slug(b.term)] = route;
    }
    // Paragraph anchors, e.g. PM2-1
    let policy = null;
    for (const b of c.blocks) { if (b.type === 'policy') policy = b.code; if (b.type === 'para' && b.n != null) anchors[policy ? `${policy}-${b.n}` : `${c.id}-${b.n}`] = route; }
    const html = renderNppfChapter(c, esc);
    const toc = c.blocks.filter((b) => b.type === 'policy' || b.type === 'h3').map((b) => b.type === 'policy' ? { id: b.code, heading: `${b.code}: ${b.title}`, level: 3 } : { id: slug(b.text), heading: b.text, level: 2 });
    pages.push({ id: 'reference', route, template: 'reference', title: `${c.heading} – NPPF`, source: src, unitTitle: c.heading, html, toc, units: units.map((x) => ({ id: x.id, title: x.title, route: `/reference/nppf/${x.id}/` })) });
    for (const ch of chunkNppfChapter(c)) {
      for (const [k, part] of splitText(ch.text).entries()) {
        if (!part.trim()) continue;
        chunks.push({ id: `nppf#${ch.anchor}${k ? ':' + k : ''}`, doc: 'nppf', docTitle: src.short, kind: src.kind, anchor: ch.anchor, route, heading: ch.heading, text: part });
      }
    }
  }
  pages.push({ id: 'reference', route: '/reference/nppf/', template: 'reference-index', title: src.title, source: src, units: units.map((u) => ({ id: u.id, title: u.title, route: `/reference/nppf/${u.id}/`, sections: u.chapter.blocks.filter((b) => b.type === 'policy').map((b) => ({ id: b.code, heading: `${b.code}: ${b.title}` })) })) });
}

/** Markdown -> plain text good enough for indexing. */
function mdToPlain(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]+/g, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\|/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Split plain text into pieces of about CHUNK_TARGET characters at paragraph boundaries. */
function splitText(plain) {
  const paras = plain.split('\n').map((p) => p.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > CHUNK_TARGET * 1.4) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + p;
    if (cur.length >= CHUNK_TARGET) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}
