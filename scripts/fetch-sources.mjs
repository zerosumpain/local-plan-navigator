// scripts/fetch-sources.mjs — refresh content/sources/ from the originals.
//
// A deliberate, separate step: the build never touches the network. This
// script downloads each source, converts it to the Markdown the corpus
// builder reads, and reports what changed. It is how the prototype is kept
// honest when the guidance moves.
//
//   node scripts/fetch-sources.mjs                  # everything
//   node scripts/fetch-sources.mjs nppf pcpa-2004   # some source ids
//
// GOV.UK pages come from the content API (clean HTML in JSON); legislation
// from legislation.gov.uk's XML; the NPPF is a PDF, extracted with pdftotext
// (poppler-utils) if it is installed, otherwise skipped with a warning.
//
// Two kinds of source are kept to the parts a plan-maker needs rather than
// taken whole: a Planning Practice Guidance chapter can name the `sections`
// (its ## headings) to keep, and an Act can name the provisions `from` and
// `to` (legislation.gov.uk element ids) to cut out of a Part or Chapter.
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
const only = process.argv.slice(2);
const UA = 'local-plan-navigator (prototype; https://github.com/zerosumpain/local-plan-navigator)';

// Where each source id comes from. GOV.UK: the content API path. Legislation:
// the XML endpoint for the whole instrument, or a Part or Chapter of an Act
// with the first and last provisions to keep.
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
  // Site allocations: the new system's four-stage site selection guidance.
  'site-selection': { govuk: '/guidance/selecting-identifying-and-assessing-sites-for-local-plans' },
  'site-selection-stage-1': { govuk: '/guidance/identifying-sites-for-local-plans-stage-1' },
  'site-selection-stage-2': { govuk: '/guidance/assessing-sites-for-local-plans-stage-2' },
  'site-selection-stage-3': { govuk: '/guidance/determining-your-draft-allocations-for-local-plans-stage-3' },
  'site-selection-stage-4': { govuk: '/guidance/confirming-draft-allocations-and-recording-decisions-for-local-plans-stage-4' },
  // The rest of the new-system collection a plan-maker needs.
  'publish-plan-data': { govuk: '/government/publications/publish-your-plan-data/publish-your-plan-data' },
  'housing-requirement-data': { govuk: '/guidance/publishing-your-local-plan-housing-requirement' },
  'requirement-to-assist': { govuk: '/guidance/issue-a-requirement-to-assist-notice' },
  'local-government-reorganisation': { govuk: '/guidance/plan-making-and-local-government-reorganisation' },
  // Planning Practice Guidance: only the plan-making parts of the long chapters.
  'ppg-land-availability': { govuk: '/guidance/housing-and-economic-land-availability-assessment' },
  'ppg-viability': { govuk: '/guidance/viability', sections: ['Viability and plan making', 'Golden Rules for Green Belt development'] },
  'ppg-flood-risk': { govuk: '/guidance/flood-risk-and-coastal-change', sections: ['Taking flood risk into account in preparing plans', 'The sequential approach to the location of development', 'The Exception Test'], dropQuestions: /application/i },
  // Primary legislation: the plan-making provisions, not the whole Acts.
  'pcpa-2004': { legislation: 'https://www.legislation.gov.uk/ukpga/2004/5/part/2/data.xml', from: 'part-2-crossheading-plan-timetables', to: 'section-15LH', crossheadingLevel: 2 },
  'lura-2023': { legislation: 'https://www.legislation.gov.uk/ukpga/2023/55/part/3/chapter/2/data.xml', from: 'part-3-chapter-2-crossheading-development-plans-and-national-policy', to: 'section-100' },
  'planning-data-regulations-2026': { legislation: 'https://www.legislation.gov.uk/uksi/2026/420/data.xml' },
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

