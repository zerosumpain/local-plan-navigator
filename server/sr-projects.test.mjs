// ACCESS_MODE=sr-projects: strangeramblings.com, where Main decides and the estate
// gateway signs. These sign what the gateway would.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { signIdentity } from '../gateway/identity.mjs';
import { createApp, MOUNT, API } from './app.mjs';
import { createSettingsStore } from './settings.mjs';

const key = 'local-plan-navigator-test-key-long-enough-1234';
const owner = 'owner@example.test';
const origin = 'https://strangeramblings.example';
let root;
let server;
let bridge;
let base;

const signed = (path, { method = 'GET', email = null, project = null, projectKey = 'local-plan-navigator' } = {}) => ({
  'x-local-plan-navigator-identity': signIdentity(email, method, path, key, 'sr-local-plan-navigator', Date.now(),
    project ? { project: { key: projectKey, access: project } } : undefined),
});
const get = (path, headers = {}) => fetch(`${base}${path}`, { headers, redirect: 'manual' });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'lpn-sr-'));
  for (const dir of ['data', 'admin', 'private', 'sign-in']) await mkdir(join(root, dir));
  await writeFile(join(root, 'index.html'), '<h1>Local Plan Navigator</h1>');
  await writeFile(join(root, 'admin/index.html'), '<h1>Administration</h1>');
  await writeFile(join(root, 'private/index.html'), '<h1>This prototype is private</h1>');
  await writeFile(join(root, 'sign-in/index.html'), '<h1>Sign in</h1>');
  await writeFile(join(root, 'data/corpus.json'), JSON.stringify({ chunks: [{
    id: 'reg-2026#r32', docTitle: 'Regulations', heading: 'Regulation 32', text: 'A gateway is required.',
    route: '/reference/regulations/', anchor: 'r32', kind: 'regulation',
  }] }));
  bridge = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"A gateway is required [1]."}}]}\n\ndata: [DONE]\n\n');
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => bridge.once('listening', resolve));
  const settings = createSettingsStore({ dir: null, secret: key, env: { CODEX_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}` } });
  server = createServer(createApp({
    distDir: root, accessMode: 'sr-projects', gatewayKey: key, ownerEmail: owner, secret: key, siteOrigin: origin, settings, retryDelayMs: 1,
  })).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await Promise.all([server, bridge].map((s) => new Promise((resolve) => s.close(resolve))));
  await rm(root, { recursive: true, force: true });
});

test('the owner, signed in to the site, sees everything including the admin page — no other password', async () => {
  assert.equal((await get(`${MOUNT}/`, signed(`${MOUNT}/`, { email: owner }))).status, 200);
  assert.equal((await get(`${MOUNT}/admin/`, signed(`${MOUNT}/admin/`, { email: owner }))).status, 200);
  // Main's owner decision is enough on its own (the site's owner, whatever OWNER_EMAIL says).
  assert.equal((await get(`${MOUNT}/admin/`, signed(`${MOUNT}/admin/`, { email: 'other@example.test', project: 'owner' }))).status, 200);
  const settings = await (await get(`${API}/admin/settings`, signed(`${API}/admin/settings`, { email: owner }))).json();
  assert.equal(settings.mode, 'sr-projects');
  assert.equal(settings.sharing.elsewhere, '/projects');
});

test('a /projects share link opens it without signing in, and keeps working page to page', async () => {
  const token = 'b'.repeat(43);
  const opened = await get(`${MOUNT}/?t=${token}`, { ...signed(`${MOUNT}/?t=${token}`, { project: 'share' }), 'x-forwarded-proto': 'https' });
  assert.equal(opened.status, 200);
  const cookies = opened.headers.getSetCookie();
  for (const path of [MOUNT, API]) {
    assert.ok(cookies.some((c) => c.startsWith(`psh_local-plan-navigator=${token}; Path=${path};`) && /HttpOnly/.test(c) && /Secure/.test(c)), path);
  }
  assert.equal((await get(`${MOUNT}/`, signed(`${MOUNT}/`, { project: 'share' }))).status, 200);
  // Not the admin page.
  assert.equal((await get(`${MOUNT}/admin/`, signed(`${MOUNT}/admin/`, { project: 'share' }))).status, 404);
  // They can ask.
  const asked = await fetch(`${base}${API}/ask`, {
    method: 'POST', headers: { ...signed(`${API}/ask`, { method: 'POST', project: 'share' }), 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.4' },
    body: JSON.stringify({ question: 'Is a gateway required?', ids: ['reg-2026#r32'] }),
  });
  assert.equal(asked.status, 200);
  assert.match(await asked.text(), /"type":"done"/);
  // A token that cannot be one is never echoed into a cookie.
  const odd = await get(`${MOUNT}/?t=x;Path=/`, signed(`${MOUNT}/?t=x;Path=/`, { project: 'share' }));
  assert.deepEqual(odd.headers.getSetCookie(), []);
});

test('a public project is open to all; anyone else is shown the private page', async () => {
  assert.equal((await get(`${MOUNT}/`, signed(`${MOUNT}/`, { project: 'public' }))).status, 200);
  for (const headers of [{}, signed(`${MOUNT}/`, { project: 'none' }), signed(`${MOUNT}/`, { project: 'share', projectKey: 'policy-engine' }), signed(`${MOUNT}/`, { email: 'someone@example.test' })]) {
    const page = await get(`${MOUNT}/`, headers);
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), `${MOUNT}/private/`);
  }
  assert.equal((await get(`${MOUNT}/private/`)).status, 200);
  assert.equal((await fetch(`${base}${API}/ask`, { method: 'POST', body: '{}' })).status, 401);
});

test('"Sign in" goes to the site\'s own login and comes back to the admin page; there is no passphrase', async () => {
  const signIn = await get(`${MOUNT}/sign-in/`);
  assert.equal(signIn.status, 303);
  assert.equal(signIn.headers.get('location'), `/login?callbackUrl=${encodeURIComponent(`${MOUNT}/admin/`)}`);
  assert.equal((await fetch(`${base}${API}/session`, { method: 'POST', body: '{"password":"x"}' })).status, 404);
});
