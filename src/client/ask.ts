// src/client/ask.ts — describe a problem.
//
// Two halves. Retrieval always runs: the question goes through the same index
// as the search page and the best passages come back with citations. Then a
// summary, from one of two places the visitor chooses between:
//
//  - the website's own model: the question and the ids of the passages go to
//    strangeramblings.com, which answers from its copy of the same corpus and
//    streams the summary back (the default — it is the good model);
//  - a model on the visitor's device: WebLLM on WebGPU, or transformers.js on
//    WebAssembly where there is no WebGPU. Nothing leaves the browser except
//    the one-off download of the weights from Hugging Face.
//
// `?engine=mock` swaps in a fake local engine so the whole path can be
// smoke-tested without a download; the smoke test intercepts the server route.
import { loadIndex, search, escapeHtml, hrefFor, type Hit } from './retrieval';
import { buildMessages, fitPassages, type Passage } from './engines/prompt';
import type { ToWorker, FromWorker } from './engines/protocol';

type Engine = { send: (m: ToWorker) => void; onMessage: (fn: (m: FromWorker) => void) => void; kind: string };

// The site's endpoint. Same-origin on strangeramblings.com; anywhere else (a
// local build, the downloaded zip) it is called cross-origin, which the
// endpoint allows.
const SITE = 'https://strangeramblings.com';
const ENDPOINT = (location.origin === SITE ? '' : SITE) + '/api/projects/local-plan-navigator/ask';

