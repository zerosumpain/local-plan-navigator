// server/checker/schema.mjs — what the model must send back, and what a report is.
//
// Two kinds of checking, both by hand so the server keeps no dependencies:
//
//   check*Answer   takes the model's parsed JSON for one call and keeps only
//                  well-formed entries for the ids that were asked about,
//                  listing every problem (a missing id, a status outside the
//                  enum, a clause citing no real national policy) in words of
//                  our own, never the model's. The pipeline retries once on
//                  any problem, then falls back.
//   reportProblems checks a whole report — the one the export endpoint is
//                  sent back by the browser — against version 1 of the
//                  schema documented in docs/checker.md.

export const REPORT_SCHEMA = 'local-plan-navigator/plan-check-report';
export const REPORT_VERSION = 1;
export const STATUSES = ['met', 'partly', 'missing', 'not-assessable'];
export const FINDINGS = ['adds-local-detail', 'partly-restates', 'restates', 'inconsistent'];
export const DOC_TYPES = ['docx', 'pptx', 'md', 'txt'];

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
const texts = (v, items, max) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, items).map((x) => text(x, max)) : null);

/** Parse a model reply that should be one JSON object, tolerating code fences and stray prose. */
export function parseModelJson(reply) {
  if (typeof reply !== 'string') return null;
  const s = reply.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const body = s.slice(start, end + 1);
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, '$1')]) {
    try { const v = JSON.parse(candidate); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* try the next */ }
  }
  return null;
}

/** A batch of rubric items. */
export function checkItemsAnswer(parsed, items, { soundness = false } = {}) {
  const valid = new Map();
  const problems = [];
  const wanted = new Map(items.map((i) => [i.id, i]));
  if (!Array.isArray(parsed?.items)) return { valid, problems: ['no "items" list'] };
  for (const entry of parsed.items) {
    const item = wanted.get(entry?.id);
    if (!item || valid.has(entry.id)) continue;
    const status = entry.status;
    const finding = text(entry.finding, 700);
    if (!STATUSES.includes(status)) { problems.push(`${entry.id}: a status that is not allowed`); continue; }
    if (!finding) { problems.push(`${entry.id}: no finding`); continue; }
    const out = {
      status,
      finding,
      evidence: texts(entry.evidence, 4, 700) ?? [],
      gaps: texts(entry.gaps, 4, 400) ?? [],
      action: text(entry.action, 500) ?? '',
    };
    if (item.rule?.type === 'count-outcomes') out.list = texts(entry.list, 15, 400) ?? [];
    if (item.conditions) {
      const got = Array.isArray(entry.conditions) ? entry.conditions : [];
      const answers = item.conditions.map((_, k) => got.find((c) => Number(c?.n) === k + 1));
      if (answers.some((a) => !a || !['yes', 'no'].includes(a.answer))) { problems.push(`${entry.id}: every condition needs a "yes" or "no"`); continue; }
      out.conditions = answers.map((a) => ({ answer: a.answer, quote: text(a.quote, 700) ?? '' }));
    }
    if (item.rule?.type === 'plan-period') {
      const year = (v) => (v == null || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= 1990 && Number(v) <= 2100 ? Number(v) : undefined);
      const f = entry.facts ?? {};
      const facts = { planStart: year(f.planStart), planEnd: year(f.planEnd), adoption: year(f.adoption) };
      if (Object.values(facts).includes(undefined)) { problems.push(`${entry.id}: facts must be years or null`); continue; }
      out.facts = facts;
    }
    if (soundness) {
      out.questions = texts(entry.questions, 4, 400) ?? [];
      out.evidenceDocuments = texts(entry.evidenceDocuments, 12, 200) ?? [];
      if (!out.questions.length && status !== 'not-assessable') { problems.push(`${entry.id}: no questions`); continue; }
    }
    valid.set(entry.id, out);
  }
  for (const id of wanted.keys()) if (!valid.has(id) && !problems.some((p) => p.startsWith(`${id}:`))) problems.push(`${id}: missing`);
  return { valid, problems };
}

