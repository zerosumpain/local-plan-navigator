// server/admin.mjs — the owner's admin API: which model connection answers.
//
//   GET  …/admin/settings   the connections (secrets as hints), the kinds, recent calls
//   PUT  …/admin/settings   save the connections and which one is in use
//   POST …/admin/test       send one short prompt through a connection as the form has it
//   GET  …/admin/models     the models a Codex or OpenAI-compatible endpoint offers
//
// Owner only: app.mjs answers 404 to anyone else before it gets here, exactly as
// it does for a page the visitor may not see. Every write must come from a page
// this server sent (the Origin check) and be JSON.
import { KINDS, cleanConnection, cleanSettings, connectionProblems, redact } from './settings.mjs';
import { buildRequest, modelName } from './llm.mjs';

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify(value));
};

async function readBody(req, limit = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createAdmin({ settings, llm, siteOrigin, fetchImpl = fetch }) {
  return async function admin(req, res, sub) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers.origin && req.headers.origin !== siteOrigin) return json(res, 403, { message: 'Changes are only taken from pages this server sent.' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { message: 'Send JSON.' });
    }

    if (sub === '/settings' && req.method === 'GET') {
      return json(res, 200, {
        settings: redact(await settings.read()),
        kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, secrets: v.secrets }])),
        recent: llm.recent().slice(0, 50),
        stored: Boolean(settings.path),
      });
    }

    if (sub === '/settings' && req.method === 'PUT') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { message: 'The settings could not be read.' }); }
      const { errors, settings: next } = cleanSettings(body, await settings.read());
      if (errors.length) return json(res, 422, { message: 'Check the settings.', errors });
      try { return json(res, 200, { settings: redact(await settings.save(next)) }); }
      catch (err) { return json(res, 503, { message: err.message }); }
    }

    if (sub === '/test' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { message: 'The connection could not be read.' }); }
      const errors = [];
      const stored = (await settings.read()).connections.find((c) => c.id === body?.connection?.id);
      const connection = cleanConnection(body?.connection, stored, errors);
      if (!connection || errors.length) return json(res, 422, { ok: false, message: errors.join('; ') || 'Check the connection.' });
      const problems = connectionProblems(connection);
      if (problems.length) return json(res, 422, { ok: false, message: `It cannot answer yet: ${problems.join(', ')}.` });
      const started = Date.now();
      try {
        const reply = await llm.complete({
          feature: 'admin-test', connection,
          system: 'You are a connection test. Follow the instruction exactly.',
          user: 'Reply with exactly these words and nothing else: The connection works.',
          maxTokens: 20, temperature: 0, timeoutMs: 30_000,
        });
        return json(res, 200, { ok: true, ms: Date.now() - started, model: modelName(connection), reply: reply.trim().slice(0, 200) });
      } catch (err) {
        return json(res, 200, { ok: false, ms: Date.now() - started, model: modelName(connection), message: String(err?.message ?? err).slice(0, 300) });
      }
    }

    if (sub === '/models' && req.method === 'GET') {
      const id = new URL(req.url, 'http://localhost').searchParams.get('connection');
      const c = (await settings.read()).connections.find((x) => x.id === id);
      if (!c) return json(res, 404, { message: 'No such connection.' });
      if (c.kind === 'azure') return json(res, 200, { models: [], note: 'Azure deployments are named by whoever set up the gateway; type the deployment name.' });
      try {
        // The same headers a chat call would send, against the models list.
        const { headers } = await buildRequest(c, { system: '', user: '', maxTokens: 1, temperature: 0, stream: false }, async () => '');
        const base = c.baseUrl.replace(/\/+$/, '');
        const url = c.kind === 'codex' ? `${base}/v1/models` : `${base}/models`;
        const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return json(res, 200, { models: [], note: `The endpoint answered ${response.status}.` });
        const list = (await response.json())?.data ?? [];
        return json(res, 200, { models: list.map((m) => String(m.id)).filter(Boolean).slice(0, 100) });
      } catch (err) {
        return json(res, 200, { models: [], note: `The list could not be fetched: ${err.message}` });
      }
    }

    return json(res, 404, { message: 'Not found' });
  };
}
