import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { verifyAssertion } from '../gateway/identity.mjs';
import { answerPrompt, loadCorpus, parseAskBody, pickChunks, SYSTEM_PROMPT } from './ask.mjs';
import { createAdmin } from './admin.mjs';
import { createLlm } from './llm.mjs';
import { createSettingsStore } from './settings.mjs';

const MOUNT = '/projects/local-plan-navigator';
const API = '/api/projects/local-plan-navigator';
const ASK = `${API}/ask`;
const ADMIN = `${API}/admin`;
const ADMIN_PAGE = `${MOUNT}/admin`;
const PROJECT_KEY = 'local-plan-navigator';
// SR-Main's per-project share cookie (`psh_<key>`, $lib/projects/shares there).
// Main's session authority reads it from the cookie header the gateway forwards.
const SHARE_COOKIE = `psh_${PROJECT_KEY}`;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{20,512}$/;
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

/**
 * Who this request is for, from the gateway's signed assertion, or null for a 404.
 *
 * SR-Main decides; this process holds none of the rows. The gateway forwards the
 * request's `?t=` and cookies to Main's session authority, which applies the
 * project's visibility row, the owner preview and the /projects share links, and
 * the gateway signs that answer (`project`) into the assertion alongside the
 * signed-in email, if any. A decision for another project, or `none`, is a 404,
 * exactly as before: the page still does not admit it exists.
 *
 *   owner   the configured owner, or Main's owner previewing a private project
 *   share   a recipient of a live share link from /projects (no sign-in needed)
 *   public  the project has been made public on /projects
 */
export function accessFor(assertion, owner) {
  if (!assertion) return null;
  if (assertion.email && assertion.email === owner) return 'owner';
  const project = assertion.project;
  if (!project || project.key !== PROJECT_KEY) return null;
  return ['owner', 'share', 'public'].includes(project.access) ? project.access : null;
}

/**
 * Keep a share recipient in, once Main has accepted the link's `?t=`. The pages
 * link to each other without the token, so it rides in Main's per-project cookie,
 * set for the pages and, separately, for this project's API (a cookie's path is a
 * prefix, and the two share none). Twelve hours, like Main's own projects;
 * opening the link again starts a fresh twelve.
 */
function shareCookies(req) {
  const token = new URL(req.url, 'http://localhost').searchParams.get('t');
  if (!token || !SHARE_TOKEN.test(token)) return [];
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return [MOUNT, API].map((path) =>
    `${SHARE_COOKIE}=${token}; Path=${path}; Max-Age=43200; HttpOnly; SameSite=Lax${secure}`);
}

/**
 * Who is calling when the service runs behind someone else's sign-in rather
 * than the strangeramblings.com gateway (ACCESS_MODE=trusted-proxy): Azure App
 * Service authentication, an Entra ID application proxy or similar puts the
 * signed-in person's email in a header, and strips any copy a browser sent.
 * Everyone it lets through may read and ask; ADMIN_EMAILS may also use the admin
 * page. ONLY safe when nothing can reach this process except through that proxy.
 */
export function proxyAccessFor(req, header, admins) {
  const email = String(req.headers[header] ?? '').trim().toLowerCase();
  if (!email || email.length > 254 || !email.includes('@')) return { access: null, email: null };
  return { access: admins.has(email) ? 'owner' : 'share', email };
}

