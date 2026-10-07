// tests/checker-pipeline.test.mjs — the check, end to end, with a fake model.
//
// What these pin down is the consistency contract: every rubric item in every
// report, in rubric order, with one status from the enum; a bad answer
// retried once and then "not-assessable" with a reason; quotes the plan does
// not contain dropped and the result lowered; national policies that do not
// exist never cited; the summary arithmetic; and the same input giving the
// same report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evidenceIndex, normalise, verifyQuote, verifyQuotes } from '../server/checker/evidence.mjs';
import { across, runCheck, summarise, worst } from '../server/checker/pipeline.mjs';
import { readDocument } from '../server/checker/read-document.mjs';
import { judgeClauses, parseModelJson, reportProblems, STATUSES } from '../server/checker/schema.mjs';
import { builtCorpus, fakeComplete, root } from './checker-helpers.mjs';

const sample = async () => readDocument({ name: 'northwold-draft-local-plan.md', bytes: await readFile(`${root}content/samples/northwold-draft-local-plan.md`) });
const now = new Date('2026-10-07T12:00:00Z');
const check = async (complete, extra = {}) => {
  const { rubric, corpusFile } = await builtCorpus();
  return runCheck({ document: await sample(), rubric, corpus: corpusFile, complete, now, ...extra });
};
const items = (report) => report.sections.flatMap((s) => s.items);
const item = (report, id) => items(report).find((i) => i.id === id);

test('quotes are verified against the document, after normalising only what a copy can innocently change', async () => {
  const doc = await sample();
  const index = evidenceIndex(doc);
  const found = verifyQuote(index, '“At least 2,800  affordable homes\ncompleted by 2042”.');
  assert.equal(found.quote, 'At least 2,800 affordable homes completed by 2042', 'the plan\'s own words are returned');
  assert.equal(found.locator, '3 Vision and outcomes › 3.3 Measurable outcomes');
  assert.ok(verifyQuote(index, "development in Wendbury and at Harrowfield can meet all of the plan's requirements"), 'curly and straight apostrophes match');
  assert.ok(verifyQuote(index, 'THE PLAN PERIOD IS 15 YEARS'), 'case is ignored');
  assert.equal(verifyQuote(index, 'The plan period is 16 years'), null, 'a changed word is not the same quote');
  assert.equal(verifyQuote(index, 'at least 9,600 new homes … an average of 640 a year').quote, 'At least 9,600 new homes … an average of 640 a year', 'an elided quote must be found in pieces, in order, in one section');
  assert.equal(verifyQuote(index, 'an average of 640 a year … at least 9,600 new homes'), null, 'pieces out of order');
  assert.equal(verifyQuote(index, 'Site reference: NW/H1', { scope: ['s21'] }), null, 'confined to other sections, it is not found');
  const { kept, dropped } = verifyQuotes(index, ['The plan period is 15 years', 'invented words that are nowhere', 'the plan period is 15 years']);
  assert.equal(kept.length, 1, 'duplicates collapse');
  assert.equal(dropped, 1);
  assert.equal(normalise('Café —  “x”'), 'café - "x"');
});

