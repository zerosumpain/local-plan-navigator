import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { verifyIdentity } from '../gateway/identity.mjs';
import { answerPrompt, loadCorpus, parseAskBody, pickChunks, SYSTEM_PROMPT } from './ask.mjs';

const MOUNT = '/projects/local-plan-navigator';
const ASK = '/api/projects/local-plan-navigator/ask';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
  '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' });
  res.end(body);
}

/** The ask page reads `message` from a failed request and shows it as it is. */
const sendError = (res, status, message) => send(res, status, JSON.stringify({ message }), 'application/json');

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveFile(req, res, root) {
  const rawPath = new URL(req.url, 'http://localhost').pathname;
  if (rawPath === MOUNT) {
    res.writeHead(308, { Location: `${MOUNT}/${new URL(req.url, 'http://localhost').search}`, 'Cache-Control': 'private, no-store' });
    res.end();
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(rawPath.slice(MOUNT.length)); }
  catch { send(res, 400, 'Invalid path'); return; }
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) {
    send(res, 403, 'Forbidden'); return;
  }
  const base = resolve(root);
  let path = resolve(base, `.${pathname}`);
  const inside = (candidate) => candidate === base || candidate.startsWith(base + sep);
  if (!inside(path)) { send(res, 403, 'Forbidden'); return; }
  let details = await stat(path).catch(() => null);
  if (details?.isDirectory()) {
    if (!rawPath.endsWith('/')) {
      res.writeHead(308, { Location: `${rawPath}/${new URL(req.url, 'http://localhost').search}`, 'Cache-Control': 'private, no-store' });
      res.end();
      return;
    }
    path = resolve(path, 'index.html');
    details = await stat(path).catch(() => null);
  }
  if (!details?.isFile()) { send(res, 404, 'Not found'); return; }
  const actual = await realpath(path).catch(() => null);
  if (!actual || !inside(actual) || relative(base, actual).startsWith('..')) {
    send(res, 403, 'Forbidden'); return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
    'Content-Length': details.size,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(path).pipe(res);
}

/** Consume the OpenAI-compatible bridge stream without importing a second model stack. */
async function streamCompletion(response, res) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answered = false;
  const event = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  const consume = (block) => {
    const data = block.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const token = JSON.parse(data)?.choices?.[0]?.delta?.content;
    if (typeof token === 'string' && token) { answered = true; event({ type: 'token', token }); }
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
  if (!answered) event({ type: 'token', token: 'Sorry — I could not generate an answer for that. Try rephrasing.' });
  event({ type: 'done' });
}

export function createApp({
  distDir = resolve('dist'),
  ownerEmail = process.env.OWNER_EMAIL,
  gatewayKey = process.env.LOCAL_PLAN_NAVIGATOR_GATEWAY_KEY,
  siteOrigin = 'https://strangeramblings.com',
  bridgeUrl = process.env.CODEX_BRIDGE_URL ?? 'http://127.0.0.1:5207',
  model = process.env.LOCAL_PLAN_NAVIGATOR_MODEL ?? 'gpt-6-luna',
  dailyCap = Number(process.env.LOCAL_PLAN_NAVIGATOR_DAILY_CAP ?? 400),
  release = process.env.APP_RELEASE_ID ?? 'local',
  retryDelayMs = 4000,
} = {}) {
  if (!ownerEmail || !gatewayKey || gatewayKey.length < 32) throw new Error('OWNER_EMAIL and a 32+ character gateway key are required');
  const owner = ownerEmail.trim().toLowerCase();
  const buckets = new Map();
  let day = '';
  let usedToday = 0;
  return async (req, res) => {
    res.setHeader('x-local-plan-navigator-release', release);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/__alive') {
      send(res, 200, JSON.stringify({ ready: true, release }), 'application/json');
      return;
    }
    if (!(pathname === MOUNT || pathname.startsWith(`${MOUNT}/`) || pathname === ASK)) {
      send(res, 404, 'Not found'); return;
    }
    const assertion = verifyIdentity(req.headers['x-local-plan-navigator-identity'], req.method, req.url,
      gatewayKey, 'sr-local-plan-navigator');
    if (assertion?.email !== owner) { send(res, 404, 'Not found'); return; }
    if (pathname !== ASK) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Method not allowed'); return; }
      try { await serveFile(req, res, distDir); }
      catch { if (!res.headersSent) send(res, 500, 'File unavailable'); else res.destroy(); }
      return;
    }
    if (req.method !== 'POST') { sendError(res, 405, 'Method not allowed.'); return; }
    if (req.headers.origin && req.headers.origin !== siteOrigin) { sendError(res, 403, 'Questions are only taken from pages this server sent.'); return; }
    let input;
    try { input = parseAskBody(await readJson(req)); }
    catch { sendError(res, 400, 'The question could not be read.'); return; }
    if (!input.question || !input.ids.length) { sendError(res, 400, 'A question and at least one passage are needed.'); return; }
    // Keyed on the signed identity, not the address: it cannot be chosen by the
    // caller, and every request that reaches this line carries one.
    const now = Date.now();
    const bucket = buckets.get(assertion.email) ?? { tokens: 20, at: now };
    bucket.tokens = Math.min(20, bucket.tokens + (now - bucket.at) * (20 / 60_000));
    bucket.at = now;
    if (bucket.tokens < 1) { sendError(res, 429, 'Too many questions in a short time. Wait a minute and try again.'); return; }
    bucket.tokens -= 1;
    buckets.set(assertion.email, bucket);
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== day) { day = today; usedToday = 0; }
    if (usedToday >= dailyCap) { sendError(res, 503, "Today's allowance of model answers has been used."); return; }
    let chunks;
    try { chunks = pickChunks(input.ids, await loadCorpus(distDir), siteOrigin); }
    catch { sendError(res, 503, 'The guidance texts could not be loaded.'); return; }
    if (!chunks.length) { sendError(res, 409, 'The page is older than the guidance on the server. Reload it and ask again.'); return; }
    usedToday++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const event = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    // `id` lets the page number its citations by the passages the model was
    // actually given, which is not always every passage the page asked for.
    event({ type: 'sources', sources: chunks.map((chunk, index) => ({
      n: index + 1, id: chunk.id, title: chunk.title, sourceType: chunk.sourceType, url: chunk.url,
    })) });
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
    const ask = () => fetch(`${bridgeUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer codex-bridge-local' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: answerPrompt(input.question, chunks) }],
        temperature: 0.3, max_tokens: 1000, stream: true,
      }),
      signal,
    });
    try {
      // The bridge is shared and restarts with every SR-Main deploy (about ten
      // seconds). One retry, before anything is streamed, rides that out.
      let response = await ask().catch((err) => { if (signal.aborted) throw err; return null; });
      if (!response?.ok || !response.body) {
        response?.body?.cancel().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        response = await ask();
      }
      if (!response.ok || !response.body) throw new Error('model unavailable');
      await streamCompletion(response, res);
    } catch {
      if (!res.destroyed) event({ type: 'error', message: 'The model could not answer just now. Ask again in a minute.' });
    } finally {
      res.end();
    }
  };
}
