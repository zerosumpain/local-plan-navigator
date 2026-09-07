// Convert the saved gov.uk content-API bodies to Markdown for reading and for the corpus.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const TurndownService = require('../govuk-probe/node_modules/turndown/lib/turndown.cjs.js');
const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
// Keep tables as pipe tables (simple version)
td.addRule('table', {
  filter: 'table',
  replacement: (content, node) => {
    const rows = Array.from(node.querySelectorAll('tr')).map(tr => Array.from(tr.children).map(td => td.textContent.replace(/\s+/g,' ').trim()));
    if (!rows.length) return '';
    const head = rows[0]; const sep = head.map(()=>'---');
    return '\n\n' + [head, sep, ...rows.slice(1)].map(r => '| ' + r.join(' | ') + ' |').join('\n') + '\n\n';
  }
});
for (const f of fs.readdirSync('.').filter(f => f.endsWith('.json') && !f.startsWith('lp'))) {
  const n = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!n.details || !n.details.body) continue;
  const md = `---\ntitle: ${n.title}\nurl: https://www.gov.uk${n.base_path}\npublished: ${n.first_published_at}\nupdated: ${n.public_updated_at}\npublisher: ${(n.links.organisations||[]).map(o=>o.title).join('; ')}\n---\n\n` + td.turndown(n.details.body).replace(/ /g,' ');
  const out = f.replace(/\.json$/, '.md');
  fs.writeFileSync(out, md);
  console.log(out, md.length, 'chars');
}
