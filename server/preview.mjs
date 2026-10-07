// Local browser preview only. PREVIEW_ACCESS chooses what it stands in for:
//
//   owner (default), share, none   strangeramblings.com (ACCESS_MODE=sr-projects):
//        it signs what the estate gateway would — the owner, a /projects share-link
//        holder, or a stranger — so each view can be looked at without the site
//   standalone   the navigator on its own: its own share links and admin sign-in
//        (passphrase PREVIEW_ADMIN_PASSPHRASE, default below)
//
// Production starts server/start.mjs behind the gateway (or server/front.mjs).
import { createServer } from 'node:http';
import { hashPassword } from './access.mjs';
import { createApp } from './app.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5382);
const as = process.env.PREVIEW_ACCESS ?? 'owner';
const ownerEmail = process.env.OWNER_EMAIL ?? 'local-owner@example.invalid';
const gatewayKey = process.env.LOCAL_PLAN_NAVIGATOR_GATEWAY_KEY ?? 'local-preview-key-only-2026-09-26-123456789';
const passphrase = process.env.PREVIEW_ADMIN_PASSPHRASE ?? 'local preview passphrase';
// The origin the browser will send, so the same-origin checks on writes pass.
const siteOrigin = process.env.ORIGIN ?? `http://${host}:${port}`;
const standalone = as === 'standalone';
const app = createApp({
  siteOrigin,
  accessMode: standalone ? 'standalone' : 'sr-projects',
  ownerEmail,
  gatewayKey,
  secret: process.env.LOCAL_PLAN_NAVIGATOR_SECRET ?? 'local-preview-secret-only-2026-10-07-123456789',
  adminPasswordHash: standalone ? hashPassword(passphrase) : '',
});
const { signIdentity } = standalone ? {} : await import('../gateway/identity.mjs');

createServer((req, res) => {
  if (!standalone) {
    const sign = (email, project) => signIdentity(email, req.method, req.url, gatewayKey, 'sr-local-plan-navigator', Date.now(),
      project ? { project: { key: 'local-plan-navigator', access: project } } : undefined);
    req.headers['x-local-plan-navigator-identity'] = as === 'share' ? sign(null, 'share') : as === 'none' ? sign(null, 'none') : sign(ownerEmail, 'owner');
  }
  Promise.resolve(app(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  });
}).listen(port, host, () => console.log(`Local Plan Navigator preview (${as}) on ${siteOrigin}/projects/local-plan-navigator/${standalone ? ` — admin passphrase "${passphrase}"` : ''}`));
