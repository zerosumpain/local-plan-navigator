// server/app.mjs — the navigator's web process: the built pages, the Ask API,
// the plan checker, the admin API and its own sign-in.
//
// It depends on no other service to decide who may see it. Two access modes:
//
//   standalone      (default) the navigator's own admin sign-in and share links
//                   (server/access.mjs) — how it runs on strangeramblings.com,
//                   where the only other thing it touches is its card on /projects
//   trusted-proxy   behind someone else's sign-in (Azure App Service
//                   authentication, an Entra ID application proxy, …) that puts the
//                   signed-in email in a header — see docs/handover.md
//
// Whoever is let in may read, search, ask and run the plan checker; only an
// admin may use the admin page. Anyone else sees a page saying the prototype is
// private and how to get a link, and every API answers 401.
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { answerPrompt, loadCorpus, parseAskBody, pickChunks, SYSTEM_PROMPT } from './ask.mjs';
import { createAccess } from './access.mjs';
import { createAdmin } from './admin.mjs';
import { createLlm } from './llm.mjs';
import { createSettingsStore } from './settings.mjs';

export const MOUNT = '/projects/local-plan-navigator';
export const API = '/api/projects/local-plan-navigator';
const ASK = `${API}/ask`;
const ADMIN = `${API}/admin`;
const SESSION = `${API}/session`;
const ADMIN_PAGE = `${MOUNT}/admin`;
// Pages and files anyone may load: the sign-in page, the "this is private" page,
// and the styles, scripts and icon they are drawn with (the code is public anyway).
const OPEN = [`${MOUNT}/sign-in/`, `${MOUNT}/private/`, `${MOUNT}/assets/`];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
  '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
// On every response: a share link's token is in the URL, so never send it on as a
// referrer to GOV.UK or legislation.gov.uk when a visitor follows a citation.
const COMMON = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' };

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...COMMON, 'Content-Type': type });
  res.end(body);
}

/** The pages read `message` from a failed request and show it as it is. */
const sendError = (res, status, message, extra = {}) => send(res, status, JSON.stringify({ message, ...extra }), 'application/json');

