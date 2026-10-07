// server/checker/export.mjs — a checked report as a Word document or as Markdown.
//
//   statementsDocx(report)  the draft statement of compliance and statement of
//                           soundness, in Word with heading styles and one
//                           editable table per entry, for officers to finish
//   statementsMarkdown(report), reportMarkdown(report, { siteUrl })
//                           the same statements, or the whole report, as text
//
// Callers validate the report against the schema first (reportProblems);
// everything here escapes what it writes, so a report edited in the browser
// can change the words but not the document's structure.
import { buildDocx } from './docx.mjs';

const LABEL = { met: 'Met', partly: 'Partly met', missing: 'Not met', 'not-assessable': 'Cannot assess' };
const STATUS_IN_DRAFT = { met: 'Met, on the plan as drafted', partly: 'Partly met: needs more work', missing: 'Not met: needs work', 'not-assessable': 'To be completed by the authority' };
const FOOTER = 'Machine-drafted starting point, not an assessment by the Planning Inspectorate. Check and complete every entry.';

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const evidenceLines = (evidence) => evidence.map((e) => `“${e.quote}” (${e.locator})`);
const orNone = (lines, none) => (lines.length ? lines.join('\n') : none);
/** A two-column table of labelled rows, the labels in bold, with no header row. */
const keyed = (rows) => ({ type: 'table', widths: [1, 3], header: [], rows: rows.map(([k, v]) => [[{ text: k, bold: true }], v]) });

