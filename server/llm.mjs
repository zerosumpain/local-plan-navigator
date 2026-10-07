// server/llm.mjs — every model call the service makes goes through here.
//
// The pages and the plan checker never know which model answered. They call
// `complete()` (the whole reply) or `stream()` (token by token, for Ask), and
// this module turns that into an OpenAI-style chat-completions request for the
// connection the admin page has made active:
//
//   codex   the site's ChatGPT-subscription bridge   POST {baseUrl}/v1/chat/completions
//   azure   Azure OpenAI deployment style            POST {baseUrl}/openai/deployments/{deployment}/chat/completions?api-version=…
//           or the OpenAI style through APIM         POST {baseUrl}/chat/completions  (with `model`)
//           authenticated by an APIM subscription key, an Azure `api-key`, or a
//           Microsoft Entra ID token (client credentials), cached until it expires
//   openai  any OpenAI-compatible endpoint           POST {baseUrl}/chat/completions  (Bearer key)
//
// Every call is logged — which feature, which connection and model, how long,
// tokens if the provider reports them, and whether it worked — but never the
// prompt or the answer. That is the record the admin page shows, and what an
// AI Gateway would add its own audit trail to.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const CALL_TIMEOUT_MS = 120_000;
const RECENT = 200;

/** The URL, headers and body for one chat-completions call on connection `c`. */
export async function buildRequest(c, { system, user, maxTokens, temperature, stream }, getToken) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const body = { messages, max_tokens: maxTokens, temperature, stream };
  const headers = { 'Content-Type': 'application/json' };
  const base = String(c.baseUrl ?? '').replace(/\/+$/, '');
  let url;
  if (c.kind === 'codex') {
    url = `${base}/v1/chat/completions`;
    headers.Authorization = 'Bearer codex-bridge-local';
    body.model = c.model;
  } else if (c.kind === 'azure') {
    if (c.apiStyle === 'openai') {
      url = `${base}/chat/completions`;
      body.model = c.model;
    } else {
      url = `${base}/openai/deployments/${encodeURIComponent(c.deployment)}/chat/completions?api-version=${encodeURIComponent(c.apiVersion || '2024-10-21')}`;
      // Newer Azure models refuse `max_tokens` and want this instead.
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    if (c.auth === 'entra-id') headers.Authorization = `Bearer ${await getToken(c)}`;
    else headers[c.keyHeader || (c.auth === 'api-key' ? 'api-key' : 'Ocp-Apim-Subscription-Key')] = c.apiKey ?? '';
  } else {
    url = `${base}/chat/completions`;
    if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
    body.model = c.model;
  }
  return { url, headers, body };
}

/** The model name to show and log for a connection. */
export const modelName = (c) => (c.kind === 'azure' && c.apiStyle !== 'openai' ? c.deployment : c.model) || '?';

/**
 * Read an OpenAI-style SSE stream, calling `onToken` with each piece of text.
 * A gateway that ignores `stream: true` and answers with one JSON body is read
 * as that, so a proxy which buffers is slower but still works.
 */
async function readStream(response, onToken) {
  if (/application\/json/i.test(response.headers.get('content-type') ?? '')) {
    const body = await response.json();
    const text = String(body?.choices?.[0]?.message?.content ?? '');
    if (text) onToken?.(text);
    return { text, usage: body?.usage ?? null };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  const consume = (block) => {
    const data = block.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    if (event?.usage) usage = event.usage;
    const token = event?.choices?.[0]?.delta?.content;
    if (typeof token === 'string' && token) { text += token; onToken?.(token); }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    if (buffer.length > 1_000_000) throw new Error('model stream event too large');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      consume(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
  if (buffer.trim()) consume(buffer);
  return { text, usage };
}

/** What a failed provider said, short enough to show an administrator. */
async function failure(response) {
  let detail = '';
  try {
    const body = await response.text();
    try { const j = JSON.parse(body); detail = j?.error?.message ?? j?.message ?? j?.detail ?? body; }
    catch { detail = body; }
  } catch { /* nothing readable */ }
  return new Error(`The model service answered ${response.status}${detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 240)}` : ''}`);
}

/**
 * The client. `settings` is the store from settings.mjs; `stateDir`, if set,
 * gets an append-only usage log (usage.jsonl) as well as the in-memory list.
 */
export function createLlm({ settings, stateDir = null, retryDelayMs = 4000, fetchImpl = fetch, log = console }) {
  const tokens = new Map();
  const recent = [];

  async function getToken(c) {
    const cacheKey = `${c.tenantId}|${c.clientId}|${c.scope}`;
    const held = tokens.get(cacheKey);
    if (held && held.expires - Date.now() > 60_000) return held.token;
    const response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret ?? '', scope: c.scope }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Microsoft Entra ID refused the client credentials (${response.status})`);
    const body = await response.json();
    tokens.set(cacheKey, { token: body.access_token, expires: Date.now() + Number(body.expires_in ?? 300) * 1000 });
    return body.access_token;
  }

  function record(entry) {
    recent.unshift(entry);
    recent.length = Math.min(recent.length, RECENT);
    if (stateDir) {
      mkdir(stateDir, { recursive: true })
        .then(() => appendFile(join(stateDir, 'usage.jsonl'), `${JSON.stringify(entry)}\n`))
        .catch((err) => log.warn?.(`[llm] usage log not written: ${err.message}`));
    }
  }

  /**
   * One call. Retries once, before anything has streamed, when the service is
   * briefly away (the Codex bridge restarts with every SR-Main deploy, about
   * ten seconds; an APIM gateway may answer 429 or 503 under load).
   */
  async function call(req, { onToken, feature = 'unknown', connection } = {}) {
    const c = connection ?? (await settings.active());
    const started = Date.now();
    const entry = { at: new Date(started).toISOString(), feature, connection: c.id, kind: c.kind, model: modelName(c) };
    const signal = AbortSignal.any([req.signal ?? new AbortController().signal, AbortSignal.timeout(req.timeoutMs ?? CALL_TIMEOUT_MS)]);
    const send = async () => {
      const { url, headers, body } = await buildRequest(c, {
        system: req.system, user: req.user, maxTokens: req.maxTokens ?? 1000,
        temperature: req.temperature ?? 0.3, stream: true,
      }, getToken);
      return fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    };
    try {
      let response = await send().catch((err) => { if (signal.aborted) throw err; return null; });
      if (!response?.ok || !response.body) {
        const retryable = !response || [408, 429, 500, 502, 503, 504].includes(response.status);
        if (!retryable) throw await failure(response);
        response?.body?.cancel().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        response = await send();
      }
      if (!response.ok || !response.body) throw await failure(response);
      const { text, usage } = await readStream(response, onToken);
      record({ ...entry, ms: Date.now() - started, ok: true, tokensIn: usage?.prompt_tokens ?? null, tokensOut: usage?.completion_tokens ?? null });
      return text;
    } catch (err) {
      record({ ...entry, ms: Date.now() - started, ok: false, error: String(err?.message ?? err).slice(0, 200) });
      throw err;
    }
  }

  return {
    /** The whole reply as a string. */
    complete: (req) => call(req, { feature: req.feature ?? 'complete', connection: req.connection }),
    /** The reply token by token; resolves with the whole text. */
    stream: (req, onToken) => call(req, { onToken, feature: req.feature ?? 'stream', connection: req.connection }),
    /** The latest calls, newest first, for the admin page. */
    recent: () => recent.slice(),
    active: () => settings.active(),
  };
}
