// server/checker/detect.mjs — find the plan's policies, site allocations and outcomes.
//
// Done in code, from the headings and tables, so the same document always
// gives the same list and the report has the same shape every time. English
// local plans almost always head a policy "Policy XX1: Title" (or put the code
// first, "NW/H1: Land at…"), and many also have a schedule of sites in a table
// with a reference column; both are recognised. Only when nothing at all is
// found does the pipeline ask the model to identify them from the outline.
//
// A policy is treated as a site allocation when its heading says so ("Site
// allocation SA4"), its title names a piece of land ("Land north of…",
// "Former Maltings"), or its text uses the vocabulary of an allocation (site
// area, site reference, site capacity, site requirements).

const PREFIX = String.raw`(?:(?:Strategic|STRATEGIC|Draft|DRAFT|Proposed|PROPOSED|Development [Mm]anagement|Local|LOCAL)\s+)?`;
const KIND = String.raw`(Policy|POLICY|Policies|Site [Aa]llocation|SITE ALLOCATION|Allocation|ALLOCATION|Site|SITE)`;
const CODE = String.raw`([A-Z]{1,6}(?:[/.-]?[A-Z]{1,6})?[\s/.-]?\d{1,3}[a-z]?)`;
const POLICY_HEADING = new RegExp(String.raw`^${PREFIX}${KIND}\s+${CODE}(?![\w/])\s*[:.)–—-]?\s*(.*)$`);
const CODE_FIRST = new RegExp(String.raw`^${CODE}\s*[:–—-]\s+(\S.*)$`);
const LAND = /\b(land\s+(?:at|to|off|of|by|near|behind|between|adjacent|adjoining|north|south|east|west|rear)|site|sites|farm|quarter|garden village|urban extension|village extension|depot|maltings|works|yard|former|barracks|airfield|mill|wharf|business park extension|employment area|brickworks|hospital site)\b/i;
const ALLOCATION_TEXT = /\bsite (area|reference|capacity|requirements?)\b|\ballocated for\b/i;

export const normaliseCode = (code) => String(code).toUpperCase().replace(/\s+/g, '').replace(/[.-]/g, '/');

/** The section and the sections nested under it, up to the next heading at its level or above. */
function blockOf(doc, index) {
  const s = doc.sections[index];
  const ids = [s.id];
  const texts = [s.text];
  if (doc.type !== 'pptx') {
    for (let i = index + 1; i < doc.sections.length; i++) {
      const next = doc.sections[i];
      if (next.level <= s.level || POLICY_HEADING.test(next.heading) || CODE_FIRST.test(next.heading)) break;
      ids.push(next.id);
      texts.push(`${next.heading}\n${next.text}`);
    }
  }
  return { sectionIds: ids, text: texts.join('\n').trim() };
}

/** Rows of every table whose header has a reference column, as allocation candidates. */
function tableAllocations(doc) {
  const out = [];
  for (const s of doc.sections) {
    for (const t of s.tables) {
      const header = t.rows[0] ?? [];
      const refCol = header.findIndex((c) => /^(site\s*)?ref(erence)?\.?(\s*(no|number|code))?$|^site\s*(id|code)$|^allocation(\s*(ref|reference|code))?$/i.test(c.trim()));
      const nameCol = header.findIndex((c, i) => i !== refCol && /\b(site|name|location|address)\b/i.test(c));
      if (refCol < 0 || nameCol < 0) continue;
      t.rows.slice(1).forEach((row, r) => {
        const ref = (row[refCol] ?? '').trim();
        if (!ref || ref.length > 20 || !/\d/.test(ref)) return;
        out.push({ ref, name: (row[nameCol] ?? '').trim(), sectionId: s.id, locator: s.locator, header: header.join(' | '), row: row.join(' | '), order: doc.sections.indexOf(s) + r / 1000 });
      });
    }
  }
  return out;
}

/**
 * { policies, allocations } found in the document. Every entry carries the
 * section ids its evidence must come from (`scope`), the text the model
 * reads, and extra evidence entries for table rows (`rows`).
 */
