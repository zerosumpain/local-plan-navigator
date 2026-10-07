// server/settings.mjs — the model connections the admin page manages.
//
// One file, `settings.json`, in the service's state directory (a volume in
// production, so it survives a release). It holds a list of connections and
// which one is in use. Secrets — an API key, an Entra ID client secret — are
// encrypted at rest with AES-256-GCM under a key derived from
// LOCAL_PLAN_NAVIGATOR_SETTINGS_KEY (or, if that is unset, the gateway key), and
// they never leave this process: the admin API returns "set, ending …a1b2",
// not the value. Rotating the key that encrypts them means re-entering them.
//
// With no file at all, the service behaves as it always has: the site's Codex
// bridge (CODEX_BRIDGE_URL) on LOCAL_PLAN_NAVIGATOR_MODEL, default gpt-6-luna.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The kinds of connection, and the fields each one keeps. */
export const KINDS = {
  // The site's ChatGPT-subscription bridge: OpenAI chat format, no real key.
  codex: { label: 'Codex bridge (ChatGPT subscription)', fields: ['baseUrl', 'model'], secrets: [] },
  // Azure OpenAI behind Azure API Management — the shape of the MHCLG AI
  // Gateway — or Azure OpenAI / AI Foundry directly. `apiStyle` says how the
  // URL is formed; `auth` says how the request proves itself.
  azure: {
    label: 'Azure (MHCLG AI Gateway, API Management or Azure OpenAI)',
    fields: ['baseUrl', 'apiStyle', 'deployment', 'model', 'apiVersion', 'auth', 'keyHeader', 'tenantId', 'clientId', 'scope'],
    secrets: ['apiKey', 'clientSecret'],
  },
  // Anything that speaks the OpenAI chat-completions API (LiteLLM, vLLM, …).
  openai: { label: 'Other OpenAI-compatible endpoint', fields: ['baseUrl', 'model'], secrets: ['apiKey'] },
};

const API_STYLES = ['azure-openai', 'openai'];
const AUTHS = ['subscription-key', 'api-key', 'entra-id'];
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_CONNECTIONS = 12;

/** The connection the service starts with, before anyone has saved settings. */
export function defaultSettings(env = process.env) {
  return {
    version: 1,
    active: 'codex',
    connections: [{
      id: 'codex',
      label: 'Codex (demo)',
      kind: 'codex',
      baseUrl: env.CODEX_BRIDGE_URL ?? 'http://127.0.0.1:5207',
      model: env.LOCAL_PLAN_NAVIGATOR_MODEL ?? 'gpt-6-luna',
    }, {
      id: 'mhclg-ai-gateway',
      label: 'MHCLG AI Gateway',
      kind: 'azure',
      baseUrl: '',
      apiStyle: 'azure-openai',
      deployment: '',
      model: '',
      apiVersion: '2024-10-21',
      auth: 'subscription-key',
      keyHeader: 'Ocp-Apim-Subscription-Key',
      tenantId: '',
      clientId: '',
      scope: 'https://cognitiveservices.azure.com/.default',
    }],
  };
}

const text = (value, max = 300) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function httpUrl(value, field, errors) {
  const v = text(value, 500);
  if (!v) return '';
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    if (u.username || u.password) { errors.push(`${field}: put credentials in the key field, not the address`); return ''; }
    return v.replace(/\/+$/, '');
  } catch {
    errors.push(`${field}: enter a full address starting https://`);
    return '';
  }
}

/**
 * Check one connection as the admin page sent it and return the clean copy.
 * `previous` supplies the stored secrets a form leaves blank ("keep the key").
 */
export function cleanConnection(input, previous, errors) {
  const kind = KINDS[input?.kind] ? input.kind : null;
  const id = text(input?.id, 40).toLowerCase();
  const where = `Connection "${text(input?.label, 60) || id || '?'}"`;
  if (!kind) { errors.push(`${where}: choose a type`); return null; }
  if (!ID.test(id)) { errors.push(`${where}: the id must be lowercase letters, numbers and hyphens`); return null; }
  const out = { id, label: text(input.label, 60) || id, kind };
  out.baseUrl = httpUrl(input.baseUrl, `${where} address`, errors);
  out.model = text(input.model, 120);
  if (kind === 'azure') {
    out.apiStyle = API_STYLES.includes(input.apiStyle) ? input.apiStyle : 'azure-openai';
    out.deployment = text(input.deployment, 120);
    out.apiVersion = text(input.apiVersion, 40) || '2024-10-21';
    out.auth = AUTHS.includes(input.auth) ? input.auth : 'subscription-key';
    out.keyHeader = text(input.keyHeader, 80) || (out.auth === 'api-key' ? 'api-key' : 'Ocp-Apim-Subscription-Key');
    if (!/^[A-Za-z0-9-]+$/.test(out.keyHeader)) errors.push(`${where}: the key header can only contain letters, numbers and hyphens`);
    out.tenantId = text(input.tenantId, 80);
    out.clientId = text(input.clientId, 80);
    out.scope = text(input.scope, 200) || 'https://cognitiveservices.azure.com/.default';
  }
  for (const name of KINDS[kind].secrets) {
    const supplied = typeof input[name] === 'string' ? input[name].trim() : '';
    if (input[`${name}Clear`] === true) continue;
    if (supplied) out[name] = supplied.slice(0, 2000);
    else if (previous?.kind === kind && previous[name]) out[name] = previous[name];
  }
  return out;
}

