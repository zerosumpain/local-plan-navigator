// server/access.mjs — who may see the navigator, decided by the navigator alone.
//
// Nothing here asks another service. Two ways in:
//
//   admin   signs in on /sign-in/ with the passphrase whose scrypt hash is in
//           LOCAL_PLAN_NAVIGATOR_ADMIN_PASSWORD_HASH, and gets a signed,
//           twelve-hour cookie. Changing the passphrase ends every session.
//   share   opens a link minted on the admin page (…/?share=<token>). The token
//           is 32 random bytes; only its SHA-256 is stored, in shares.json in the
//           state directory, with a label, an expiry and a use count. It is kept
//           in a cookie for twelve hours so links between pages keep working;
//           opening the link again starts a fresh twelve. Revoking it ends access
//           at the next request.
//
// Both cookies are HttpOnly, SameSite=Lax and, behind HTTPS, Secure, and are set
// for the pages and the API only.
import { createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ADMIN_COOKIE = 'lpn_admin';
export const SHARE_COOKIE = 'lpn_share';
const SESSION_SECONDS = 12 * 60 * 60;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{40,64}$/;
const MAX_ACTIVE_SHARES = 100;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** `scrypt:N:r:p:salt:hash`, for LOCAL_PLAN_NAVIGATOR_ADMIN_PASSWORD_HASH. */
export function hashPassword(password, salt = randomBytes(16)) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Use a passphrase of at least 12 characters');
  const key = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${b64(salt)}:${b64(key)}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string' || !password || password.length > 1024) return false;
  const [, N, r, p, salt, hash] = parts;
  try {
    const expected = Buffer.from(hash, 'base64url');
    const actual = scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** One cookie value out of a Cookie header. */
export function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

export function createAccess({ secret, adminPasswordHash = '', stateDir = null, mount, api, now = () => Date.now(), log = console }) {
  if (!secret || secret.length < 32) throw new Error('A 32+ character LOCAL_PLAN_NAVIGATOR_SECRET is required');
  const sessionKey = Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), 'local-plan-navigator admin session v1', 32));
  // Changing the passphrase changes this, so every session signed under the old one stops working.
  const passwordEpoch = adminPasswordHash ? sha256(adminPasswordHash).slice(0, 12) : 'none';
  const sharesPath = stateDir ? join(stateDir, 'shares.json') : null;
  let cache = { mtimeMs: -1, shares: [] };
  const pending = new Map();

  // --- admin session ------------------------------------------------------

  function signSession() {
    const iat = Math.floor(now() / 1000);
    const payload = b64(JSON.stringify({ sub: 'admin', iat, exp: iat + SESSION_SECONDS, epoch: passwordEpoch }));
    return `${payload}.${b64(createHmac('sha256', sessionKey).update(payload).digest())}`;
  }

  function verifySession(value) {
    if (!adminPasswordHash || typeof value !== 'string' || value.length > 512) return false;
    const [payload, signature] = value.split('.');
    if (!payload || !signature) return false;
    const expected = createHmac('sha256', sessionKey).update(payload).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const seconds = Math.floor(now() / 1000);
      return claims.sub === 'admin' && claims.epoch === passwordEpoch && Number.isInteger(claims.exp) && claims.exp > seconds && claims.iat <= seconds + 5;
    } catch {
      return false;
    }
  }

  // --- share links ----------------------------------------------------------

  async function readShares() {
    if (!sharesPath) return [];
    let info;
    try { info = await stat(sharesPath); } catch { cache = { mtimeMs: -1, shares: [] }; return []; }
    if (info.mtimeMs === cache.mtimeMs) return cache.shares;
    try {
      const parsed = JSON.parse(await readFile(sharesPath, 'utf8'));
      cache = { mtimeMs: info.mtimeMs, shares: Array.isArray(parsed.shares) ? parsed.shares : [] };
    } catch (err) {
      log.warn?.(`[access] ${sharesPath} is unreadable (${err.message}); no share link will work until it is fixed`);
      cache = { mtimeMs: info.mtimeMs, shares: [] };
    }
    return cache.shares;
  }

  async function writeShares(shares) {
    await mkdir(stateDir, { recursive: true });
    const temp = `${sharesPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, shares }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, sharesPath);
    cache = { mtimeMs: -1, shares: [] };
  }

  /** Apply the use counts gathered since the last write. Both slots share the file, so re-read first. */
  async function flushUsage() {
    if (!pending.size || !sharesPath) return;
    const deltas = new Map(pending);
    pending.clear();
    const shares = (await readShares()).map((s) => {
      const d = deltas.get(s.id);
      return d ? { ...s, useCount: (s.useCount ?? 0) + d.count, lastUsedAt: d.at } : s;
    });
    await writeShares(shares).catch((err) => log.warn?.(`[access] share use counts not written: ${err.message}`));
  }
  const flushTimer = setInterval(() => { flushUsage().catch(() => {}); }, 30_000);
  flushTimer.unref?.();

  const live = (s, at = now()) => !s.revokedAt && (!s.expiresAt || Date.parse(s.expiresAt) > at);

  async function validateShare(token) {
    if (!token || !SHARE_TOKEN.test(token)) return null;
    const hash = sha256(token);
    const share = (await readShares()).find((s) => s.tokenHash === hash);
    if (!share || !live(share)) return null;
    const d = pending.get(share.id) ?? { count: 0, at: null };
    pending.set(share.id, { count: d.count + 1, at: new Date(now()).toISOString() });
    return share;
  }

  const publicShare = (s) => ({
    id: s.id, label: s.label, createdAt: s.createdAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt,
    lastUsedAt: pending.get(s.id)?.at ?? s.lastUsedAt ?? null, useCount: (s.useCount ?? 0) + (pending.get(s.id)?.count ?? 0),
    status: s.revokedAt ? 'revoked' : live(s) ? 'live' : 'expired',
  });

  async function listShares() {
    return (await readShares()).map(publicShare).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function createShare({ label, days }) {
    if (!sharesPath) throw new Error('This server has no state directory, so share links cannot be kept');
    await flushUsage();
    const shares = await readShares();
    if (shares.filter((s) => live(s)).length >= MAX_ACTIVE_SHARES) throw new Error(`There are already ${MAX_ACTIVE_SHARES} live links. Revoke some first.`);
    const token = randomBytes(32).toString('base64url');
    const created = new Date(now());
    const lifetime = Number(days);
    const share = {
      id: randomBytes(6).toString('hex'),
      label: String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Share link',
      tokenHash: sha256(token),
      createdAt: created.toISOString(),
      expiresAt: Number.isFinite(lifetime) && lifetime > 0 ? new Date(created.getTime() + Math.min(lifetime, 366) * 86_400_000).toISOString() : null,
      revokedAt: null,
      lastUsedAt: null,
      useCount: 0,
    };
    await writeShares([...shares, share]);
    return { share: publicShare(share), token };
  }

  async function revokeShare(id) {
    await flushUsage();
    const shares = await readShares();
    const share = shares.find((s) => s.id === id);
    if (!share) return null;
    if (!share.revokedAt) {
      share.revokedAt = new Date(now()).toISOString();
      await writeShares(shares);
    }
    return publicShare(share);
  }

  // --- the decision ---------------------------------------------------------

  function cookie(name, value, maxAge, secure) {
    return [mount, api].map((path) => `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  }

  /**
   * `{ access: 'owner' | 'share' | null, setCookies }` for one request. A token in
   * the URL beats one in a cookie, so opening a new link replaces an old one.
   */
  async function decide(req) {
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const cookies = req.headers.cookie ?? '';
    if (verifySession(cookieValue(cookies, ADMIN_COOKIE))) return { access: 'owner', setCookies: [] };
    const fromUrl = new URL(req.url, 'http://localhost').searchParams.get('share');
    const token = fromUrl || cookieValue(cookies, SHARE_COOKIE);
    const share = await validateShare(token);
    if (!share) return { access: null, setCookies: fromUrl ? cookie(SHARE_COOKIE, '', 0, secure) : [] };
    return { access: 'share', share, setCookies: fromUrl ? cookie(SHARE_COOKIE, fromUrl, SESSION_SECONDS, secure) : [] };
  }

  return {
    decide,
    signInCookies: (secure) => cookie(ADMIN_COOKIE, signSession(), SESSION_SECONDS, secure),
    signOutCookies: (secure) => [...cookie(ADMIN_COOKIE, '', 0, secure), ...cookie(SHARE_COOKIE, '', 0, secure)],
    checkPassword: (password) => Boolean(adminPasswordHash) && verifyPassword(password, adminPasswordHash),
    adminConfigured: Boolean(adminPasswordHash),
    canShare: Boolean(sharesPath),
    listShares,
    createShare,
    revokeShare,
    flushUsage,
    close: () => clearInterval(flushTimer),
  };
}
