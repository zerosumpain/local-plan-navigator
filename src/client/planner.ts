// src/client/planner.ts — the timeline planner page.
//
// Reads the date and the durations, builds the schedule with the same
// function the build used for the worked example, and re-renders the checks,
// the table and the chart. Invalid input gets the GOV.UK error summary.
// The timetable downloads two ways: a readable CSV of every milestone, and
// the plan-timetable dataset the Planning Data Regulations require
// (src/lib/plan-timetable.ts).
import { buildSchedule, formatDate, iso, type Schedule, type PlannerInputs } from '../lib/schedule.ts';
import { ganttSvg } from '../lib/gantt.ts';
import { armViz } from './viz';
import { planTimetableCsv, validPlanReference } from '../lib/plan-timetable.ts';
import { escapeHtml } from './retrieval';

/** A GOV.UK date input's three fields as an ISO date, or null if they do not make a real date. */
function readDate(form: HTMLFormElement, prefix: string): string | null {
  const num = (name: string) => Number((form.elements.namedItem(`${prefix}-${name}`) as HTMLInputElement)?.value);
  const d = num('day'), mo = num('month'), y = num('year');
  const date = new Date(Date.UTC(y, mo - 1, d));
  const ok = Number.isInteger(d) && Number.isInteger(mo) && Number.isInteger(y) && y >= 2025 && y <= 2100 && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
  return ok ? iso(date) : null;
}