/** What a connection still needs before it can answer, in plain words. */
export function connectionProblems(c) {
  const problems = [];
  if (!c.baseUrl) problems.push('it has no address');
  if (c.kind === 'azure') {
    if (c.apiStyle === 'azure-openai' && !c.deployment) problems.push('it has no deployment name');
    if (c.apiStyle === 'openai' && !c.model) problems.push('it has no model name');
    if (c.auth === 'entra-id') {
      if (!c.tenantId || !c.clientId) problems.push('Entra ID needs a tenant and client id');
      if (!c.clientSecret) problems.push('Entra ID needs a client secret');
    } else if (!c.apiKey) problems.push('it has no key');
  } else if (!c.model) problems.push('it has no model name');
  return problems;
}

/** The settings as the admin page may see them: secrets replaced by a hint. */
export function redact(settings) {
  return {
    ...settings,
    connections: settings.connections.map((c) => {
      const out = { ...c };
      for (const name of KINDS[c.kind].secrets) {
        delete out[name];
        out[`${name}Hint`] = c[name] ? `set, ending …${c[name].slice(-4)}` : '';
      }
      out.problems = connectionProblems(c);
      return out;
    }),
  };
}

/** Validate a whole settings document from the admin page. */
export function cleanSettings(input, previous) {
  const errors = [];
  const list = Array.isArray(input?.connections) ? input.connections.slice(0, MAX_CONNECTIONS) : [];
  const connections = [];
  for (const raw of list) {
    const before = previous.connections.find((c) => c.id === raw?.id);
    const c = cleanConnection(raw, before, errors);
    if (!c) continue;
    if (connections.some((x) => x.id === c.id)) { errors.push(`Two connections are called "${c.id}"`); continue; }
    connections.push(c);
  }
  if (!connections.length) errors.push('Keep at least one connection');
  const active = connections.find((c) => c.id === input?.active);
  if (!active) errors.push('Choose which connection to use');
  else {
    const problems = connectionProblems(active);
    if (problems.length) errors.push(`The connection in use cannot answer yet: ${problems.join(', ')}`);
  }
  return { errors, settings: { version: 1, active: active?.id ?? previous.active, connections } };
}

// --- encryption at rest ---------------------------------------------------

function cipherKey(secret) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), 'local-plan-navigator settings v1', 32));
}

function seal(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function open(sealed, key) {
  const [v, iv, body, tag] = String(sealed).split('.');
  if (v !== 'v1' || !iv || !body || !tag) throw new Error('unreadable secret');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * The store. `read()` is cached by file content so every model call does not
 * re-parse; `save()` writes a temp file and renames it, so two web slots sharing
 * the volume never read half a file.
 */
export function createSettingsStore({ dir, secret, env = process.env, log = console }) {
  if (!secret || secret.length < 32) throw new Error('A 32+ character settings key is required');
  const key = cipherKey(secret);
  const path = dir ? join(dir, 'settings.json') : null;
  let cache = { raw: null, value: defaultSettings(env) };

  async function read() {
    if (!path) return cache.value;
    let raw;
    try { raw = await readFile(path, 'utf8'); } catch { return defaultSettings(env); }
    if (raw === cache.raw) return cache.value;
    try {
      const stored = JSON.parse(raw);
      const connections = stored.connections.map((c) => {
        const out = { ...c };
        for (const name of KINDS[c.kind]?.secrets ?? []) {
          if (!c[name]) continue;
          try { out[name] = open(c[name], key); }
          catch { delete out[name]; log.warn?.(`[settings] ${c.id}.${name} could not be decrypted — re-enter it on the admin page`); }
        }
        return out;
      });
      cache = { raw, value: { version: 1, active: stored.active, connections } };
    } catch (err) {
      log.warn?.(`[settings] ${path} is unreadable (${err.message}); using the defaults`);
      cache = { raw, value: defaultSettings(env) };
    }
    return cache.value;
  }

  async function save(settings) {
    if (!path) throw new Error('This server has no state directory, so settings cannot be saved');
    const stored = {
      version: 1,
      active: settings.active,
      updatedAt: new Date().toISOString(),
      connections: settings.connections.map((c) => {
        const out = { ...c };
        for (const name of KINDS[c.kind].secrets) if (c[name]) out[name] = seal(c[name], key);
        return out;
      }),
    };
    await mkdir(dir, { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
    cache = { raw: null, value: defaultSettings(env) };
    return read();
  }

  async function active() {
    const settings = await read();
    return settings.connections.find((c) => c.id === settings.active) ?? defaultSettings(env).connections[0];
  }

  return { read, save, active, path };
}
