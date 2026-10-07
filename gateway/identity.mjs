import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed identity assertions between an edge gateway and the application behind it.
 *
 * Generalised verbatim from the proven Policy Analysis implementation
 * (SR-Policy-Analysis src/lib/server/gateway-identity.mjs, live since 2026-09-12).
 * The only change is that the audience is a parameter rather than the constant
 * 'sr-policy', so one implementation serves every extracted application.
 *
 * The assertion is bound to ONE request: audience, method and path are all signed,
 * and it expires in 30 seconds. A leaked assertion therefore cannot be replayed
 * against a different endpoint or a different application.
 *
 * Optional claims (kit 2.2). Main's session authority decides them and the
 * gateway signs them, so an application no longer reads Main's identity or
 * project tables to answer "who" and "may they":
 *
 *   pid      the effective person's activity principal id (Drive only)
 *   drive    { level, grants, people } — the Drive level Main's access rows give
 *            a MEMBER, every permission they hold, and the display names of the
 *            principals that member may see. Absent for the owner, whose access
 *            stays the app's own env allow-list.
 *   project  { key, access } — the visibility/share decision for the project an
 *            application serves: 'public', 'owner' (owner previewing a private
 *            project), 'share' (a valid share link) or 'none'.
 *
 * An assertion carries an email, a project decision, or both. Anything malformed
 * makes the WHOLE assertion invalid: a half-understood claim is never trusted.
 */

/**
 * @typedef {{ level: 'self' | 'all' | 'admin', grants: string[], people: Record<string, string> }} DriveClaim
 * @typedef {{ key: string, access: 'public' | 'owner' | 'share' | 'none' }} ProjectClaim
 * @typedef {{ pid?: string, drive?: DriveClaim, project?: ProjectClaim }} Claims
 * @typedef {{ email: string | null, expires: string, principalId: string | null, drive: DriveClaim | null, project: ProjectClaim | null }} Assertion
 * @typedef {string | ReadonlyArray<string | null | undefined> | null | undefined} KeyRing
 */

const TTL_SECONDS = 30;
const LEVELS = new Set(['self', 'all', 'admin']);
const PROJECT_ACCESS = new Set(['public', 'owner', 'share', 'none']);
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const PERMISSION = /^[a-z][a-z0-9.-]{0,47}:[a-z][a-z0-9-]{0,31}$/;
const PROJECT_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_GRANTS = 64;
const MAX_PEOPLE = 64;
const MAX_LABEL = 120;

const digest = (payload, key) => createHmac('sha256', key).update(payload).digest('base64url');
/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** @param {KeyRing} key @returns {string[]} */
const usableKeys = (key) => (Array.isArray(key) ? key : [key]).filter((k) => typeof k === 'string' && k.length >= 32);

/**
 * A normalised copy of the optional claims, or null when any of them is malformed.
 * @param {unknown} claims
 * @returns {Claims | null}
 */
export function normaliseClaims(claims) {
	if (claims == null) return {};
	if (!isRecord(claims)) return null;
	/** @type {Claims} */
	const out = {};
	if (claims.pid != null) {
		if (typeof claims.pid !== 'string' || !PRINCIPAL.test(claims.pid)) return null;
		out.pid = claims.pid;
	}
	if (claims.drive != null) {
		const d = claims.drive;
		if (!isRecord(d) || !out.pid || !LEVELS.has(d.level)) return null;
		if (!Array.isArray(d.grants) || d.grants.length > MAX_GRANTS) return null;
		if (!d.grants.every((g) => typeof g === 'string' && PERMISSION.test(g))) return null;
		const people = d.people ?? {};
		if (!isRecord(people)) return null;
		const entries = Object.entries(people);
		if (entries.length > MAX_PEOPLE) return null;
		for (const [id, label] of entries) {
			if (!PRINCIPAL.test(id) || typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL) return null;
		}
		out.drive = { level: d.level, grants: [...new Set(d.grants)].sort(), people: Object.fromEntries(entries) };
	}
	if (claims.project != null) {
		const p = claims.project;
		if (!isRecord(p) || typeof p.key !== 'string' || !PROJECT_KEY.test(p.key) || !PROJECT_ACCESS.has(p.access)) return null;
		out.project = { key: p.key, access: p.access };
	}
	return out;
}

