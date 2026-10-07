// Local browser preview only: the web process on its own, with a preview
// administrator passphrase (PREVIEW_ADMIN_PASSPHRASE, default below) so the
// sign-in, share links and admin page can be tried. Production runs
// server/start.mjs behind server/front.mjs.
import { createServer } from 'node:http';
import { hashPassword } from './access.mjs';
import { createApp } from './app.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5382);
const passphrase = process.env.PREVIEW_ADMIN_PASSPHRASE ?? 'local preview passphrase';
// The origin the browser will send, so the same-origin checks on writes pass.
const siteOrigin = process.env.ORIGIN ?? `http://${host}:${port}`;
const app = createApp({
  siteOrigin,
  secret: process.env.LOCAL_PLAN_NAVIGATOR_SECRET ?? 'local-preview-secret-only-2026-10-07-123456789',
  adminPasswordHash: hashPassword(passphrase),
});

createServer((req, res) => {
  Promise.resolve(app(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  });
}).listen(port, host, () => console.log(`Local Plan Navigator preview on ${siteOrigin}/projects/local-plan-navigator/ (admin passphrase: "${passphrase}")`));
