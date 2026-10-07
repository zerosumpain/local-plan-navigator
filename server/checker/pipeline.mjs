// server/checker/pipeline.mjs — one check, from a read document to a report.
//
//   runCheck({ document, rubric, corpus, complete, onProgress, signal }) -> report
//
// `complete` is the only way out to a model, and this file does not know or
// care which model that is:
//
//   (req: { system, user, maxTokens?, temperature?, json?, signal? }) => Promise<string>
//
// The order of work:
//   1. find the policies, site allocations and numbered outcomes (code; the
//      model only if no policy headings at all are found)
//   2. batch the rubric: items a few at a time, allocations and policies three
//      at a time, each call given only the passages of the plan relevant to it,
//      at most three calls at once
//   3. the soundness tests last, told what sections B and D found
//   4. rules and derived items in code; every quote verified against the
//      document; the summary and the draft Gateway statements built in code
//
// What makes the report consistent:
//   - temperature 0, fixed prompts, fixed batch order, deterministic retrieval
//   - every rubric item of every enabled section is in the report, in rubric
//     order, with exactly one status from a fixed enum; an answer that fails
//     its schema is retried once, then the item is "not-assessable" with the
//     reason, never left out
//   - a quote the document does not contain is dropped, and a "met" or
//     "partly met" with no quote left is lowered one step
//   - citations come from the rubric; a national policy the model names that is
//     not a national decision-making policy is dropped
//   - counts, aggregates, derived items, the summary and the statements are
//     computed in code
import { detectOutcomes, detectPolicies, fromModelDetection, outline as outlineFor } from './detect.mjs';
import { evidenceIndex, normaliseWithMap, verifyQuote, verifyQuotes } from './evidence.mjs';
import { allocationsPrompt, detectPrompt, itemsPrompt, policiesPrompt, retryNote } from './prompts.mjs';
import { TYPE_NAMES } from './read-document.mjs';
import { mergePassages, passageIndex, rankPassages, retrieve } from './retrieve.mjs';
import { checkAllocationsAnswer, checkDetectAnswer, checkItemsAnswer, checkPoliciesAnswer, judgeClauses, parseModelJson, REPORT_SCHEMA, REPORT_VERSION, STATUSES } from './schema.mjs';
import { buildStatements } from './statements.mjs';

export const CHECK_LIMITS = {
  concurrency: 3,        // model calls at once
  maxAllocations: 40,    // allocations checked against footnote 8 (the rest are listed)
  maxPolicies: 60,       // policies compared with national policy (the rest are listed)
  extractBudget: 24000,  // characters of plan text in one call
  callTimeoutMs: 150000, // one model call
  maxCalls: 70,          // model calls in one check, retries included
  maxTokens: 2600,       // reply length for one call
};

export const NOTICE = 'This report was drafted by a machine, using the Local Plan Navigator prototype, which is not a government service. It is a starting point for officers, not an assessment: it is not the view of the Planning Inspectorate or of MHCLG, it can be wrong, and every finding needs checking against the plan and its evidence. Quotes are the plan\'s own words, each found in the uploaded document.';

const RANK = { missing: 0, partly: 1, met: 2 };
const DOWN = { met: 'partly', partly: 'missing' };
export const STATUS_WORDS = { met: 'met', partly: 'partly met', missing: 'not met', 'not-assessable': 'cannot assess' };

/** The lowest judged status; "not-assessable" only if nothing was judged. */
export function worst(statuses) {
  const judged = statuses.filter((s) => s in RANK);
  return judged.length ? judged.reduce((a, b) => (RANK[b] < RANK[a] ? b : a)) : 'not-assessable';
}

/** Across allocations or policies: met if all are, not met if none is, otherwise partly. */
export function across(statuses) {
  const judged = statuses.filter((s) => s in RANK);
  if (!judged.length) return 'not-assessable';
  if (judged.every((s) => s === 'met')) return 'met';
  if (judged.every((s) => s === 'missing')) return 'missing';
  return 'partly';
}

/** Counts per status, per section and overall: arithmetic, not the model's opinion. */
export function summarise(sections) {
  const zero = () => Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const counts = zero();
  const per = sections.map((s) => {
    const c = zero();
    for (const i of s.items) { c[i.status]++; counts[i.status]++; }
    return { id: s.id, letter: s.letter, title: s.title, counts: c, total: s.items.length };
  });
  return { counts, total: per.reduce((a, s) => a + s.total, 0), sections: per };
}

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listOf = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Run `fn` over `jobs` with at most `n` running at once, keeping order in the results. */
async function pool(jobs, n, fn) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; results[i] = await fn(jobs[i], i); }
  }));
  return results;
}