export function init(): void {
  const form = document.querySelector<HTMLFormElement>('form.lpn-ask');
  const status = document.querySelector<HTMLElement>('#ask-status');
  const answerBox = document.querySelector<HTMLElement>('#ask-answer');
  const passagesBox = document.querySelector<HTMLElement>('#ask-passages');
  const support = document.querySelector<HTMLElement>('#model-support');
  const loadBtn = document.querySelector<HTMLButtonElement>('[data-action="load-model"]');
  const progress = document.querySelector<HTMLElement>('#model-progress');
  const progressFill = progress?.querySelector<HTMLElement>('.lpn-progress__fill');
  const progressText = document.querySelector<HTMLElement>('#model-progress-text');
  if (!form || !status || !answerBox || !passagesBox) return;
  const base = document.body.dataset.base ?? './';
  const mock = new URLSearchParams(location.search).get('engine') === 'mock';
  const modeRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
  const localControls = document.querySelector<HTMLElement>('#local-model-controls');
  const mode = () => modeRadios.find((r) => r.checked)?.value ?? 'server';
  const showLocal = () => { if (localControls) localControls.hidden = mode() !== 'local'; };
  for (const r of modeRadios) r.addEventListener('change', showLocal);
  showLocal();

  // --- capability check -----------------------------------------------------
  const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="model"]')];
  for (const r of radios) {
    if (r.dataset.engine === 'webllm' && !hasWebGpu) {
      r.disabled = true;
      const label = document.querySelector<HTMLElement>(`label[for="${r.id}"]`);
      if (label) label.textContent += ' — needs WebGPU, not available in this browser';
    }
  }
  if (!hasWebGpu) { const fallback = radios.find((r) => r.dataset.engine === 'transformers'); if (fallback) fallback.checked = true; }
  if (support) support.textContent = hasWebGpu ? 'This browser has WebGPU: the faster models will run.' : 'No WebGPU in this browser: only the small WebAssembly model can run, and it will be slow.';

  // --- engine ----------------------------------------------------------------
  let engine: Engine | null = null;
  let ready = false;
  let lastHits: Hit[] = [];
  let lastQuestion = '';
  let genId = 0;

  const makeEngine = (kind: string): Engine => {
    if (mock) {
      let handler: (m: FromWorker) => void = () => {};
      return {
        kind: 'mock',
        onMessage: (fn) => { handler = fn; },
        send: (m) => {
          if (m.type === 'load') { let p = 0; const t = setInterval(() => { p += 0.25; handler({ type: 'progress', progress: Math.min(1, p), text: `Mock loading ${Math.round(p * 100)}%` }); if (p >= 1) { clearInterval(t); handler({ type: 'ready', modelId: m.modelId }); } }, 60); }
          if (m.type === 'generate') {
            const words = 'This is a mock answer written from the extracts, so the page can be tested without a download [1]. The first extract is the one the search ranked highest [1], and the second supports the second sentence [2].'.split(' ');
            let i = 0; const t = setInterval(() => { if (i < words.length) handler({ type: 'token', id: m.id, text: words[i++] + ' ' }); else { clearInterval(t); handler({ type: 'done', id: m.id, tokens: words.length, ms: 300 }); } }, 20);
          }
        },
      };
    }
    const worker = new Worker(new URL(kind === 'webllm' ? './engine-webllm.worker.js' : './engine-transformers.worker.js', new URL(`${base}assets/`, location.href)), { type: 'module' });
    return { kind, onMessage: (fn) => { worker.onmessage = (e) => fn(e.data); }, send: (m) => worker.postMessage(m) };
  };

  loadBtn?.addEventListener('click', () => {
    const chosen = radios.find((r) => r.checked);
    if (!chosen) return;
    const kind = chosen.dataset.engine ?? 'webllm';
    if (engine && engine.kind !== kind) { engine = null; ready = false; }
    engine ??= makeEngine(kind);
    ready = false;
    loadBtn.disabled = true;
    progress?.removeAttribute('hidden');
    if (progressText) progressText.textContent = `Starting download (${chosen.dataset.size}). This can take a few minutes the first time.`;
    engine.onMessage((m) => {
      if (m.type === 'progress') { if (progressFill) progressFill.style.width = `${Math.round(m.progress * 100)}%`; if (progressText) progressText.textContent = m.text; }
      else if (m.type === 'ready') { ready = true; if (progressFill) progressFill.style.width = '100%'; if (progressText) progressText.textContent = 'Model ready. Ask a question, or the last one will be answered now.'; loadBtn.textContent = 'Model loaded'; if (lastQuestion && lastHits.length) void generate(lastQuestion, lastHits); }
      else if (m.type === 'token') { appendToken(m.text); }
      else if (m.type === 'done') { finishAnswer(m.tokens, m.ms); }
      else if (m.type === 'error') { status.textContent = `The model reported an error: ${m.message}`; loadBtn.disabled = false; if (progressText) progressText.textContent = m.message; }
    });
    engine.send({ type: 'load', modelId: chosen.value });
  });

  // --- retrieval -------------------------------------------------------------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = (form.elements.namedItem('question') as HTMLTextAreaElement).value.trim();
    if (!q) { status.textContent = 'Describe the problem first.'; return; }
    status.textContent = 'Finding the relevant guidance…';
    try { await loadIndex(base); } catch (err) { status.textContent = `The guidance index could not be loaded (${(err as Error).message}).`; return; }
    const hits = search(q, { limit: 6, uniqueAnchors: true });
    lastHits = hits; lastQuestion = q;
    answerBox.innerHTML = '';
    if (!hits.length) { status.textContent = 'Nothing in the guidance matched those words. Try describing it differently, or use the search page.'; passagesBox.innerHTML = ''; return; }
    status.textContent = `${hits.length} relevant passages found. ${mode() === 'server' || ready ? 'Writing a summary…' : 'Load a model to get a plain-English summary; the passages below are the answer.'}`;
    passagesBox.innerHTML = `<h2 class="govuk-heading-m">The guidance that answers it</h2>` + hits.map((h, i) => `
      <article class="lpn-result" id="passage-${i + 1}">
        <p class="lpn-result__source">[${i + 1}] ${escapeHtml(h.docTitle)} › ${escapeHtml(h.heading)}</p>
        <p class="govuk-body-s">${escapeHtml(h.text.length > 700 ? h.text.slice(0, 700).replace(/\s\S*$/, '') + '…' : h.text)}</p>
        <p class="govuk-body-s"><a class="govuk-link" href="${hrefFor(base, h)}">Read it in context</a></p>
      </article>`).join('');
    if (mode() === 'server') void generateOnServer(q, hits);
    else if (ready) void generate(q, hits);
  });

  // --- the site's model ----------------------------------------------------
  async function generateOnServer(q: string, hits: Hit[]) {
    answerText = '';
    answerBox.innerHTML = `<h2 class="govuk-heading-m">Plain-English summary</h2><div class="lpn-answer" aria-live="polite" aria-busy="true"><p class="govuk-body" id="answer-text"></p></div>`;
    answerP = answerBox.querySelector('#answer-text');
    status.textContent = "Asking the website's model…";
    const started = Date.now();
    let tokens = 0;
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q, ids: hits.map((h) => h.id) }) });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(res.status === 429 ? 'Too many questions in a short time. Wait a minute and try again.' : res.status === 503 ? (safeMessage(detail) || "The site's model is not available right now.") : `The site answered ${res.status}. ${safeMessage(detail)}`);
      }
      // Server-sent events over POST: "data: {json}\n\n" frames.
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
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const msg = JSON.parse(line.slice(6)) as { type: string; token?: string; message?: string };
          if (msg.type === 'token' && msg.token) { tokens++; appendToken(msg.token); }
          else if (msg.type === 'error') throw new Error(msg.message || 'generation failed');
        }
      }
      finishAnswer(tokens, Date.now() - started, 'the website');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      answerBox.querySelector('.lpn-answer')?.setAttribute('aria-busy', 'false');
      status.textContent = `${message} The passages below are still the answer, or choose "a model on my device".`;
      if (answerP && !answerText) answerP.textContent = 'No summary was written.';
    }
  }
  function safeMessage(detail: string): string {
    try { const j = JSON.parse(detail); return String(j.message ?? '').slice(0, 200); } catch { return ''; }
  }

  // --- generation ------------------------------------------------------------
  let answerText = '';
  let answerP: HTMLElement | null = null;
  async function generate(q: string, hits: Hit[]) {
    if (!engine || !ready) return;
    const passages: Passage[] = fitPassages(hits.map((h, i) => ({ n: i + 1, source: h.docTitle, heading: h.heading, text: h.text })));
    answerText = '';
    answerBox.innerHTML = `<h2 class="govuk-heading-m">Plain-English summary</h2><div class="lpn-answer" aria-live="polite" aria-busy="true"><p class="govuk-body" id="answer-text"></p></div>`;
    answerP = answerBox.querySelector('#answer-text');
    status.textContent = 'Writing a summary from the passages…';
    engine.send({ type: 'generate', id: ++genId, messages: buildMessages(q, passages), maxTokens: 300 });
  }
  function appendToken(t: string) { answerText += t; if (answerP) answerP.innerHTML = renderAnswer(answerText); }
  function finishAnswer(tokens: number, ms: number, where = 'your device') {
    answerBox.querySelector('.lpn-answer')?.setAttribute('aria-busy', 'false');
    // A small model often forgets to cite. The passages it was given are known,
    // so say which ones rather than leave the summary looking unsourced.
    if (!/\[\d\]/.test(answerText) && answerP) {
      const n = Math.min(lastHits.length, 6);
      answerP.insertAdjacentHTML('afterend', `<p class="govuk-body-s">Written from passages ${Array.from({ length: n }, (_, i) => `<a class="govuk-link" href="#passage-${i + 1}">[${i + 1}]</a>`).join(' ')} below.</p>`);
    }
    const rate = ms ? (tokens / (ms / 1000)).toFixed(1) : '?';
    status.textContent = `Summary written on ${where}: ${tokens} tokens in ${(ms / 1000).toFixed(1)} seconds (${rate} tokens a second). Check it against the passages.`;
  }
  function renderAnswer(text: string): string {
    return escapeHtml(text).replace(/\[(\d)\]/g, (_, n) => `<a class="govuk-link" href="#passage-${n}">[${n}]</a>`);
  }
}
