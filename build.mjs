// build.mjs — the whole build, in the order it happens.
//
//   1. clean         dist/ is deleted and recreated
//   2. corpus        the government texts are chunked into a search corpus and
//                    rendered as reference pages with an anchor per chunk
//   3. pages         every page in the site map is rendered from its Nunjucks
//                    template with the GOV.UK Frontend macros
//   4. styles        app.scss (GOV.UK Frontend + the prototype layer) -> app.css
//   5. scripts       the client TypeScript -> ES modules, code-split so the two
//                    model engines only load on the Ask page
//   6. static        public/ and the ONNX runtime's wasm files are copied in
//   7. code page     the source files are rendered for /code/ and zipped for download
//
// Run `node build.mjs`. Nothing here needs a network connection; the sources
// are committed, and `npm run fetch-sources` is the separate, deliberate step
// that refreshes them from GOV.UK and legislation.gov.uk.
import { rm, mkdir, cp, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as sass from 'sass';
import esbuild from 'esbuild';
import { buildCorpus } from './scripts/build-corpus.mjs';
import { renderPages } from './scripts/render-pages.mjs';
import { buildCodePage } from './scripts/lib/code-page.mjs';

const root = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(root, 'dist');
const started = Date.now();
const log = (step, detail = '') => console.log(`${String(Date.now() - started).padStart(5)}ms  ${step.padEnd(9)} ${detail}`);

// 1. clean
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'assets'), { recursive: true });
await mkdir(path.join(dist, 'data'), { recursive: true });
log('clean');

// 2. corpus — returns the chunks (for the pages that cite them) and writes
//    dist/data/corpus.json for the search and ask pages.
const corpus = await buildCorpus({ root, dist });
log('corpus', `${corpus.chunks.length} chunks from ${corpus.sources.length} sources`);

// 7a. code page data — gathered before the pages render because /code/ is a page.
const code = await buildCodePage({ root, dist });
log('code', `${code.files.length} files, zip ${(code.zipBytes / 1024).toFixed(0)} KB`);

// 3. pages
const pages = await renderPages({ root, dist, corpus, code });
log('pages', `${pages.length} pages`);

// 4. styles
const css = sass.compile(path.join(root, 'src/styles/app.scss'), {
  loadPaths: [path.join(root, 'node_modules')],
  style: 'compressed',
  quietDeps: true,
  // GOV.UK Frontend still emits a few deprecation notices of its own; they are
  // theirs to fix and only noise here.
  silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'mixed-decls'],
});
await writeFile(path.join(dist, 'assets/app.css'), css.css);
log('styles', `${(css.css.length / 1024).toFixed(0)} KB`);

// 5. scripts
const result = await esbuild.build({
  entryPoints: {
    app: 'src/client/app.ts',
    'engine-webllm.worker': 'src/client/engines/webllm.worker.ts',
    'engine-transformers.worker': 'src/client/engines/transformers.worker.ts',
  },
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  sourcemap: true,
  target: ['es2022'],
  outdir: path.join(dist, 'assets'),
  chunkNames: 'chunks/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  metafile: true,
});
const outputs = Object.entries(result.metafile.outputs).filter(([f]) => f.endsWith('.js'));
log('scripts', outputs.map(([f, o]) => `${path.basename(f)} ${(o.bytes / 1024).toFixed(0)}KB`).join(', '));

// 6. static
await cp(path.join(root, 'public'), dist, { recursive: true });
// The ONNX runtime loads its WebAssembly from wherever it is told; the
// transformers.js worker points it at ./ort/ next to itself.
const ortSrc = path.join(root, 'node_modules/onnxruntime-web/dist');
await mkdir(path.join(dist, 'assets/ort'), { recursive: true });
for (const f of await readdir(ortSrc)) {
  if (/^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/.test(f)) await cp(path.join(ortSrc, f), path.join(dist, 'assets/ort', f));
}
log('static');

// A sitemap of every rendered route, for the smoke test and for humans.
await writeFile(path.join(dist, 'sitemap.json'), JSON.stringify(pages.map((p) => p.route), null, 2));
log('done', `dist/ ready in ${Date.now() - started}ms`);