export async function runCheck({ document: doc, rubric, corpus, complete, onProgress = () => {}, signal, limits = {}, now = new Date() }) {
  if (typeof complete !== 'function') throw new TypeError('runCheck needs a complete function');
  const lim = { ...CHECK_LIMITS, ...limits };
  const started = Date.now();
  const run = { modelCalls: 0, retries: 0, unanswered: 0, answerProblems: [] };
  const sections = rubric.sections.filter((s) => s.enabled !== false);
  const checkDate = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const evidence = evidenceIndex(doc);
  const passages = passageIndex(doc);
  const headings = headingOutline(doc, 4000);
  let step = 0;
  let total = null;
  const progress = (message) => onProgress({ step: ++step, total, message });
  const callSignal = () => AbortSignal.any([signal, AbortSignal.timeout(lim.callTimeoutMs)].filter(Boolean));

  /**
   * One model call with one retry. `check` turns parsed JSON into
   * { valid, problems }. Valid entries from both attempts are kept, the
   * retry's winning where both answered.
   */
  async function ask(prompt, check, maxTokens = lim.maxTokens) {
    let merged = null;
    let problem = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (run.modelCalls >= lim.maxCalls) { problem = 'the check reached its limit of model calls'; break; }
      run.modelCalls++;
      if (attempt) run.retries++;
      let reply;
      try {
        reply = await complete({ system: prompt.system, user: attempt ? prompt.user + retryNote(problem) : prompt.user, maxTokens, temperature: 0, json: true, signal: callSignal() });
      } catch (err) {
        if (signal?.aborted) throw err;
        problem = 'the model did not answer';
        if (run.answerProblems.length < 10) run.answerProblems.push(problem);
        continue;
      }
      const parsed = parseModelJson(reply);
      if (!parsed) { problem = 'the reply was not valid JSON'; if (run.answerProblems.length < 10) run.answerProblems.push(problem); continue; }
      const { valid, problems } = check(parsed);
      merged = valid instanceof Map ? new Map([...(merged ?? []), ...valid]) : (valid ?? merged);
      if (!problems.length) return { valid: merged, problem: null };
      problem = problems.slice(0, 3).join('; ');
      if (run.answerProblems.length < 10) run.answerProblems.push(problem);
    }
    run.unanswered++;
    return { valid: merged ?? new Map(), problem };
  }

  // 1. What is in the plan -------------------------------------------------
  progress(`Read the document: ${plural(doc.sections.length, 'section')}, about ${doc.words.toLocaleString('en-GB')} words`);
  let detected = detectPolicies(doc);
  let method = 'headings';
  const detectNotes = [];
  if (!detected.policies.length && !detected.allocations.length) {
    const outline = outlineFor(doc);
    const r = outline ? await ask(detectPrompt({ doc, outline }), checkDetectAnswer, 1600) : { valid: null };
    if (r.valid && !(r.valid instanceof Map)) detected = fromModelDetection(doc, r.valid);
    method = detected.policies.length || detected.allocations.length ? 'model' : 'none';
    detectNotes.push(method === 'model'
      ? 'No headings in the usual "Policy XX1: Title" form were found, so the model identified the policies and sites from the plan\'s outline.'
      : 'No policies or site allocations could be identified in the plan.');
  }
  const outcomes = detectOutcomes(doc);
  const allocations = detected.allocations.slice(0, lim.maxAllocations);
  const policies = detected.policies.slice(0, lim.maxPolicies);
  if (detected.allocations.length > allocations.length) detectNotes.push(`Only the first ${lim.maxAllocations} of ${detected.allocations.length} site allocations were checked against footnote 8.`);
  if (detected.policies.length > policies.length) detectNotes.push(`Only the first ${lim.maxPolicies} of ${detected.policies.length} policies were compared with national policy.`);

  // 2. Plan the calls --------------------------------------------------------
  const jobs = [];
  for (const section of sections) {
    const phase = section.statement === 'soundness' ? 2 : 1;
    if (section.mode === 'items') {
      const asked = section.items.filter((i) => i.assess === 'model' || (i.rule?.type === 'count-outcomes' && !outcomes.length));
      const batches = chunk(asked, section.batchSize ?? 4);
      batches.forEach((items, k) => jobs.push({ kind: 'items', phase, section, items, label: `${section.title}${batches.length > 1 ? ` (${k + 1} of ${batches.length})` : ''}` }));
    } else if (section.mode === 'per-allocation') {
      const batches = chunk(allocations, section.batchSize ?? 3);
      batches.forEach((list, k) => jobs.push({ kind: 'allocations', phase, section, allocations: list, label: `${section.title} (${k + 1} of ${batches.length})` }));
    } else if (section.mode === 'per-policy') {
      const batches = chunk(policies, section.batchSize ?? 3);
      batches.forEach((list, k) => jobs.push({ kind: 'policies', phase, section, policies: list, label: `${section.title} (${k + 1} of ${batches.length})` }));
    }
  }
  total = 2 + jobs.length + 1;
  progress(`Found ${plural(detected.allocations.length, 'site allocation')}, ${plural(detected.policies.length, 'policy', 'policies')} and ${plural(outcomes.length, 'numbered outcome')}`);

  const answers = { items: new Map(), allocations: new Map(), policies: new Map() };
  const failures = new Map(); // id -> why there is no answer

  const focus = {
    outcomes: [...new Set(outcomes.map((o) => o.sectionId))].slice(0, 4),
    vision: doc.sections.filter((s) => /\bvision\b/i.test(s.heading)).map((s) => s.id).slice(0, 4),
    monitoring: doc.sections.filter((s) => /monitor/i.test(s.heading)).map((s) => s.id).slice(0, 4),
  };

  async function runItems(job, context = '') {
    const soundness = job.section.statement === 'soundness';
    const per = Math.max(6000, Math.floor(lim.extractBudget / job.items.length));
    const lists = job.items.map((item) => retrieve(passages, [...(item.keywords ?? []), item.title], {
      budget: per, max: 10, require: (item.focus ?? []).flatMap((f) => focus[f] ?? []),
    }));
    const chosen = mergePassages(lists, lim.extractBudget);
    const prompt = itemsPrompt({ doc, items: job.items, passages: chosen, outline: headings, checkDate, soundness, context });
    const r = await ask(prompt, (parsed) => checkItemsAnswer(parsed, job.items, { soundness }));
    for (const item of job.items) {
      if (r.valid.has(item.id)) answers.items.set(item.id, r.valid.get(item.id));
      else failures.set(item.id, r.problem ?? 'no answer');
    }
  }

  async function runAllocations(job) {
    const fields = job.section.items;
    const prompt = allocationsPrompt({ doc, fields, allocations: job.allocations.map((a) => ({ ...a, text: a.text.slice(0, 7000) })) });
    const r = await ask(prompt, (parsed) => checkAllocationsAnswer(parsed, job.allocations, fields), lim.maxTokens + 800);
    for (const a of job.allocations) {
      answers.allocations.set(a.id, r.valid.get(a.id) ?? new Map());
      if ((r.valid.get(a.id)?.size ?? 0) < fields.length) failures.set(a.id, r.problem ?? 'no answer');
    }
  }

  const dmList = rubric.nationalDecisionMakingPolicies;
  const dmCodes = new Set(dmList.map((p) => p.code));
  const dmIndex = nationalIndex(dmList, corpus);
  const dmById = new Map(dmList.map((p) => [p.code, p]));

  async function runPolicies(job) {
    const [d1, d2] = job.section.items;
    const k = job.section.candidates ?? 4;
    const batch = job.policies.map((p) => ({ ...p, text: p.text.slice(0, 5000), candidates: [...new Set(rankPassages(dmIndex.index, [p.title, p.text], k * 3).map((x) => x.sectionId))].slice(0, k) }));
    const offered = [...new Set(batch.flatMap((p) => p.candidates))].sort((a, b) => dmList.findIndex((x) => x.code === a) - dmList.findIndex((x) => x.code === b));
    const national = offered.map((code) => ({ code, title: dmById.get(code).title, text: dmIndex.text.get(code) ?? '' }));
    const prompt = policiesPrompt({ doc, d1, d2, policies: batch, national });
    const r = await ask(prompt, (parsed) => checkPoliciesAnswer(parsed, batch, dmCodes));
    for (const p of batch) {
      if (r.valid.has(p.id)) answers.policies.set(p.id, { ...r.valid.get(p.id), candidates: p.candidates });
      else failures.set(p.id, r.problem ?? 'no answer');
    }
  }

  const runJob = async (job, context) => {
    if (job.kind === 'items') await runItems(job, context);
    else if (job.kind === 'allocations') await runAllocations(job);
    else await runPolicies(job);
    progress(`Checked: ${job.label}`);
  };
  await pool(jobs.filter((j) => j.phase === 1), lim.concurrency, (job) => runJob(job));

  // 3. Results for everything but soundness, so soundness can be told about them
  const results = new Map();
  const extendedEvidence = [...evidence, ...allocations.flatMap((a) => (a.rows ?? []).map((row) => ({ ...row, ...normaliseWithMap(row.original) })))];
  const ctx = { doc, evidence, extendedEvidence, outcomes, allocations, policies, detected, method, answers, failures, results, dmById, checkYear: now.getUTCFullYear() };
  const resolveSection = (section) => {
    for (const item of section.items) if (item.assess !== 'derived') results.set(item.id, resultFor(item, section, ctx));
  };
  for (const section of sections.filter((s) => s.statement !== 'soundness')) resolveSection(section);
  const soundnessContext = contextForSoundness(ctx);
  await pool(jobs.filter((j) => j.phase === 2), lim.concurrency, (job) => runJob(job, soundnessContext));
  for (const section of sections.filter((s) => s.statement === 'soundness')) resolveSection(section);
  for (const section of sections) for (const item of section.items) if (item.assess === 'derived') results.set(item.id, derivedResult(item, results));

  // 4. The report ------------------------------------------------------------
  const resultSections = sections.map((s) => ({
    id: s.id, letter: s.letter, title: s.title, summary: s.summary, mode: s.mode,
    items: s.items.map((i) => results.get(i.id)),
  }));
  const statements = buildStatements({ doc, results });
  progress('Wrote the draft statement of compliance and statement of soundness');
  return {
    schema: REPORT_SCHEMA,
    version: REPORT_VERSION,
    generatedAt: now.toISOString(),
    rubricVersion: rubric.version,
    notice: NOTICE,
    document: {
      name: doc.name, type: doc.type, typeName: TYPE_NAMES[doc.type], bytes: doc.bytes, characters: doc.characters, words: doc.words, sha256: doc.sha256,
      sectionCount: doc.sections.length,
      outline: doc.sections.slice(0, 600).map((s) => ({ id: s.id, heading: s.heading, level: s.level, locator: s.locator })),
    },
    detected: {
      method,
      allocations: detected.allocations.map((a, i) => ({ id: a.id, code: a.code, title: a.title, locator: a.locator, checked: i < lim.maxAllocations })),
      policies: detected.policies.map((p, i) => ({ id: p.id, code: p.code, title: p.title, locator: p.locator, checked: i < lim.maxPolicies })),
      outcomes: outcomes.map((o) => ({ number: o.number, text: o.text, locator: o.locator })),
      notes: detectNotes,
    },
    sections: resultSections,
    pending: rubric.sections.filter((s) => s.enabled === false).map((s) => ({ id: s.id, letter: s.letter, title: s.title, summary: s.summary, items: s.items.map((i) => ({ id: i.id, title: i.title })) })),
    summary: summarise(resultSections),
    statements,
    run: { ...run, durationMs: Date.now() - started },
  };
}