function download(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function init(): void {
  const form = document.querySelector<HTMLFormElement>('form.lpn-planner');
  const out = document.querySelector<HTMLElement>('#planner-output');
  if (!form || !out) return;
  const base = document.body.dataset.base ?? './';
  const refRoutes: Record<string, string> = JSON.parse(document.getElementById('planner-ref-routes')?.textContent ?? '{}');
  let current: Schedule | null = null;

  const read = (): { inputs: Partial<PlannerInputs>; errors: { href: string; text: string }[] } => {
    const errors: { href: string; text: string }[] = [];
    const num = (name: string) => Number((form.elements.namedItem(name) as HTMLInputElement)?.value);
    const gateway1 = readDate(form, 'g1');
    if (!gateway1) errors.push({ href: '#g1-day', text: 'Enter a real Gateway 1 date, for example 4 1 2027' });
    const inputs: Partial<PlannerInputs> = { gateway1: gateway1 ?? '' };
    for (const f of ['noticeMonths', 'scopingWeeks', 'prepWeeks', 'contentWeeks', 'collateWeeks', 'gateway2Weeks', 'reviseWeeks', 'planWeeks', 'finaliseWeeks', 'gateway3Weeks', 'examinationMonths', 'pauseMonths', 'adoptionWeeks'] as const) {
      const v = num(f);
      if (!Number.isFinite(v) || v < 0 || v > 120) errors.push({ href: `#${f}`, text: `Enter a number of ${f.endsWith('Months') ? 'months' : 'weeks'} for ${(form.querySelector(`label[for="${f}"]`)?.textContent ?? f).trim().toLowerCase()}` });
      else inputs[f] = v;
    }
    return { inputs, errors };
  };

  const showErrors = (errors: { href: string; text: string }[]) => {
    const box = form.querySelector<HTMLElement>('[data-errors]')!;
    form.querySelectorAll('.govuk-form-group--error').forEach((g) => g.classList.remove('govuk-form-group--error'));
    form.querySelectorAll('.govuk-error-message').forEach((m) => m.remove());
    if (!errors.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="govuk-error-summary" data-module="govuk-error-summary" tabindex="-1"><div role="alert"><h2 class="govuk-error-summary__title">There is a problem</h2><div class="govuk-error-summary__body"><ul class="govuk-list govuk-error-summary__list">${errors.map((e) => `<li><a href="${e.href}">${escapeHtml(e.text)}</a></li>`).join('')}</ul></div></div></div>`;
    for (const e of errors) {
      const el = form.querySelector<HTMLElement>(e.href);
      const group = el?.closest('.govuk-form-group');
      group?.classList.add('govuk-form-group--error');
      const msg = document.createElement('p'); msg.className = 'govuk-error-message'; msg.innerHTML = `<span class="govuk-visually-hidden">Error:</span> ${escapeHtml(e.text)}`;
      (group?.querySelector('.govuk-fieldset__legend, label') ?? group?.firstElementChild)?.insertAdjacentElement('afterend', msg);
    }
    (box.firstElementChild as HTMLElement).focus();
  };

  const refLink = (ref?: { doc: string; anchor: string; label: string }) => {
    if (!ref) return '';
    const route = refRoutes[`${ref.doc}#${ref.anchor}`];
    const href = route ? `${base}${route.replace(/^\//, '')}#${ref.anchor}` : `${base}reference/${ref.doc}/`;
    return ` <span class="lpn-cite"><a class="govuk-link" href="${href}">${escapeHtml(ref.label)}</a></span>`;
  };

  const render = (s: Schedule) => {
    current = s;
    out.removeAttribute('data-example');
    out.innerHTML = `
      <h2 class="govuk-heading-l">Your timetable: Gateway 1 on ${formatDate(s.inputs.gateway1)}</h2>
      <h3 class="govuk-heading-m">Checks</h3>
      <ul class="govuk-list lpn-checks">${s.checks.map((c) => `<li class="lpn-check lpn-check--${c.ok ? 'ok' : 'fail'}"><span class="lpn-check__mark" aria-hidden="true">${c.ok ? '✓' : '✗'}</span> <span class="govuk-visually-hidden">${c.ok ? 'Passes:' : 'Fails:'}</span> ${escapeHtml(c.text)}${refLink(c.ref)}</li>`).join('')}</ul>
      <p class="govuk-body">Months from Gateway 1 to adoption: <strong>${s.monthsToAdoption.toFixed(1)}</strong>.</p>
      <h3 class="govuk-heading-m">Milestones</h3>
      <div class="lpn-table-scroll"><table class="govuk-table"><caption class="govuk-table__caption govuk-visually-hidden">Every milestone with its date and the rule behind it</caption>
      <thead class="govuk-table__head"><tr class="govuk-table__row"><th scope="col" class="govuk-table__header">Milestone</th><th scope="col" class="govuk-table__header">Date</th><th scope="col" class="govuk-table__header">Rule</th></tr></thead>
      <tbody class="govuk-table__body">${s.milestones.map((m) => `<tr class="govuk-table__row"><th scope="row" class="govuk-table__header">${escapeHtml(m.label)}</th><td class="govuk-table__cell">${formatDate(m.start)}${m.end !== m.start ? ' to ' + formatDate(m.end) : ''}</td><td class="govuk-table__cell">${escapeHtml(m.rule)}${refLink(m.ref)}</td></tr>`).join('')}</tbody></table></div>
      <h3 class="govuk-heading-m">Chart</h3>
      <figure class="lpn-figure lpn-figure--wide lpn-viz"><div class="lpn-figure__scroll">${ganttSvg(s, { id: 'gantt' })}</div><figcaption>The same milestones drawn against the calendar and grouped by phase. Bars are consultations, gateways and the examination; diamonds are single dates; red diamonds are statutory deadlines. The 30 months from Gateway 1 are shaded.</figcaption></figure>`;
    armViz(out);
    out.querySelector('h2')?.setAttribute('tabindex', '-1');
    (out.querySelector('h2') as HTMLElement | null)?.focus();
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { inputs, errors } = read();
    showErrors(errors);
    if (errors.length) return;
    render(buildSchedule(inputs));
  });
  form.querySelector('[data-action="print"]')?.addEventListener('click', () => window.print());
  form.querySelector('[data-action="csv"]')?.addEventListener('click', () => {
    const s = current ?? buildSchedule(read().inputs.gateway1 ? read().inputs : { gateway1: '2027-01-04' });
    const rows = [['Milestone', 'Start', 'End', 'Rule', 'Source'], ...s.milestones.map((m) => [m.label, m.start, m.end, m.rule, m.ref?.label ?? ''])];
    download(`local-plan-timetable-${s.inputs.gateway1}.csv`, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n'));
  });

  // The plan-timetable dataset: today's date is the entry date unless one is given.
  const today = new Date();
  for (const [name, value] of [['day', today.getDate()], ['month', today.getMonth() + 1], ['year', today.getFullYear()]] as const) {
    const field = form.elements.namedItem(`entry-${name}`) as HTMLInputElement | null;
    if (field && !field.value) field.value = String(value);
  }
  form.querySelector('[data-action="plan-timetable"]')?.addEventListener('click', () => {
    const { inputs, errors } = read();
    const plan = (form.elements.namedItem('planReference') as HTMLInputElement).value.trim();
    if (!plan) errors.push({ href: '#plan-reference', text: 'Enter the plan reference from your plan dataset' });
    else if (!validPlanReference(plan)) errors.push({ href: '#plan-reference', text: 'Plan reference must only include letters, numbers, hyphens, underscores and full stops, and be 100 characters or fewer' });
    const entryDate = readDate(form, 'entry');
    if (!entryDate) errors.push({ href: '#entry-day', text: 'Enter a real entry date, for example 7 10 2026' });
    showErrors(errors);
    if (errors.length || !entryDate) return;
    // The file follows the form as it is now; show that timetable too if it is not the one on screen.
    const s = buildSchedule(inputs);
    if (JSON.stringify(s.inputs) !== JSON.stringify(current?.inputs)) render(s);
    download(`${plan}-plan-timetable.csv`, planTimetableCsv(s, { plan, entryDate }));
  });
}
