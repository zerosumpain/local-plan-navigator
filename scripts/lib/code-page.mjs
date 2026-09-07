// scripts/lib/code-page.mjs — the /code/ page and the download.
//
// Gathers every source file of the prototype (the same set that is committed:
// templates, data, styles, client code, build, scripts, tests, docs), renders
// each with light syntax colouring for the page, and zips the lot with fflate
// so the whole repository can be downloaded and rebuilt. The government texts
// are included in the zip so a rebuild needs no network.
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const INCLUDE_DIRS = ['src', 'scripts', 'content', 'tests', 'docs', 'public'];
const INCLUDE_FILES = ['build.mjs', 'package.json', 'README.md', 'LICENCE.md', '.gitignore'];
const SHOW_ON_PAGE = (p) => !p.startsWith('content/sources/') && !p.startsWith('public/') && !p.endsWith('.png');

// The dependencies, with why each is here. Kept by hand so the page can say
// something more useful than a version number.
export const DEPENDENCIES = [
  { name: 'govuk-frontend', version: '6.5.0', licence: 'MIT (crown, crest and typeface not used)', purpose: 'The GOV.UK Design System: components, macros, styles and behaviour.' },
  { name: 'nunjucks', version: '3.2.4', licence: 'BSD-2-Clause', purpose: 'Templating, as used by the GOV.UK Prototype Kit; renders every page at build time.', dev: true },
  { name: 'sass', version: '1.92.1', licence: 'MIT', purpose: 'Compiles GOV.UK Frontend with the settings this deployment needs.', dev: true },
  { name: 'esbuild', version: '0.28.2', licence: 'MIT', purpose: 'Bundles the client TypeScript, code-split so the model engines only load on demand.', dev: true },
  { name: 'marked', version: '18.0.11', licence: 'MIT', purpose: 'Renders the Markdown of the government texts with GOV.UK classes.', dev: true },
  { name: 'fflate', version: '0.8.3', licence: 'MIT', purpose: 'Makes the zip on this page.', dev: true },
  { name: 'turndown', version: '7.2.4', licence: 'MIT', purpose: 'Converts GOV.UK content-API HTML to Markdown in the fetch-sources script.', dev: true },
  { name: 'axe-core', version: '4.13.0', licence: 'MPL-2.0', purpose: 'Accessibility checks in the smoke test.', dev: true },
  { name: 'minisearch', version: '7.2.0', licence: 'MIT', purpose: 'Full-text search over the corpus, in the browser.' },
  { name: '@mlc-ai/web-llm', version: '0.2.84', licence: 'Apache-2.0', purpose: 'Runs a language model on WebGPU inside the browser (the Ask page, opt-in).' },
  { name: '@huggingface/transformers', version: '4.2.0', licence: 'Apache-2.0', purpose: 'Runs a small language model on WebAssembly where there is no WebGPU (the Ask page, opt-in).' },
];

async function* walk(dir, rel = '') {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(p, r); else yield r;
  }
}

export async function buildCodePage({ root, dist }) {
  const paths = [];
  for (const d of INCLUDE_DIRS) { try { for await (const r of walk(path.join(root, d), d)) paths.push(r); } catch { /* absent dir */ } }
  for (const f of INCLUDE_FILES) { try { await stat(path.join(root, f)); paths.push(f); } catch { /* absent */ } }
  const files = [];
  const zipEntries = {};
  let totalLines = 0;
  for (const p of paths) {
    const buf = await readFile(path.join(root, p));
    zipEntries[`local-plan-navigator/${p}`] = new Uint8Array(buf);
    if (!SHOW_ON_PAGE(p)) continue;
    const text = buf.toString('utf8');
    const lines = text.split('\n').length;
    totalLines += lines;
    files.push({ path: p, lines, summary: summarise(text, p), html: highlight(text, p) });
  }
  // A worked note on where the sources come from, for the zip reader.
  zipEntries['local-plan-navigator/content/sources/README.md'] = strToU8('The files in this folder are Crown copyright, reproduced under the Open Government Licence v3.0. See LICENCE.md and /sources/ on the site for the fetch dates. `npm run fetch-sources` refreshes them.\n');
  const zip = zipSync(zipEntries, { level: 6 });
  await mkdir(path.join(dist, 'download'), { recursive: true });
  await writeFile(path.join(dist, 'download/local-plan-navigator-source.zip'), zip);
  return { files, totalLines, zipBytes: zip.length, dependencies: DEPENDENCIES };
}

/** The first comment block of a file, flattened to a sentence or two. */
function summarise(text, p) {
  const ext = path.extname(p);
  let m;
  if (ext === '.njk') m = text.match(/\{#\s*([\s\S]*?)#\}/);
  else if (['.ts', '.mjs', '.js', '.scss'].includes(ext)) m = text.match(/^(?:\/\/[^\n]*\n)+/);
  else if (ext === '.json') return p.startsWith('content/') ? 'Content data; see the description in scripts/site-map.mjs.' : 'Package manifest.';
  else if (ext === '.md') return text.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 200) ?? '';
  if (!m) return '';
  return m[0].replace(/\{#|#\}|^\/\/ ?/gm, '').replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/).slice(0, 2).join(' ').slice(0, 260);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const KEYWORDS = /\b(import|export|from|const|let|var|function|return|if|else|for|of|in|while|await|async|new|class|extends|interface|type|throw|try|catch|finally|switch|case|break|continue|default|typeof|instanceof|void|null|undefined|true|false)\b/g;

/** Light, safe syntax colouring: comments, strings, keywords and tags. Everything else is plain. */
function highlight(text, p) {
  const ext = path.extname(p);
  const out = [];
  if (ext === '.njk' || ext === '.html' || ext === '.svg') {
    // Nunjucks comments, then tags/vars, then HTML tags.
    return esc(text)
      .replace(/\{#[\s\S]*?#\}/g, (m) => `<span class="c">${m}</span>`)
      .replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, (m) => `<span class="k">${m}</span>`)
      .replace(/&lt;\/?[a-zA-Z][^&]*?&gt;/g, (m) => `<span class="t">${m}</span>`);
  }
  if (ext === '.scss' || ext === '.css') {
    return esc(text).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => `<span class="c">${m}</span>`).replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => `<span class="s">${m}</span>`);
  }
  if (ext === '.json') {
    return esc(text).replace(/"(?:\\.|[^"\\])*"(?=\s*:)/g, (m) => `<span class="k">${m}</span>`).replace(/:\s*"(?:\\.|[^"\\])*"/g, (m) => m.replace(/"(?:\\.|[^"\\])*"/, (s) => `<span class="s">${s}</span>`));
  }
  if (ext === '.md') return esc(text).replace(/^#.*$/gm, (m) => `<span class="k">${m}</span>`);
  // JavaScript / TypeScript: tokenise so strings and comments are not mangled by later passes.
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    out.push(esc(text.slice(last, m.index)).replace(KEYWORDS, '<span class="k">$1</span>'));
    if (m[1]) out.push(`<span class="c">${esc(m[1])}</span>`); else out.push(`<span class="s">${esc(m[2])}</span>`);
    last = m.index + m[0].length;
  }
  out.push(esc(text.slice(last)).replace(KEYWORDS, '<span class="k">$1</span>'));
  return out.join('');
}
