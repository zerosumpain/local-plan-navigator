// tests/plan-timetable.test.mjs — the planner's milestones as plan-timetable data.
//
// The field names, their order and the event codes are fixed by the approved
// data standard (MHCLG, "Publish your plan data", and its CSV template); the
// constants below are copied from those, not from the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule } from '../src/lib/schedule.ts';
import { planTimetableRows, planTimetableCsv, toCsv, validPlanReference, PLAN_TIMETABLE_FIELDS, PLAN_EVENTS } from '../src/lib/plan-timetable.ts';

// The header of local-plan-and-minerals-and-waste-plan-timetable-template.csv.
const TEMPLATE_HEADER = 'reference,plan,plan-event,event-date,entry-date,actual-date,notes';
// The events every local plan timetable must include ("Publish your plan data", plan timetable dataset).
const REQUIRED = [
  'publish-notice-intention-commence', 'scoping-consultation-start', 'scoping-consultation-end', 'gateway-1-self-assessment',
  'plan-content-evidence-consultation-start', 'plan-content-evidence-consultation-end', 'gateway-2-advice-sought',
  'proposed-plan-consultation-start', 'proposed-plan-consultation-end', 'gateway-3-advice-sought', 'examination-submitted', 'adopted',
];
// The non-optional rows of the template, in its order.
const TEMPLATE_ORDER = [
  'publish-notice-intention-commence', 'scoping-consultation-start', 'scoping-consultation-end', 'gateway-1-self-assessment',
  'plan-content-evidence-consultation-start', 'plan-content-evidence-consultation-end', 'gateway-2-advice-sought', 'gateway-2-advice-published',
  'proposed-plan-consultation-start', 'proposed-plan-consultation-end', 'gateway-3-advice-sought', 'gateway-3-advice-published',
  'examination-submitted', 'examination-recommendations-published', 'adopted',
];

const s = buildSchedule({ gateway1: '2027-01-04' });
const opts = { plan: 'LP-BRX-2027', entryDate: '2026-10-07' };
const rows = planTimetableRows(s, opts);
const at = (id, end = false) => { const m = s.milestones.find((x) => x.id === id); return end ? m.end : m.start; };
const dateOf = (event) => rows.find((r) => r['plan-event'] === event)['event-date'];

test('the columns are the template\'s, in its order', () => {
  assert.equal(PLAN_TIMETABLE_FIELDS.join(','), TEMPLATE_HEADER);
  assert.equal(planTimetableCsv(s, opts).split('\r\n')[0], TEMPLATE_HEADER);
});

test('every required event is there, in the template\'s order, and nothing else', () => {
  assert.deepEqual(rows.map((r) => r['plan-event']), TEMPLATE_ORDER);
  for (const e of REQUIRED) assert.ok(rows.some((r) => r['plan-event'] === e), `missing ${e}`);
  assert.deepEqual(PLAN_EVENTS.filter((e) => e.required).map((e) => e.event), REQUIRED);
});

test('each event takes its date from the right milestone', () => {
  assert.equal(dateOf('publish-notice-intention-commence'), at('notice'));
  assert.equal(dateOf('publish-notice-intention-commence'), '2026-09-04'); // four months before Gateway 1
  assert.equal(dateOf('scoping-consultation-start'), at('scoping'));
  assert.equal(dateOf('scoping-consultation-end'), at('scoping', true));
  assert.equal(dateOf('gateway-1-self-assessment'), '2027-01-04');
  assert.equal(dateOf('plan-content-evidence-consultation-start'), at('content'));
  assert.equal(dateOf('plan-content-evidence-consultation-end'), at('content', true));
  assert.equal(dateOf('gateway-2-advice-sought'), at('gateway-2'));
  assert.equal(dateOf('gateway-2-advice-published'), at('g2-publish'));
  assert.equal(dateOf('proposed-plan-consultation-start'), at('plan'));
  assert.equal(dateOf('proposed-plan-consultation-end'), at('plan', true));
  assert.equal(dateOf('gateway-3-advice-sought'), at('gateway-3'));
  assert.equal(dateOf('gateway-3-advice-published'), at('gateway-3', true));
  assert.equal(dateOf('examination-submitted'), at('submission'));
  assert.equal(dateOf('examination-recommendations-published'), at('report-publish'));
  assert.equal(dateOf('adopted'), at('adoption'));
});

test('the dates run in the legally fixed order and are YYYY-MM-DD', () => {
  const dates = rows.map((r) => r['event-date']);
  for (const d of dates) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  // Consultation ends never come before their starts; the rest is in sequence.
  assert.deepEqual(dates, [...dates].sort());
});

test('references are unique, every row names the plan, and future events have no actual date', () => {
  assert.equal(new Set(rows.map((r) => r.reference)).size, rows.length);
  assert.equal(rows[0].reference, 'LP-BRX-2027-publish-notice-intention-commence');
  for (const r of rows) {
    assert.equal(r.plan, 'LP-BRX-2027');
    assert.equal(r['entry-date'], '2026-10-07');
    assert.equal(r['actual-date'], '');
  }
});

test('the CSV is RFC 4180: CRLF line ends, a final line end, quotes only where a value needs them', () => {
  const csv = planTimetableCsv(s, opts);
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(csv.split('\r\n').length, rows.length + 2); // header, rows, and the empty string after the last CRLF
  assert.equal(csv.split('\r\n')[1], `LP-BRX-2027-publish-notice-intention-commence,LP-BRX-2027,publish-notice-intention-commence,${at('notice')},2026-10-07,,`);
  const odd = toCsv([{ reference: 'a', plan: 'b', 'plan-event': 'adopted', 'event-date': '2029-01-01', 'entry-date': '2026-10-07', 'actual-date': '', notes: 'Adopted by "full" council, 3 Jan' }]);
  assert.equal(odd.split('\r\n')[1], 'a,b,adopted,2029-01-01,2026-10-07,,"Adopted by ""full"" council, 3 Jan"');
});

test('a longer timetable moves every date with it', () => {
  const later = planTimetableRows(buildSchedule({ gateway1: '2027-01-04', pauseMonths: 3 }), opts);
  const by = (rs, e) => rs.find((r) => r['plan-event'] === e)['event-date'];
  assert.equal(by(later, 'examination-submitted'), dateOf('examination-submitted'));
  assert.ok(by(later, 'adopted') > dateOf('adopted'));
});

test('plan references: the standard\'s examples pass, anything unreadable does not', () => {
  for (const ok of ['LP-BRX-2024', 'barnet-local-plan-2021-2036', 'central-lincolnshire', 'essex_waste.plan']) assert.ok(validPlanReference(ok), ok);
  for (const bad of ['', ' LP', 'LP 2024', 'LP,2024', '-LP', 'x'.repeat(101)]) assert.ok(!validPlanReference(bad), JSON.stringify(bad));
});