/**
 * The gateway signs an identity it has already authenticated, bound to one request.
 * `email` may be null only when a project decision is being carried.
 * @param {string | null} email
 * @param {string} method
 * @param {string} path
 * @param {string} key
 * @param {string} audience
 * @param {number} [now]
 * @param {Claims} [claims]
 * @returns {string}
 */
export function signIdentity(email, method, path, key, audience, now = Date.now(), claims = undefined) {
	if (!key || key.length < 32) throw new Error('Gateway signing key must contain at least 32 characters');
	if (!audience) throw new Error('Gateway audience is required');
	const extra = normaliseClaims(claims);
	if (!extra) throw new Error('Invalid identity claims');
	const hasEmail = typeof email === 'string' && !!email.trim();
	if (!hasEmail && (email != null || !extra.project)) throw new Error('An identity needs an email or a project decision');
	const issued = Math.floor(now / 1000);
	const payload = Buffer.from(
		JSON.stringify({ aud: audience, email: hasEmail ? email : null, method, path, iat: issued, exp: issued + TTL_SECONDS, ...extra })
	).toString('base64url');
	return `${payload}.${digest(payload, key)}`;
}

/**
 * Verify an assertion and return everything it says, or null.
 *
 * `key` may be one key or an array (current first, then the previous key during
 * a rotation). Every key is tried; a token verifies if any of them signed it.
 * @param {string | null | undefined} token
 * @param {string} method
 * @param {string} path
 * @param {KeyRing} key
 * @param {string} audience
 * @param {number} [now]
 * @returns {Assertion | null}
 */
export function verifyAssertion(token, method, path, key, audience, now = Date.now()) {
	const keys = usableKeys(key);
	if (!keys.length || !audience) return null;
	if (typeof token !== 'string' || token.length > 8192) return null;
	try {
		const parts = token.split('.');
		if (parts.length !== 2) return null;
		const [payload, signature] = parts;
		const supplied = Buffer.from(signature);
		let signed = false;
		for (const k of keys) {
			const expected = Buffer.from(digest(payload, k));
			// Compare before parsing: an unsigned payload never reaches JSON.parse.
			if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) signed = true;
		}
		if (!signed) return null;
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		const seconds = Math.floor(now / 1000);
		if (
			!isRecord(claims) ||
			claims.aud !== audience ||
			claims.method !== method ||
			claims.path !== path ||
			!Number.isInteger(claims.iat) ||
			!Number.isInteger(claims.exp) ||
			claims.iat > seconds + 5 ||
			claims.exp <= seconds ||
			claims.exp - claims.iat !== TTL_SECONDS
		) {
			return null;
		}
		const extra = normaliseClaims({ pid: claims.pid, drive: claims.drive, project: claims.project });
		if (!extra) return null;
		let email = null;
		if (typeof claims.email === 'string' && claims.email.trim()) email = claims.email.trim().toLowerCase();
		else if (claims.email != null || !extra.project) return null;
		return {
			email,
			expires: new Date(claims.exp * 1000).toISOString(),
			principalId: extra.pid ?? null,
			drive: extra.drive ?? null,
			project: extra.project ?? null
		};
	} catch {
		return null;
	}
}

/**
 * The signed-in person, or null. Unchanged contract: an assertion without an email is not an identity.
 * @param {string | null | undefined} token
 * @param {string} method
 * @param {string} path
 * @param {KeyRing} key
 * @param {string} audience
 * @param {number} [now]
 * @returns {{ email: string, expires: string } | null}
 */
export function verifyIdentity(token, method, path, key, audience, now = Date.now()) {
	const assertion = verifyAssertion(token, method, path, key, audience, now);
	if (!assertion?.email) return null;
	return { email: assertion.email, expires: assertion.expires };
}