export function detectPolicies(doc) {
  const policies = [];
  const allocations = [];
  const seen = new Set();
  doc.sections.forEach((s, i) => {
    let m = s.heading.match(POLICY_HEADING);
    let kind = m?.[1] ?? '';
    let code = m?.[2];
    let title = m?.[3] ?? '';
    if (!m) { m = s.heading.match(CODE_FIRST); code = m?.[1]; title = m?.[2] ?? ''; kind = ''; }
    if (!code) return;
    if (/^policies$/i.test(kind)) return; // "Policies 1 to 5" is a heading about policies, not one
    const key = normaliseCode(code);
    if (seen.has(key)) return;
    seen.add(key);
    const block = blockOf(doc, i);
    const entry = { order: i, code: code.replace(/\s+/g, ''), title: title.replace(/^[:–—-]\s*/, '').trim(), heading: s.heading, locator: s.locator, scope: block.sectionIds, text: block.text };
    const isAllocation = /site|allocation/i.test(kind) || LAND.test(title) || ALLOCATION_TEXT.test(block.text);
    (isAllocation ? allocations : policies).push(entry);
  });
  // A schedule of sites adds rows to the allocations it names, or new ones.
  for (const row of tableAllocations(doc)) {
    const key = normaliseCode(row.ref);
    const rowEvidence = { id: `${row.sectionId}:${key}`, locator: `${row.locator}, table row ${row.ref}`, original: `${row.header}\n${row.row}` };
    const existing = allocations.find((a) => normaliseCode(a.code) === key);
    if (existing) {
      existing.order = Math.min(existing.order, row.order);
      existing.rows = [...(existing.rows ?? []), rowEvidence];
      existing.text += `\nFrom the table in "${row.locator}":\n${row.header}\n${row.row}`;
      continue;
    }
    if (seen.has(key)) continue; // it is a policy, not a site
    seen.add(key);
    allocations.push({ order: row.order, code: row.ref, title: row.name, heading: row.name, locator: rowEvidence.locator, scope: [], rows: [rowEvidence], text: `${row.header}\n${row.row}` });
  }
  // In the order the plan first presents them, whether in a heading or a schedule.
  allocations.sort((a, b) => a.order - b.order);
  return {
    policies: policies.map(({ order, ...p }, i) => ({ id: `P${i + 1}`, ...p })),
    allocations: allocations.map(({ order, ...a }, i) => ({ id: `S${i + 1}`, ...a })),
  };
}

/**
 * The plan's measurable outcomes when they are numbered ("Outcome 3", "MO3",
 * "O3:"), as { number, text, sectionId }. Distinct numbers only, so a
 * monitoring table that repeats them does not double the count.
 */
export function detectOutcomes(doc) {
  const found = new Map();
  for (const s of doc.sections) {
    const lines = [s.heading, ...s.text.split('\n')];
    for (const line of lines) {
      const m = line.match(/^(?:measurable\s+)?outcome\s*(\d{1,2})\b|^MO\s?(\d{1,2})\b|^O(\d{1,2})\s*[:.]/i);
      if (!m) continue;
      const n = Number(m[1] ?? m[2] ?? m[3]);
      if (!found.has(n)) found.set(n, { number: n, text: line.split(' | ')[0].slice(0, 300), sectionId: s.id, locator: s.locator });
    }
  }
  return [...found.values()].sort((a, b) => a.number - b.number);
}

/** A compact outline (headings with the start of their text) for the fallback model call. */
export function outline(doc, budget = 24000) {
  const lines = [];
  let used = 0;
  for (const s of doc.sections) {
    if (!s.heading) continue;
    const line = `[${s.id}] ${'  '.repeat(Math.max(0, s.level - 1))}${s.heading} — ${s.text.slice(0, 140).replace(/\s+/g, ' ')}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/** Turn the fallback model call's answer into the same shape as detectPolicies, checking every section id. */
export function fromModelDetection(doc, answer) {
  const ids = new Set(doc.sections.map((s) => s.id));
  const take = (list) => (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x.section === 'string' && ids.has(x.section))
    .slice(0, 80);
  const build = (x) => {
    const index = doc.sections.findIndex((s) => s.id === x.section);
    const block = blockOf(doc, index);
    const s = doc.sections[index];
    return { code: String(x.code ?? '').slice(0, 20) || s.heading.slice(0, 20), title: String(x.title ?? s.heading).slice(0, 160), heading: s.heading, locator: s.locator, scope: block.sectionIds, text: block.text };
  };
  return {
    policies: take(answer?.policies).map(build).map((p, i) => ({ id: `P${i + 1}`, ...p })),
    allocations: take(answer?.allocations).map(build).map((a, i) => ({ id: `S${i + 1}`, ...a })),
  };
}
