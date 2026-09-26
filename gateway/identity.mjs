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
 */

const TTL_SECONDS = 30;

const digest = (payload, key) => createHmac('sha256', key).update(payload).digest('base64url');

/** The gateway signs an identity it has already authenticated, bound to one request. */
export function signIdentity(email, method, path, key, audience, now = Date.now()) {
	if (!key || key.length < 32) throw new Error('Gateway signing key must contain at least 32 characters');
	if (!audience) throw new Error('Gateway audience is required');
	const issued = Math.floor(now / 1000);
	const payload = Buffer.from(
		JSON.stringify({ aud: audience, email, method, path, iat: issued, exp: issued + TTL_SECONDS })
	).toString('base64url');
	return `${payload}.${digest(payload, key)}`;
}

export function verifyIdentity(token, method, path, key, audience, now = Date.now()) {
	if (!key || key.length < 32 || !audience) return null;
	if (typeof token !== 'string' || token.length > 8192) return null;
	try {
		const parts = token.split('.');
		if (parts.length !== 2) return null;
		const [payload, signature] = parts;
		const expected = Buffer.from(digest(payload, key));
		const supplied = Buffer.from(signature);
		// Compare before parsing: an unsigned payload never reaches JSON.parse.
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		const seconds = Math.floor(now / 1000);
		if (
			claims.aud !== audience ||
			claims.method !== method ||
			claims.path !== path ||
			!Number.isInteger(claims.iat) ||
			!Number.isInteger(claims.exp) ||
			claims.iat > seconds + 5 ||
			claims.exp <= seconds ||
			claims.exp - claims.iat !== TTL_SECONDS ||
			typeof claims.email !== 'string' ||
			!claims.email.trim()
		) {
			return null;
		}
		return { email: claims.email.trim().toLowerCase(), expires: new Date(claims.exp * 1000).toISOString() };
	} catch {
		return null;
	}
}