/** A batch of allocations, each with every footnote 8 field. */
export function checkAllocationsAnswer(parsed, allocations, fields) {
  const valid = new Map();
  const problems = [];
  if (!Array.isArray(parsed?.allocations)) return { valid, problems: ['no "allocations" list'] };
  const fieldIds = fields.map((f) => f.id);
  for (const a of allocations) {
    const entry = parsed.allocations.find((x) => x?.id === a.id);
    if (!entry || !Array.isArray(entry.fields)) { problems.push(`${a.id}: missing`); continue; }
    const got = new Map();
    for (const f of entry.fields) {
      if (!fieldIds.includes(f?.id) || got.has(f.id)) continue;
      if (!STATUSES.includes(f.status)) { problems.push(`${a.id}/${f.id}: status not allowed`); continue; }
      got.set(f.id, { status: f.status, evidence: texts(f.evidence, 2, 500) ?? [], note: text(f.note, 300) ?? '' });
    }
    for (const id of fieldIds) if (!got.has(id)) problems.push(`${a.id}/${id}: missing`);
    valid.set(a.id, got);
  }
  return { valid, problems };
}

export const RELATIONS = ['repeats', 'contradicts'];

/** A batch of local policies, each split into clauses with three facts each. */
export function checkPoliciesAnswer(parsed, policies, nationalCodes) {
  const valid = new Map();
  const problems = [];
  if (!Array.isArray(parsed?.policies)) return { valid, problems: ['no "policies" list'] };
  for (const p of policies) {
    const entry = parsed.policies.find((x) => x?.id === p.id);
    if (!entry) { problems.push(`${p.id}: missing`); continue; }
    if (!['met', 'partly', 'missing'].includes(entry.localIssue)) { problems.push(`${p.id}: localIssue not allowed`); continue; }
    if (!Array.isArray(entry.clauses) || !entry.clauses.length) { problems.push(`${p.id}: no clauses`); continue; }
    // Citations must be national decision-making policies, never invented
    // ones: a clause naming anything else makes the answer unusable.
    const clauses = [];
    let bad = null;
    for (const c of entry.clauses.slice(0, 16)) {
      const quote = text(c?.quote, 700);
      if (!quote || typeof c?.local !== 'boolean') { bad = 'a clause without a quote or a true/false "local"'; break; }
      const code = c.national == null || c.national === '' ? null : String(c.national).toUpperCase().replace(/\s+/g, '');
      if (code !== null && !nationalCodes.has(code)) { bad = 'a clause names something that is not a national decision-making policy'; break; }
      if (code !== null && !RELATIONS.includes(c.relation)) { bad = 'a clause naming a national policy needs "repeats" or "contradicts"'; break; }
      clauses.push({ quote, local: c.local, national: code, relation: code ? c.relation : null });
    }
    if (bad) { problems.push(`${p.id}: ${bad}`); continue; }
    valid.set(p.id, {
      clauses,
      explanation: text(entry.explanation, 700) ?? '',
      localIssue: entry.localIssue,
      localIssueNote: text(entry.localIssueNote, 400) ?? '',
    });
  }
  return { valid, problems };
}

/**
 * The status and finding for a policy from its verified clauses, decided in
 * code. A clause counts as local if it has local content or no national
 * decision-making policy covers its matter. Met: every clause local and none
 * contradicting; not met: no clause local; partly: anything between.
 */
export function judgeClauses(clauses) {
  if (!clauses.length) return null;
  const local = clauses.filter((c) => c.local || !c.national).length;
  const contradicts = clauses.some((c) => c.relation === 'contradicts');
  const status = local === 0 ? 'missing' : local === clauses.length && !contradicts ? 'met' : 'partly';
  const finding = contradicts ? 'inconsistent' : { met: 'adds-local-detail', partly: 'partly-restates', missing: 'restates' }[status];
  return { status, finding };
}

