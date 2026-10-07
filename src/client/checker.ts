// src/client/checker.ts — check a draft local plan.
//
// The page posts the file to the server that sent it (as the Ask page does),
// reads the server-sent events that come back — progress while the plan is
// checked, then the report — and renders the report: the summary counts, a
// card per check with its status as a tag with words, the quotes found in the
// plan, the gaps, the sources, and the two draft Gateway statements. The
// downloads go back to the server, which turns the report into Word or
// Markdown; the JSON is made here.
//
// Nothing is stored: the report lives in this page until it is downloaded.
import { escapeHtml } from './retrieval';

const ENDPOINT = '/api/projects/local-plan-navigator/check';
const EXPORT = '/api/projects/local-plan-navigator/check/export';
const SERVED = location.protocol === 'http:' || location.protocol === 'https:';
const MAX_BYTES = 15 * 1024 * 1024;
const ACCEPTED = ['.docx', '.pptx', '.md', '.markdown', '.txt'];
const TYPE_MESSAGE = 'The selected file must be a Word document (.docx), PowerPoint presentation (.pptx), Markdown file (.md) or text file (.txt)';

type Status = 'met' | 'partly' | 'missing' | 'not-assessable';
interface Evidence { quote: string; locator: string }
interface Citation { label: string; href: string | null; sourceTitle?: string }
interface Instance { id: string; label: string; locator: string; status: Status; note?: string; evidence: Evidence[]; findingLabel?: string; national?: { code: string; title: string; href: string | null }[]; clauses?: { quote: string; local: boolean; national: string | null; relation: string | null }[] }
interface Item { id: string; ref: string | null; title: string; requirement: string; status: Status; assessedBy: string; finding: string; evidence: Evidence[]; gaps: string[]; action: string; citations: Citation[]; notes: string[]; instances?: Instance[]; conditions?: { text: string; answer: 'yes' | 'no'; quote: string | null; locator: string | null }[]; questions?: string[]; evidenceDocuments?: string[] }
interface Section { id: string; letter: string; title: string; summary: string; mode: string; items: Item[] }
interface Entry { id: string; ref: string | null; title: string; requirement: string; status: Status; shows: string; evidence: Evidence[]; gaps: string[]; action: string; completeBy: string; questions?: string[]; evidenceDocuments?: string[] }
interface Report {
  document: { name: string; typeName: string; words: number; sectionCount: number };
  generatedAt: string;
  notice: string;
  detected: { method: string; allocations: { code: string; title: string; locator: string }[]; policies: { code: string; title: string }[]; outcomes: { number: number }[]; notes: string[] };
  sections: Section[];
  pending: { letter: string; title: string; summary: string }[];
  summary: { counts: Record<Status, number>; total: number; sections: { id: string; letter: string; title: string; counts: Record<Status, number>; total: number }[] };
  statements: { compliance: { title: string; notice: string; intro: string[]; parts: { heading: string; entries: Entry[] }[] }; soundness: { title: string; intro: string[]; entries: Entry[]; evidenceBase: string[] } };
}

const LABEL: Record<Status, string> = { met: 'Met', partly: 'Partly met', missing: 'Not met', 'not-assessable': 'Cannot assess' };
const TAG: Record<Status, string> = { met: 'green', partly: 'yellow', missing: 'red', 'not-assessable': 'grey' };
const BY: Record<string, string> = {
  model: 'Judged by the language model from the parts of the plan it needs, against the criteria in the rubric.',
  rule: 'Decided in code from what the checker found in the plan.',
  derived: 'Combined in code from the other checks it depends on.',
  officer: 'Depends on documents and steps outside the plan: for the authority to complete.',
};

const esc = (s: unknown) => escapeHtml(String(s ?? ''));
const tag = (status: Status, text = LABEL[status]) => `<strong class="govuk-tag govuk-tag--${TAG[status]}">${esc(text)}</strong>`;

