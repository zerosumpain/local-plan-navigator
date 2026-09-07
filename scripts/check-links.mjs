// scripts/check-links.mjs — every internal link and anchor in dist/ must resolve.
//
// Walks every HTML file, collects href/src values that are not external, and
// checks that the target file exists and, where there is a fragment, that an
// element with that id exists in the target page. Run by `npm test`.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith('.html')) yield p;
  }
}

const ids = new Map(); // file -> Set of ids
async function idsOf(file) {
  if (!ids.has(file)) {
    const html = await readFile(file, 'utf8');
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return ids.get(file);
}

let checked = 0; const broken = [];
for await (const file of walk(root)) {
  // Code shown on the page is text, not links.
  const html = (await readFile(file, 'utf8')).replace(/<pre[\s\S]*?<\/pre>/g, '');
  const dir = path.dirname(file);
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = m[1];
    if (/^(https?:|mailto:|data:|javascript:|#$)/.test(raw)) continue;
    const [pathPart, frag] = raw.split('#');
    let target = pathPart ? path.resolve(dir, pathPart) : file;
    if (pathPart) {
      const s = await stat(target).catch(() => null);
      if (s?.isDirectory()) target = path.join(target, 'index.html');
      else if (!s && !path.extname(target)) target = path.join(target, 'index.html');
      const ok = await stat(target).catch(() => null);
      if (!ok) { broken.push(`${path.relative(root, file)} -> ${raw} (missing)`); continue; }
    }
    if (frag && target.endsWith('.html')) {
      const set = await idsOf(target);
      if (!set.has(frag)) broken.push(`${path.relative(root, file)} -> ${raw} (no id "${frag}")`);
    }
    checked++;
  }
}
console.log(`checked ${checked} links; ${broken.length} broken`);
for (const b of broken.slice(0, 60)) console.log('  ' + b);
if (broken.length > 60) console.log(`  … and ${broken.length - 60} more`);
process.exit(broken.length ? 1 : 0);