// ---------------------------------------------------------------------------
// Turning answers into results
// ---------------------------------------------------------------------------

/** The fields every result has, from the rubric item. */
function base(item, extra) {
  return {
    id: item.id,
    ref: item.ref ?? null,
    title: item.title,
    requirement: item.requirement,
    source: item.source,
    assessedBy: 'model',
    status: 'not-assessable',
    finding: '',
    evidence: [],
    gaps: [],
    action: '',
    citations: item.cites.map((c) => ({ label: c.label, href: c.href, sourceTitle: c.sourceTitle })),
    notes: [],
    ...extra,
  };
}

const unanswered = (item, why) => base(item, {
  finding: 'The model did not return a usable answer for this item, even after a retry, so it was not assessed. Check it by hand.',
  notes: [`Reason: ${why}.`],
  action: item.action ?? '',
});

/** Verify quotes and apply the "show it or lower it" rule. */
function settle(status, quotes, index, options = {}) {
  const { kept, dropped } = verifyQuotes(index, quotes, options);
  const notes = [];
  if (dropped) notes.push(`${plural(dropped, 'quote')} the model gave could not be found word for word in the plan and ${dropped === 1 ? 'was' : 'were'} left out.`);
  if ((status === 'met' || status === 'partly') && !kept.length) {
    notes.push(`No quote supporting this was found in the plan, so the result was lowered from "${STATUS_WORDS[status]}" to "${STATUS_WORDS[DOWN[status]]}".`);
    status = DOWN[status];
  }
  return { status, evidence: kept, notes };
}

