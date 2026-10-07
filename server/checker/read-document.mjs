// server/checker/read-document.mjs — an uploaded plan, read into one shape.
//
// Four formats come in; one structure goes out:
//
//   { name, type, bytes, sha256, characters, words, text,
//     sections: [{ id, heading, level, path, locator, text, tables }] }
//
// A section runs from one heading to the next. Its `text` is the paragraphs
// under that heading with any tables flattened to "cell | cell" lines, so the
// search, the prompts and the quote check all see the same words; `tables`
// keeps the rows for the code that looks for a schedule of site allocations.
// `locator` is how the report says where something is ("3 Spatial strategy ›
// Policy NW2", or "Slide 4: Our sites").
//
//   .docx  word/document.xml: headings from the paragraph's outline level or
//          its style (Heading 1-9, Title, resolved through styles.xml so a
//          renamed or localised style still counts), paragraphs, tables as
//          rows; tracked deletions, field codes, the table of contents and the
//          VML copy of a text box are skipped
//   .pptx  ppt/slides/slideN.xml in the order presentation.xml lists them,
//          each slide a section titled by its title placeholder, with its
//          tables and its speaker notes
//   .md    ATX and setext headings, paragraphs, list items, pipe tables, with
//          the inline Markdown taken out
//   .txt   paragraphs, and lines that look like headings ("3. Spatial
//          strategy", "POLICY NW1", "Chapter 2")
//
// Everything happens in memory. Nothing is written to disk and nothing from
// the document is logged; a DocumentError carries a message written for the
// person who uploaded the file, in the GOV.UK style for file upload errors.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { openZip } from './zip.mjs';
import { xmlTokens } from './xml.mjs';

export const DOCUMENT_LIMITS = {
  maxBytes: 15 * 1024 * 1024,
  // About 100,000 words, or a 300-page plan. The model only ever sees the
  // parts of the plan relevant to each check, so this bounds memory and the
  // size of the outline, not the cost.
  maxCharacters: 650_000,
  minCharacters: 300,
};

export const ACCEPTED = { '.docx': 'docx', '.pptx': 'pptx', '.md': 'md', '.markdown': 'md', '.txt': 'txt' };
export const TYPE_NAMES = { docx: 'Word document', pptx: 'PowerPoint presentation', md: 'Markdown file', txt: 'text file' };
const ACCEPT_MESSAGE = 'The selected file must be a Word document (.docx), PowerPoint presentation (.pptx), Markdown file (.md) or text file (.txt)';
const NEARLY = {
  '.doc': 'The selected file is an older Word format (.doc). Save it as a Word document (.docx) and try again',
  '.docm': 'The selected file contains macros. Save it as a Word document (.docx) and try again',
  '.dotx': 'The selected file is a Word template. Save it as a Word document (.docx) and try again',
  '.odt': 'The selected file is an OpenDocument file. Save it as a Word document (.docx) and try again',
  '.rtf': 'The selected file is in Rich Text Format. Save it as a Word document (.docx) and try again',
  '.ppt': 'The selected file is an older PowerPoint format (.ppt). Save it as a PowerPoint presentation (.pptx) and try again',
  '.pdf': 'PDF files cannot be checked. Upload the Word version of the plan (.docx), or save the PDF as a Word document and try again',
};

