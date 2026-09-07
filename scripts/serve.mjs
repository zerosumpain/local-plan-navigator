// scripts/serve.mjs — a tiny static server for local checks.
//
// Serves dist/ at the same sub-path production uses, so relative links and
// asset paths are exercised exactly as they will be live. Directory URLs get
// their index.html; nothing else is clever. Not for production.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const mount = process.env.MOUNT ?? '/projects/local-plan-navigator';
const port = Number(process.env.PORT ?? 5177);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.map': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith(mount)) { res.writeHead(302, { Location: mount + '/' }); return res.end(); }
  let rel = decodeURIComponent(url.pathname.slice(mount.length)) || '/';
  let file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    let s = await stat(file).catch(() => null);
    if (s?.isDirectory()) {
      if (!rel.endsWith('/')) { res.writeHead(301, { Location: mount + rel + '/' }); return res.end(); }
      file = path.join(file, 'index.html'); s = await stat(file);
    }
    if (!s) throw new Error('missing');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + rel);
  }
}).listen(port, () => console.log(`serving dist/ at http://localhost:${port}${mount}/`));
