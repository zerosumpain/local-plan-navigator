// scripts/fetch-sources.mjs — refresh content/sources/ from the originals.
//
// A deliberate, separate step: the build never touches the network. This
// script downloads each source, converts it to the Markdown the corpus
// builder reads, and reports what changed. It is how the prototype is kept
// honest when the guidance moves.
//
//   node scripts/fetch-sources.mjs          # everything
//   node scripts/fetch-sources.mjs nppf     # one source id
//
// GOV.UK pages come from the content API (clean HTML in JSON); legislation
// from legislation.gov.uk's XML; the NPPF is a PDF, extracted with pdftotext
// (poppler-utils) if it is installed, otherwise skipped with a warning.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const TurndownService = require('turndown');
const run = promisify(execFile);

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { sources } = JSON.parse(await readFile(path.join(root, 'content/sources.json'), 'utf8'));
const only = process.argv[2];
const UA = 'local-plan-navigator (prototype; https://github.com/zerosumpain/local-plan-navigator)';

// Where each source id comes from. GOV.UK: the content API path. Legislation:
// the XML endpoint for the whole instrument (or one regulation).
const ORIGINS = {
  '30-month-overview': { govuk: '/guidance/30-month-local-plan-process-an-overview' },
  'procedural-guide': { govuk: '/guidance/procedural-guide-for-examinations-and-gateways-under-the-town-and-country-planning-local-planning-england-regulations-2026' },
  'gateway-1': { govuk: '/guidance/gateway-1-for-local-plans-what-you-need-to-do' },
  'gateway-2': { govuk: '/guidance/gateway-2-assessment-for-local-plans-what-you-need-to-do' },
  'gateway-3': { govuk: '/guidance/gateway-3-for-local-plans-what-you-need-to-do' },
  'creating-a-plan-timetable': { govuk: '/guidance/creating-a-plan-timetable' },
  'giving-notice': { govuk: '/guidance/giving-notice-of-your-plan-making' },
  'getting-ready': { govuk: '/guidance/getting-ready-to-prepare-a-new-plan' },
  'engaging-the-public': { govuk: '/guidance/engaging-the-public-when-preparing-a-local-plan' },
  'gathering-baseline-information': { govuk: '/guidance/gathering-baselining-information-to-inform-a-local-plan' },
  'preparing-a-vision': { govuk: '/guidance/preparing-a-local-plan-vision' },
  'making-documents-available': { govuk: '/guidance/making-your-local-plan-documents-publicly-available' },
  'regulations-2026': { legislation: 'https://www.legislation.gov.uk/uksi/2026/186/data.xml' },
  'sea-regulations-2004': { legislation: 'https://www.legislation.gov.uk/uksi/2004/1633/data.xml' },
  'costs-regulations-2026': { legislation: 'https://www.legislation.gov.uk/uksi/2026/187/data.xml' },
  nppf: { pdfFrom: '/guidance/national-planning-policy-framework' },
};