function resultFor(item, section, ctx) {
  if (item.assess === 'officer') {
    let action = item.officerAction;
    if (item.id === 'E11') {
      const onMap = [...ctx.allocations.map((a) => `${a.code} ${a.title}`.trim()), ...ctx.policies.filter((p) => /polic(y|ies) map/i.test(p.text)).map((p) => `Policy ${p.code} ${p.title}`.trim())];
      if (onMap.length) action += ` Found in the draft: ${onMap.join('; ')}.`;
    }
    return base(item, { assessedBy: 'officer', finding: 'This depends on documents and steps outside the plan, so the checker cannot assess it. The authority needs to complete it.', action });
  }
  if (item.rule?.type === 'count-outcomes') return outcomesResult(item, ctx);
  if (item.rule?.type === 'plan-period') return planPeriodResult(item, ctx);
  if (item.rule?.type === 'allocations-found') return allocationsFoundResult(item, ctx);
  if (section.mode === 'per-allocation') return allocationFieldResult(item, ctx);
  if (section.mode === 'per-policy') return policyResult(item, section, ctx);
  const ans = ctx.answers.items.get(item.id);
  if (!ans) return unanswered(item, ctx.failures.get(item.id) ?? 'no answer');
  const settled = item.conditions ? settleConditions(item, ans, ctx.evidence) : settle(ans.status, ans.evidence, ctx.evidence);
  const r = base(item, {
    status: settled.status,
    finding: ans.finding,
    evidence: settled.evidence,
    gaps: settled.gaps ?? (settled.status === 'met' ? ans.gaps.slice(0, 2) : ans.gaps),
    ...(settled.conditions ? { conditions: settled.conditions } : {}),
    action: settled.status === 'met' ? ans.action : (ans.action || item.action || ''),
    notes: settled.notes,
  });
  if (item.officerAction && r.status !== 'met') r.action = [r.action, item.officerAction].filter(Boolean).join(' ');
  if (ans.questions) {
    r.questions = ans.questions;
    // Only documents the plan really names, in the plan's own words.
    r.evidenceDocuments = verifyQuotes(ctx.evidence, ans.evidenceDocuments, { minLength: 6 }).kept.map((e) => e.quote);
  }
  return r;
}

