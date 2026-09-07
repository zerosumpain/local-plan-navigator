// tests/content.test.mjs — the content data has to hang together.
//
// The build already refuses an unresolved citation; these tests cover the
// rest: every stage's `next` exists, the question flow reaches every result
// and every option goes somewhere, checklist ids are unique, and the
// glossary points at real anchors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const json = async (f) => JSON.parse(await readFile(new URL(`../content/${f}`, import.meta.url), 'utf8'));

test('every stage links to stages that exist, and every phase is used', async () => {
  const { phases, stages } = await json('stages.json');
  const ids = new Set(stages.map((s) => s.id));
  const phaseIds = new Set(phases.map((p) => p.id));
  for (const s of stages) {
    assert.ok(phaseIds.has(s.phase), `${s.id}: unknown phase ${s.phase}`);
    for (const n of s.next ?? []) assert.ok(ids.has(n), `${s.id}: next stage ${n} does not exist`);
    assert.ok(s.summary && s.title && s.short && s.when, `${s.id}: missing summary/title/short/when`);
    if (s.clock) assert.ok(s.clock[0] <= s.clock[1] && s.clock[1] <= 36, `${s.id}: clock out of range`);
  }
  for (const p of phaseIds) assert.ok(stages.some((s) => s.phase === p), `phase ${p} has no stages`);
  // Exactly three gateways, in order.
  assert.deepEqual(stages.filter((s) => s.kind === 'gateway').map((s) => s.id), ['gateway-1', 'gateway-2', 'gateway-3']);
});

test('the question flow is complete and every result is reachable', async () => {
  const n = await json('navigator.json');
  const { stages } = await json('stages.json');
  const stageIds = new Set(stages.map((s) => s.id));
  assert.ok(n.questions[n.start], 'start question exists');
  const reached = new Set();
  for (const [qid, q] of Object.entries(n.questions)) {
    assert.ok(q.options.length >= 2, `${qid}: fewer than two options`);
    for (const o of q.options) {
      assert.ok((o.next && n.questions[o.next]) || (o.result && n.results[o.result]), `${qid}/${o.value}: goes nowhere`);
      if (o.result) reached.add(o.result);
    }
  }
  for (const rid of Object.keys(n.results)) assert.ok(reached.has(rid), `result ${rid} is unreachable`);
  for (const [rid, r] of Object.entries(n.results)) for (const t of r.now ?? []) if (t.stage) assert.ok(stageIds.has(t.stage), `${rid}: unknown stage ${t.stage}`);
});

test('checklist item ids are unique across all checklists', async () => {
  const { checklists } = await json('checklists.json');
  const seen = new Set();
  for (const c of checklists) for (const g of c.groups) for (const i of g.items) {
    assert.ok(!seen.has(i.id), `duplicate checklist item id ${i.id}`);
    seen.add(i.id);
    assert.ok(i.text.length > 10, `${i.id}: text too short`);
  }
  assert.ok(seen.size > 100);
});

test('glossary terms are unique and sorted enough to find', async () => {
  const { terms, abbreviations } = await json('glossary.json');
  const names = terms.map((t) => t.term.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'duplicate glossary term');
  assert.ok(abbreviations.every((a) => a.abbr && a.expansion));
});