export function createApp({
  distDir = resolve('dist'),
  ownerEmail = process.env.OWNER_EMAIL,
  gatewayKey = process.env.LOCAL_PLAN_NAVIGATOR_GATEWAY_KEY,
  siteOrigin = process.env.ORIGIN ?? 'https://strangeramblings.com',
  accessMode = process.env.ACCESS_MODE ?? 'sr-gateway',
  proxyIdentityHeader = (process.env.PROXY_IDENTITY_HEADER ?? 'x-ms-client-principal-name').toLowerCase(),
  adminEmails = process.env.ADMIN_EMAILS ?? '',
  stateDir = process.env.LOCAL_PLAN_NAVIGATOR_STATE_DIR ?? null,
  settingsKey = process.env.LOCAL_PLAN_NAVIGATOR_SETTINGS_KEY ?? gatewayKey,
  dailyCap = Number(process.env.LOCAL_PLAN_NAVIGATOR_DAILY_CAP ?? 400),
  release = process.env.APP_RELEASE_ID ?? 'local',
  retryDelayMs = 4000,
  settings = null,
  llm = null,
  checker = null,
} = {}) {
  if (!['sr-gateway', 'trusted-proxy'].includes(accessMode)) throw new Error('ACCESS_MODE must be sr-gateway or trusted-proxy');
  if (accessMode === 'sr-gateway' && (!ownerEmail || !gatewayKey || gatewayKey.length < 32)) {
    throw new Error('OWNER_EMAIL and a 32+ character gateway key are required');
  }
  const owner = (ownerEmail ?? '').trim().toLowerCase();
  const admins = new Set(String(adminEmails).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (accessMode === 'trusted-proxy' && owner) admins.add(owner);
  const store = settings ?? createSettingsStore({ dir: stateDir, secret: settingsKey });
  const model = llm ?? createLlm({ settings: store, stateDir, retryDelayMs });
  const admin = createAdmin({ settings: store, llm: model, siteOrigin });
  const check = checker?.({ complete: (req) => model.complete({ ...req, feature: req.feature ?? 'checker' }), distDir, siteOrigin }) ?? null;
  const buckets = new Map();
  let day = '';
  let usedToday = 0;

  /**
   * One rate limit for every model-backed request: a refilling bucket per caller
   * (twenty a minute) and one daily cap across everyone. The owner is keyed on
   * the signed identity, which the caller cannot choose; a share recipient has
   * none, so they share a bucket per address — the gateway sets x-forwarded-for
   * from Cloudflare's cf-connecting-ip, never from anything the caller wrote.
   */
  function allow(req, access, email, cost = 1) {
    const who = access === 'owner' && email ? `owner:${email}`
      : email ? `user:${email}` : `guest:${String(req.headers['x-forwarded-for'] ?? 'unknown').slice(0, 64)}`;
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
    // Guests are keyed per address, so forget the idle ones rather than grow forever.
    if (buckets.size > 2000) for (const [id, b] of buckets) if (now - b.at > 600_000) buckets.delete(id);
    return null;
  }

  return async (req, res) => {
    res.setHeader('x-local-plan-navigator-release', release);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/__alive') {
      send(res, 200, JSON.stringify({ ready: true, release }), 'application/json');
      return;
    }
    if (!(pathname === MOUNT || pathname.startsWith(`${MOUNT}/`) || pathname === API || pathname.startsWith(`${API}/`))) {
      send(res, 404, 'Not found'); return;
    }
    let access;
    let email = null;
    if (accessMode === 'trusted-proxy') {
      ({ access, email } = proxyAccessFor(req, proxyIdentityHeader, admins));
    } else {
      const assertion = verifyAssertion(req.headers['x-local-plan-navigator-identity'], req.method, req.url,
        gatewayKey, 'sr-local-plan-navigator');
      access = accessFor(assertion, owner);
      email = assertion?.email ?? null;
      if (access === 'share') {
        const cookies = shareCookies(req);
        if (cookies.length) res.setHeader('Set-Cookie', cookies);
      }
    }
    if (!access) { send(res, 404, 'Not found'); return; }

    // The admin page and its API exist only for the owner; to anyone else they
    // are as absent as the rest of the site is to a stranger.
    const isAdmin = pathname === ADMIN_PAGE || pathname.startsWith(`${ADMIN_PAGE}/`) || pathname.startsWith(`${ADMIN}/`);
    if (isAdmin && access !== 'owner') { send(res, 404, 'Not found'); return; }
    if (pathname.startsWith(`${ADMIN}/`)) {
      try { await admin(req, res, pathname.slice(ADMIN.length)); }
      catch { if (!res.headersSent) sendError(res, 500, 'The admin request failed.'); else res.end(); }
      return;
    }

    if (check && (pathname === `${API}/check` || pathname.startsWith(`${API}/check/`))) {
      if (req.method !== 'POST') { sendError(res, 405, 'Method not allowed.'); return; }
      if (req.headers.origin && req.headers.origin !== siteOrigin) { sendError(res, 403, 'Documents are only taken from pages this server sent.'); return; }
      // A check is many model calls; it costs five of a caller's twenty a minute.
      const sub = pathname.slice(`${API}/check`.length);
      if (sub === '') {
        const refused = allow(req, access, email, 5);
        if (refused) { sendError(res, refused.status, refused.message); return; }
      }
      try { await check(req, res, { access, sub }); }
      catch { if (!res.headersSent) sendError(res, 500, 'The check failed.'); else res.end(); }
      return;
    }

    if (pathname.startsWith(MOUNT)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Method not allowed'); return; }
      try { await serveFile(req, res, distDir); }
      catch { if (!res.headersSent) send(res, 500, 'File unavailable'); else res.destroy(); }
      return;
    }
    if (pathname !== ASK) { sendError(res, 404, 'Not found'); return; }

    if (req.method !== 'POST') { sendError(res, 405, 'Method not allowed.'); return; }
    if (req.headers.origin && req.headers.origin !== siteOrigin) { sendError(res, 403, 'Questions are only taken from pages this server sent.'); return; }
    let input;
    try { input = parseAskBody(await readJson(req)); }
    catch { sendError(res, 400, 'The question could not be read.'); return; }
    if (!input.question || !input.ids.length) { sendError(res, 400, 'A question and at least one passage are needed.'); return; }
    let chunks;
    try { chunks = pickChunks(input.ids, await loadCorpus(distDir), siteOrigin); }
    catch { sendError(res, 503, 'The guidance texts could not be loaded.'); return; }
    if (!chunks.length) { sendError(res, 409, 'The page is older than the guidance on the server. Reload it and ask again.'); return; }
    const refused = allow(req, access, email);
    if (refused) { sendError(res, refused.status, refused.message); return; }
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