/**
 * An item answered as yes/no conditions: a "yes" counts only if its quote is
 * in the plan, and the status is arithmetic: met if every condition holds,
 * not met if none does, partly otherwise.
 */
function settleConditions(item, ans, index) {
  const notes = [];
  const conditions = item.conditions.map((text, k) => {
    const a = ans.conditions[k];
    const found = a.quote ? verifyQuote(index, a.quote) : null;
    let answer = a.answer;
    if (answer === 'yes' && !found) {
      answer = 'no';
      notes.push(`Condition ${k + 1} was answered "yes", but the passage quoted for it could not be found in the plan, so it counts as "no".`);
    }
    return { text, answer, quote: found?.quote ?? null, locator: found?.locator ?? null, sectionId: found?.sectionId ?? null };
  });
  const yes = conditions.filter((c) => c.answer === 'yes').length;
  const status = yes === conditions.length ? 'met' : yes === 0 ? 'missing' : 'partly';
  const evidence = conditions.filter((c) => c.quote).map((c) => ({ quote: c.quote, sectionId: c.sectionId, locator: c.locator }));
  return {
    status,
    evidence: [...new Map(evidence.map((e) => [e.quote, e])).values()],
    notes,
    conditions: conditions.map(({ sectionId, ...c }) => c),
    gaps: conditions.filter((c) => c.answer === 'no').map((c) => `Not shown: ${c.text.charAt(0).toLowerCase()}${c.text.slice(1)}`),
  };
}

