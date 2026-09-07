// src/lib/schedule.ts — the timetable maths, shared by the build (which
// renders a worked example) and the browser (which renders yours).
//
// Everything is derived from one date, the day the Gateway 1 self-assessment
// summary is published, plus a handful of durations you can adjust. Each
// milestone carries the rule it comes from, and the statutory minimums are
// checked so that a timetable that breaks one is flagged rather than drawn.
//
// The default durations reproduce the government's own picture of the 30
// months: preparation to month 23 with Gateway 2 around the halfway point,
// examination in months 24 to 29, adoption in months 30 to 31.
export interface PlannerInputs {
  /** ISO date (YYYY-MM-DD) the Gateway 1 summary is, or will be, published. */
  gateway1: string;
  /** Months of notice before Gateway 1 (statutory minimum 4). */
  noticeMonths: number;
  /** Length of the scoping consultation in weeks (21 days recommended). */
  scopingWeeks: number;
  /** Weeks from Gateway 1 to the start of the content and evidence consultation. */
  prepWeeks: number;
  /** Length of the content and evidence consultation in weeks (statutory minimum 6). */
  contentWeeks: number;
  /** Weeks from the content and evidence summary to the start of Gateway 2. */
  collateWeeks: number;
  /** Length of Gateway 2 in weeks (4 to 6 expected). */
  gateway2Weeks: number;
  /** Weeks after the Gateway 2 report is published before the proposed plan consultation starts. */
  reviseWeeks: number;
  /** Length of the proposed plan consultation in weeks (statutory minimum 8). */
  planWeeks: number;
  /** Weeks from the proposed plan summary to the start of Gateway 3. */
  finaliseWeeks: number;
  /** Length of Gateway 3 in weeks (4, up to 6 by exception). */
  gateway3Weeks: number;
  /** Months for the examination (the government expects no more than 6). */
  examinationMonths: number;
  /** Months of pause, if any (statutory maximum 6). */
  pauseMonths: number;
  /** Weeks from the Inspector's report to full council adoption. */
  adoptionWeeks: number;
}

export const DEFAULT_INPUTS: PlannerInputs = {
  gateway1: '',
  noticeMonths: 4,
  scopingWeeks: 4,
  prepWeeks: 26,
  contentWeeks: 6,
  collateWeeks: 20,
  gateway2Weeks: 6,
  reviseWeeks: 8,
  planWeeks: 8,
  finaliseWeeks: 4,
  gateway3Weeks: 4,
  examinationMonths: 6,
  pauseMonths: 0,
  adoptionWeeks: 4,
};

export interface Milestone {
  id: string;
  label: string;
  /** ISO start date. */
  start: string;
  /** ISO end date for windows; same as start for a point in time. */
  end: string;
  phase: 'get-ready' | 'prepare' | 'examine' | 'adopt' | 'monitor';
  kind: 'milestone' | 'window' | 'deadline';
  /** The rule this date comes from, in a sentence. */
  rule: string;
  /** A content reference for the rule. */
  ref?: { doc: string; anchor: string; label: string };
}

export interface Check {
  id: string;
  ok: boolean;
  text: string;
  ref?: { doc: string; anchor: string; label: string };
}

export interface Schedule {
  inputs: PlannerInputs;
  milestones: Milestone[];
  checks: Check[];
  /** Whole months from Gateway 1 to adoption. */
  monthsToAdoption: number;
}

const DAY = 86400000;
export const iso = (d: Date): string => d.toISOString().slice(0, 10);
export const parseIso = (s: string): Date => new Date(s + 'T00:00:00Z');
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY);
export const addWeeks = (d: Date, n: number): Date => addDays(d, Math.round(n * 7));
export function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + n);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}
export const monthsBetween = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / (DAY * 30.4375);

