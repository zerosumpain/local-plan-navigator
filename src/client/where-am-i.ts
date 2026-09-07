// src/client/where-am-i.ts — the question pages.
//
// Each question is a real page. On Continue, the chosen radio's data-next says
// where to go. No answer chosen shows the GOV.UK error pattern: an error
// summary that takes focus, and an error message on the fieldset. Answers are
// kept in sessionStorage only so a result page could, in future, show them.
export function init(): void {
  const form = document.querySelector<HTMLFormElement>('form.lpn-question');
  if (!form) return;
  const group = form.querySelector<HTMLElement>('.govuk-form-group');
  const fieldset = form.querySelector<HTMLElement>('.govuk-fieldset');
  const legend = form.querySelector<HTMLElement>('.govuk-fieldset__legend');
  const first = form.querySelector<HTMLInputElement>('input[type="radio"]');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const chosen = form.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    if (!chosen) return showError();
    clearError();
    try {
      const answers = JSON.parse(sessionStorage.getItem('lpn-answers') ?? '{}');
      answers[form.dataset.question ?? ''] = chosen.value;
      sessionStorage.setItem('lpn-answers', JSON.stringify(answers));
    } catch { /* fine without it */ }
    const next = chosen.dataset.next;
    if (next) location.href = next;
  });

  function showError() {
    clearError();
    group?.classList.add('govuk-form-group--error');
    const msg = document.createElement('p');
    msg.className = 'govuk-error-message';
    msg.id = 'answer-error';
    msg.innerHTML = '<span class="govuk-visually-hidden">Error:</span> Select an answer';
    legend?.insertAdjacentElement('afterend', msg);
    fieldset?.setAttribute('aria-describedby', `${fieldset.getAttribute('aria-describedby') ?? ''} answer-error`.trim());
    const summary = document.createElement('div');
    summary.className = 'govuk-error-summary';
    summary.setAttribute('data-module', 'govuk-error-summary');
    summary.innerHTML = `<div role="alert"><h2 class="govuk-error-summary__title">There is a problem</h2><div class="govuk-error-summary__body"><ul class="govuk-list govuk-error-summary__list"><li><a href="#${first?.id ?? ''}">Select an answer</a></li></ul></div></div>`;
    summary.tabIndex = -1;
    form.insertAdjacentElement('beforebegin', summary);
    summary.focus();
    summary.querySelector('a')?.addEventListener('click', (ev) => { ev.preventDefault(); first?.focus(); });
  }
  function clearError() {
    group?.classList.remove('govuk-form-group--error');
    document.getElementById('answer-error')?.remove();
    document.querySelector('.govuk-error-summary')?.remove();
  }
}