/** "15MB", or "64KB" below a megabyte, as GOV.UK file upload errors write sizes. */
export const sizeLabel = (bytes) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)}MB` : `${Math.round(bytes / 1024)}KB`);

export class DocumentError extends Error {
  /** @param {string} message shown to the user as it is @param {number} status HTTP status */
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Read an upload. `bytes` is a Buffer; `name` is the file name the browser sent. */
export function readDocument({ name, bytes, limits = {} }) {
  const lim = { ...DOCUMENT_LIMITS, ...limits };
  const fileName = cleanName(name);
  if (!bytes || !bytes.length) throw new DocumentError('The selected file is empty');
  if (bytes.length > lim.maxBytes) throw new DocumentError(`The selected file must be smaller than ${sizeLabel(lim.maxBytes)}`, 413);
  const ext = (fileName.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '').toLowerCase();
  const type = ACCEPTED[ext];
  if (!type) throw new DocumentError(NEARLY[ext] ?? ACCEPT_MESSAGE, 415);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  // An Office file with a password is an OLE compound file, not a zip.
  const isOle = bytes.length >= 8 && bytes.readUInt32LE(0) === 0xe011cfd0;

  let blocks;
  if (type === 'docx' || type === 'pptx') {
    if (isOle) throw new DocumentError('The selected file is password protected or in an older format. Remove the password, or save it again as a .docx or .pptx, and try again');
    if (!isZip) throw new DocumentError(`The selected file is not a ${TYPE_NAMES[type]}. Check it opens, save it again and try again`, 415);
    let zip;
    try { zip = openZip(bytes); } catch { throw new DocumentError('The selected file could not be opened. Check it opens, save it again and try again'); }
    try { blocks = type === 'docx' ? docxBlocks(zip) : pptxBlocks(zip); }
    catch (err) {
      if (err instanceof DocumentError) throw err;
      throw new DocumentError('The selected file could not be read. Check it opens, save it again and try again');
    }
  } else {
    if (isZip || isOle || bytes.subarray(0, 8192).includes(0)) throw new DocumentError(`The selected file is not a ${TYPE_NAMES[type]}. Check the file and try again`, 415);
    const text = decodeText(bytes);
    blocks = type === 'md' ? markdownBlocks(text) : textBlocks(text);
  }
  const doc = assemble(fileName, type, bytes, blocks);
  if (doc.characters < lim.minCharacters) throw new DocumentError('The selected file has too little text to check. Upload the draft plan itself');
  if (doc.characters > lim.maxCharacters) {
    const words = Math.round(doc.words / 1000) * 1000;
    const maxWords = Math.round(lim.maxCharacters / 6.5 / 1000) * 1000;
    throw new DocumentError(`The selected file has about ${words.toLocaleString('en-GB')} words. The checker can read up to about ${maxWords.toLocaleString('en-GB')} words. Check the plan in parts, for example the strategy and policies separately from the site allocations`, 413);
  }
  return doc;
}

/** Keep the file's base name only, printable and short. */
export function cleanName(name) {
  // eslint-disable-next-line no-control-regex
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|]/g, '').trim();
  return (base || 'document').slice(0, 160);
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

/** Collapse the whitespace inside one paragraph. */
const clean = (s) => s.replace(/[\t  -​  　 ]+/g, ' ').replace(/ *\n */g, '\n').trim();

// ---------------------------------------------------------------------------
// Assembly: blocks -> sections
// ---------------------------------------------------------------------------

/**
 * blocks: { kind: 'heading', level, text, label? } | { kind: 'para', text } |
 *         { kind: 'table', rows: string[][] }
 */
function assemble(name, type, bytes, blocks) {
  const sections = [];
  const stack = []; // open headings, for the path
  let cur = { heading: '', level: 0, path: [], label: null, paras: [], tables: [] };
  const flush = () => { if (cur.heading || cur.paras.length || cur.tables.length) sections.push(cur); };
  for (const b of blocks) {
    if (b.kind === 'heading') {
      flush();
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop();
      stack.push({ level: b.level, text: b.text });
      cur = { heading: b.text, level: b.level, path: stack.map((h) => h.text), label: b.label ?? null, paras: [], tables: [] };
    } else if (b.kind === 'para') {
      if (b.text) cur.paras.push(b.text);
    } else if (b.kind === 'table') {
      const rows = b.rows.map((r) => r.map((c) => clean(c).replace(/\n/g, ' '))).filter((r) => r.some(Boolean));
      if (rows.length) { cur.tables.push({ rows }); cur.paras.push(rows.map((r) => r.join(' | ')).join('\n')); }
    }
  }
  flush();
  // A single top-level heading at the start is the document's title: leave it
  // out of every other section's location, where it would only repeat.
  const titled = sections[0]?.level === 1 && sections.filter((s) => s.level === 1).length === 1 && type !== 'pptx';
  if (titled) for (const s of sections.slice(1)) if (s.path[0] === sections[0].heading) s.path = s.path.slice(1);
  const out = sections.map((s, i) => ({
    id: `s${i + 1}`,
    heading: s.heading,
    level: s.level,
    path: s.path,
    locator: s.label ? (s.heading && s.heading !== s.label ? `${s.label}: ${s.heading}` : s.label) : (s.path.length ? s.path.slice(-3).join(' › ') : 'Opening text'),
    text: s.paras.join('\n'),
    tables: s.tables,
  }));
  const text = out.map((s) => [s.heading, s.text].filter(Boolean).join('\n')).join('\n\n');
  return {
    name,
    type,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    characters: text.length,
    words: (text.match(/\S+/g) ?? []).length,
    text,
    sections: out,
  };
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

/** Relationship id -> { target (full part path), type } for one .rels part. */
function relsOf(xml, baseDir) {
  const map = new Map();
  if (!xml) return map;
  for (const t of xmlTokens(xml)) {
    if (t.type !== 'open' || t.name !== 'Relationship' || t.attrs.TargetMode === 'External') continue;
    const target = t.attrs.Target ?? '';
    map.set(t.attrs.Id, { type: t.attrs.Type ?? '', target: target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(baseDir, target)) });
  }
  return map;
}

/** styleId -> heading level (1-9), 'toc' for table-of-contents styles, or null. */
function docxStyles(xml) {
  const raw = new Map();
  if (xml) {
    let cur = null;
    for (const t of xmlTokens(xml)) {
      if (t.type === 'open' && t.name === 'w:style') { cur = { id: t.attrs['w:styleId'], name: '', basedOn: null, outline: null }; raw.set(cur.id, cur); }
      else if (cur && t.type === 'open' && t.name === 'w:name') cur.name = t.attrs['w:val'] ?? '';
      else if (cur && t.type === 'open' && t.name === 'w:basedOn') cur.basedOn = t.attrs['w:val'] ?? null;
      else if (cur && t.type === 'open' && t.name === 'w:outlineLvl') cur.outline = Number(t.attrs['w:val']);
      else if (t.type === 'close' && t.name === 'w:style') cur = null;
    }
  }
  const levelOf = (id, depth = 0) => {
    if (!id || depth > 8) return null;
    const s = raw.get(id);
    const name = (s?.name ?? '').toLowerCase();
    if (/^toc\b|^table of contents/.test(name) || /^toc/i.test(id)) return 'toc';
    let m = name.match(/^heading\s*([1-9])$/) ?? String(id).match(/^heading([1-9])$/i);
    if (m) return Number(m[1]);
    if (name === 'title' || id === 'Title') return 1;
    if (s && Number.isInteger(s.outline) && s.outline >= 0 && s.outline < 9) return s.outline + 1;
    return s?.basedOn ? levelOf(s.basedOn, depth + 1) : null;
  };
  const cache = new Map();
  return (id) => { if (!cache.has(id)) cache.set(id, levelOf(id)); return cache.get(id); };
}

// Subtrees whose text is not part of the document as read: deleted text,
// field instructions, the legacy (VML) duplicate of a drawing, properties.
const DOCX_SKIP = new Set(['mc:Fallback', 'w:del', 'w:moveFrom', 'w:delText', 'w:instrText', 'w:rPr', 'w:sectPr', 'w:footnoteReference', 'w:endnoteReference']);

function docxBlocks(zip) {
  const rootRels = relsOf(zip.text('_rels/.rels'), '');
  const main = [...rootRels.values()].find((r) => r.type.endsWith('/officeDocument'))?.target ?? 'word/document.xml';
  const xml = zip.text(main);
  if (!xml || !xml.includes('w:body')) throw new DocumentError('The selected file is not a Word document. Check it opens, save it again and try again', 415);
  const levelOfStyle = docxStyles(zip.text(posix.join(posix.dirname(main), 'styles.xml')));
  const blocks = [];
  const stack = []; // { kind: 'p', parts, style, outline } | { kind: 'tbl', rows } | { kind: 'tr', cells } | { kind: 'tc', parts }
  let skip = null;
  let skipDepth = 0;
  let inText = false;
  let inPPr = 0;
  const top = (kind) => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === kind) return stack[i]; return null; };
  for (const t of xmlTokens(xml)) {
    if (skip) {
      if (t.name === skip) skipDepth += t.type === 'open' ? 1 : t.type === 'close' ? -1 : 0;
      if (skipDepth === 0) skip = null;
      continue;
    }
    if (t.type === 'text') { if (inText) top('p')?.parts.push(t.text); continue; }
    if (t.type === 'open') {
      if (DOCX_SKIP.has(t.name)) { skip = t.name; skipDepth = 1; continue; }
      switch (t.name) {
        case 'w:p': stack.push({ kind: 'p', parts: [], style: null, outline: null }); break;
        case 'w:pPr': inPPr++; break;
        case 'w:pStyle': if (inPPr && top('p')) top('p').style = t.attrs['w:val']; break;
        case 'w:outlineLvl': if (inPPr && top('p')) top('p').outline = Number(t.attrs['w:val']); break;
        case 'w:t': inText = true; break;
        case 'w:tab': if (!inPPr) top('p')?.parts.push('\t'); break;
        case 'w:br': case 'w:cr': top('p')?.parts.push('\n'); break;
        case 'w:noBreakHyphen': top('p')?.parts.push('-'); break;
        case 'w:tbl': stack.push({ kind: 'tbl', rows: [] }); break;
        case 'w:tr': stack.push({ kind: 'tr', cells: [] }); break;
        case 'w:tc': stack.push({ kind: 'tc', parts: [] }); break;
        default: break;
      }
      continue;
    }
    // close
    switch (t.name) {
      case 'w:t': inText = false; break;
      case 'w:pPr': inPPr = Math.max(0, inPPr - 1); break;
      case 'w:p': {
        const p = stack.pop();
        if (p?.kind !== 'p') break;
        const text = clean(p.parts.join(''));
        const parent = stack[stack.length - 1];
        const level = Number.isInteger(p.outline) && p.outline >= 0 && p.outline < 9 ? p.outline + 1 : levelOfStyle(p.style);
        if (level === 'toc' || !text) break;
        if (parent?.kind === 'tc') parent.parts.push(text);
        else if (typeof level === 'number' && text.length <= 300 && !top('tc')) blocks.push({ kind: 'heading', level, text });
        else blocks.push({ kind: 'para', text });
        break;
      }
      case 'w:tc': { const c = stack.pop(); top('tr')?.cells.push(c?.parts?.join('\n') ?? ''); break; }
      case 'w:tr': { const r = stack.pop(); if (r?.cells?.length) top('tbl')?.rows.push(r.cells); break; }
      case 'w:tbl': {
        const tbl = stack.pop();
        if (!tbl?.rows) break;
        const cell = top('tc');
        // A table inside a table cell becomes text in that cell.
        if (cell) cell.parts.push(tbl.rows.map((r) => r.join(' | ')).join('\n'));
        else blocks.push({ kind: 'table', rows: tbl.rows });
        break;
      }
      default: break;
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------

const PH_TITLE = new Set(['title', 'ctrTitle']);
const PH_SKIP = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);

/** One slide (or notes page) -> { title, items: [{ kind: 'para'|'table' }] }. */
function slideContent(xml, { bodyOnly = false } = {}) {
  const items = [];
  const titles = [];
  const shapes = []; // open p:sp
  const tables = []; // open a:tbl { rows, row, cell }
  let para = null;
  let inText = false;
  for (const t of xmlTokens(xml)) {
    if (t.type === 'text') { if (inText && para) para.push(t.text); continue; }
    if (t.type === 'open') {
      switch (t.name) {
        case 'p:sp': shapes.push({ ph: null, paras: [] }); break;
        case 'p:ph': if (shapes.length) shapes[shapes.length - 1].ph = t.attrs.type ?? 'body'; break;
        case 'a:p': para = []; break;
        case 'a:t': inText = true; break;
        case 'a:br': para?.push('\n'); break;
        case 'a:tbl': tables.push({ rows: [], row: null, cell: null }); break;
        case 'a:tr': if (tables.length) tables[tables.length - 1].row = []; break;
        case 'a:tc': if (tables.length) tables[tables.length - 1].cell = []; break;
        default: break;
      }
      continue;
    }
    switch (t.name) {
      case 'a:t': inText = false; break;
      case 'a:p': {
        const text = clean((para ?? []).join(''));
        para = null;
        if (!text) break;
        const tbl = tables[tables.length - 1];
        if (tbl?.cell) tbl.cell.push(text);
        else if (shapes.length) shapes[shapes.length - 1].paras.push(text);
        break;
      }
      case 'a:tc': { const tbl = tables[tables.length - 1]; if (tbl?.cell && tbl.row) { tbl.row.push(tbl.cell.join(' ')); tbl.cell = null; } break; }
      case 'a:tr': { const tbl = tables[tables.length - 1]; if (tbl?.row) { tbl.rows.push(tbl.row); tbl.row = null; } break; }
      case 'a:tbl': { const tbl = tables.pop(); if (tbl?.rows.length && !bodyOnly) items.push({ kind: 'table', rows: tbl.rows }); break; }
      case 'p:sp': {
        const s = shapes.pop();
        if (!s || PH_SKIP.has(s.ph)) break;
        if (bodyOnly && s.ph !== 'body') break;
        if (PH_TITLE.has(s.ph)) titles.push(s.paras.join(' '));
        else for (const text of s.paras) items.push({ kind: 'para', text });
        break;
      }
      default: break;
    }
  }
  return { title: clean(titles.join(' ')), items };
}

function pptxBlocks(zip) {
  const pres = zip.text('ppt/presentation.xml');
  if (!pres) throw new DocumentError('The selected file is not a PowerPoint presentation. Check it opens, save it again and try again', 415);
  const rels = relsOf(zip.text('ppt/_rels/presentation.xml.rels'), 'ppt');
  let slides = [];
  for (const t of xmlTokens(pres)) {
    if (t.type === 'open' && t.name === 'p:sldId') { const r = rels.get(t.attrs['r:id']); if (r) slides.push(r.target); }
  }
  if (!slides.length) {
    slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/i)[1]) - Number(b.match(/(\d+)\.xml$/i)[1]));
  }
  const blocks = [];
  slides.forEach((path, i) => {
    const xml = zip.text(path);
    if (!xml) return;
    const { title, items } = slideContent(xml);
    const label = `Slide ${i + 1}`;
    blocks.push({ kind: 'heading', level: 1, text: title || label, label });
    for (const item of items) blocks.push(item);
    const slideRels = relsOf(zip.text(posix.join(posix.dirname(path), '_rels', `${posix.basename(path)}.rels`)), posix.dirname(path));
    const notesPath = [...slideRels.values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
    const notesXml = notesPath ? zip.text(notesPath) : null;
    if (notesXml) {
      const notes = slideContent(notesXml, { bodyOnly: true }).items.map((x) => x.text).filter(Boolean);
      if (notes.length) blocks.push({ kind: 'para', text: `Speaker notes: ${notes.join('\n')}` });
    }
  });
  return blocks;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Take the inline Markdown out of one line: links, emphasis, code, HTML.
 * Every repeat is bounded, so a hostile line cannot make a pattern backtrack
 * across the whole document.
 */
export function stripInline(s) {
  return s
    .replace(/!\[([^\]]{0,500})\]\([^)]{0,2000}\)/g, '$1')
    .replace(/\[([^\]]{1,500})\]\([^)]{0,2000}\)/g, '$1')
    .replace(/\[([^\]]{1,500})\]\[[^\]]{0,200}\]/g, '$1')
    .replace(/<(https?:[^>\s]{1,2000})>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]{0,500}>/g, '')
    .replace(/`([^`]{0,1000})`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([^\n]{0,500}?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]{0,500}?\S)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]{0,500}?\S)_(?![\w])/g, '$1$2')
    .replace(/~~(?=\S)([^\n]{0,500}?\S)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => clean(stripInline(c.trim())));