const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
td.addRule('table', {
  filter: 'table',
  replacement: (content, node) => {
    const rows = Array.from(node.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
    if (!rows.length) return '';
    return '\n\n' + [rows[0], rows[0].map(() => '---'), ...rows.slice(1)].map((r) => '| ' + r.join(' | ') + ' |').join('\n') + '\n\n';
  },
});

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function govukToMarkdown(base) {
  const n = JSON.parse(await fetchText(`https://www.gov.uk/api/content${base}`));
  const md = td.turndown(n.details.body).replace(/ /g, ' ');
  return { text: `---\ntitle: ${n.title}\nurl: https://www.gov.uk${n.base_path}\npublished: ${n.first_published_at}\nupdated: ${n.public_updated_at}\npublisher: ${(n.links.organisations || []).map((o) => o.title).join('; ')}\n---\n\n${md}`, updated: (n.public_updated_at || '').slice(0, 10), attachments: n.details.attachments || [] };
}

/** legislation.gov.uk CLML XML -> Markdown: Parts, regulations (### N. Title), numbered paragraphs, schedules. */
function legislationToMarkdown(xml) {
  let x = xml.replace(/<ukm:Metadata[\s\S]*?<\/ukm:Metadata>/g, '').replace(/<Commentaries>[\s\S]*?<\/Commentaries>/g, '').replace(/<CommentaryRef[^>]*\/>/g, '').replace(/<Versions>[\s\S]*?<\/Versions>/g, '');
  const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const out = [];
  const title = (x.match(/<Title>([^<]*)<\/Title>/) || [])[1];
  if (title) out.push('# ' + text(title) + '\n');
  const re = /<(\/?)(Part|Chapter|Pblock|P1group|P1|P2|P3|P4|Schedule|Title|Number|Pnumber|Text|ExplanatoryNotes|tr|td|th|Tabular|table)\b[^>]*>|([^<]+)|<[^>]+>/g;
  const stack = []; let buf = ''; let depth = 0; let pending = { num: '', title: '' };
  let inTitle = false, inNumber = false, inPnumber = false, inText = false, inTable = false, row = [];
  const flush = () => { if (buf.trim()) out.push('  '.repeat(Math.max(0, depth - 1)) + buf.trim()); buf = ''; };
  let m;
  while ((m = re.exec(x))) {
    const [, close, tag, chars] = m;
    if (chars !== undefined) { if (inTitle || inNumber || inPnumber || inText || inTable) buf += chars; continue; }
    if (!tag) continue;
    const open = !close;
    switch (tag) {
      case 'Part': case 'Chapter': case 'Schedule': case 'Pblock': case 'ExplanatoryNotes': case 'P1group':
        if (open) { stack.push(tag); pending = { num: '', title: '' }; } else stack.pop(); break;
      case 'Number': if (open) { inNumber = true; buf = ''; } else { inNumber = false; pending.num = text(buf); buf = ''; } break;
      case 'Title':
        if (open) { inTitle = true; buf = ''; } else {
          inTitle = false; const t = text(buf); buf = ''; const top = stack[stack.length - 1];
          if (top === 'Part' || top === 'Schedule') out.push('\n## ' + (pending.num ? pending.num + ' — ' : '') + t + '\n');
          else if (top === 'Chapter') out.push('\n### ' + (pending.num ? pending.num + ' — ' : '') + t + '\n');
          else if (top === 'Pblock') out.push('\n#### ' + t + '\n');
          else if (top === 'ExplanatoryNotes') out.push('\n## ' + t + '\n');
          else if (top === 'P1group') pending.title = t;
        } break;
      case 'P1': case 'P2': case 'P3': case 'P4':
        if (open) depth = Number(tag[1]); else { flush(); depth = Math.max(0, Number(tag[1]) - 1); } break;
      case 'Pnumber': if (open) { inPnumber = true; buf = ''; } else { inPnumber = false; const n = text(buf); buf = ''; if (depth === 1) out.push('\n### ' + n + '. ' + pending.title + '\n'); else buf = '(' + n + ') '; } break;
      case 'Text': if (open) inText = true; else { inText = false; flush(); } break;
      case 'Tabular': case 'table': inTable = open; if (!open) out.push(''); break;
      case 'tr': if (open) row = []; else out.push('| ' + row.join(' | ') + ' |'); break;
      case 'td': case 'th': if (open) buf = ''; else { row.push(text(buf)); buf = ''; } break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

for (const src of sources) {
  if (only && src.id !== only) continue;
  const origin = ORIGINS[src.id];
  const file = path.join(root, 'content/sources', src.file);
  const before = await readFile(file, 'utf8').catch(() => '');
  let after, updated = src.updated;
  try {
    if (origin.govuk) ({ text: after, updated } = await govukToMarkdown(origin.govuk));
    else if (origin.legislation) after = legislationToMarkdown(await fetchText(origin.legislation));
    else if (origin.pdfFrom) {
      const page = JSON.parse(await fetchText(`https://www.gov.uk/api/content${origin.pdfFrom}`));
      const pdf = (page.details.attachments || []).find((a) => a.content_type === 'application/pdf');
      if (!pdf) throw new Error('no PDF attachment on the NPPF page');
      const res = await fetch(pdf.url, { headers: { 'user-agent': UA } });
      const tmp = path.join(root, '.cache'); await run('mkdir', ['-p', tmp]);
      const pdfPath = path.join(tmp, 'nppf.pdf');
      await writeFile(pdfPath, Buffer.from(await res.arrayBuffer()));
      try { await run('pdftotext', ['-layout', pdfPath, path.join(tmp, 'nppf.txt')]); after = await readFile(path.join(tmp, 'nppf.txt'), 'utf8'); }
      catch { console.warn(`  ${src.id}: pdftotext is not installed; the PDF is at ${pdfPath}, the text was not refreshed`); continue; }
      updated = (page.public_updated_at || '').slice(0, 10);
    }
  } catch (err) { console.error(`  ${src.id}: ${err.message}`); continue; }
  const changed = after !== before;
  if (changed) await writeFile(file, after);
  console.log(`${changed ? 'updated ' : 'same    '} ${src.id} (${updated})`);
}
console.log('Now update the "updated" dates in content/sources.json where they moved, and rebuild.');
