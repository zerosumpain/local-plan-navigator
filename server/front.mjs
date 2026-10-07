// server/front.mjs — the navigator's own front door, in front of its two web slots.
//
// It does the routing half of what the estate's shared gateway did, and nothing
// else: it asks no other service who the visitor is (the web process decides
// that itself — server/access.mjs), so the navigator keeps working whatever the
// rest of the site is doing.
//
//   - answers only for the navigator's two paths, on the canonical host
//     (www. is redirected to it; any other Host is refused)
//   - reads routing.json on every request (release.mjs replaces it atomically)
//     and proxies to the active slot, falling back to the previous one if the
//     active slot refuses the connection before answering
//   - strips every x-forwarded-* header a caller sent and restates the two the
//     app needs: the protocol, and the client address from cf-connecting-ip,
//     which Cloudflare overwrites on every request (the first hop of a caller's
//     own x-forwarded-for chain is whatever they wrote, so it is never trusted)
//   - /__gateway/health reports the active slot, which is how release.mjs proves
//     a switch took effect
//
// Configured by environment, not by a file inside a release directory, so it
// never depends on a release that retention may delete.
import http from 'node:http';
import { readFileSync } from 'node:fs';

export function frontConfig(env = process.env) {
  return {
    port: Number(env.FRONT_PORT ?? 5370),
    host: env.FRONT_HOST ?? '127.0.0.1',
    canonicalHost: env.CANONICAL_HOST ?? 'strangeramblings.com',
    wwwHost: env.WWW_HOST ?? `www.${env.CANONICAL_HOST ?? 'strangeramblings.com'}`,
    paths: (env.FRONT_PATHS ?? '/projects/local-plan-navigator,/api/projects/local-plan-navigator').split(',').map((p) => p.trim()).filter(Boolean),
    slots: { primary: Number(env.SLOT_PRIMARY ?? 5372), candidate: Number(env.SLOT_CANDIDATE ?? 5373) },
    slotHost: env.SLOT_HOST ?? '127.0.0.1',
    routingFile: env.ROUTING_FILE ?? '/etc/sr-local-plan-navigator/routing/routing.json',
    name: env.APP_NAME ?? 'local-plan-navigator',
    // What the visitor's browser is speaking. Cloudflare terminates TLS in
    // production, so https; a local preview over plain http says so, or the
    // app's Secure cookies would never come back.
    proto: env.FRONT_PROTO === 'http' ? 'http' : 'https',
  };
}

const owns = (config, path) => config.paths.some((p) => path === p || path.startsWith(`${p}/`));

/** The headers the slot gets: the caller's, minus anything that could claim to be from us. */
export function forwardHeaders(headers, socketAddress, proto = 'https') {
  const client = headers['cf-connecting-ip'] ?? socketAddress;
  const clean = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith('x-forwarded-') || name === 'forwarded' || name.startsWith('x-local-plan-navigator-')) continue;
    clean[name] = value;
  }
  clean['x-forwarded-proto'] = proto;
  if (client) clean['x-forwarded-for'] = client;
  return clean;
}

export function createFront(config = frontConfig()) {
  const readRouting = () => {
    const routing = JSON.parse(readFileSync(config.routingFile, 'utf8'));
    if (!Object.hasOwn(config.slots, routing.active)) throw new Error('Invalid active slot');
    return routing;
  };

  return function front(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const host = String(req.headers.host ?? '').toLowerCase();
    if (url.pathname === '/__gateway/health') {
      let routing;
      try { routing = readRouting(); } catch { res.writeHead(503); res.end('Routing unavailable'); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ app: config.name, active: routing.active, previous: routing.previous }));
      return;
    }
    if (!owns(config, url.pathname)) { res.writeHead(404); res.end('Not found'); return; }
    if (host === config.wwwHost) {
      res.writeHead(308, { location: `${config.proto}://${config.canonicalHost}${req.url}` });
      res.end();
      return;
    }
    if (host !== config.canonicalHost) { res.writeHead(400); res.end('Invalid host'); return; }

    let routing;
    try { routing = readRouting(); } catch { res.writeHead(503); res.end('Routing unavailable'); return; }
    const headers = forwardHeaders(req.headers, req.socket.remoteAddress, config.proto);

    const proxy = (slot, retry) => {
      const upstream = http.request(
        { hostname: config.slotHost, port: config.slots[slot], path: req.url, method: req.method, headers },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        // Only before anything has been sent, and only for a request whose body
        // has not been consumed: a page or asset fetch, never an upload or a question.
        const replayable = req.method === 'GET' || req.method === 'HEAD';
        if (retry && replayable && !res.headersSent && Object.hasOwn(config.slots, routing.previous ?? '')) {
          proxy(routing.previous, false);
          return;
        }
        if (!res.headersSent) { res.writeHead(502); res.end('The navigator is restarting. Try again in a moment.'); }
        else res.destroy(err);
      });
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
      if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
      else req.pipe(upstream);
    };
    proxy(routing.active, true);
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const config = frontConfig();
  http.createServer(createFront(config)).listen(config.port, config.host, () => {
    console.log(`Local Plan Navigator front on ${config.host}:${config.port} → slots ${JSON.stringify(config.slots)}`);
  });
}
