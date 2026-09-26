// Local browser preview only. Compose publishes this port to 127.0.0.1 and
// provides a synthetic owner identity; production starts server/start.mjs.
import { createServer } from 'node:http';
import { signIdentity } from '../gateway/identity.mjs';
import { createApp } from './app.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5382);
const ownerEmail = process.env.OWNER_EMAIL ?? 'local-owner@example.invalid';
const gatewayKey = process.env.LOCAL_PLAN_NAVIGATOR_GATEWAY_KEY ?? 'local-preview-key-only-2026-09-26-123456789';
const app = createApp({ ownerEmail, gatewayKey, siteOrigin: `http://127.0.0.1:${port}` });

createServer((req, res) => {
  req.headers['x-local-plan-navigator-identity'] = signIdentity(
    ownerEmail, req.method, req.url, gatewayKey, 'sr-local-plan-navigator',
  );
  Promise.resolve(app(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  });
}).listen(port, host, () => console.log(`Local Plan Navigator preview on ${host}:${port}`));