function outcomesResult(item, ctx) {
  const max = item.rule.max ?? 10;
  let found;
  let by = 'rule';
  if (ctx.outcomes.length) {
    found = ctx.outcomes.map((o) => verifyQuote(ctx.evidence, o.text) ?? { quote: o.text, sectionId: o.sectionId, locator: o.locator });
  } else {
    const ans = ctx.answers.items.get(item.id);
    if (!ans) return unanswered(item, ctx.failures.get(item.id) ?? 'no answer');
    found = verifyQuotes(ctx.evidence, ans.list).kept;
    by = 'model';
  }
  const n = found.length;
  const status = n >= 1 && n <= max ? 'met' : 'missing';
  return base(item, {
    assessedBy: 'rule',
    status,
    finding: n === 0 ? 'No measurable outcomes could be found in the plan.' : n <= max ? `The plan sets out ${plural(n, 'measurable outcome')}, within the limit of ${max}.` : `The plan sets out ${n} outcomes, more than the ${max} allowed.`,
    evidence: found.slice(0, 12),
    gaps: n === 0 ? ['No measurable outcomes.'] : n > max ? [`${n - max} more outcomes than the regulations allow.`] : [],
    action: status === 'met' ? '' : item.action,
    notes: [by === 'rule' ? 'Counted in code from the numbered outcomes in the plan.' : 'Counted in code from the outcomes the model listed, each one found word for word in the plan. Whether they can be measured is item A3.'],
  });
}

function planPeriodResult(item, ctx) {
  const ans = ctx.answers.items.get(item.id);
  if (!ans) return unanswered(item, ctx.failures.get(item.id) ?? 'no answer');
  const { planStart, planEnd, adoption } = ans.facts ?? {};
  const years = item.rule.years ?? 10;
  const assumed = adoption == null;
  const adopted = adoption ?? ctx.checkYear + 2;
  let status = 'missing';
  let finding = 'No plan period could be found in the plan.';
  if (planEnd != null) {
    const span = planEnd - adopted;
    status = span >= years ? 'met' : 'partly';
    finding = `The plan period ${planStart != null ? `runs from ${planStart} to ${planEnd}` : `ends in ${planEnd}`}. ${assumed ? `The plan gives no expected adoption date, so adoption in ${adopted} is assumed` : `The plan expects adoption in ${adopted}`}, which leaves ${span} years from adoption: ${span >= years ? 'at least' : 'fewer than'} the ${years} required.`;
  }
  const settled = settle(status, ans.evidence, ctx.evidence);
  return base(item, {
    assessedBy: 'rule',
    status: settled.status,
    finding,
    evidence: settled.evidence,
    gaps: status === 'met' ? [] : planEnd == null ? ['No plan period is stated.'] : [`The plan period should run to at least ${adopted + years}.`],
    action: status === 'met' ? '' : item.action,
    notes: ['The years were read from the plan by the model and compared in code.', ...settled.notes],
  });
}

function allocationsFoundResult(item, ctx) {
  const n = ctx.detected.allocations.length;
  const evidence = ctx.detected.allocations.slice(0, 8).map((a) => verifyQuote(ctx.extendedEvidence, a.heading || a.code) ?? verifyQuote(ctx.extendedEvidence, a.code)).filter(Boolean);
  return base(item, {
    assessedBy: 'rule',
    status: n ? 'met' : 'missing',
    finding: n ? `The plan allocates ${plural(n, 'site')}: ${listOf(ctx.detected.allocations.slice(0, 12).map((a) => a.code))}${n > 12 ? ' and others' : ''}.` : 'No site allocations could be identified from the plan\'s headings or tables.',
    evidence,
    gaps: n ? [] : ['No site allocations found.'],
    action: n ? '' : item.action,
    notes: [ctx.method === 'model' ? 'Identified by the model from the plan\'s outline.' : 'Found in code from the plan\'s headings and tables.'],
  });
}

const allocationLabel = (a) => [a.code, a.title].filter(Boolean).join(' ').trim();

function allocationFieldResult(item, ctx) {
  const instances = ctx.allocations.map((a) => {
    const got = ctx.answers.allocations.get(a.id)?.get(item.id);
    if (!got) return { id: a.id, label: allocationLabel(a), locator: a.locator, status: 'not-assessable', evidence: [], note: 'Not assessed: the model did not return a usable answer for this allocation.' };
    const scope = [...a.scope, ...(a.rows ?? []).map((r) => r.id)];
    const settled = settle(got.status, got.evidence, ctx.extendedEvidence, { scope, minLength: 2 });
    return { id: a.id, label: allocationLabel(a), locator: a.locator, status: settled.status, evidence: settled.evidence, note: [got.note, ...settled.notes].filter(Boolean).join(' ') };
  });
  if (!instances.length) {
    return base(item, { assessedBy: 'model', finding: 'No site allocations were found, so this could not be checked.', action: '' });
  }
  const by = (s) => instances.filter((i) => i.status === s);
  const met = by('met').length;
  const parts = [`Given for ${met} of ${plural(instances.length, 'allocation')}.`];
  if (by('partly').length) parts.push(`Thin for ${listOf(by('partly').map((i) => i.label))}.`);
  if (by('missing').length) parts.push(`Not given for ${listOf(by('missing').map((i) => i.label))}.`);
  if (by('not-assessable').length) parts.push(`Not assessed for ${listOf(by('not-assessable').map((i) => i.label))}.`);
  const status = across(instances.map((i) => i.status));
  return base(item, {
    status,
    finding: parts.join(' '),
    gaps: instances.filter((i) => i.status === 'missing' || i.status === 'partly').map((i) => `${i.label}: ${i.status === 'missing' ? 'not given' : 'thin'}${i.note ? ` (${i.note})` : ''}`),
    action: status === 'met' ? '' : item.action,
    instances,
  });
}