/** The fallback detection call. */
export function checkDetectAnswer(parsed) {
  if (!parsed || (!Array.isArray(parsed.policies) && !Array.isArray(parsed.allocations))) return { valid: null, problems: ['no "policies" or "allocations" list'] };
  return { valid: parsed, problems: [] };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const HREF = /^\/reference\/[a-z0-9/-]+#[A-Za-z0-9._:-]+$/;

/** Every way `r` departs from report schema version 1. Empty when it conforms. */
export function reportProblems(r) {
  const p = [];
  const str = (v, max, where, optional = false) => { if (v == null && optional) return; if (typeof v !== 'string' || v.length > max) p.push(`${where}: expected text of at most ${max} characters`); };
  const list = (v, max, where, each) => { if (!Array.isArray(v) || v.length > max) { p.push(`${where}: expected a list of at most ${max}`); return; } v.forEach((x, i) => each(x, `${where}[${i}]`)); };
  const status = (v, where) => { if (!STATUSES.includes(v)) p.push(`${where}: unknown status`); };
  const evidence = (e, where) => { if (!e || typeof e !== 'object') { p.push(`${where}: not an object`); return; } str(e.quote, 1500, `${where}.quote`); str(e.locator, 500, `${where}.locator`); };
  const textList = (v, max, len, where) => list(v, max, where, (x, w) => str(x, len, w));
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['the report is not an object'];
  if (r.schema !== REPORT_SCHEMA) p.push('schema: not a plan check report');
  if (r.version !== REPORT_VERSION) p.push(`version: expected ${REPORT_VERSION}`);
  str(r.generatedAt, 40, 'generatedAt');
  str(r.notice, 2000, 'notice');
  const d = r.document;
  if (!d || typeof d !== 'object') p.push('document: missing');
  else {
    str(d.name, 200, 'document.name');
    if (!DOC_TYPES.includes(d.type)) p.push('document.type: unknown');
    for (const k of ['bytes', 'characters', 'words']) if (!Number.isInteger(d[k]) || d[k] < 0) p.push(`document.${k}: expected a whole number`);
  }
  list(r.sections, 12, 'sections', (s, w) => {
    str(s?.id, 40, `${w}.id`); str(s?.title, 200, `${w}.title`); str(s?.letter, 2, `${w}.letter`);
    list(s?.items, 40, `${w}.items`, (it, wi) => {
      str(it?.id, 12, `${wi}.id`); str(it?.title, 300, `${wi}.title`); status(it?.status, `${wi}.status`);
      str(it?.finding, 4000, `${wi}.finding`); str(it?.action, 2000, `${wi}.action`, true); str(it?.requirement, 2000, `${wi}.requirement`);
      list(it?.evidence, 20, `${wi}.evidence`, evidence);
      textList(it?.gaps, 20, 1000, `${wi}.gaps`);
      list(it?.citations, 10, `${wi}.citations`, (c, wc) => { str(c?.label, 200, `${wc}.label`); if (c?.href != null && !(typeof c.href === 'string' && HREF.test(c.href))) p.push(`${wc}.href: not a reference link`); });
      if (it?.instances != null) list(it.instances, 120, `${wi}.instances`, (x, wx) => { str(x?.label, 400, `${wx}.label`); status(x?.status, `${wx}.status`); });
    });
  });
  const st = r.statements;
  if (!st || typeof st !== 'object') p.push('statements: missing');
  else {
    const entry = (e, w) => { str(e?.id, 12, `${w}.id`); str(e?.title, 300, `${w}.title`); status(e?.status, `${w}.status`); str(e?.shows, 4000, `${w}.shows`); list(e?.evidence, 20, `${w}.evidence`, evidence); textList(e?.gaps, 20, 1000, `${w}.gaps`); str(e?.action, 2000, `${w}.action`, true); };
    str(st.compliance?.title, 200, 'statements.compliance.title');
    list(st.compliance?.parts, 8, 'statements.compliance.parts', (part, w) => { str(part?.heading, 300, `${w}.heading`); list(part?.entries, 20, `${w}.entries`, entry); });
    str(st.soundness?.title, 200, 'statements.soundness.title');
    list(st.soundness?.entries, 10, 'statements.soundness.entries', (e, w) => { entry(e, w); textList(e?.questions, 6, 600, `${w}.questions`); });
  }
  if (!r.summary || typeof r.summary !== 'object' || !r.summary.counts) p.push('summary: missing');
  return p;
}
