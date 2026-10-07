// src/lib/plan-timetable.ts — the planner's milestones as plan-timetable data.
//
// The Planning Data (England) Regulations 2026 (SI 2026/420, in force 7 May
// 2026) make a local plan timetable planning data, and require it to be
// published to the approved data standard: MHCLG's "Publish your plan data"
// (statutory guidance, updated 13 August 2026). Under that standard the
// timetable is a CSV with one row per plan event, and a local plan's timetable
// must include an event-date for each of twelve events.
//
// The columns, their order and the event codes here are exactly those of
// MHCLG's template (local-plan-and-minerals-and-waste-plan-timetable-
// template.csv, on GOV.UK) and of the plan-event codes on
// planning.data.gov.uk. The template also lists three publication events
// (the Gateway 2 and Gateway 3 reports and the examiner's recommendations)
// that the planner dates too, so they are included with their planned dates.
// The optional events (main modifications, pauses, additional consultations,
// a repeated Gateway 3, withdrawal, revocation) are left for the authority
// to add when they happen.
//
// Shared by the planner page (the download) and tests/plan-timetable.test.mjs.
import type { Schedule } from './schedule.ts';

/** The plan-timetable fields, in the template's order. */
export const PLAN_TIMETABLE_FIELDS = ['reference', 'plan', 'plan-event', 'event-date', 'entry-date', 'actual-date', 'notes'] as const;
export type PlanTimetableField = (typeof PLAN_TIMETABLE_FIELDS)[number];
export type PlanTimetableRow = Record<PlanTimetableField, string>;

/**
 * Each event in the template's order, and the planner milestone it is dated
 * from: the start of a window, its end, or a single date.
 */
export const PLAN_EVENTS: { event: string; milestone: string; at: 'start' | 'end'; required: boolean }[] = [
  { event: 'publish-notice-intention-commence', milestone: 'notice', at: 'start', required: true },
  { event: 'scoping-consultation-start', milestone: 'scoping', at: 'start', required: true },
  { event: 'scoping-consultation-end', milestone: 'scoping', at: 'end', required: true },
  { event: 'gateway-1-self-assessment', milestone: 'gateway-1', at: 'start', required: true },
  { event: 'plan-content-evidence-consultation-start', milestone: 'content', at: 'start', required: true },
  { event: 'plan-content-evidence-consultation-end', milestone: 'content', at: 'end', required: true },
  // Advice is sought on the day the authority sends its documents: the first day of the gateway.
  { event: 'gateway-2-advice-sought', milestone: 'gateway-2', at: 'start', required: true },
  { event: 'gateway-2-advice-published', milestone: 'g2-publish', at: 'start', required: false },
  { event: 'proposed-plan-consultation-start', milestone: 'plan', at: 'start', required: true },
  { event: 'proposed-plan-consultation-end', milestone: 'plan', at: 'end', required: true },
  { event: 'gateway-3-advice-sought', milestone: 'gateway-3', at: 'start', required: true },
  // The planner has no separate date for publishing the Gateway 3 report; it arrives as the assessment ends.
  { event: 'gateway-3-advice-published', milestone: 'gateway-3', at: 'end', required: false },
  { event: 'examination-submitted', milestone: 'submission', at: 'start', required: true },
  { event: 'examination-recommendations-published', milestone: 'report-publish', at: 'start', required: false },
  { event: 'adopted', milestone: 'adoption', at: 'start', required: true },
];

export interface PlanTimetableOptions {
  /** The plan's reference, which must match the reference in the authority's plan dataset. */
  plan: string;
  /** The date the data was created or changed (YYYY-MM-DD). */
  entryDate: string;
}

/**
 * A plan reference the standard will accept and a reader can say: letters,
 * numbers, hyphens, underscores and full stops, starting with a letter or
 * number ("LP-BRX-2024", "barnet-local-plan-2021-2036").
 */
export function validPlanReference(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(ref);
}

/** One row per event. Each event's reference is the plan's reference and the event code, which is unique and stable. */
export function planTimetableRows(s: Schedule, o: PlanTimetableOptions): PlanTimetableRow[] {
  return PLAN_EVENTS.map(({ event, milestone, at }) => {
    const m = s.milestones.find((x) => x.id === milestone);
    if (!m) throw new Error(`the schedule has no ${milestone} milestone for ${event}`);
    return {
      reference: `${o.plan}-${event}`,
      plan: o.plan,
      'plan-event': event,
      'event-date': at === 'end' ? m.end : m.start,
      'entry-date': o.entryDate,
      'actual-date': '', // left blank while the event is in the future
      notes: '',
    };
  });
}

/** RFC 4180 CSV, as the government's tabular data standard asks: a header row, CRLF line ends, quotes only where needed. */
export function toCsv(rows: PlanTimetableRow[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [PLAN_TIMETABLE_FIELDS.join(','), ...rows.map((r) => PLAN_TIMETABLE_FIELDS.map((f) => cell(r[f])).join(','))].join('\r\n') + '\r\n';
}

export function planTimetableCsv(s: Schedule, o: PlanTimetableOptions): string {
  return toCsv(planTimetableRows(s, o));
}
