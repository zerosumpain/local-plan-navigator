// scripts/lib/markdown.mjs — Markdown -> HTML with GOV.UK classes.
//
// The content files are Markdown because that is what the government pages
// convert to cleanly. GOV.UK Frontend styles nothing without its classes, so
// the renderer adds them: govuk-body on paragraphs, govuk-list on lists, the
// heading scale on headings, govuk-table on tables and govuk-link on links.
import { marked } from 'marked';

const renderer = {
  heading({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const size = { 1: 'xl', 2: 'l', 3: 'm', 4: 's', 5: 's', 6: 's' }[depth] || 's';
    const id = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return `<h${depth} class="govuk-heading-${size}" id="${id}">${text}</h${depth}>\n`;
  },
  paragraph({ tokens }) {
    return `<p class="govuk-body">${this.parser.parseInline(tokens)}</p>\n`;
  },
  list(token) {
    const tag = token.ordered ? 'ol' : 'ul';
    const cls = token.ordered ? 'govuk-list govuk-list--number' : 'govuk-list govuk-list--bullet';
    const items = token.items.map((item) => `<li>${this.parser.parse(item.tokens, !!item.loose).replace(/<p class="govuk-body">|<\/p>\n?/g, '')}</li>`).join('\n');
    return `<${tag} class="${cls}">\n${items}\n</${tag}>\n`;
  },
  link({ href, tokens }) {
    const text = this.parser.parseInline(tokens);
    const external = /^https?:\/\//.test(href) ? ' rel="external"' : '';
    return `<a class="govuk-link" href="${href}"${external}>${text}</a>`;
  },
  table(token) {
    const head = token.header.map((c) => `<th scope="col" class="govuk-table__header">${this.parser.parseInline(c.tokens)}</th>`).join('');
    const rows = token.rows
      .map((r) => `<tr class="govuk-table__row">${r.map((c, i) => (i === 0 ? `<th scope="row" class="govuk-table__header">${this.parser.parseInline(c.tokens)}</th>` : `<td class="govuk-table__cell">${this.parser.parseInline(c.tokens)}</td>`)).join('')}</tr>`)
      .join('\n');
    return `<div class="lpn-table-scroll"><table class="govuk-table"><thead class="govuk-table__head"><tr class="govuk-table__row">${head}</tr></thead><tbody class="govuk-table__body">\n${rows}\n</tbody></table></div>\n`;
  },
  blockquote({ tokens }) {
    return `<div class="govuk-inset-text">${this.parser.parse(tokens)}</div>\n`;
  },
  hr() {
    return '<hr class="govuk-section-break govuk-section-break--l govuk-section-break--visible">\n';
  },
};

marked.use({ renderer, gfm: true });

export function markdownToHtml(md) {
  return marked.parse(md);
}
