// tests/checker-export.test.mjs — the draft statements as Word and Markdown, and the report schema.
//
// The .docx is unzipped with fflate (not the server's own reader) and its
// document.xml is checked for real Word heading styles and tables, so an
// officer opening it gets a navigable, editable document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { reportMarkdown, statementsDocx, statementsMarkdown } from '../server/checker/export.mjs';
import { runCheck } from '../server/checker/pipeline.mjs';
import { readDocument } from '../server/checker/read-document.mjs';
import { reportProblems } from '../server/checker/schema.mjs';
import { builtCorpus, fakeComplete, root } from './checker-helpers.mjs';

let cached;
async function report() {
  if (cached) return structuredClone(cached);
  const { rubric, corpusFile } = await builtCorpus();
  const document = readDocument({ name: 'northwold-draft-local-plan.md', bytes: await readFile(`${root}content/samples/northwold-draft-local-plan.md`) });
  cached = await runCheck({ document, rubric, corpus: corpusFile, complete: fakeComplete(), now: new Date('2026-10-07T12:00:00Z') });
  return structuredClone(cached);
}

test('the Word export has the statements under real heading styles, with a table per entry', async () => {
  const docx = statementsDocx(await report());
  const files = unzipSync(new Uint8Array(docx));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/footer1.xml', 'docProps/core.xml']) assert.ok(files[part], `missing ${part}`);
  const xml = strFromU8(files['word/document.xml']);
  const headings = (level) => [...xml.matchAll(new RegExp(`<w:pStyle w:val="Heading${level}"/></w:pPr>((?:<w:r>.*?</w:r>)+)</w:p>`, 'g'))].map((m) => [...m[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''));
  assert.deepEqual(headings(1), ['Draft statement of compliance', 'Draft statement of soundness', 'How this draft was made']);
  assert.ok(headings(2).includes('Part 1: The prescribed requirements (regulation 32)'));
  assert.ok(headings(2).includes('Positive (NPPF PM15(1)(a))'));
  assert.ok(headings(3).includes('Regulation 32(a): Policies on the amount, type, location and timetable of development'));
  assert.equal(headings(3).filter((h) => h.startsWith('Regulation 32(')).length, 12);
  assert.ok((xml.match(/<w:tbl>/g) ?? []).length >= 20, 'one editable table per entry');
  assert.match(xml, /Machine-drafted starting point/);
  assert.match(xml, /To be completed by the authority/);
  const styles = strFromU8(files['word/styles.xml']);
  assert.match(styles, /<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"\/>/);
  assert.match(styles, /<w:outlineLvl w:val="0"\/>/);
  assert.match(strFromU8(files['word/footer1.xml']), /not an assessment by the Planning Inspectorate/);
  assert.match(strFromU8(files['[Content_Types].xml']), /wordprocessingml\.document\.main\+xml/);
});

test('text from the report is escaped, so an edited report cannot break the document', async () => {
  const r = await report();
  r.statements.compliance.parts[0].entries[0].shows = 'Ampersands & <w:p>tags</w:p> and "quotes" \u0001control';
  r.document.name = 'plan <script>.docx';
  assert.deepEqual(reportProblems(r), []);
  const xml = strFromU8(unzipSync(new Uint8Array(statementsDocx(r)))['word/document.xml']);
  assert.match(xml, /Ampersands &amp; &lt;w:p&gt;tags&lt;\/w:p&gt; and &quot;quotes&quot; control/);
  assert.doesNotMatch(xml, /\u0001/);
  assert.match(statementsMarkdown(r), /Ampersands & \\<w:p\\>tags\\<\/w:p\\>/);
});

test('the Markdown exports carry the statements, and the report links its sources', async () => {
  const r = await report();
  const statements = statementsMarkdown(r);
  assert.match(statements, /^# Draft statement of compliance and statement of soundness/);
  assert.match(statements, /#### Regulation 32\(l\): Ready to proceed to independent examination/);
  assert.match(statements, /Questions an inspector may ask:/);
  const full = reportMarkdown(r, { siteUrl: 'https://example.test/lpn' });
  assert.match(full, /^# Plan check: northwold-draft-local-plan\.md/);
  assert.match(full, /\| \*\*All 42 items\*\* \|/);
  assert.match(full, /\[Regulation 32\(a\)\]\(https:\/\/example\.test\/lpn\/reference\/regulations-2026\/part-4\/#reg-32\)/);
  assert.match(full, /# The draft Gateway statements/);
});

test('the report schema refuses what the export should not render', async () => {
  const good = await report();
  assert.deepEqual(reportProblems(good), []);
  const broken = (change) => { const r = structuredClone(good); change(r); return reportProblems(r); };
  assert.match(broken((r) => { r.version = 2; }).join(), /version/);
  assert.match(broken((r) => { r.sections[0].items[0].status = 'great'; }).join(), /unknown status/);
  assert.match(broken((r) => { r.sections[0].items[0].citations[0].href = 'javascript:alert(1)'; }).join(), /not a reference link/);
  assert.match(broken((r) => { r.sections[0].items[0].finding = 'x'.repeat(5000); }).join(), /finding/);
  assert.match(broken((r) => { delete r.statements; }).join(), /statements: missing/);
  assert.match(reportProblems(null).join(), /not an object/);
});
