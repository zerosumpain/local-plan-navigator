// src/client/search.ts — the search page.
import { loadIndex, search, snippet, escapeHtml, hrefFor } from './retrieval';

export function init(): void {
  const form = document.querySelector<HTMLFormElement>('form.lpn-search');
  const input = document.querySelector<HTMLInputElement>('#q');
  const status = document.querySelector<HTMLElement>('#search-status');
  const out = document.querySelector<HTMLElement>('#search-results');
  if (!form || !input || !status || !out) return;
  const base = document.body.dataset.base ?? './';

  let ready: Promise<unknown> | null = null;
  const ensure = () => (ready ??= loadIndex(base).then(({ count }) => { status.textContent = `Ready to search ${count} passages.`; }).catch((e) => { status.textContent = `The search index could not be loaded (${e.message}).`; }));

  const run = async () => {
    const q = input.value.trim();
    if (!q) { status.textContent = 'Enter a word or phrase to search for.'; out.innerHTML = ''; input.focus(); return; }
    status.textContent = 'Searching…';
    await ensure();
    const docs = [...form.querySelectorAll<HTMLInputElement>('input[name="docs"]:checked')].map((c) => c.value);
    const hits = search(q, { docs, limit: 25 });
    const url = new URL(location.href); url.searchParams.set('q', q); history.replaceState(null, '', url);
    status.textContent = hits.length ? `${hits.length} result${hits.length === 1 ? '' : 's'} for “${q}”, best match first.` : `Nothing found for “${q}”. Try fewer or different words.`;
    out.innerHTML = hits.map((h) => `
      <article class="lpn-result">
        <p class="lpn-result__source">${escapeHtml(h.docTitle)} › ${escapeHtml(h.heading)}</p>
        <h2 class="govuk-heading-s govuk-!-margin-bottom-1"><a class="govuk-link" href="${hrefFor(base, h)}">${escapeHtml(h.heading)}</a></h2>
        <p class="govuk-body-s">${snippet(h.text, h.terms)}</p>
      </article>`).join('');
  };

  form.addEventListener('submit', (e) => { e.preventDefault(); void run(); });
  input.addEventListener('focus', () => void ensure(), { once: true });
  const initial = new URLSearchParams(location.search).get('q');
  if (initial) { input.value = initial; void run(); } else void ensure();
}