function policyResult(item, section, ctx) {
  const isD1 = item.id === section.items[0].id;
  const findingLabel = { 'adds-local-detail': 'Adds local detail', 'partly-restates': 'Partly restates national policy', restates: 'Duplicates or restates national policy', inconsistent: 'Inconsistent with national policy' };
  const instances = ctx.policies.map((p) => {
    const label = `Policy ${p.code}${p.title ? `: ${p.title}` : ''}`;
    const got = ctx.answers.policies.get(p.id);
    if (!got) return { id: p.id, label, locator: p.locator, status: 'not-assessable', evidence: [], note: 'Not assessed: the model did not return a usable answer for this policy.' };
    // Only clauses found word for word in the policy count towards its finding.
    const clauses = got.clauses.map((c) => ({ ...c, found: verifyQuote(ctx.evidence, c.quote, { scope: p.scope }) })).filter((c) => c.found);
    const dropped = got.clauses.length - clauses.length;
    const notes = dropped ? [`${plural(dropped, 'clause')} the model quoted could not be found word for word in the policy and ${dropped === 1 ? 'was' : 'were'} left out.`] : [];
    const evidence = clauses.map((c) => c.found);
    if (!isD1) {
      const settled = settle(got.localIssue, evidence.map((e) => e.quote), ctx.evidence, { scope: p.scope });
      return { id: p.id, label, locator: p.locator, status: settled.status, note: [got.localIssueNote, ...notes, ...settled.notes].filter(Boolean).join(' '), evidence: settled.evidence };
    }
    const judged = judgeClauses(clauses);
    if (!judged) return { id: p.id, label, locator: p.locator, status: 'not-assessable', evidence: [], note: 'None of the clauses the model quoted could be found in the policy, so it was not assessed.' };
    const codes = [...new Set(clauses.filter((c) => c.national && !c.local).map((c) => c.national).concat(clauses.filter((c) => c.relation === 'contradicts').map((c) => c.national)))];
    const national = codes.map((code) => ({ code, title: ctx.dmById.get(code)?.title ?? code, href: ctx.dmById.get(code)?.href ?? null }));
    // A clause that could not be verified never lets a policy look better than "partly".
    let { status } = judged;
    if (status === 'met' && dropped) { status = 'partly'; notes.push('Lowered to "partly met" because not every clause could be checked.'); }
    return {
      id: p.id, label, locator: p.locator, status, finding: judged.finding, findingLabel: findingLabel[judged.finding], national,
      clauses: clauses.map((c) => ({ quote: c.found.quote, local: c.local, national: c.national, relation: c.relation })),
      note: [got.explanation, ...notes].filter(Boolean).join(' '),
      evidence,
    };
  });
  if (!instances.length) return base(item, { finding: 'No locally specific policies were found, so this could not be checked.' });
  const status = across(instances.map((i) => i.status));
  const named = (i) => (i.national?.length ? `${i.label.replace(/:.*$/, '')} (${i.national.map((n) => n.code).join(', ')})` : i.label.replace(/:.*$/, ''));
  const failing = instances.filter((i) => i.status === 'missing');
  const thin = instances.filter((i) => i.status === 'partly');
  const finding = isD1
    ? [
      `${failing.length} of ${plural(instances.length, 'policy', 'policies')} duplicate, restate or contradict national decision-making policy${failing.length ? `: ${listOf(failing.map(named))}` : ''}.`,
      thin.length ? `${thin.length} partly restate it: ${listOf(thin.map(named))}.` : '',
      `${instances.filter((i) => i.status === 'met').length} add local detail only.`,
    ].filter(Boolean).join(' ')
    : `${instances.filter((i) => i.status === 'met').length} of ${plural(instances.length, 'policy', 'policies')} clearly address a local issue or support allocated sites.${failing.length ? ` ${failing.length} are general: ${listOf(failing.map((i) => i.label.replace(/:.*$/, '')))}.` : ''}`;
  return base(item, {
    status,
    finding,
    gaps: [...failing, ...thin].map((i) => `${i.label}: ${isD1 ? i.findingLabel.toLowerCase() : (i.status === 'missing' ? 'no local reason given' : 'partly local')}${i.national?.length ? ` (${i.national.map((n) => `${n.code} ${n.title}`).join('; ')})` : ''}`),
    action: status === 'met' ? '' : item.action,
    instances,
  });
}

