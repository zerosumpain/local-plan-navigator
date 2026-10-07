// src/client/admin.ts — the owner's model-connections page.
//
// Draws the connections from GET /admin/settings, edits one at a time in the
// form on the page, and saves the whole list back with PUT — the server checks
// it, keeps any secret left blank, and refuses to make a connection "in use"
// that could not answer. Secrets are typed into password fields and sent once;
// the server only ever sends back "set, ending …a1b2".

const API = '/api/projects/local-plan-navigator/admin';

interface Connection {
  id: string; label: string; kind: string; baseUrl: string; model?: string;
  apiStyle?: string; deployment?: string; apiVersion?: string; auth?: string; keyHeader?: string;
  tenantId?: string; clientId?: string; scope?: string;
  apiKeyHint?: string; clientSecretHint?: string; problems?: string[];
  apiKey?: string; clientSecret?: string;
}
interface Settings { active: string; connections: Connection[] }
interface Recent { at: string; feature: string; connection: string; model: string; ms: number; ok: boolean; error?: string; tokensIn?: number | null; tokensOut?: number | null }

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

let settings: Settings = { active: '', connections: [] };
let kinds: Record<string, { label: string; secrets: string[] }> = {};
let editing: { original: string | null; draft: Connection } | null = null;

const KIND_HINTS: Record<string, { address: string; model: string }> = {
  codex: { address: 'The bridge on this server, for example http://127.0.0.1:5207.', model: 'A model the ChatGPT subscription offers, for example gpt-6-luna.' },
  azure: { address: 'The gateway or resource address, for example https://<name>.azure-api.net/<api> or https://<resource>.openai.azure.com.', model: 'The model name the gateway expects in the request.' },
  openai: { address: 'The address before /chat/completions, for example https://gateway.example/v1.', model: 'The model name the endpoint expects.' },
};

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  let body: any = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, body };
}

function status(text: string) { $('#admin-status').textContent = text; }

