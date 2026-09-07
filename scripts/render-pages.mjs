// scripts/render-pages.mjs — turns the site map into HTML.
//
// Every page is a Nunjucks template in src/pages/. The GOV.UK Frontend macros
// are on the loader path, so a template can `{% from "govuk/components/button/
// macro.njk" import govukButton %}` exactly as it would in the GOV.UK
// Prototype Kit. Pages that are generated from data (one per stage, gateway,
// checklist or question) share a template and get their data as `page`.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nunjucks from 'nunjucks';
import { siteMap } from './site-map.mjs';
import { markdownToHtml } from './lib/markdown.mjs';

export async function renderPages({ root, dist, corpus, code }) {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader([path.join(root, 'src'), path.join(root, 'node_modules/govuk-frontend/dist')]),
    { autoescape: true, throwOnUndefined: false, trimBlocks: true, lstripBlocks: true },
  );
  // Filters the templates lean on.
  env.addFilter('md', (s) => new nunjucks.runtime.SafeString(markdownToHtml(String(s ?? ''))));
  env.addFilter('date', (d) => formatDate(d));
  env.addFilter('json', (v) => JSON.stringify(v));
  env.addFilter('slug', (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''));

  const site = await siteMap({ root, corpus, code });
  const built = new Date().toISOString().slice(0, 10);
  for (const page of site.pages) {
    // Relative asset prefix so the bundle works at any mount point:
    // "/" -> "./", "/process/gateway-2/" -> "../../".
    const depth = page.route.split('/').filter(Boolean).length;
    const base = depth === 0 ? './' : '../'.repeat(depth);
    const nav = site.nav.map((item) => ({
      ...item,
      href: base + item.href,
      active: page.route === '/' + item.href || (item.href !== '' && page.route.startsWith('/' + item.href.replace(/\/$/, '') + '/')),
    }));
    // `rel('/process/')` -> base + 'process/': every internal link goes through
    // this so the bundle works wherever it is mounted.
    env.addGlobal('rel', (href) => (typeof href === 'string' && href.startsWith('/') ? base + href.slice(1) : href));
    const html = env.render(`pages/${page.template}.njk`, {
      ...page,
      site,
      nav,
      base,
      built,
      assetPath: base + 'assets',
      htmlLang: 'en',
      bodyAttributes: { 'data-page': page.id, 'data-route': page.route, 'data-base': base },
      corpusMeta: corpus.meta,
    });
    const file = path.join(dist, page.route, 'index.html');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, html);
  }
  return site.pages;
}

function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
