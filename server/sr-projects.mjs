// server/sr-projects.mjs — strangeramblings.com only (ACCESS_MODE=sr-projects).
//
// On strangeramblings.com the navigator is shared like every other /projects app:
// the owner sees it through the site's own sign-in, and anyone else needs a share
// link minted with the Share button on its /projects card. The site decides, not
// this process: the estate gateway in front asks Main's session authority about
// every request (the visibility row, the owner preview, the share link in `?t=`
// or the `psh_local-plan-navigator` cookie) and signs the answer into a
// request-bound assertion (deploy/app.json `sessionClaims: ["project"]`), which is
// all this module reads.
//
// REMOVABLE. Spun up anywhere else, delete this file and gateway/, and run
// ACCESS_MODE=standalone (the navigator's own share links and admin sign-in,
// server/access.mjs) or ACCESS_MODE=trusted-proxy — see docs/handover.md.
import { verifyAssertion } from '../gateway/identity.mjs';

const PROJECT_KEY = 'local-plan-navigator';
const AUDIENCE = 'sr-local-plan-navigator';
// Main's per-project share cookie (`psh_<key>`, $lib/projects/shares there).
const SHARE_COOKIE = `psh_${PROJECT_KEY}`;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{20,512}$/;
const IDENTITY_HEADER = 'x-local-plan-navigator-identity';

/**
 * What the signed assertion allows, or null.
 *
 *   owner   the configured owner, or Main's owner previewing the private project
 *   share   a live /projects share link (no sign-in needed)
 *   public  the project has been made public on /projects
 */
export function accessFor(assertion, owner) {
  if (!assertion) return null;
  if (assertion.email && owner && assertion.email === owner) return 'owner';
  const project = assertion.project;
  if (!project || project.key !== PROJECT_KEY) return null;
  return ['owner', 'share', 'public'].includes(project.access) ? project.access : null;
}

export function createSrProjectsAccess({ gatewayKey, ownerEmail, mount, api }) {
  if (!gatewayKey || gatewayKey.length < 32) throw new Error('ACCESS_MODE=sr-projects needs LOCAL_PLAN_NAVIGATOR_GATEWAY_KEY (32+ characters), shared with the estate gateway');
  const owner = String(ownerEmail ?? '').trim().toLowerCase();

  /**
   * Keep a share recipient in once Main has accepted the link's `?t=`. The pages
   * link to each other without the token, so it rides in Main's per-project
   * cookie — set for the pages and, separately, for the API, because a cookie's
   * path is a prefix and the two share none. Twelve hours, like Main's own
   * projects; opening the link again starts a fresh twelve.
   */
  function shareCookies(req) {
    const token = new URL(req.url, 'http://localhost').searchParams.get('t');
    if (!token || !SHARE_TOKEN.test(token)) return [];
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return [mount, api].map((path) => `${SHARE_COOKIE}=${token}; Path=${path}; Max-Age=43200; HttpOnly; SameSite=Lax${secure}`);
  }

  return {
    mode: 'sr-projects',
    async decide(req) {
      const assertion = verifyAssertion(req.headers[IDENTITY_HEADER], req.method, req.url, gatewayKey, AUDIENCE);
      const access = accessFor(assertion, owner);
      return {
        access,
        email: assertion?.email ?? null,
        setCookies: access === 'share' ? shareCookies(req) : [],
      };
    },
    // Signing in is the site's own: its login page comes back to the admin page.
    signInRedirect: `/login?callbackUrl=${encodeURIComponent(`${mount}/admin/`)}`,
    // Share links are minted on /projects, not here.
    sharing: { elsewhere: '/projects', note: 'Share links for this site are made on /projects: use Share on the Local Plan Navigator card, and withdraw them there too.' },
  };
}