function derivedResult(item, results) {
  const sources = item.derive.from.map((id) => results.get(id)).filter(Boolean);
  const status = worst(sources.map((s) => s.status));
  const notMet = sources.filter((s) => s.status !== 'met');
  return base(item, {
    assessedBy: 'derived',
    status,
    finding: `Taken from ${sources.length > 1 ? 'items' : 'item'} ${listOf(sources.map((s) => s.id))}: ${sources.map((s) => `${s.title.charAt(0).toLowerCase()}${s.title.slice(1)} is ${STATUS_WORDS[s.status]}`).join('; ')}.`,
    evidence: sources.flatMap((s) => s.evidence).slice(0, 4),
    gaps: notMet.flatMap((s) => (s.gaps.length ? s.gaps : [`${s.title} (${STATUS_WORDS[s.status]})`])).slice(0, 6),
    action: notMet.map((s) => s.action).filter(Boolean).join(' '),
    ...(item.questions ? { questions: item.questions, evidenceDocuments: [] } : {}),
  });
}

/** What the other sections found that bears on the soundness tests, in fixed words. */
function contextForSoundness(ctx) {
  const lines = [];
  const fieldItems = [...ctx.results.values()].filter((r) => r.instances && r.id.startsWith('B'));
  const incomplete = ctx.allocations.map((a) => {
    const short = fieldItems.filter((r) => r.instances.find((i) => i.id === a.id)?.status !== 'met').map((r) => r.title.toLowerCase());
    return short.length ? `${a.code} (${short.join(', ')})` : null;
  }).filter(Boolean);
  lines.push(`- Site allocations found: ${ctx.allocations.length}. Allocations missing some footnote 8 information: ${incomplete.length ? incomplete.join('; ') : 'none'}.`);
  const d1 = ctx.results.get('D1');
  const restating = (d1?.instances ?? []).filter((i) => i.finding && i.finding !== 'adds-local-detail');
  lines.push(`- Local policies found: ${ctx.policies.length}. Policies that repeat or contradict national decision-making policy: ${restating.length ? restating.map((i) => `${i.label.replace(/:.*$/, '')} (${i.findingLabel.toLowerCase()}: ${i.national.map((n) => n.code).join(', ')})`).join('; ') : 'none'}.`);
  lines.push(`- Numbered measurable outcomes found: ${ctx.outcomes.length}.`);
  return `FINDINGS ALREADY MADE BY THIS CHECK (facts to use where a test bears on them)\n${lines.join('\n')}`;
}

/** The plan's headings, indented, for orientation in a prompt. */
function headingOutline(doc, budget) {
  const out = [];
  let used = 0;
  for (const s of doc.sections) {
    if (!s.heading) continue;
    const line = `${'  '.repeat(Math.max(0, Math.min(4, s.level) - 1))}${s.heading}`;
    if (used + line.length > budget) { out.push('…'); break; }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

/** A search index over the national decision-making policies, and their text for prompts. */
function nationalIndex(list, corpus) {
  const parts = new Map();
  for (const c of corpus.chunks) {
    if (c.doc !== 'nppf') continue;
    if (!parts.has(c.anchor)) parts.set(c.anchor, []);
    parts.get(c.anchor).push(c.text);
  }
  const text = new Map();
  const sections = list.map((p) => {
    const full = (parts.get(p.code) ?? []).join('\n');
    // Enough of each policy for the comparison; the reference link has the rest.
    let short = full.slice(0, 2600);
    if (full.length > 2600) short = `${short.replace(/\s+\S*$/, '')} …`;
    text.set(p.code, short);
    return { id: p.code, heading: p.title, level: 1, locator: p.code, text: full, tables: [] };
  });
  return { index: passageIndex({ sections }), text };
}