export function init(): void {
  const form = document.querySelector<HTMLFormElement>('#checker-form');
  const input = document.querySelector<HTMLInputElement>('#plan-file');
  const errors = document.querySelector<HTMLElement>('#checker-errors');
  const progress = document.querySelector<HTMLElement>('#checker-progress');
  const bar = document.querySelector<HTMLProgressElement>('#checker-progress-bar');
  const progressText = document.querySelector<HTMLElement>('#checker-progress-text');
  const reportBox = document.querySelector<HTMLElement>('#checker-report');
  if (!form || !input || !errors || !progress || !bar || !progressText || !reportBox) return;
  const base = document.body.dataset.base ?? './';
  const pageTitle = document.title;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#checker-submit, [data-sample]')];
  let report: Report | null = null;
  let busy = false;

  // --- errors, in the GOV.UK pattern --------------------------------------
  const group = input.closest<HTMLElement>('.govuk-form-group');
  function clearErrors() {
    errors.innerHTML = '';
    group?.classList.remove('govuk-form-group--error');
    input.classList.remove('govuk-file-upload--error');
    document.querySelector('#plan-file-error')?.remove();
    input.setAttribute('aria-describedby', 'plan-file-hint');
    document.title = pageTitle;
  }
  function showError(message: string, onField: boolean) {
    clearErrors();
    errors.innerHTML = `<div class="govuk-error-summary" data-module="govuk-error-summary"><div role="alert"><h2 class="govuk-error-summary__title">There is a problem</h2><div class="govuk-error-summary__body"><ul class="govuk-list govuk-error-summary__list"><li>${onField ? `<a href="#plan-file">${esc(message)}</a>` : esc(message)}</li></ul></div></div></div>`;
    if (onField) {
      group?.classList.add('govuk-form-group--error');
      input.classList.add('govuk-file-upload--error');
      input.insertAdjacentHTML('beforebegin', `<p id="plan-file-error" class="govuk-error-message"><span class="govuk-visually-hidden">Error:</span> ${esc(message)}</p>`);
      input.setAttribute('aria-describedby', 'plan-file-hint plan-file-error');
    }
    document.title = `Error: ${pageTitle}`;
    const summary = errors.querySelector<HTMLElement>('.govuk-error-summary');
    summary?.setAttribute('tabindex', '-1');
    summary?.focus();
    errors.querySelector<HTMLAnchorElement>('a[href="#plan-file"]')?.addEventListener('click', (e) => { e.preventDefault(); input.focus(); });
  }
  function validate(file: File | undefined): string | null {
    if (!file) return 'Select a draft local plan to check';
    const ext = (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '').toLowerCase();
    if (!ACCEPTED.includes(ext)) return ext === '.pdf' ? 'PDF files cannot be checked. Upload the Word version of the plan (.docx)' : ext === '.doc' ? 'The selected file is an older Word format (.doc). Save it as a Word document (.docx) and try again' : TYPE_MESSAGE;
    if (file.size === 0) return 'The selected file is empty';
    if (file.size > MAX_BYTES) return 'The selected file must be smaller than 15MB';
    return null;
  }

  // --- running a check -----------------------------------------------------
  function setBusy(on: boolean) {
    busy = on;
    for (const b of buttons) { b.disabled = on; b.setAttribute('aria-disabled', String(on)); }
    progress.hidden = !on;
  }
  function showProgress(step: number, total: number | null, message: string) {
    if (total) { bar.max = total; bar.value = step; } else bar.removeAttribute('value');
    progressText.textContent = total ? `Step ${step} of ${total}: ${message}` : message;
  }

  async function check(file: File) {
    if (busy) return;
    const problem = validate(file);
    if (problem) { showError(problem, true); return; }
    clearErrors();
    if (!SERVED) { showError('The checker needs the website\'s server. A copy opened from a file cannot check plans.', false); return; }
    report = null;
    reportBox.innerHTML = '';
    setBusy(true);
    showProgress(0, null, `Sending ${file.name}…`);
    progress.scrollIntoView({ block: 'nearest' });
    try {
      const body = new FormData();
      body.append('plan', file, file.name);
      const res = await fetch(ENDPOINT, { method: 'POST', body });
      if (!res.ok || !res.body) {
        const said = await res.json().catch(() => ({})) as { message?: string; field?: string };
        const fieldError = res.status === 400 || res.status === 413 || res.status === 415;
        if (res.status === 404) throw new Error('This copy of the site has no checker behind it. Run `npm run preview:service`, or sign in again if your session has expired.');
        if (fieldError && said.message) { showError(said.message, true); return; }
        throw new Error(said.message || `The site answered ${res.status}.`);
      }
      // Server-sent events over POST: "event: x\ndata: {json}\n\n" frames.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const msg = JSON.parse(data) as { type: string; step?: number; total?: number | null; message?: string; report?: Report };
          if (msg.type === 'progress') showProgress(msg.step ?? 0, msg.total ?? null, msg.message ?? '');
          else if (msg.type === 'report' && msg.report) report = msg.report;
          else if (msg.type === 'error') throw new Error(msg.message || 'The check could not be completed.');
        }
      }
      if (!report) throw new Error('The connection closed before the check finished. Try again.');
      render(report);
    } catch (err) {
      const message = err instanceof Error ? (err.message === 'Failed to fetch' ? 'The checker could not be reached. Check your connection and try again.' : err.message) : String(err);
      showError(message, false);
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); void check(input.files?.[0] as File); });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-sample]')) {
    b.addEventListener('click', async () => {
      const name = b.dataset.sample ?? '';
      try {
        const res = await fetch(`${base}samples/${name}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        void check(new File([blob], name, { type: blob.type }));
      } catch {
        showError('The sample plan could not be loaded. Reload the page and try again.', false);
      }
    });
  }

  // --- downloads -----------------------------------------------------------
  function save(blob: Blob, name: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function exportReport(format: 'docx' | 'md', part: 'statements' | 'report', button: HTMLButtonElement) {
    if (!report) return;
    button.disabled = true;
    try {
      const res = await fetch(EXPORT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report, format, part }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message || `The site answered ${res.status}.`);
      const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? `plan-check.${format}`;
      save(await res.blob(), name);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err), false);
    } finally {
      button.disabled = false;
    }
  }
  reportBox.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-export]');
    if (!b || !report) return;
    const kind = b.dataset.export;
    if (kind === 'json') {
      const slug = report.document.name.replace(/\.[A-Za-z0-9]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'plan';
      save(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `plan-check-${slug}.json`);
    } else if (kind === 'docx') void exportReport('docx', 'statements', b);
    else if (kind === 'statements-md') void exportReport('md', 'statements', b);
    else if (kind === 'report-md') void exportReport('md', 'report', b);
  });

  // A closed <details> prints closed, and the draft statements live in two:
  // open every one in the report for printing, then put them back.
  let opened: HTMLDetailsElement[] = [];
  window.addEventListener('beforeprint', () => { opened = [...reportBox.querySelectorAll<HTMLDetailsElement>('details:not([open])')]; for (const d of opened) d.open = true; });
  window.addEventListener('afterprint', () => { for (const d of opened) d.open = false; opened = []; });

  // --- the report ----------------------------------------------------------
  const href = (h: string | null) => (h ? `${base}${h.replace(/^\//, '')}` : '');
  const citations = (cs: Citation[]) => cs.map((c) => (c.href ? `<a class="govuk-link" href="${esc(href(c.href))}">${esc(c.label)}</a>` : esc(c.label))).join(' · ');
  const quotes = (ev: Evidence[]) => ev.map((e) => `<blockquote class="lpn-evidence"><p>${esc(e.quote)}</p><footer class="lpn-evidence__where">${esc(e.locator)}</footer></blockquote>`).join('');
  const list = (xs: string[]) => (xs.length ? `<ul class="govuk-list govuk-list--bullet">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const row = (key: string, value: string) => (value ? `<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">${esc(key)}</dt><dd class="govuk-summary-list__value">${value}</dd></div>` : '');

  function conditionsHtml(item: Item) {
    if (!item.conditions?.length) return '';
    return `<ul class="govuk-list lpn-conditions">${item.conditions.map((c) => `<li>${tag(c.answer === 'yes' ? 'met' : 'missing', c.answer === 'yes' ? 'Yes' : 'No')} ${esc(c.text)}</li>`).join('')}</ul>`;
  }

  function instancesHtml(item: Item, section: Section) {
    if (!item.instances?.length) return '';
    const policy = section.mode === 'per-policy';
    const head = policy ? '<th scope="col" class="govuk-table__header">Policy</th><th scope="col" class="govuk-table__header">Result</th><th scope="col" class="govuk-table__header">Why</th>' : '<th scope="col" class="govuk-table__header">Allocation</th><th scope="col" class="govuk-table__header">Result</th><th scope="col" class="govuk-table__header">In the plan</th>';
    const rows = item.instances.map((x) => {
      const national = (x.national ?? []).map((n) => (n.href ? `<a class="govuk-link" href="${esc(href(n.href))}">${esc(n.code)}</a>` : esc(n.code))).join(', ');
      const why = policy
        ? `${x.findingLabel ? `<p class="govuk-body-s"><strong>${esc(x.findingLabel)}</strong>${national ? `: ${national}` : ''}</p>` : ''}${x.note ? `<p class="govuk-body-s">${esc(x.note)}</p>` : ''}${x.clauses?.length ? `<details class="govuk-details lpn-clauses"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">Clause by clause</span></summary><div class="govuk-details__text"><ul class="govuk-list govuk-list--spaced">${x.clauses.map((c) => `<li><span class="lpn-clause-label">${c.local ? 'Local' : c.relation === 'contradicts' ? `Contradicts ${esc(c.national)}` : c.national ? `Repeats ${esc(c.national)}` : 'Local'}${c.local && c.national ? ` (${c.relation === 'contradicts' ? 'departs from' : 'overlaps'} ${esc(c.national)})` : ''}:</span> “${esc(c.quote)}”</li>`).join('')}</ul></div></details>` : ''}`
        : `${x.evidence.map((e) => `<p class="govuk-body-s">“${esc(e.quote)}”</p>`).join('')}${x.note ? `<p class="govuk-body-s lpn-muted">${esc(x.note)}</p>` : ''}`;
      return `<tr class="govuk-table__row"><th scope="row" class="govuk-table__header">${esc(x.label)}</th><td class="govuk-table__cell">${tag(x.status)}</td><td class="govuk-table__cell">${why}</td></tr>`;
    }).join('');
    return `<table class="govuk-table lpn-instances"><caption class="govuk-table__caption govuk-table__caption--s">${esc(item.id)} for each ${policy ? 'policy' : 'allocation'}</caption><thead class="govuk-table__head"><tr class="govuk-table__row">${head}</tr></thead><tbody class="govuk-table__body">${rows}</tbody></table>`;
  }

  function itemHtml(item: Item, section: Section) {
    const detail = [
      row('What the plan shows', `<p class="govuk-body">${esc(item.finding)}</p>${conditionsHtml(item)}`),
      row('Evidence from the plan', quotes(item.evidence)),
      row('Gaps', list(item.gaps)),
      row('What to do', item.action ? `<p class="govuk-body">${esc(item.action)}</p>` : ''),
      row('Questions an inspector may ask', list(item.questions ?? [])),
      row('Evidence documents the plan names', list(item.evidenceDocuments ?? [])),
      row('How this was assessed', `<p class="govuk-body-s">${esc(BY[item.assessedBy] ?? '')}</p>${item.notes.map((n) => `<p class="govuk-body-s">${esc(n)}</p>`).join('')}`),
      row('Sources', `<p class="govuk-body-s">${citations(item.citations)}</p>`),
    ].join('');
    return `<div class="govuk-summary-card lpn-check" id="check-${esc(item.id)}">
      <div class="govuk-summary-card__title-wrapper"><h4 class="govuk-summary-card__title">${esc(item.id)}${item.ref && /^\d/.test(item.ref) ? ` (regulation ${esc(item.ref)})` : ''} ${esc(item.title)}</h4>${tag(item.status)}</div>
      <div class="govuk-summary-card__content"><p class="govuk-body-s lpn-requirement">${esc(item.requirement)}</p><dl class="govuk-summary-list">${detail}</dl>${instancesHtml(item, section)}</div>
    </div>`;
  }

  /** Every allocation against every footnote 8 item, at a glance. */
  function matrixHtml(section: Section) {
    const items = section.items.filter((i) => i.instances?.length);
    if (!items.length) return '';
    const ids = items[0].instances!.map((x) => x.id);
    const short: Record<Status, string> = { met: 'Yes', partly: 'Thin', missing: 'No', 'not-assessable': 'Not checked' };
    const head = items.map((i) => `<th scope="col" class="govuk-table__header">${esc(i.title)}</th>`).join('');
    const rows = ids.map((id) => {
      const first = items[0].instances!.find((x) => x.id === id)!;
      return `<tr class="govuk-table__row"><th scope="row" class="govuk-table__header">${esc(first.label)}</th>${items.map((i) => { const x = i.instances!.find((y) => y.id === id); return `<td class="govuk-table__cell">${x ? tag(x.status, short[x.status]) : ''}</td>`; }).join('')}</tr>`;
    }).join('');
    return `<div class="lpn-table-scroll" tabindex="0" role="region" aria-label="Site allocations against footnote 8"><table class="govuk-table lpn-matrix"><caption class="govuk-table__caption govuk-table__caption--s">Each allocation against footnote 8</caption><thead class="govuk-table__head"><tr class="govuk-table__row"><th scope="col" class="govuk-table__header">Allocation</th>${head}</tr></thead><tbody class="govuk-table__body">${rows}</tbody></table></div>`;
  }

  function entryHtml(e: Entry) {
    return `<div class="govuk-summary-card"><div class="govuk-summary-card__title-wrapper"><h4 class="govuk-summary-card__title">${e.ref && /^\d/.test(e.ref) ? `Regulation ${esc(e.ref)}: ` : ''}${esc(e.title)}</h4>${tag(e.status, e.completeBy === 'authority' ? 'For the authority' : LABEL[e.status])}</div><div class="govuk-summary-card__content"><dl class="govuk-summary-list">
      ${row('What the plan shows', `<p class="govuk-body">${esc(e.shows)}</p>`)}
      ${row('Where in the plan', e.evidence.map((x) => `<p class="govuk-body-s">${esc(x.locator)}</p>`).join(''))}
      ${row('Gaps', list(e.gaps))}
      ${row('Questions an inspector may ask', list(e.questions ?? []))}
      ${row('Action', e.action ? `<p class="govuk-body">${esc(e.action)}</p>` : '')}
    </dl></div></div>`;
  }

  function render(r: Report) {
    const s = r.summary;
    const sumRows = s.sections.map((x) => `<tr class="govuk-table__row"><th scope="row" class="govuk-table__header"><a class="govuk-link" href="#report-${esc(x.id)}">${esc(x.letter)}. ${esc(x.title)}</a></th>${(['met', 'partly', 'missing', 'not-assessable'] as Status[]).map((k) => `<td class="govuk-table__cell govuk-table__cell--numeric">${x.counts[k]}</td>`).join('')}</tr>`).join('');
    const d = r.detected;
    const found = `<dl class="govuk-summary-list">
      ${row('Site allocations', d.allocations.length ? list(d.allocations.map((a) => `${a.code} ${a.title}`.trim())) : '<p class="govuk-body">None found</p>')}
      ${row('Policies', d.policies.length ? `<p class="govuk-body">${d.policies.map((p) => esc(p.code)).join(', ')}</p>` : '<p class="govuk-body">None found</p>')}
      ${row('Numbered measurable outcomes', `<p class="govuk-body">${d.outcomes.length}</p>`)}
      ${d.notes.length ? row('Notes', list(d.notes)) : ''}
    </dl>`;
    const sections = r.sections.map((sec) => `<section class="lpn-report-section" id="report-${esc(sec.id)}" aria-labelledby="report-${esc(sec.id)}-heading">
      <h3 class="govuk-heading-m" id="report-${esc(sec.id)}-heading">${esc(sec.letter)}. ${esc(sec.title)}</h3>
      <p class="govuk-body">${esc(sec.summary)}</p>
      ${sec.mode === 'per-allocation' ? matrixHtml(sec) : ''}
      ${sec.items.map((i) => itemHtml(i, sec)).join('')}
    </section>`).join('');
    const pending = r.pending.map((p) => `<h3 class="govuk-heading-m">${esc(p.letter)}. ${esc(p.title)}</h3><p class="govuk-body">${esc(p.summary)}</p>`).join('');
    const c = r.statements.compliance;
    const so = r.statements.soundness;
    reportBox.innerHTML = `
      <h2 class="govuk-heading-l" id="report-heading" tabindex="-1">Report on ${esc(r.document.name)}</h2>
      <div class="govuk-inset-text">${esc(r.notice)}</div>
      <p class="govuk-body">A ${esc(r.document.typeName)} of about ${r.document.words.toLocaleString('en-GB')} words in ${r.document.sectionCount} sections. Of ${s.total} checks: <strong>${s.counts.met} met</strong>, <strong>${s.counts.partly} partly met</strong>, <strong>${s.counts.missing} not met</strong> and <strong>${s.counts['not-assessable']} that cannot be assessed</strong> from the plan alone.</p>
      <table class="govuk-table"><caption class="govuk-table__caption govuk-table__caption--m">Summary</caption>
        <thead class="govuk-table__head"><tr class="govuk-table__row"><th scope="col" class="govuk-table__header">Part</th><th scope="col" class="govuk-table__header govuk-table__header--numeric">Met</th><th scope="col" class="govuk-table__header govuk-table__header--numeric">Partly met</th><th scope="col" class="govuk-table__header govuk-table__header--numeric">Not met</th><th scope="col" class="govuk-table__header govuk-table__header--numeric">Cannot assess</th></tr></thead>
        <tbody class="govuk-table__body">${sumRows}<tr class="govuk-table__row"><th scope="row" class="govuk-table__header">All ${s.total} checks</th>${(['met', 'partly', 'missing', 'not-assessable'] as Status[]).map((k) => `<td class="govuk-table__cell govuk-table__cell--numeric"><strong>${s.counts[k]}</strong></td>`).join('')}</tr></tbody>
      </table>
      <h3 class="govuk-heading-m">Download</h3>
      <div class="govuk-button-group">
        <button type="button" class="govuk-button" data-export="docx">Draft statements (Word)</button>
        <button type="button" class="govuk-button govuk-button--secondary" data-export="report-md">Full report (Markdown)</button>
        <button type="button" class="govuk-button govuk-button--secondary" data-export="json">Report data (JSON)</button>
        <button type="button" class="govuk-button govuk-button--secondary" data-export="statements-md">Draft statements (Markdown)</button>
      </div>
      <h3 class="govuk-heading-m">What the checker found in the plan</h3>
      ${found}
      ${sections}
      ${pending}
      <h3 class="govuk-heading-m" id="report-statements">The draft Gateway statements</h3>
      <div class="govuk-inset-text">${esc(c.notice)}</div>
      <details class="govuk-details"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">${esc(c.title)}</span></summary><div class="govuk-details__text">
        ${c.intro.map((p) => `<p class="govuk-body">${esc(p)}</p>`).join('')}
        ${c.parts.map((part) => `<h4 class="govuk-heading-s">${esc(part.heading)}</h4>${part.entries.map(entryHtml).join('')}`).join('')}
      </div></details>
      <details class="govuk-details"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">${esc(so.title)}</span></summary><div class="govuk-details__text">
        ${so.intro.map((p) => `<p class="govuk-body">${esc(p)}</p>`).join('')}
        ${so.entries.map(entryHtml).join('')}
        ${so.evidenceBase.length ? `<h4 class="govuk-heading-s">Evidence documents the plan names</h4>${list(so.evidenceBase)}` : ''}
      </div></details>
      <p class="govuk-body"><a class="govuk-link" href="#checker-form">Check another plan</a></p>`;
    document.title = `Report on ${r.document.name} – ${pageTitle}`;
    reportBox.querySelector<HTMLElement>('#report-heading')?.focus();
  }
}