const slug = (s) => String(s).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/** Keep the ## sections named in `keep` (and, inside them, drop the ### questions matching `drop`). */
function selectSections(md, keep, drop) {
  const wanted = keep.map((k) => k.toLowerCase());
  const out = [];
  let on = false, skip = false;
  for (const line of md.split('\n')) {
    const m = line.match(/^(#{2,3}) (.*?)\s*$/);
    if (m && m[1].length === 2) { on = wanted.some((k) => m[2].toLowerCase().startsWith(k)); skip = false; }
    else if (m && on) skip = Boolean(drop?.test(m[2]));
    if (on && !skip) out.push(line);
  }
  return out.join('\n');
}

/**
 * Links that only work on GOV.UK — a fragment of a section this copy does not
 * have (or that GOV.UK names differently), or a path on www.gov.uk — become
 * absolute links to the original, so the reference page has no dead links.
 */
function absoluteLinks(md, pageUrl) {
  const ids = new Set([...md.matchAll(/^#{1,4}\s+(.+?)\s*$/gm)].map((m) => slug(m[1].replace(/\\\./g, '.'))));
  return md
    .replace(/\]\(#([^)\s]+)\)/g, (all, frag) => (ids.has(frag) ? all : `](${pageUrl}#${frag})`))
    .replace(/\]\(\/(?!\/)/g, '](https://www.gov.uk/');
}

async function govukToMarkdown(base, origin = {}) {
  const n = JSON.parse(await fetchText(`https://www.gov.uk/api/content${base}`));
  let md = td.turndown(n.details.body).replace(/ /g, ' ');
  if (origin.sections) md = selectSections(md, origin.sections, origin.dropQuestions);
  md = absoluteLinks(md, `https://www.gov.uk${n.base_path}`);
  return { text: `---\ntitle: ${n.title}\nurl: https://www.gov.uk${n.base_path}\npublished: ${n.first_published_at}\nupdated: ${n.public_updated_at}\npublisher: ${(n.links.organisations || []).map((o) => o.title).join('; ')}\n---\n\n${md}`, updated: (n.public_updated_at || '').slice(0, 10), attachments: n.details.attachments || [] };
}

/**
 * Cut the provisions `from`..`to` (legislation.gov.uk element ids) out of a
 * Part or Chapter. A section's id is on its <P1>, so the cut widens to the
 * <P1group> around it, which carries the section's title.
 */
function sliceLegislation(xml, from, to) {
  const start = (id) => {
    const at = xml.indexOf(`id="${id}"`);
    if (at < 0) throw new Error(`no provision with id ${id}`);
    const tag = xml.lastIndexOf('<', at);
    return /^<P1[\s>]/.test(xml.slice(tag, tag + 4)) ? xml.lastIndexOf('<P1group', tag) : tag;
  };
  const a = start(from);
  // The end of the element that starts at start(to), counting nested groups:
  // an amending section can contain the whole of the section it inserts.
  const b = start(to);
  const name = xml.slice(b + 1).match(/^[A-Za-z0-9]+/)[0];
  const tags = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, 'g');
  tags.lastIndex = b;
  let depth = 0, end = -1, t;
  while ((t = tags.exec(xml))) {
    if (t[2]) continue; // self-closing
    depth += t[1] ? -1 : 1;
    if (depth === 0) { end = tags.lastIndex; break; }
  }
  if (end < 0) throw new Error(`provision ${to} is not closed`);
  // No title of its own: sources.json names the extract, and an Act's title
  // with nothing under it would become an empty first page.
  return `<Legislation>${xml.slice(a, end)}</Legislation>`;
}

/**
 * legislation.gov.uk CLML XML -> Markdown: Parts, regulations or sections
 * (### N. Title), numbered paragraphs, schedules. A provision that has been
 * enacted but is not yet in force (Status="Prospective") says so in its
 * heading. Cross-headings are #### unless `crossheadingLevel` says otherwise
 * (an Act cut into pages by cross-heading uses 2).
 */
function legislationToMarkdown(xml, { from, to, crossheadingLevel = 4 } = {}) {
  if (from) xml = sliceLegislation(xml, from, to ?? from);
  let x = xml.replace(/<ukm:Metadata[\s\S]*?<\/ukm:Metadata>/g, '').replace(/<Commentaries>[\s\S]*?<\/Commentaries>/g, '').replace(/<CommentaryRef[^>]*\/>/g, '').replace(/<Versions>[\s\S]*?<\/Versions>/g, '');
  const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const out = [];
  const title = from ? undefined : (x.match(/<Title>([^<]*)<\/Title>/) || [])[1];
  if (title) out.push('# ' + text(title) + '\n');
  const re = /<(\/?)(Part|Chapter|Pblock|P1group|P1|P2|P3|P4|Schedule|Title|Number|Pnumber|Text|ExplanatoryNotes|tr|td|th|Tabular|table)\b([^>]*)>|([^<]+)|<[^>]+>/g;
  const prospective = (attrs) => /\bStatus="Prospective"/.test(attrs);
  const stack = []; let buf = ''; let depth = 0; let pending = { num: '', title: '', prospective: false };
  let inTitle = false, inNumber = false, inPnumber = false, inText = false, inTable = false, row = [];
  const flush = () => { if (buf.trim()) out.push('  '.repeat(Math.max(0, depth - 1)) + buf.trim()); buf = ''; };
  let m;
  while ((m = re.exec(x))) {
    const [, close, tag, attrs, chars] = m;
    if (chars !== undefined) { if (inTitle || inNumber || inPnumber || inText || inTable) buf += chars; continue; }
    if (!tag) continue;
    const open = !close;
    switch (tag) {
      case 'Part': case 'Chapter': case 'Schedule': case 'Pblock': case 'ExplanatoryNotes': case 'P1group':
        if (open) { stack.push(tag); pending = { num: '', title: '', prospective: prospective(attrs) }; } else stack.pop(); break;
      case 'Number': if (open) { inNumber = true; buf = ''; } else { inNumber = false; pending.num = text(buf); buf = ''; } break;
      case 'Title':
        if (open) { inTitle = true; buf = ''; } else {
          inTitle = false; const t = text(buf); buf = ''; const top = stack[stack.length - 1];
          if (top === 'Part' || top === 'Schedule') out.push('\n## ' + (pending.num ? pending.num + ' — ' : '') + t + '\n');
          else if (top === 'Chapter') out.push('\n### ' + (pending.num ? pending.num + ' — ' : '') + t + '\n');
          else if (top === 'Pblock') out.push('\n' + '#'.repeat(crossheadingLevel) + ' ' + t + '\n');
          else if (top === 'ExplanatoryNotes') out.push('\n## ' + t + '\n');
          else if (top === 'P1group') pending.title = t;
        } break;
      case 'P1': case 'P2': case 'P3': case 'P4':
        if (open) { depth = Number(tag[1]); if (tag === 'P1' && prospective(attrs)) pending.prospective = true; } else { flush(); depth = Math.max(0, Number(tag[1]) - 1); } break;
      case 'Pnumber': if (open) { inPnumber = true; buf = ''; } else { inPnumber = false; const n = text(buf); buf = ''; if (depth === 1) out.push('\n### ' + n + '. ' + pending.title + (pending.prospective ? ' (prospective: not yet in force)' : '') + '\n'); else buf = '(' + n + ') '; } break;
      case 'Text': if (open) inText = true; else { inText = false; flush(); } break;
      case 'Tabular': case 'table': inTable = open; if (!open) out.push(''); break;
      case 'tr': if (open) row = []; else out.push('| ' + row.join(' | ') + ' |'); break;
      case 'td': case 'th': if (open) buf = ''; else { row.push(text(buf)); buf = ''; } break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

for (const src of sources) {
  if (only.length && !only.includes(src.id)) continue;
  const origin = ORIGINS[src.id];
  const file = path.join(root, 'content/sources', src.file);
  const before = await readFile(file, 'utf8').catch(() => '');
  let after, updated = src.updated;
  try {
    if (!origin) throw new Error('no origin in ORIGINS for this source id');
    if (origin.govuk) ({ text: after, updated } = await govukToMarkdown(origin.govuk, origin));
    else if (origin.legislation) {
      const xml = await fetchText(origin.legislation);
      after = legislationToMarkdown(xml, origin);
      // The date the revised text on legislation.gov.uk is valid from (absent for a new instrument as made).
      updated = (xml.match(/<dct:valid>([^<]+)<\/dct:valid>/) || [])[1] ?? updated;
    }
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