function showErrors(errors: string[]) {
  const box = $('#admin-errors');
  if (!errors.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="govuk-error-summary" data-module="govuk-error-summary"><div role="alert"><h2 class="govuk-error-summary__title">There is a problem</h2><div class="govuk-error-summary__body"><ul class="govuk-list govuk-error-summary__list">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div></div></div>`;
  box.focus();
}

function describe(c: Connection): string {
  const model = c.kind === 'azure' && c.apiStyle !== 'openai' ? `deployment ${c.deployment || '—'}` : (c.model || '—');
  const secret = c.kind === 'azure' && c.auth === 'entra-id' ? (c.clientSecretHint || 'no client secret') : kinds[c.kind]?.secrets.includes('apiKey') ? (c.apiKeyHint || 'no key') : 'no key needed';
  return `${esc(kinds[c.kind]?.label ?? c.kind)} · ${esc(model)} · ${esc(secret)}`;
}

function renderConnections() {
  const rows = settings.connections.map((c) => {
    const inUse = c.id === settings.active;
    const problems = c.problems?.length ? `<p class="govuk-body-s govuk-!-margin-bottom-0"><strong class="govuk-tag govuk-tag--yellow">Not ready</strong> ${esc(c.problems.join('; '))}</p>` : '';
    return `<div class="govuk-summary-card"><div class="govuk-summary-card__title-wrapper">
      <h3 class="govuk-summary-card__title">${esc(c.label)} ${inUse ? '<strong class="govuk-tag govuk-tag--green">In use</strong>' : ''}</h3>
      <ul class="govuk-summary-card__actions">
        <li class="govuk-summary-card__action"><a class="govuk-link" href="#" data-action="edit" data-id="${esc(c.id)}">Change<span class="govuk-visually-hidden"> ${esc(c.label)}</span></a></li>
        <li class="govuk-summary-card__action"><a class="govuk-link" href="#" data-action="test" data-id="${esc(c.id)}">Test<span class="govuk-visually-hidden"> ${esc(c.label)}</span></a></li>
        ${inUse ? '' : `<li class="govuk-summary-card__action"><a class="govuk-link" href="#" data-action="use" data-id="${esc(c.id)}">Use this one<span class="govuk-visually-hidden"> (${esc(c.label)})</span></a></li>
        <li class="govuk-summary-card__action"><a class="govuk-link" href="#" data-action="remove" data-id="${esc(c.id)}">Remove<span class="govuk-visually-hidden"> ${esc(c.label)}</span></a></li>`}
      </ul></div>
      <div class="govuk-summary-card__content"><dl class="govuk-summary-list">
        <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Type and model</dt><dd class="govuk-summary-list__value">${describe(c)}</dd></div>
        <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Address</dt><dd class="govuk-summary-list__value"><code>${esc(c.baseUrl || '—')}</code></dd></div>
      </dl>${problems}<div class="lpn-admin-test" id="test-${esc(c.id)}" aria-live="polite"></div></div></div>`;
  });
  $('#admin-connections').innerHTML = rows.join('');
}

function renderRecent(recent: Recent[]) {
  if (!recent.length) { $('#admin-recent').innerHTML = '<p class="govuk-body">No calls yet.</p>'; return; }
  const time = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
  $('#admin-recent').innerHTML = `<table class="govuk-table"><thead class="govuk-table__head"><tr class="govuk-table__row">
    <th class="govuk-table__header" scope="col">When</th><th class="govuk-table__header" scope="col">For</th><th class="govuk-table__header" scope="col">Connection</th>
    <th class="govuk-table__header" scope="col">Model</th><th class="govuk-table__header govuk-table__header--numeric" scope="col">Time</th><th class="govuk-table__header" scope="col">Result</th></tr></thead>
    <tbody class="govuk-table__body">${recent.map((r) => `<tr class="govuk-table__row"><td class="govuk-table__cell">${esc(time(r.at))}</td><td class="govuk-table__cell">${esc(r.feature)}</td>
    <td class="govuk-table__cell">${esc(r.connection)}</td><td class="govuk-table__cell">${esc(r.model)}</td><td class="govuk-table__cell govuk-table__cell--numeric">${(r.ms / 1000).toFixed(1)} s</td>
    <td class="govuk-table__cell">${r.ok ? '<strong class="govuk-tag govuk-tag--green">Worked</strong>' : `<strong class="govuk-tag govuk-tag--red">Failed</strong> ${esc(r.error ?? '')}`}</td></tr>`).join('')}</tbody></table>`;
}

async function load() {
  const { ok, body } = await api('/settings');
  if (!ok) { status('The settings could not be loaded. Reload the page.'); return; }
  settings = body.settings; kinds = body.kinds;
  status(body.stored ? '' : 'This server has no state directory, so changes cannot be saved here.');
  renderConnections();
  renderRecent(body.recent ?? []);
}

async function saveAll(next: Settings, done: string) {
  const { ok, body } = await api('/settings', { method: 'PUT', body: JSON.stringify(next) });
  if (!ok) { showErrors(body.errors ?? [body.message ?? 'The settings were not saved.']); return false; }
  showErrors([]);
  settings = body.settings;
  renderConnections();
  status(done);
  return true;
}

// --- the editor ---------------------------------------------------------

const form = () => $('#admin-form') as HTMLFormElement;
const field = (name: string) => form().elements.namedItem(name) as HTMLInputElement | RadioNodeList | null;
function setValue(name: string, value: string) {
  const f = field(name);
  if (!f) return;
  if (f instanceof RadioNodeList) { for (const r of Array.from(f) as HTMLInputElement[]) r.checked = r.value === value; }
  else f.value = value;
}
function getValue(name: string): string {
  const f = field(name);
  if (!f) return '';
  return f instanceof RadioNodeList ? f.value : f.value.trim();
}

function applyVisibility() {
  const kind = getValue('kind');
  const style = getValue('apiStyle') || 'azure-openai';
  const auth = getValue('auth') || 'subscription-key';
  document.querySelectorAll<HTMLElement>('[data-show]').forEach((el) => { el.hidden = el.dataset.show !== kind; });
  document.querySelectorAll<HTMLElement>('[data-show-style]').forEach((el) => { el.hidden = el.dataset.showStyle !== style; });
  document.querySelectorAll<HTMLElement>('[data-show-auth]').forEach((el) => {
    el.hidden = el.dataset.showAuth === 'entra-id' ? auth !== 'entra-id' : auth === 'entra-id';
  });
  $<HTMLElement>('[data-show-model]').hidden = kind === 'azure' && style !== 'openai';
  $<HTMLElement>('[data-show-key]').hidden = kind === 'codex' || (kind === 'azure' && auth === 'entra-id');
  $('#f-baseUrl-hint').textContent = KIND_HINTS[kind]?.address ?? '';
  $('#f-model-hint').textContent = KIND_HINTS[kind]?.model ?? '';
}

async function openEditor(c: Connection | null) {
  const draft: Connection = c ? { ...c } : {
    id: '', label: '', kind: 'azure', baseUrl: '', apiStyle: 'azure-openai', apiVersion: '2024-10-21',
    auth: 'subscription-key', keyHeader: 'Ocp-Apim-Subscription-Key', scope: 'https://cognitiveservices.azure.com/.default',
  };
  editing = { original: c?.id ?? null, draft };
  $('#f-kind').innerHTML = Object.entries(kinds).map(([k, v]) => `<div class="govuk-radios__item"><input class="govuk-radios__input" id="f-kind-${k}" name="kind" type="radio" value="${k}"><label class="govuk-label govuk-radios__label" for="f-kind-${k}">${esc(v.label)}</label></div>`).join('');
  for (const name of ['label', 'id', 'kind', 'baseUrl', 'apiStyle', 'deployment', 'apiVersion', 'model', 'auth', 'keyHeader', 'tenantId', 'clientId', 'scope']) {
    setValue(name, String((draft as any)[name] ?? ''));
  }
  setValue('apiKey', ''); setValue('clientSecret', '');
  $('#f-apiKey-hint').textContent = draft.apiKeyHint ? `Saved key: ${draft.apiKeyHint}. Leave blank to keep it.` : 'Paste the key. It is stored encrypted and not shown again.';
  $('#f-clientSecret-hint').textContent = draft.clientSecretHint ? `Saved secret: ${draft.clientSecretHint}. Leave blank to keep it.` : 'Paste the secret. It is stored encrypted and not shown again.';
  ($('#f-id') as HTMLInputElement).readOnly = Boolean(c);
  $('#admin-editor-heading').textContent = c ? `Change ${c.label}` : 'Add a connection';
  $('#admin-test-result').innerHTML = '';
  $('#admin-editor').hidden = false;
  applyVisibility();
  $('#admin-editor-heading').focus();
  if (c && c.kind !== 'azure') {
    const { body } = await api(`/models?connection=${encodeURIComponent(c.id)}`);
    $('#f-model-list').innerHTML = (body.models ?? []).map((m: string) => `<option value="${esc(m)}">`).join('');
  }
}

function draftFromForm(): Connection {
  const c: Connection = {
    id: getValue('id').toLowerCase(), label: getValue('label'), kind: getValue('kind'), baseUrl: getValue('baseUrl'), model: getValue('model'),
    apiStyle: getValue('apiStyle'), deployment: getValue('deployment'), apiVersion: getValue('apiVersion'), auth: getValue('auth'),
    keyHeader: getValue('keyHeader'), tenantId: getValue('tenantId'), clientId: getValue('clientId'), scope: getValue('scope'),
  };
  const key = getValue('apiKey'); const secret = getValue('clientSecret');
  if (key) c.apiKey = key;
  if (secret) c.clientSecret = secret;
  return c;
}

function testResult(el: HTMLElement, r: any) {
  el.innerHTML = r.ok
    ? `<p class="govuk-body govuk-!-margin-top-2"><strong class="govuk-tag govuk-tag--green">Works</strong> ${esc(r.model)} answered in ${(r.ms / 1000).toFixed(1)} s: “${esc(r.reply)}”</p>`
    : `<p class="govuk-body govuk-!-margin-top-2"><strong class="govuk-tag govuk-tag--red">Failed</strong> ${esc(r.message ?? 'No answer.')}</p>`;
}

async function test(c: Connection, el: HTMLElement) {
  el.innerHTML = '<p class="govuk-body govuk-!-margin-top-2">Sending a test prompt…</p>';
  const { body } = await api('/test', { method: 'POST', body: JSON.stringify({ connection: c }) });
  testResult(el, body);
  load().catch(() => {});
}

export function init() {
  load().catch(() => status('The settings could not be loaded. Reload the page.'));
  document.addEventListener('change', (e) => { if ((e.target as HTMLElement).closest('#admin-form')) applyVisibility(); });
  document.addEventListener('click', async (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    e.preventDefault();
    const id = target.dataset.id ?? '';
    const c = settings.connections.find((x) => x.id === id) ?? null;
    switch (target.dataset.action) {
      case 'add': await openEditor(null); break;
      case 'edit': if (c) await openEditor(c); break;
      case 'cancel': $('#admin-editor').hidden = true; editing = null; break;
      case 'test': if (c) await test(c, document.getElementById(`test-${id}`)!); break;
      case 'test-form': await test(draftFromForm(), $('#admin-test-result')); break;
      case 'use': if (c) await saveAll({ ...settings, active: id }, `${c.label} now answers every question and plan check.`); break;
      case 'remove':
        if (c && confirm(`Remove ${c.label}?`)) await saveAll({ ...settings, connections: settings.connections.filter((x) => x.id !== id) }, `${c.label} removed.`);
        break;
      case 'save': {
        if (!editing) break;
        const draft = draftFromForm();
        const others = settings.connections.filter((x) => x.id !== (editing.original ?? draft.id));
        const at = settings.connections.findIndex((x) => x.id === editing.original);
        const list = [...others];
        list.splice(at < 0 ? list.length : at, 0, draft);
        if (await saveAll({ ...settings, connections: list }, `${draft.label || draft.id} saved.`)) {
          $('#admin-editor').hidden = true; editing = null;
        }
        break;
      }
    }
  });
}
