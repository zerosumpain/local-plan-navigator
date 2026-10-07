// tests/checker-http.test.mjs — the check and export endpoints, with a fake model.
//
// Through the real app (signed identity, routing) for the happy path, and
// through the handlers directly for the limits: file errors as JSON, a stream
// of progress then the report, origin checks, one check at a time per user,
// the hourly allowance, and the Word download.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { signIdentity } from '../gateway/identity.mjs';
import { createApp } from '../server/app.mjs';
import { CHECK_PATH, createCheckHandler, createExportHandler, EXPORT_PATH, parseMultipart } from '../server/checker/http.mjs';
import { builtCorpus, fakeComplete, root } from './checker-helpers.mjs';

const key = 'plan-checker-test-key-long-enough-123456789';
const owner = 'owner@example.test';
const origin = 'https://site.example';
let appServer;
let appBase;
let complete;
let plan;

const identity = (path, method = 'POST') => ({ 'x-local-plan-navigator-identity': signIdentity(owner, method, path, key, 'sr-local-plan-navigator') });

/** Collect the server-sent events of a response. */
async function events(res) {
  const text = await res.text();
  return text.split('\n\n').filter((f) => f.includes('data:')).map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data:')).slice(5)));
}

function serve(handler, ctx = {}) {
  const server = createServer((req, res) => { handler(req, res, { user: owner, siteOrigin: origin, ...ctx }).catch(() => res.end()); }).listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

before(async () => {
  const { dist } = await builtCorpus();
  plan = await readFile(`${root}content/samples/northwold-draft-local-plan.md`);
  complete = fakeComplete();
  // The app's own model client, stood in for: the checker must call whatever `complete` it is given.
  const llm = { complete: (req) => complete(req), stream: async () => '', recent: () => [], active: async () => ({}) };
  appServer = createServer(createApp({ distDir: dist, accessMode: 'sr-projects', ownerEmail: owner, gatewayKey: key, secret: key, siteOrigin: origin, llm })).listen(0, '127.0.0.1');
  await new Promise((resolve) => appServer.once('listening', resolve));
  appBase = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((resolve) => appServer.close(resolve)));

test('the app mounts the checker behind the signed identity, and a multipart upload streams progress then the report', async () => {
  assert.equal((await fetch(`${appBase}${CHECK_PATH}`, { method: 'POST' })).status, 401, 'no identity, no checker');
  const body = new FormData();
  body.append('plan', new Blob([plan]), 'northwold.md');
  const res = await fetch(`${appBase}${CHECK_PATH}`, { method: 'POST', body, headers: { ...identity(CHECK_PATH), Origin: origin } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const got = await events(res);
  assert.ok(got.filter((e) => e.type === 'progress').length >= 5);
  assert.equal(got.at(-1).type, 'report');
  const report = got.at(-1).report;
  assert.equal(report.document.name, 'northwold.md');
  assert.equal(report.summary.total, 42);
  assert.ok(complete.calls.length > 0, 'the app passed its complete function through');

  const exp = await fetch(`${appBase}${EXPORT_PATH}`, { method: 'POST', body: JSON.stringify({ report, format: 'docx' }), headers: { ...identity(EXPORT_PATH), 'content-type': 'application/json' } });
  assert.equal(exp.status, 200);
  assert.equal(exp.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(exp.headers.get('content-disposition'), 'attachment; filename="draft-gateway-statements-northwold.docx"');
  const xml = strFromU8(unzipSync(new Uint8Array(await exp.arrayBuffer()))['word/document.xml']);
  assert.match(xml, /Heading1/);
  assert.match(xml, /Draft statement of compliance/);
  const md = await fetch(`${appBase}${EXPORT_PATH}`, { method: 'POST', body: JSON.stringify({ report, format: 'md', part: 'report' }), headers: identity(EXPORT_PATH) });
  assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.match(await md.text(), /^# Plan check: northwold\.md/);
});

test('a raw upload with its name in a header works too', async () => {
  const { server, url } = await serve(createCheckHandler({ complete: fakeComplete(), distDir: (await builtCorpus()).dist }));
  const res = await fetch(url, { method: 'POST', body: plan, headers: { 'x-file-name': encodeURIComponent('Northwold plan.md'), 'content-type': 'application/octet-stream' } });
  const got = await events(res);
  assert.equal(got.at(-1).report.document.name, 'Northwold plan.md');
  server.close();
});

test('files that cannot be checked get a 4xx with a message for the field, and no model call', async () => {
  const fake = fakeComplete();
  const { server, url } = await serve(createCheckHandler({ complete: fake, distDir: (await builtCorpus()).dist, documentLimits: { maxBytes: 64 * 1024 } }));
  const post = async (name, bytes, headers = {}) => {
    const body = new FormData();
    body.append('plan', new Blob([bytes]), name);
    const res = await fetch(url, { method: 'POST', body, headers });
    return { status: res.status, ...(await res.json()) };
  };
  let r = await post('plan.pdf', Buffer.from('%PDF'));
  assert.equal(r.status, 415);
  assert.match(r.message, /PDF files cannot be checked/);
  assert.equal(r.field, 'plan-file');
  r = await post('plan.md', Buffer.alloc(200 * 1024, 'a'));
  assert.equal(r.status, 413);
  assert.equal(r.message, 'The selected file must be smaller than 64KB');
  r = await post('plan.md', Buffer.from('short'));
  assert.equal(r.status, 400);
  assert.match(r.message, /too little text/);
  const none = await fetch(url, { method: 'POST', body: new FormData() });
  assert.equal(none.status, 400);
  assert.match((await none.json()).message, /Select a draft local plan to check/);
  r = await post('plan.md', plan, { Origin: 'https://attacker.example' });
  assert.equal(r.status, 403);
  assert.equal((await fetch(url)).status, 405);
  assert.equal(fake.calls.length, 0);
  server.close();
});

test('one check at a time per user, and a few an hour', async () => {
  const slow = fakeComplete({ delayMs: 40 });
  const { server, url } = await serve(createCheckHandler({ complete: slow, distDir: (await builtCorpus()).dist, limits: { checksPerHour: 2 } }));
  const go = () => fetch(url, { method: 'POST', body: plan, headers: { 'x-file-name': 'p.md' } });
  const first = go();
  await new Promise((r) => setTimeout(r, 30));
  const second = await go();
  assert.equal(second.status, 409);
  assert.match((await second.json()).message, /already running/);
  await (await first).text();
  await (await go()).text();
  const third = await go();
  assert.equal(third.status, 429);
  assert.match((await third.json()).message, /in the last hour/);
  server.close();
});

test('a model that fails still ends the stream with a report, every item accounted for', async () => {
  const { server, url } = await serve(createCheckHandler({ complete: fakeComplete({ invalid: 'always' }), distDir: (await builtCorpus()).dist }));
  const got = await events(await fetch(url, { method: 'POST', body: plan, headers: { 'x-file-name': 'p.md' } }));
  const report = got.at(-1).report;
  assert.equal(report.summary.total, 42);
  assert.ok(report.summary.counts['not-assessable'] > 20);
  server.close();
});

test('the export refuses a report that does not match the schema', async () => {
  const { server, url } = await serve(createExportHandler());
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ report: { schema: 'something else' }, format: 'docx' }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /could not be read/);
  assert.equal((await fetch(url, { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ report: {}, format: 'pdf' }) })).status, 400);
  server.close();
});

test('the multipart parser finds the file part and its name, including RFC 5987 names', () => {
  const b = 'XyZ';
  const body = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="other"\r\n\r\nvalue\r\n--${b}\r\nContent-Disposition: form-data; name="plan"; filename="x.md"; filename*=UTF-8''Pl%C3%A4n.md\r\nContent-Type: text/markdown\r\n\r\n# Plan\r\nbody\r\n--${b}--\r\n`);
  const got = parseMultipart(body, `multipart/form-data; boundary=${b}`);
  assert.equal(got.name, 'Plän.md');
  assert.equal(got.bytes.toString(), '# Plan\r\nbody');
  assert.throws(() => parseMultipart(body, 'multipart/form-data'), /could not be read/);
});
