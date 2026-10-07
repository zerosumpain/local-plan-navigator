// scripts/make-sample-plan.mjs — the fictional sample plan, in the formats the checker reads.
//
// content/samples/ holds the sample in Markdown: a draft local plan for an
// invented authority, Northwold District Council, written with deliberate
// gaps (allocations missing footnote 8 details, policies that restate
// national policy, outcomes without targets) so the checker has something to
// find, and a short summary deck. This turns them into
//
//   northwold-draft-local-plan.md     the plan, as written
//   northwold-draft-local-plan.docx   the plan as a Word document, with real
//                                     heading styles and tables
//   northwold-summary-deck.pptx       the deck, one slide per section, with
//                                     speaker notes
//
// The build calls it to put the three files in dist/samples/ for the page's
// "try it with the sample plan" links; `node scripts/make-sample-plan.mjs [dir]`
// writes them anywhere. Nothing is committed in binary form, so the files can
// never drift from the Markdown.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDocx } from '../server/checker/docx.mjs';
import { stripInline } from '../server/checker/read-document.mjs';
import { buildPptx } from './lib/pptx.mjs';

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripInline(c.trim()));

/** Bold runs for **text**, plain runs for the rest. */
function runs(text) {
  const out = [];
  for (const [i, part] of text.split(/\*\*(.+?)\*\*/).entries()) if (part) out.push({ text: stripInline(part), bold: i % 2 === 1 });
  return out;
}

/** The plan's Markdown as Word blocks: # title, ## to #### headings 1 to 3, lists, tables, the notice as a note. */
export function planBlocks(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let bullets = [];
  const flush = () => {
    if (para.length) { blocks.push({ type: 'para', runs: runs(para.join(' ')) }); para = []; }
    if (bullets.length) { blocks.push({ type: 'bullets', items: bullets.map(runs) }); bullets = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { flush(); continue; }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); blocks.push(h[1].length === 1 ? { type: 'title', text: h[2] } : { type: 'heading', level: h[1].length - 1, text: h[2] }); continue; }
    if (t.startsWith('>')) { flush(); blocks.push({ type: 'para', style: 'Note', runs: runs(t.replace(/^>\s?/, '')) }); continue; }
    if (t.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flush();
      const header = cells(t);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim().includes('|'); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const b = t.match(/^[-*]\s+(.*)$/);
    if (b) { if (para.length) flush(); bullets.push(b[1]); continue; }
    if (bullets.length) flush();
    para.push(t);
  }
  flush();
  return blocks;
}

/** The deck's Markdown as slides: "---" between slides, "# " title, "> " subtitle, "- " bullets, one table, "Notes:". */
export function deckSlides(md) {
  return md.replace(/\r\n?/g, '\n').split(/\n---\n/).map((chunk) => {
    const slide = { title: '', bullets: [] };
    const lines = chunk.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      if (t.startsWith('# ')) slide.title = t.slice(2);
      else if (t.startsWith('> ')) slide.subtitle = t.slice(2);
      else if (t.startsWith('- ')) slide.bullets.push(t.slice(2));
      else if (t.startsWith('Notes:')) slide.notes = [t.slice(6).trim(), ...lines.slice(i + 1).map((l) => l.trim()).filter(Boolean)].join('\n');
      else if (t.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
        const header = cells(t);
        const rows = [];
        for (i += 2; i < lines.length && lines[i].trim().includes('|'); i++) rows.push(cells(lines[i]));
        i--;
        slide.table = { header, rows };
      }
      if (slide.notes) break;
    }
    return slide;
  });
}

export async function makeSamplePlan({ root, outDir }) {
  const src = path.join(root, 'content/samples');
  const planMd = await readFile(path.join(src, 'northwold-draft-local-plan.md'), 'utf8');
  const deckMd = await readFile(path.join(src, 'northwold-summary-deck.md'), 'utf8');
  const files = [
    ['northwold-draft-local-plan.md', Buffer.from(planMd)],
    ['northwold-draft-local-plan.docx', buildDocx({ title: 'Northwold Local Plan 2027 to 2042 (fictional sample)', footer: 'Fictional sample plan for the Local Plan Navigator prototype. Northwold District Council does not exist.', blocks: planBlocks(planMd) })],
    ['northwold-summary-deck.pptx', buildPptx({ title: 'Northwold Local Plan summary (fictional sample)', slides: deckSlides(deckMd) })],
  ];
  await mkdir(outDir, { recursive: true });
  const out = [];
  for (const [name, data] of files) {
    await writeFile(path.join(outDir, name), data);
    out.push({ path: path.join(outDir, name), bytes: data.length });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const outDir = path.resolve(process.argv[2] ?? path.join(root, 'dist/samples'));
  for (const f of await makeSamplePlan({ root, outDir })) console.log(`${f.path}  ${(f.bytes / 1024).toFixed(1)} KB`);
}