function markdownBlocks(input) {
  let text = input.replace(/\r\n?/g, '\n');
  const fm = text.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) text = text.slice(fm[0].length);
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { const t = clean(stripInline(para.join(' '))); if (t) blocks.push({ kind: 'para', text: t }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const next = lines[i + 1] ?? '';
    if (/^(```|~~~)/.test(trimmed)) {
      flush();
      const fence = trimmed.slice(0, 3);
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) code.push(lines[i]);
      const t = clean(code.join('\n'));
      if (t) blocks.push({ kind: 'para', text: t });
      continue;
    }
    if (!trimmed) { flush(); continue; }
    let m = trimmed.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) { flush(); const t = clean(stripInline(m[2])); if (t) blocks.push({ kind: 'heading', level: m[1].length, text: t }); continue; }
    if (!para.length && /^(=+|-+)\s*$/.test(next.trim()) && next.trim().length >= 2 && !/^[-*+]\s/.test(trimmed) && !trimmed.includes('|')) {
      blocks.push({ kind: 'heading', level: next.trim()[0] === '=' ? 1 : 2, text: clean(stripInline(trimmed)) });
      i++;
      continue;
    }
    if (trimmed.includes('|') && TABLE_RULE.test(next)) {
      flush();
      const rows = [splitRow(trimmed)];
      for (i += 2; i < lines.length && lines[i].trim().includes('|') && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
      i--;
      blocks.push({ kind: 'table', rows });
      continue;
    }
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed.replace(/\s/g, ''))) { flush(); continue; }
    m = trimmed.match(/^(?:[-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (m) { flush(); para = [m[1]]; continue; }
    para.push(trimmed.replace(/^>\s?/, ''));
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

/** A heading level if this line looks like a heading, else 0. */
function headingLevel(line) {
  if (line.length > 120 || !/[A-Za-z]/.test(line) || /[.,;:]$/.test(line)) return 0;
  if (/^(chapter|part|appendix|annex|schedule)\s+\w/i.test(line)) return 1;
  if (/^(strategic\s+)?policy\s+[A-Z]{0,6}[\s/-]?\d/i.test(line)) return 3;
  const num = line.match(/^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+[A-Z]/);
  if (num) return Math.min(4, num[1].split('.').length);
  const letters = line.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 4 && letters === letters.toUpperCase()) return 1;
  const words = line.split(/\s+/);
  const significant = words.filter((w) => w.length > 3);
  if (words.length <= 10 && /^[A-Z]/.test(line) && significant.length && significant.filter((w) => /^[A-Z]/.test(w)).length / significant.length >= 0.6) return 2;
  return 0;
}

function textBlocks(input) {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const blank = lines.filter((l) => !l.trim()).length;
  // A file with almost no blank lines has one paragraph per line (Word's
  // "Save as plain text"); otherwise paragraphs are separated by blank lines.
  const perLine = lines.length > 20 && blank / lines.length < 0.05;
  const groups = [];
  let cur = [];
  for (const l of lines) {
    if (!l.trim()) { if (cur.length) groups.push(cur); cur = []; continue; }
    if (perLine) groups.push([l]); else cur.push(l);
  }
  if (cur.length) groups.push(cur);
  const blocks = [];
  for (const g of groups) {
    const t = clean(g.join(' '));
    const level = g.length === 1 ? headingLevel(t) : 0;
    blocks.push(level ? { kind: 'heading', level, text: t } : { kind: 'para', text: t });
  }
  return blocks;
}