/** A slug for download file names. */
export const fileSlug = (name) => String(name ?? 'plan').replace(/\.[A-Za-z0-9]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'plan';

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

export function statementsDocx(report) {
  const { compliance, soundness } = report.statements;
  const plan = report.document.name;
  const blocks = [
    { type: 'title', text: 'Draft statement of compliance and statement of soundness' },
    { type: 'para', runs: [{ text: 'Proposed local plan: ', bold: true }, { text: plan }] },
    { type: 'para', runs: [{ text: 'Drafted: ', bold: true }, { text: `${when(report.generatedAt)}, by the Local Plan Navigator plan checker (prototype), rubric ${report.rubricVersion}` }] },
    { type: 'para', style: 'Note', text: compliance.notice },
    { type: 'heading', level: 1, text: compliance.title },
    ...compliance.intro.map((text) => ({ type: 'para', text })),
  ];
  for (const part of compliance.parts) {
    blocks.push({ type: 'heading', level: 2, text: part.heading });
    for (const e of part.entries) {
      blocks.push({ type: 'heading', level: 3, text: `${e.ref && /^\d/.test(e.ref) ? `Regulation ${e.ref}: ` : ''}${e.title}` });
      blocks.push({ type: 'para', runs: [{ text: 'Requirement: ', bold: true }, { text: e.requirement }] });
      blocks.push(keyed([
        ['Status in this draft', STATUS_IN_DRAFT[e.status]],
        ['What the plan shows', e.shows],
        ['Where in the plan', orNone(evidenceLines(e.evidence), e.completeBy === 'authority' ? 'To be completed by the authority.' : 'Not found in the plan.')],
        ['Gaps', orNone(e.gaps, 'None found.')],
        ['Action', e.action || 'None.'],
      ]));
    }
  }
  blocks.push({ type: 'heading', level: 1, text: soundness.title });
  for (const text of soundness.intro) blocks.push({ type: 'para', text });
  for (const e of soundness.entries) {
    blocks.push({ type: 'heading', level: 2, text: `${e.title}${e.ref ? ` (NPPF ${e.ref})` : ''}` });
    blocks.push({ type: 'para', runs: [{ text: 'The test: ', bold: true }, { text: e.requirement }] });
    blocks.push(keyed([
      ['Status in this draft', STATUS_IN_DRAFT[e.status]],
      ['Evidence the plan shows', e.shows],
      ['Where in the plan', orNone(evidenceLines(e.evidence), 'Not found in the plan.')],
      ['Evidence documents the plan names', orNone(e.evidenceDocuments ?? [], 'None named for this test. Add the evidence documents that support it.')],
      ['Gaps', orNone(e.gaps, 'None found.')],
      ['Questions an inspector may ask', orNone(e.questions ?? [], 'None suggested.')],
      ['Action', e.action || 'None.'],
    ]));
  }
  blocks.push({ type: 'heading', level: 2, text: 'Evidence documents the plan names' });
  if (soundness.evidenceBase.length) blocks.push({ type: 'bullets', items: soundness.evidenceBase });
  else blocks.push({ type: 'para', text: 'The plan names no evidence documents. List the evidence base here.' });
  blocks.push({ type: 'heading', level: 1, text: 'How this draft was made' });
  blocks.push({ type: 'para', text: report.notice });
  blocks.push({ type: 'para', text: `The plan checker read "${plan}" (${report.document.words.toLocaleString('en-GB')} words) and checked it against ${report.summary.total} rubric items drawn from the Town and Country Planning (Local Planning) (England) Regulations 2026, the National Planning Policy Framework (August 2026) and government guidance. Each quote above was found word for word in the plan. A language model read the relevant parts of the plan for each item; counts, combined results and the layout of these statements were worked out in code.` });
  return buildDocx({ title: `Draft Gateway statements: ${plan}`, footer: FOOTER, blocks, created: report.generatedAt });
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Escape the few characters that would change Markdown structure inside a line. */
const md = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/([\\`*_[\]<>|])/g, '\\$1');
const quoteLines = (evidence) => evidence.map((e) => `> ${md(e.quote)}\n>\n> — ${md(e.locator)}`).join('\n\n');

export function statementsMarkdown(report) {
  const { compliance, soundness } = report.statements;
  const out = [
    '# Draft statement of compliance and statement of soundness',
    '',
    `**Proposed local plan:** ${md(report.document.name)}  `,
    `**Drafted:** ${when(report.generatedAt)}, by the Local Plan Navigator plan checker (prototype), rubric ${md(report.rubricVersion)}`,
    '',
    `> **Note.** ${md(compliance.notice)}`,
    '',
    `## ${compliance.title}`,
    '',
    ...compliance.intro.flatMap((t) => [md(t), '']),
  ];
  for (const part of compliance.parts) {
    out.push(`### ${md(part.heading)}`, '');
    for (const e of part.entries) {
      out.push(`#### ${e.ref && /^\d/.test(e.ref) ? `Regulation ${md(e.ref)}: ` : ''}${md(e.title)}`, '');
      out.push(`*Requirement:* ${md(e.requirement)}`, '');
      out.push(`- **Status in this draft:** ${STATUS_IN_DRAFT[e.status]}`);
      out.push(`- **What the plan shows:** ${md(e.shows)}`);
      out.push(`- **Gaps:** ${e.gaps.length ? e.gaps.map(md).join('; ') : 'None found.'}`);
      out.push(`- **Action:** ${md(e.action) || 'None.'}`, '');
      if (e.evidence.length) out.push('Where in the plan:', '', quoteLines(e.evidence), '');
    }
  }
  out.push(`## ${soundness.title}`, '', ...soundness.intro.flatMap((t) => [md(t), '']));
  for (const e of soundness.entries) {
    out.push(`### ${md(e.title)}${e.ref ? ` (NPPF ${md(e.ref)})` : ''}`, '');
    out.push(`*The test:* ${md(e.requirement)}`, '');
    out.push(`- **Status in this draft:** ${STATUS_IN_DRAFT[e.status]}`);
    out.push(`- **Evidence the plan shows:** ${md(e.shows)}`);
    out.push(`- **Evidence documents the plan names:** ${(e.evidenceDocuments ?? []).length ? e.evidenceDocuments.map(md).join('; ') : 'None named for this test.'}`);
    out.push(`- **Gaps:** ${e.gaps.length ? e.gaps.map(md).join('; ') : 'None found.'}`);
    out.push(`- **Action:** ${md(e.action) || 'None.'}`, '');
    if ((e.questions ?? []).length) out.push('Questions an inspector may ask:', '', ...e.questions.map((q) => `- ${md(q)}`), '');
    if (e.evidence.length) out.push('Where in the plan:', '', quoteLines(e.evidence), '');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** The whole report. `siteUrl` makes the citation links absolute. */
export function reportMarkdown(report, { siteUrl = 'https://strangeramblings.com/projects/local-plan-navigator' } = {}) {
  const link = (c) => (c.href ? `[${md(c.label)}](${siteUrl}${c.href})` : md(c.label));
  const s = report.summary;
  const out = [
    `# Plan check: ${md(report.document.name)}`,
    '',
    `> ${md(report.notice)}`,
    '',
    `Checked ${when(report.generatedAt)} against rubric ${md(report.rubricVersion)}. The document is a ${md(report.document.typeName ?? report.document.type)} of about ${report.document.words.toLocaleString('en-GB')} words in ${report.document.sectionCount} sections.`,
    '',
    '## Summary',
    '',
    '| Section | Met | Partly met | Not met | Cannot assess |',
    '| --- | --- | --- | --- | --- |',
    ...s.sections.map((x) => `| ${x.letter} ${md(x.title)} | ${x.counts.met} | ${x.counts.partly} | ${x.counts.missing} | ${x.counts['not-assessable']} |`),
    `| **All ${s.total} items** | **${s.counts.met}** | **${s.counts.partly}** | **${s.counts.missing}** | **${s.counts['not-assessable']}** |`,
    '',
  ];
  const d = report.detected;
  if (d) {
    out.push('## What the checker found in the plan', '');
    out.push(`- Site allocations: ${d.allocations.length ? d.allocations.map((a) => md(`${a.code} ${a.title}`.trim())).join('; ') : 'none'}`);
    out.push(`- Policies: ${d.policies.length ? d.policies.map((p) => md(`${p.code} ${p.title}`.trim())).join('; ') : 'none'}`);
    out.push(`- Numbered measurable outcomes: ${d.outcomes.length}`);
    for (const n of d.notes ?? []) out.push(`- ${md(n)}`);
    out.push('');
  }
  for (const section of report.sections) {
    out.push(`## ${section.letter} ${md(section.title)}`, '', md(section.summary), '');
    for (const i of section.items) {
      out.push(`### ${i.id} ${md(i.title)}: ${LABEL[i.status]}`, '');
      out.push(md(i.finding), '');
      if (i.conditions?.length) out.push(...i.conditions.map((c) => `- ${c.answer === 'yes' ? 'Yes' : 'No'}: ${md(c.text)}`), '');
      if (i.instances?.length) {
        out.push('| Item | Result | Notes |', '| --- | --- | --- |');
        for (const x of i.instances) out.push(`| ${md(x.label)} | ${LABEL[x.status]}${x.findingLabel ? ` (${md(x.findingLabel)}${x.national?.length ? `: ${x.national.map((n) => n.code).join(', ')}` : ''})` : ''} | ${md(x.note ?? '')} |`);
        out.push('');
      }
      if (i.evidence.length) out.push(quoteLines(i.evidence), '');
      if (i.gaps.length) out.push('Gaps:', '', ...i.gaps.map((g) => `- ${md(g)}`), '');
      if (i.action) out.push(`**Action:** ${md(i.action)}`, '');
      if (i.notes?.length) out.push(...i.notes.map((n) => `*${md(n)}*`), '');
      out.push(`Sources: ${i.citations.map(link).join(', ')}`, '');
    }
  }
  for (const p of report.pending ?? []) out.push(`## ${p.letter} ${md(p.title)} (not yet checked)`, '', md(p.summary), '');
  out.push('---', '', statementsMarkdown(report).replace(/^# .*\n/, '# The draft Gateway statements\n'));
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