async function readJson(req, limit = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function sendFile(req, res, path, size, status = 200) {
  res.writeHead(status, { ...COMMON, 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Content-Length': size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(path).pipe(res);
}

async function serveFile(req, res, root) {
  const url = new URL(req.url, 'http://localhost');
  const rawPath = url.pathname;
  if (rawPath === MOUNT) {
    res.writeHead(308, { ...COMMON, Location: `${MOUNT}/${url.search}` });
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
      res.writeHead(308, { ...COMMON, Location: `${rawPath}/${url.search}` });
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
  await sendFile(req, res, path, details.size);
}

/**
 * Who is calling behind someone else's sign-in (ACCESS_MODE=trusted-proxy):
 * Azure App Service authentication, an Entra ID application proxy or similar
 * puts the signed-in person's email in a header and strips any copy a browser
 * sent. Everyone it lets through may read and ask; ADMIN_EMAILS may also use the
 * admin page. ONLY safe when nothing can reach this process except through it.
 */
export function proxyAccessFor(req, header, admins) {
  const email = String(req.headers[header] ?? '').trim().toLowerCase();
  if (!email || email.length > 254 || !email.includes('@')) return { access: null, email: null };
  return { access: admins.has(email) ? 'owner' : 'share', email };
}

/** A small fixed-window counter, for sign-in attempts. */
function attempts(limit, windowMs) {
  const seen = new Map();
  return (key) => {
    const now = Date.now();
    const entry = seen.get(key);
    if (!entry || now - entry.start > windowMs) { seen.set(key, { start: now, count: 1 }); return true; }
    entry.count++;
    if (seen.size > 5000) for (const [k, e] of seen) if (now - e.start > windowMs) seen.delete(k);
    return entry.count <= limit;
  };
}

export function createApp({
  distDir = resolve('dist'),
  siteOrigin = process.env.ORIGIN ?? 'https://strangeramblings.com',
  accessMode = process.env.ACCESS_MODE ?? 'standalone',
  // One secret for the admin session (and, unless SETTINGS_KEY is set, saved keys).
  // LOCAL_PLAN_NAVIGATOR_GATEWAY_KEY is read only so an older deployment keeps working.
  secret = process.env.LOCAL_PLAN_NAVIGATOR_SECRET ?? process.env.LOCAL_PLAN_NAVIGATOR_GATEWAY_KEY,
  adminPasswordHash = process.env.LOCAL_PLAN_NAVIGATOR_ADMIN_PASSWORD_HASH ?? '',
  proxyIdentityHeader = (process.env.PROXY_IDENTITY_HEADER ?? 'x-ms-client-principal-name').toLowerCase(),
  adminEmails = process.env.ADMIN_EMAILS ?? '',
  stateDir = process.env.LOCAL_PLAN_NAVIGATOR_STATE_DIR ?? null,
  settingsKey = process.env.LOCAL_PLAN_NAVIGATOR_SETTINGS_KEY ?? secret,
  dailyCap = Number(process.env.LOCAL_PLAN_NAVIGATOR_DAILY_CAP ?? 400),
  release = process.env.APP_RELEASE_ID ?? 'local',
  retryDelayMs = 4000,
  settings = null,
  llm = null,
  checker = null,
  access = null,
} = {}) {
  if (!['standalone', 'trusted-proxy'].includes(accessMode)) throw new Error('ACCESS_MODE must be standalone or trusted-proxy');
  if (!secret || secret.length < 32) throw new Error('LOCAL_PLAN_NAVIGATOR_SECRET must be 32 or more characters');
  const admins = new Set(String(adminEmails).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
  const doors = access ?? createAccess({ secret, adminPasswordHash, stateDir, mount: MOUNT, api: API });
  const store = settings ?? createSettingsStore({ dir: stateDir, secret: settingsKey });
  const model = llm ?? createLlm({ settings: store, stateDir, retryDelayMs });
  const admin = createAdmin({ settings: store, llm: model, siteOrigin, shares: accessMode === 'standalone' ? doors : null });
  const check = checker?.({ complete: (req) => model.complete({ ...req, feature: req.feature ?? 'checker' }), distDir, siteOrigin }) ?? null;
  const signInPerAddress = attempts(5, 15 * 60_000);
  const signInOverall = attempts(30, 60 * 60_000);
  const buckets = new Map();
  let day = '';
  let usedToday = 0;

  /**
   * One rate limit for every model-backed request: a refilling bucket per caller
   * (twenty a minute) and one daily cap across everyone. A signed-in person is
   * keyed on who they are; a share-link recipient by address — which the front
   * sets from Cloudflare's cf-connecting-ip, never from anything the caller wrote.
   */
  function allow(req, who, cost = 1) {
    const now = Date.now();
    const bucket = buckets.get(who) ?? { tokens: 20, at: now };
    bucket.tokens = Math.min(20, bucket.tokens + (now - bucket.at) * (20 / 60_000));
    bucket.at = now;
    if (bucket.tokens < cost) return { status: 429, message: 'Too many requests in a short time. Wait a minute and try again.' };
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== day) { day = today; usedToday = 0; }
    if (usedToday + cost > dailyCap) return { status: 503, message: "Today's allowance of model answers has been used." };
    bucket.tokens -= cost;
    usedToday += cost;
    buckets.set(who, bucket);
    if (buckets.size > 2000) for (const [id, b] of buckets) if (now - b.at > 600_000) buckets.delete(id);
    return null;
  }

  const sameOrigin = (req) => !req.headers.origin || req.headers.origin === siteOrigin;

  return async (req, res) => {
    res.setHeader('x-local-plan-navigator-release', release);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/__alive') {
      send(res, 200, JSON.stringify({ ready: true, release }), 'application/json');
      return;
    }
    if (!(pathname === MOUNT || pathname.startsWith(`${MOUNT}/`) || pathname.startsWith(`${API}/`))) {
      send(res, 404, 'Not found'); return;
    }
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const address = String(req.headers['x-forwarded-for'] ?? 'unknown').slice(0, 64);

    let who = null;
    let access = null;
    if (accessMode === 'trusted-proxy') {
      const decided = proxyAccessFor(req, proxyIdentityHeader, admins);
      access = decided.access;
      who = decided.email ? `user:${decided.email}` : null;
    } else {
      const decided = await doors.decide(req);
      access = decided.access;
      who = access === 'owner' ? 'owner' : access === 'share' ? `guest:${address}` : null;
      if (decided.setCookies.length) res.setHeader('Set-Cookie', decided.setCookies);
    }

    // The navigator's own sign-in.
    if (pathname === SESSION) {
      if (accessMode !== 'standalone') { sendError(res, 404, 'Sign-in is handled by this site\'s own sign-in.'); return; }
      if (!sameOrigin(req)) { sendError(res, 403, 'Sign-in is only taken from pages this server sent.'); return; }
      if (req.method === 'DELETE') {
        res.setHeader('Set-Cookie', doors.signOutCookies(secure));
        sendError(res, 200, 'Signed out.'); return;
      }
      if (req.method !== 'POST') { sendError(res, 405, 'Method not allowed.'); return; }
      if (!doors.adminConfigured) { sendError(res, 503, 'No admin passphrase is set on this server (LOCAL_PLAN_NAVIGATOR_ADMIN_PASSWORD_HASH).'); return; }
      if (!signInPerAddress(address) || !signInOverall('all')) { sendError(res, 429, 'Too many attempts. Wait fifteen minutes and try again.'); return; }
      let body;
      try { body = await readJson(req, 4096); } catch { sendError(res, 400, 'The sign-in could not be read.'); return; }
      if (!doors.checkPassword(body?.password)) { sendError(res, 401, 'That passphrase is not right.'); return; }
      res.setHeader('Set-Cookie', doors.signInCookies(secure));
      sendError(res, 200, 'Signed in.'); return;
    }

    const isOpen = OPEN.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p));
    if (isOpen) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Method not allowed'); return; }
      try { await serveFile(req, res, distDir); }
      catch { if (!res.headersSent) send(res, 500, 'File unavailable'); else res.destroy(); }
      return;
    }

    if (!access) {
      if (pathname.startsWith(`${API}/`)) {
        sendError(res, 401, 'Your share link has expired or is not valid. Open the link you were sent again, or ask whoever sent it for a new one.');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Method not allowed'); return; }
      // Its own address, not served in place: every page's links are relative to
      // where it sits, so the explanation has to be shown from where it was built.
      res.writeHead(303, { ...COMMON, Location: `${MOUNT}/private/` });
      res.end();
      return;
    }

    // The admin page and its API exist only for an admin; to anyone else they are
    // as absent as the rest of the site is to a stranger.
    const isAdmin = pathname === ADMIN_PAGE || pathname.startsWith(`${ADMIN_PAGE}/`) || pathname.startsWith(`${ADMIN}/`);
    if (isAdmin && access !== 'owner') { send(res, 404, 'Not found'); return; }
    if (pathname.startsWith(`${ADMIN}/`)) {
      try { await admin(req, res, pathname.slice(ADMIN.length)); }
      catch { if (!res.headersSent) sendError(res, 500, 'The admin request failed.'); else res.end(); }
      return;
    }

    if (check && (pathname === `${API}/check` || pathname.startsWith(`${API}/check/`))) {
      if (req.method !== 'POST') { sendError(res, 405, 'Method not allowed.'); return; }
      if (!sameOrigin(req)) { sendError(res, 403, 'Documents are only taken from pages this server sent.'); return; }
      const sub = pathname.slice(`${API}/check`.length);
      // A check is many model calls; it costs five of a caller's twenty a minute.
      if (sub === '') {
        const refused = allow(req, who, 5);
        if (refused) { sendError(res, refused.status, refused.message); return; }
      }
      try { await check(req, res, { access, sub }); }
      catch { if (!res.headersSent) sendError(res, 500, 'The check failed.'); else res.end(); }
      return;
    }

    if (pathname === MOUNT || pathname.startsWith(`${MOUNT}/`)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Method not allowed'); return; }
      try { await serveFile(req, res, distDir); }
      catch { if (!res.headersSent) send(res, 500, 'File unavailable'); else res.destroy(); }
      return;
    }
    if (pathname !== ASK) { sendError(res, 404, 'Not found'); return; }

    if (req.method !== 'POST') { sendError(res, 405, 'Method not allowed.'); return; }
    if (!sameOrigin(req)) { sendError(res, 403, 'Questions are only taken from pages this server sent.'); return; }
    let input;
    try { input = parseAskBody(await readJson(req)); }
    catch { sendError(res, 400, 'The question could not be read.'); return; }
    if (!input.question || !input.ids.length) { sendError(res, 400, 'A question and at least one passage are needed.'); return; }
    let chunks;
    try { chunks = pickChunks(input.ids, await loadCorpus(distDir), siteOrigin); }
    catch { sendError(res, 503, 'The guidance texts could not be loaded.'); return; }
    if (!chunks.length) { sendError(res, 409, 'The page is older than the guidance on the server. Reload it and ask again.'); return; }
    const refused = allow(req, who);
    if (refused) { sendError(res, refused.status, refused.message); return; }
    res.writeHead(200, {
      ...COMMON, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const event = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    // `id` lets the page number its citations by the passages the model was
    // actually given, which is not always every passage the page asked for.
    event({ type: 'sources', sources: chunks.map((chunk, index) => ({
      n: index + 1, id: chunk.id, title: chunk.title, sourceType: chunk.sourceType, url: chunk.url,
    })) });
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const text = await model.stream({
        feature: 'ask', system: SYSTEM_PROMPT, user: answerPrompt(input.question, chunks),
        maxTokens: 1000, temperature: 0.3, signal: abort.signal, timeoutMs: 60_000,
      }, (token) => event({ type: 'token', token }));
      if (!text) event({ type: 'token', token: 'Sorry — I could not generate an answer for that. Try rephrasing.' });
      event({ type: 'done' });
    } catch {
      if (!res.destroyed) event({ type: 'error', message: 'The model could not answer just now. Ask again in a minute.' });
    } finally {
      res.end();
    }
  };
}
