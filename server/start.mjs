import { createServer } from 'node:http';
import { createApp } from './app.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5372);
const app = createApp();
createServer((req, res) => {
  Promise.resolve(app(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  });
}).listen(port, host, () => console.log(`Local Plan Navigator listening on ${host}:${port}`));
