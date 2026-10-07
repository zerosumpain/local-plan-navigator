// src/client/sign-in.ts — posts the passphrase to the navigator's own session
// endpoint and, once it is accepted, goes to the admin page.
const SESSION = '/api/projects/local-plan-navigator/session';

function showError(message: string) {
  const group = document.getElementById('passphrase-group')!;
  const error = document.getElementById('passphrase-error')!;
  const summary = document.getElementById('sign-in-errors')!;
  group.classList.add('govuk-form-group--error');
  error.hidden = false;
  error.innerHTML = '<span class="govuk-visually-hidden">Error:</span> ';
  error.append(message);
  summary.innerHTML = '<div class="govuk-error-summary"><div role="alert"><h2 class="govuk-error-summary__title">There is a problem</h2><div class="govuk-error-summary__body"><ul class="govuk-list govuk-error-summary__list"><li><a href="#passphrase"></a></li></ul></div></div></div>';
  summary.querySelector('a')!.textContent = message;
  summary.focus();
}

export function init() {
  const form = document.getElementById('sign-in-form') as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = (document.getElementById('passphrase') as HTMLInputElement).value;
    if (!password) { showError('Enter the passphrase'); return; }
    const button = form.querySelector('button')!;
    button.disabled = true;
    try {
      const res = await fetch(SESSION, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      if (res.ok) { location.href = '../admin/'; return; }
      let message = `The server answered ${res.status}.`;
      try { message = (await res.json()).message ?? message; } catch { /* not JSON */ }
      showError(message);
    } catch {
      showError('The server could not be reached. Try again.');
    } finally {
      button.disabled = false;
    }
  });
}
