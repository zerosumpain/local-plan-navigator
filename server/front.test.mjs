import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createFront, forwardHeaders } from './front.mjs';

let dir;
let front;
let base;
const slots = {};
const seen = [];

function slot(name, body) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ slot: name, url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'text/plain', 'x-slot': name });
    res.end(body);
  }).listen(0, '127.0.0.1');
  return server;
}

const route = (active, previous) => writeFile(join(dir, 'routing.json'), JSON.stringify({ active, previous }));
// fetch() will not send a chosen Host header, and the Host is the point here.
const call = (path, init = {}) => new Promise((resolve, reject) => {
  const url = new URL(`${base}${path}`);
  const req = request({ hostname: url.hostname, port: url.port, path, method: init.method ?? 'GET',
    headers: { host: 'strangeramblings.com', ...(init.headers ?? {}) } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      resolve({ status: res.statusCode, headers: { get: (n) => res.headers[n.toLowerCase()] ?? null }, text: async () => text, json: async () => JSON.parse(text) });
    });
  });
  req.on('error', reject);
  req.end(init.body);
});

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lpn-front-'));
  slots.primary = slot('primary', 'from primary');
  slots.candidate = slot('candidate', 'from candidate');
  await Promise.all(Object.values(slots).map((s) => new Promise((resolve) => s.once('listening', resolve))));
  await route('primary', 'candidate');
  front = createServer(createFront({
    port: 0, host: '127.0.0.1', canonicalHost: 'strangeramblings.com', wwwHost: 'www.strangeramblings.com',
    paths: ['/projects/local-plan-navigator', '/api/projects/local-plan-navigator'],
    slots: { primary: slots.primary.address().port, candidate: slots.candidate.address().port },
    slotHost: '127.0.0.1', routingFile: join(dir, 'routing.json'), name: 'local-plan-navigator', proto: 'https',
  })).listen(0, '127.0.0.1');
  await new Promise((resolve) => front.once('listening', resolve));
  base = `http://127.0.0.1:${front.address().port}`;
});

after(async () => {
  await Promise.all([front, ...Object.values(slots)].map((s) => new Promise((resolve) => s.close(resolve))));
  await rm(dir, { recursive: true, force: true });
});

test('it serves the active slot, and follows routing.json the moment it changes', async () => {
  assert.equal(await (await call('/projects/local-plan-navigator/')).text(), 'from primary');
  await route('candidate', 'primary');
  assert.equal(await (await call('/projects/local-plan-navigator/')).text(), 'from candidate');
  const health = await (await call('/__gateway/health')).json();
  assert.deepEqual(health, { app: 'local-plan-navigator', active: 'candidate', previous: 'primary' });
  await route('primary', 'candidate');
});

test('it answers only for the navigator, on the canonical host', async () => {
  assert.equal((await call('/projects/other/')).status, 404);
  assert.equal((await call('/projects/local-plan-navigatorx')).status, 404);
  assert.equal((await call('/projects/local-plan-navigator/', { headers: { host: 'evil.example' } })).status, 400);
  const www = await call('/projects/local-plan-navigator/?share=x', { headers: { host: 'www.strangeramblings.com' } });
  assert.equal(www.status, 308);
  assert.equal(www.headers.get('location'), 'https://strangeramblings.com/projects/local-plan-navigator/?share=x');
});

test('the client address comes from Cloudflare, never from the caller', async () => {
  seen.length = 0;
  await call('/api/projects/local-plan-navigator/ask', {
    method: 'POST', body: '{"q":1}',
    headers: { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '10.0.0.1', 'x-forwarded-proto': 'http', 'x-local-plan-navigator-identity': 'forged' },
  });
  const got = seen.at(-1);
  assert.equal(got.method, 'POST');
  assert.equal(got.body, '{"q":1}');
  assert.equal(got.headers['x-forwarded-for'], '203.0.113.5');
  assert.equal(got.headers['x-forwarded-proto'], 'https');
  assert.equal(got.headers['x-local-plan-navigator-identity'], undefined);
  assert.deepEqual(forwardHeaders({ forwarded: 'for=1.2.3.4', 'x-forwarded-host': 'x' }, '127.0.0.9'), { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.9' });
});

test('a page request falls back to the previous slot if the active one is down; an upload does not', async () => {
  await new Promise((resolve) => slots.primary.close(resolve));
  try {
    const page = await call('/projects/local-plan-navigator/');
    assert.equal(await page.text(), 'from candidate');
    const upload = await call('/api/projects/local-plan-navigator/check', { method: 'POST', body: 'document' });
    assert.equal(upload.status, 502);
  } finally {
    slots.primary = slot('primary', 'from primary');
    await new Promise((resolve) => slots.primary.once('listening', resolve));
  }
});