export function formatDate(s: string): string {
  const d = parseIso(s);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Build the whole timetable from the inputs. Pure: same inputs, same output. */
export function buildSchedule(partial: Partial<PlannerInputs>): Schedule {
  const inputs: PlannerInputs = { ...DEFAULT_INPUTS, ...partial };
  const g1 = parseIso(inputs.gateway1);
  const m: Milestone[] = [];
  const point = (id: string, label: string, d: Date, phase: Milestone['phase'], rule: string, ref?: Milestone['ref'], kind: Milestone['kind'] = 'milestone') => m.push({ id, label, start: iso(d), end: iso(d), phase, kind, rule, ref });
  const window = (id: string, label: string, a: Date, b: Date, phase: Milestone['phase'], rule: string, ref?: Milestone['ref']) => m.push({ id, label, start: iso(a), end: iso(b), phase, kind: 'window', rule, ref });

  // Before the clock
  const notice = addMonths(g1, -inputs.noticeMonths);
  point('timetable', 'Publish the local plan timetable', notice, 'get-ready', 'Before or on the day of the notice of intention to commence.', { doc: 'regulations-2026', anchor: 'reg-8', label: 'Regulation 8' });
  point('notice', 'Notice of intention to commence', notice, 'get-ready', `At least 4 months before Gateway 1 (you chose ${inputs.noticeMonths}).`, { doc: 'regulations-2026', anchor: 'reg-21', label: 'Regulation 21(3)' });
  const scopingEnd = addWeeks(notice, inputs.scopingWeeks);
  window('scoping', 'Scoping consultation', notice, scopingEnd, 'get-ready', 'No earlier than the notice; must close before Gateway 1; at least 21 days recommended.', { doc: 'regulations-2026', anchor: 'reg-20', label: 'Regulation 20' });
  point('gateway-1', 'Gateway 1: publish the self-assessment summary', g1, 'get-ready', 'Day one of the 30 months. Update the timetable the same day.', { doc: 'regulations-2026', anchor: 'reg-21', label: 'Regulation 21' });

  // Prepare the plan
  const scopingSummary = addWeeks(g1, 1);
  point('scoping-summary', 'Publish the summary of scoping consultation', scopingSummary, 'prepare', 'No earlier than the day after Gateway 1; before the next consultation.', { doc: 'regulations-2026', anchor: 'reg-22', label: 'Regulation 22' });
  const contentStart = addWeeks(g1, inputs.prepWeeks);
  const contentEnd = addWeeks(contentStart, inputs.contentWeeks);
  window('content', 'Consultation on proposed plan content and evidence', contentStart, contentEnd, 'prepare', `Minimum 6 weeks from publication of the notice (you chose ${inputs.contentWeeks}).`, { doc: 'regulations-2026', anchor: 'reg-23', label: 'Regulation 23(5)' });
  point('sea-scope', 'SEA consultation bodies respond on the environmental report scope', addWeeks(contentStart, 5), 'prepare', 'Consultation bodies have 5 weeks from the invitation.', { doc: 'sea-regulations-2004', anchor: 'reg-12', label: 'SEA Regulations, regulation 12(6)' });
  const contentSummary = addWeeks(contentEnd, 2);
  point('content-summary', 'Publish the summary of that consultation', contentSummary, 'prepare', 'No earlier than the day after the closing date; Gateway 2 cannot start before it.', { doc: 'regulations-2026', anchor: 'reg-24', label: 'Regulation 24(3)' });
  const g2Start = addWeeks(contentSummary, inputs.collateWeeks);
  point('g2-notice', 'Tell the Planning Inspectorate your Gateway 2 date', addMonths(g2Start, -3), 'prepare', 'At least 3 months before entering Gateway 2.', { doc: 'procedural-guide', anchor: '3-1-the-local-plan-timetable-and-planning-inspectorate-resourcing', label: 'Procedural guide 3.1.3' });
  const g2End = addWeeks(g2Start, inputs.gateway2Weeks);
  window('gateway-2', 'Gateway 2 assessment', g2Start, g2End, 'prepare', `Expected to take 4 to 6 weeks (you chose ${inputs.gateway2Weeks}). Workshop in week 3.`, { doc: 'procedural-guide', anchor: '3-5-the-gateway-2-process', label: 'Procedural guide 3.5' });
  const g2Publish = addWeeks(g2End, 1);
  point('g2-publish', 'Publish the Gateway 2 report and everything submitted', g2Publish, 'prepare', 'As soon as reasonably practicable; update the timetable the same day.', { doc: 'regulations-2026', anchor: 'reg-26', label: 'Regulation 26(5)' });
  const planStart = addWeeks(g2Publish, inputs.reviseWeeks);
  const planEnd = addWeeks(planStart, inputs.planWeeks);
  window('plan', 'Consultation on the proposed local plan (and SDS conformity)', planStart, planEnd, 'prepare', `Minimum 8 weeks (you chose ${inputs.planWeeks}); no earlier than the day after the Gateway 2 report is published.`, { doc: 'regulations-2026', anchor: 'reg-27', label: 'Regulation 27' });
  const planSummary = addWeeks(planEnd, 3);
  point('plan-summary', 'Publish the summary of the proposed plan consultation', planSummary, 'prepare', 'No earlier than the day after the closing date; Gateway 3 cannot start before it.', { doc: 'regulations-2026', anchor: 'reg-30', label: 'Regulation 30(3)' });
  const g3Start = addWeeks(planSummary, inputs.finaliseWeeks);
  point('g3-notice', 'Tell the Planning Inspectorate your Gateway 3 date', addMonths(g3Start, -3), 'prepare', 'At least 3 months before entering Gateway 3.', { doc: 'procedural-guide', anchor: '3-1-the-local-plan-timetable-and-planning-inspectorate-resourcing', label: 'Procedural guide 3.1.3' });
  const g3End = addWeeks(g3Start, inputs.gateway3Weeks);
  window('gateway-3', 'Gateway 3 assessment', g3Start, g3End, 'prepare', `Usually 4 weeks, up to 6 by exception (you chose ${inputs.gateway3Weeks}).`, { doc: 'procedural-guide', anchor: '3-7-purpose-of-a-gateway-3-assessment', label: 'Procedural guide 3.7' });

  // Examination
  const submission = addWeeks(g3End, 3);
  point('submission', 'Submit the plan for examination', submission, 'examine', 'Normally within 3 weeks of the Gateway 3 report.', { doc: 'procedural-guide', anchor: '4-1-timing-of-local-plan-submission', label: 'Procedural guide 4.1.1' });
  const examEnd = addMonths(addMonths(submission, inputs.examinationMonths), inputs.pauseMonths);
  window('examination', inputs.pauseMonths ? `Examination (including a ${inputs.pauseMonths}-month pause)` : 'Examination', submission, examEnd, 'examine', `The government expects no more than 6 months${inputs.pauseMonths ? `; a pause may add up to 6 (you chose ${inputs.pauseMonths})` : ''}.`, { doc: 'procedural-guide', anchor: '2-overview', label: 'Procedural guide 2.7' });
  const hearings = addMonths(submission, 3);
  point('hearing-notice', 'Publish hearing date, time, place and the Inspector\'s name', addWeeks(hearings, -6), 'examine', 'At least 6 weeks before the hearing opens (hearings assumed 3 months after submission).', { doc: 'regulations-2026', anchor: 'reg-35', label: 'Regulation 35' });

  // Adoption
  point('report', 'Inspector\'s report received; fact-check within 5 days', examEnd, 'adopt', 'The examination ends when the report is delivered.', { doc: 'procedural-guide', anchor: '11-4-fact-check-final-reports', label: 'Procedural guide 11.4' });
  point('report-publish', 'Publish the recommendations and reasons', addWeeks(examEnd, 1), 'adopt', 'As soon as reasonably practicable; update the timetable the same day.', { doc: 'regulations-2026', anchor: 'reg-37', label: 'Regulation 37' });
  const adoption = addWeeks(examEnd, inputs.adoptionWeeks);
  point('adoption', 'Full council adopts the plan; adoption statement and SEA statement published', adoption, 'adopt', 'Full council approval is required; publish the adoption statement and the SEA post-adoption information.', { doc: 'regulations-2026', anchor: 'reg-39', label: 'Regulation 39' });
  point('policies-map', 'Policies map published', addMonths(adoption, 1), 'adopt', 'Immediately after adoption and no later than one month after.', { doc: 'regulations-2026', anchor: 'reg-85', label: 'Regulation 85(2)' }, 'deadline');

  // Monitoring
  point('evaluation', 'Plan evaluation report', addMonths(adoption, 48), 'monitor', 'In year 4 from adoption.', { doc: '30-month-overview', anchor: 'month-31-onwards-monitor-your-plan', label: '30-month overview' });
  point('next-plan', 'Latest date to pass Gateway 1 for the next plan', addDays(addMonths(adoption, 60), 0), 'monitor', 'Within 5 years of adoption.', { doc: 'regulations-2026', anchor: 'reg-18', label: 'Regulation 18' }, 'deadline');

  // Creation order follows the narrative; the reader wants dates in order.
  m.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const monthsToAdoption = monthsBetween(g1, adoption);
  const checks: Check[] = [
    { id: 'notice', ok: inputs.noticeMonths >= 4, text: 'At least 4 months between the notice and Gateway 1', ref: { doc: 'regulations-2026', anchor: 'reg-21', label: 'Regulation 21(3)' } },
    { id: 'scoping', ok: scopingEnd < g1, text: 'The scoping consultation closes before Gateway 1', ref: { doc: 'regulations-2026', anchor: 'reg-21', label: 'Regulation 21(3)' } },
    { id: 'scoping-length', ok: inputs.scopingWeeks * 7 >= 21, text: 'The scoping consultation runs for at least 21 days (recommended)', ref: { doc: 'engaging-the-public', anchor: 'scoping-consultation-invites', label: 'Engaging the public' } },
    { id: 'content', ok: inputs.contentWeeks >= 6, text: 'The content and evidence consultation is at least 6 weeks', ref: { doc: 'regulations-2026', anchor: 'reg-23', label: 'Regulation 23(5)' } },
    { id: 'plan', ok: inputs.planWeeks >= 8, text: 'The proposed plan consultation is at least 8 weeks', ref: { doc: 'regulations-2026', anchor: 'reg-27', label: 'Regulation 27(5)' } },
    { id: 'g2', ok: inputs.gateway2Weeks >= 4 && inputs.gateway2Weeks <= 6, text: 'Gateway 2 is planned at 4 to 6 weeks', ref: { doc: 'procedural-guide', anchor: '3-5-the-gateway-2-process', label: 'Procedural guide 3.5.2' } },
    { id: 'g3', ok: inputs.gateway3Weeks >= 4 && inputs.gateway3Weeks <= 6, text: 'Gateway 3 is planned at 4 weeks, or up to 6 by exception', ref: { doc: 'procedural-guide', anchor: '3-7-purpose-of-a-gateway-3-assessment', label: 'Procedural guide 3.7.1' } },
    { id: 'pause', ok: inputs.pauseMonths <= 6, text: 'Any pause is no more than 6 months', ref: { doc: 'regulations-2026', anchor: 'reg-36', label: 'Regulation 36(1)' } },
    { id: 'exam', ok: inputs.examinationMonths <= 6, text: 'The examination is planned at no more than 6 months', ref: { doc: 'procedural-guide', anchor: '2-overview', label: 'Procedural guide 2.7' } },
    { id: 'thirty', ok: monthsToAdoption <= 31, text: `Adoption within about 30 months of Gateway 1 (this timetable: ${monthsToAdoption.toFixed(1)} months)`, ref: { doc: 'nppf', anchor: 'PM2', label: 'NPPF policy PM2(2)' } },
  ];
  return { inputs, milestones: m, checks, monthsToAdoption };
}

/** The worked example the planner page shows before any date is entered. */
export function exampleSchedule(): Schedule {
  return buildSchedule({ gateway1: '2027-01-04' });
}
