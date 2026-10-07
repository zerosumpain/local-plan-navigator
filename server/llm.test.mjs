import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRequest, createLlm } from './llm.mjs';
import { cleanSettings, defaultSettings } from './settings.mjs';
import { proxyAccessFor } from './app.mjs';

const ask = { system: 'S', user: 'U', maxTokens: 50, temperature: 0, stream: true };
const noToken = async () => { throw new Error('no token expected'); };

test('Codex goes to the bridge in OpenAI form', async () => {
  const r = await buildRequest({ kind: 'codex', baseUrl: 'http://127.0.0.1:5207/', model: 'gpt-6-luna' }, ask, noToken);
  assert.equal(r.url, 'http://127.0.0.1:5207/v1/chat/completions');
  assert.equal(r.body.model, 'gpt-6-luna');
  assert.equal(r.headers.Authorization, 'Bearer codex-bridge-local');
});

test('an Azure deployment through API Management uses the deployment URL and a subscription key', async () => {
  const r = await buildRequest({
    kind: 'azure', baseUrl: 'https://apim.example.test/ai', apiStyle: 'azure-openai', deployment: 'gpt 4o',
    apiVersion: '2024-10-21', auth: 'subscription-key', keyHeader: 'Ocp-Apim-Subscription-Key', apiKey: 'k',
  }, ask, noToken);
  assert.equal(r.url, 'https://apim.example.test/ai/openai/deployments/gpt%204o/chat/completions?api-version=2024-10-21');
  assert.equal(r.headers['Ocp-Apim-Subscription-Key'], 'k');
  assert.equal(r.body.model, undefined);
  assert.equal(r.body.max_completion_tokens, 50);
  assert.equal(r.body.max_tokens, undefined);
});

test('the OpenAI style through a gateway names the model in the body', async () => {
  const r = await buildRequest({
    kind: 'azure', baseUrl: 'https://gw.example.test/v1', apiStyle: 'openai', model: 'claude-x', auth: 'api-key', keyHeader: 'api-key', apiKey: 'k',
  }, ask, noToken);
  assert.equal(r.url, 'https://gw.example.test/v1/chat/completions');
  assert.equal(r.body.model, 'claude-x');
  assert.equal(r.headers['api-key'], 'k');
});

test('Entra ID: a client-credentials token is fetched once and reused', async () => {
  let tokenCalls = 0;
  let lastAuth = '';
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://login.microsoftonline.com/tenant-1/')) {
      tokenCalls++;
      assert.match(String(init.body), /grant_type=client_credentials/);
      assert.match(String(init.body), /scope=https%3A%2F%2Fcognitiveservices.azure.com%2F.default/);
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } });
    }
    lastAuth = init.headers.Authorization;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'The connection works.' } }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const connection = {
    id: 'g', kind: 'azure', baseUrl: 'https://apim.example.test', apiStyle: 'azure-openai', deployment: 'd', apiVersion: 'v',
    auth: 'entra-id', tenantId: 'tenant-1', clientId: 'c', clientSecret: 's', scope: 'https://cognitiveservices.azure.com/.default',
  };
  const llm = createLlm({ settings: { active: async () => connection }, fetchImpl, retryDelayMs: 1 });
  assert.equal(await llm.complete({ system: 'S', user: 'U' }), 'The connection works.');
  assert.equal(await llm.complete({ system: 'S', user: 'U' }), 'The connection works.');
  assert.equal(tokenCalls, 1);
  assert.equal(lastAuth, 'Bearer tok');
});

test('a refusal that retrying cannot fix is reported at once, with what the service said', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ error: { message: 'Access denied due to invalid subscription key.' } }), { status: 401 }); };
  const llm = createLlm({ settings: { active: async () => ({ id: 'x', kind: 'openai', baseUrl: 'https://x.test', model: 'm' }) }, fetchImpl, retryDelayMs: 1 });
  await assert.rejects(llm.complete({ system: 'S', user: 'U' }), /401: Access denied due to invalid subscription key/);
  assert.equal(calls, 1);
  assert.equal(llm.recent()[0].ok, false);
});

test('settings refuse a connection in use that could not answer', () => {
  const previous = defaultSettings({});
  const { errors } = cleanSettings({ active: 'mhclg-ai-gateway', connections: previous.connections }, previous);
  assert.match(errors.join(' '), /cannot answer yet/);
  const ok = cleanSettings({ active: 'codex', connections: previous.connections }, previous);
  assert.deepEqual(ok.errors, []);
  const bad = cleanSettings({ active: 'codex', connections: [{ ...previous.connections[0], baseUrl: 'https://user:pw@x.test' }] }, previous);
  assert.match(bad.errors.join(' '), /credentials/);
});

test('behind a trusted proxy, its header names the person and ADMIN_EMAILS names the admins', () => {
  const admins = new Set(['lead@mhclg.example']);
  const req = (email) => ({ headers: email ? { 'x-ms-client-principal-name': email } : {} });
  assert.deepEqual(proxyAccessFor(req('Lead@MHCLG.example'), 'x-ms-client-principal-name', admins), { access: 'owner', email: 'lead@mhclg.example' });
  assert.deepEqual(proxyAccessFor(req('officer@council.example'), 'x-ms-client-principal-name', admins), { access: 'share', email: 'officer@council.example' });
  assert.deepEqual(proxyAccessFor(req(null), 'x-ms-client-principal-name', admins), { access: null, email: null });
});