test('every rubric item is in the report, in rubric order, with one status from the enum', async () => {
  const { rubric } = await builtCorpus();
  const complete = fakeComplete();
  const progress = [];
  const report = await check(complete, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(reportProblems(report), []);
  const enabled = rubric.sections.filter((s) => s.enabled !== false);
  assert.deepEqual(report.sections.map((s) => s.id), enabled.map((s) => s.id));
  assert.deepEqual(items(report).map((i) => i.id), enabled.flatMap((s) => s.items.map((i) => i.id)));
  for (const i of items(report)) {
    assert.ok(STATUSES.includes(i.status), `${i.id}: ${i.status}`);
    assert.ok(i.finding, `${i.id}: no finding`);
    assert.ok(i.citations.length && i.citations.every((c) => c.href.startsWith('/reference/')), `${i.id}: citations`);
  }
  assert.deepEqual(report.pending.map((p) => p.id), ['model-plan']);
  // The model was called a bounded number of times, never more than three at once.
  assert.ok(complete.calls.length >= 8 && complete.calls.length <= 20, `${complete.calls.length} calls`);
  assert.ok(complete.calls.every((c) => c.temperature === 0 && c.json === true && c.signal));
  assert.equal(progress.at(-1).step, progress.at(-1).total);
  assert.deepEqual(report.detected.allocations.map((a) => a.code), ['NW/H1', 'NW/H2', 'NW/H3', 'NW/E1', 'NW/GV1']);
  assert.equal(report.detected.policies.length, 14);
  assert.equal(report.detected.outcomes.length, 9);
});

test('the summary is arithmetic over the results, not the model\'s opinion', async () => {
  const report = await check(fakeComplete());
  const counted = Object.fromEntries(STATUSES.map((s) => [s, items(report).filter((i) => i.status === s).length]));
  assert.deepEqual(report.summary.counts, counted);
  assert.equal(report.summary.total, items(report).length);
  for (const s of report.summary.sections) assert.equal(Object.values(s.counts).reduce((a, b) => a + b, 0), s.total);
  assert.deepEqual(summarise([{ id: 'x', letter: 'X', title: 'X', items: [{ status: 'met' }, { status: 'met' }, { status: 'partly' }] }]).counts, { met: 2, partly: 1, missing: 0, 'not-assessable': 0 });
  assert.equal(worst(['met', 'partly', 'not-assessable']), 'partly');
  assert.equal(worst(['not-assessable']), 'not-assessable');
  assert.equal(across(['met', 'met']), 'met');
  assert.equal(across(['missing', 'missing', 'not-assessable']), 'missing');
  assert.equal(across(['met', 'missing']), 'partly');
});

test('rules and derived items are decided in code', async () => {
  const report = await check(fakeComplete());
  const a2 = item(report, 'A2');
  assert.equal(a2.assessedBy, 'rule');
  assert.equal(a2.status, 'met');
  assert.match(a2.finding, /9 measurable outcomes/);
  const a4 = item(report, 'A4');
  assert.equal(a4.status, 'met');
  assert.match(a4.finding, /2027 to 2042.*adoption in 2029.*13 years/);
  assert.equal(item(report, 'A6').status, 'met');
  for (const id of ['E7', 'E8', 'E10', 'E11', 'E12', 'E14']) {
    assert.equal(item(report, id).status, 'not-assessable');
    assert.equal(item(report, id).assessedBy, 'officer');
  }
  assert.match(item(report, 'E11').action, /NW\/H1 Land north of Wendbury/, 'the map check lists the allocations found');
  // E2 is the worst of A1, A2 and A9.
  const e2 = item(report, 'E2');
  assert.equal(e2.status, worst(['A1', 'A2', 'A9'].map((id) => item(report, id).status)));
  assert.equal(e2.assessedBy, 'derived');
  // Every policy repeats national policy in the fake's answers, so none is local.
  assert.equal(item(report, 'D1').status, 'missing');
  assert.equal(item(report, 'F4').status, 'missing', 'F4 cannot be better than D1');
});

test('policy findings come from the clause labels, in code', () => {
  assert.deepEqual(judgeClauses([{ local: true, national: null }, { local: true, national: 'HE6', relation: 'repeats' }]), { status: 'met', finding: 'adds-local-detail' });
  assert.deepEqual(judgeClauses([{ local: false, national: 'S3', relation: 'repeats' }, { local: true, national: null }]), { status: 'partly', finding: 'partly-restates' });
  assert.deepEqual(judgeClauses([{ local: false, national: 'S3', relation: 'repeats' }]), { status: 'missing', finding: 'restates' });
  assert.deepEqual(judgeClauses([{ local: true, national: 'CC2', relation: 'contradicts' }]), { status: 'partly', finding: 'inconsistent' });
  assert.equal(judgeClauses([]), null);
});

test('an answer that is not JSON is retried once, and then the item is "not-assessable" with the reason', async () => {
  const once = fakeComplete({ invalid: 'once' });
  const recovered = await check(once);
  assert.ok(recovered.run.retries > 0);
  assert.equal(recovered.run.unanswered, 0);
  assert.ok(items(recovered).filter((i) => i.assessedBy === 'model').every((i) => i.status !== 'not-assessable'));

  const never = fakeComplete({ invalid: 'always' });
  const failed = await check(never);
  assert.deepEqual(reportProblems(failed), []);
  assert.equal(items(failed).length, items(recovered).length, 'nothing is left out');
  const judged = items(failed).filter((i) => i.assessedBy === 'model' && !i.instances);
  assert.ok(judged.length > 10);
  for (const i of judged) {
    assert.equal(i.status, 'not-assessable', i.id);
    assert.match(i.notes.join(' '), /Reason: the reply was not valid JSON/);
  }
  for (const i of items(failed).filter((x) => x.instances)) assert.ok(i.instances.every((x) => x.status === 'not-assessable'), i.id);
  // Every prompt was tried exactly twice: once, then once more with a note.
  const tries = new Map();
  for (const c of never.calls) { const key = c.user.replace(/\n\nYour previous reply could not be used[\s\S]*$/, ''); tries.set(key, (tries.get(key) ?? 0) + 1); }
  assert.ok([...tries.values()].every((n) => n === 2), [...tries.values()].join(','));
  assert.ok(never.calls.filter((c) => /Your previous reply could not be used \(the reply was not valid JSON\)/.test(c.user)).length === tries.size);
});

test('quotes the plan does not contain are dropped, and "met" is lowered to "partly met"', async () => {
  const report = await check(fakeComplete({ invent: true }));
  const a1 = item(report, 'A1');
  assert.equal(a1.status, 'partly');
  assert.equal(a1.evidence.length, 0);
  assert.match(a1.notes.join(' '), /could not be found word for word.*lowered from "met" to "partly met"/);
  // A "yes" condition with an invented quote counts as "no".
  const a5 = item(report, 'A5');
  assert.equal(a5.status, 'missing');
  assert.ok(a5.conditions.every((c) => c.answer === 'no'));
  // Allocation fields too.
  assert.ok(item(report, 'B3').instances.every((x) => x.status === 'partly' && x.evidence.length === 0));
  for (const i of items(report)) for (const e of i.evidence) assert.ok(verifyQuote(evidenceIndex(await sample()), e.quote), `${i.id}: unverified quote shown`);
});

test('a national policy the model invents is never cited: the answer is retried, then not used', async () => {
  const report = await check(fakeComplete({ inventNational: true }));
  const d1 = item(report, 'D1');
  assert.equal(d1.status, 'not-assessable');
  assert.ok(d1.instances.every((x) => x.status === 'not-assessable' && !(x.national ?? []).length));
  assert.ok(report.run.retries >= 5);
  assert.doesNotMatch(JSON.stringify(report), /ZZ99/);
});

test('the same document gives the same report, apart from the run details', async () => {
  const strip = (r) => JSON.stringify({ ...r, generatedAt: null, run: null });
  const a = await check(fakeComplete());
  const b = await check(fakeComplete());
  assert.equal(strip(a), strip(b));
});

test('the draft statements are built from the results, one entry per requirement', async () => {
  const report = await check(fakeComplete());
  const { compliance, soundness } = report.statements;
  assert.deepEqual(compliance.parts.map((p) => p.entries.map((e) => e.id)), [
    ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11', 'E12'], ['A9'], ['E13'], ['E14'],
  ]);
  assert.match(compliance.notice, /Machine-drafted starting point/);
  assert.match(compliance.notice, /not an assessment by the Planning Inspectorate/);
  assert.equal(compliance.parts[0].entries[6].shows, 'To be completed by the authority. The plan document alone cannot show this.');
  assert.deepEqual(soundness.entries.map((e) => e.title), ['Positive', 'Appropriate', 'Effective', 'Consistent with national policy', 'Conformity with the spatial development strategy']);
  assert.ok(soundness.entries.every((e) => e.questions.length > 0), 'every test has questions an inspector may ask');
});

test('a model reply wrapped in prose or fences still parses; anything else does not', () => {
  assert.deepEqual(parseModelJson('Here you go:\n```json\n{"items":[{"id":"A1",}]}\n```'), { items: [{ id: 'A1' }] });
  assert.equal(parseModelJson('no braces here'), null);
  assert.equal(parseModelJson('[1,2]'), null);
});

test('a check can be cancelled', async () => {
  const abort = new AbortController();
  const pending = check(fakeComplete({ delayMs: 50 }), { signal: abort.signal });
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(pending);
});
