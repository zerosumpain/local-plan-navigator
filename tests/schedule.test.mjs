// tests/schedule.test.mjs — the timetable maths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, DEFAULT_INPUTS, addMonths, parseIso, iso } from '../src/lib/schedule.ts';

const byId = (s, id) => s.milestones.find((m) => m.id === id);

test('the defaults land adoption inside 30 months and pass every check', () => {
  const s = buildSchedule({ gateway1: '2027-01-04' });
  assert.ok(s.monthsToAdoption > 24 && s.monthsToAdoption <= 31, `months to adoption ${s.monthsToAdoption}`);
  assert.ok(s.checks.every((c) => c.ok), s.checks.filter((c) => !c.ok).map((c) => c.text).join('; '));
});

test('the legally fixed order holds', () => {
  const s = buildSchedule({ gateway1: '2027-01-04' });
  const order = ['timetable', 'notice', 'scoping', 'gateway-1', 'scoping-summary', 'content', 'content-summary', 'gateway-2', 'g2-publish', 'plan', 'plan-summary', 'gateway-3', 'submission', 'examination', 'report', 'adoption', 'policies-map', 'next-plan'];
  let last = '';
  for (const id of order) {
    const m = byId(s, id);
    assert.ok(m, `missing milestone ${id}`);
    assert.ok(m.start >= last, `${id} (${m.start}) is before the step before it (${last})`);
    last = m.start;
  }
  // Milestones come back sorted by date.
  const starts = s.milestones.map((m) => m.start);
  assert.deepEqual(starts, [...starts].sort());
});

test('breaking a statutory minimum fails the right check', () => {
  const s = buildSchedule({ gateway1: '2027-01-04', contentWeeks: 5, planWeeks: 7, noticeMonths: 3, pauseMonths: 7 });
  const failed = s.checks.filter((c) => !c.ok).map((c) => c.id).sort();
  // A 7-month pause also pushes adoption past 30 months, so that check fails too.
  assert.deepEqual(failed, ['content', 'notice', 'pause', 'plan', 'thirty'].sort());
});

test('the notice period and the four-month rule', () => {
  const s = buildSchedule({ gateway1: '2027-06-30' });
  assert.equal(byId(s, 'notice').start, '2027-02-28'); // 4 months back from 30 June clamps to 28 Feb
  assert.equal(byId(s, 'next-plan').start, iso(addMonths(parseIso(byId(s, 'adoption').start), 60)));
});

test('month arithmetic clamps to the end of shorter months', () => {
  assert.equal(iso(addMonths(parseIso('2027-01-31'), 1)), '2027-02-28');
  assert.equal(iso(addMonths(parseIso('2027-03-31'), -1)), '2027-02-28');
  assert.equal(iso(addMonths(parseIso('2028-01-31'), 1)), '2028-02-29');
});

test('inputs are echoed back with defaults filled in', () => {
  const s = buildSchedule({ gateway1: '2027-01-04', gateway2Weeks: 5 });
  assert.equal(s.inputs.gateway2Weeks, 5);
  assert.equal(s.inputs.planWeeks, DEFAULT_INPUTS.planWeeks);
});
