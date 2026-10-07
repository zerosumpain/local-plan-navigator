// tests/checker-read.test.mjs — reading uploads: Word, PowerPoint, Markdown, text.
//
// The Office fixtures are built with fflate, independently of the server's
// own zip code, and the server's zip writer is read back with fflate, so each
// implementation checks the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { DocumentError, readDocument } from '../server/checker/read-document.mjs';
import { openZip, writeZip, ZipError } from '../server/checker/zip.mjs';
import { detectOutcomes, detectPolicies } from '../server/checker/detect.mjs';
import { docxFixture, pptxFixture } from './checker-helpers.mjs';

const padding = '\n\nThis paragraph is here so the document is long enough to check, as a real plan always is. '.repeat(4);

test('a .docx keeps its headings, paragraphs and tables, and drops what a reader does not see', () => {
  const doc = readDocument({ name: 'C:\\plans\\testshire.docx', bytes: docxFixture(), limits: { minCharacters: 50 } });
  assert.equal(doc.name, 'testshire.docx');
  assert.equal(doc.type, 'docx');
  const headings = doc.sections.map((s) => [s.level, s.heading]);
  // "Ueberschrift1" is called "heading 1" in styles.xml; the outline level makes a heading 2.
  assert.deepEqual(headings, [[1, 'Testshire Local Plan'], [1, '1 Vision'], [2, 'Policy T/H1: Land at Mill Lane']]);
  const vision = doc.sections[1].text;
  assert.match(vision, /By 2040 Testshire will have grown well\./, 'insertions kept, deletions dropped, tabs become spaces');
  assert.doesNotMatch(doc.text, /never/);
  assert.equal(doc.text.match(/Text box words/g).length, 1, 'a text box is read once, not again from its VML fallback');
  assert.doesNotMatch(doc.text, /Contents|\t3/, 'the table of contents is skipped');
  assert.deepEqual(doc.sections[2].tables[0].rows, [['Ref', 'Site name'], ['T/H1', 'Land at Mill Lane second line']]);
  assert.match(doc.sections[2].text, /T\/H1 \| Land at Mill Lane second line/);
  assert.equal(doc.sections[2].locator, '1 Vision › Policy T/H1: Land at Mill Lane');
  assert.equal(doc.characters, doc.text.length);
  assert.match(doc.sha256, /^[0-9a-f]{64}$/);
});

test('a .pptx is read in presentation order, with titles, tables and speaker notes', () => {
  const doc = readDocument({ name: 'deck.pptx', bytes: pptxFixture(), limits: { minCharacters: 20 } });
  assert.deepEqual(doc.sections.map((s) => s.locator), ['Slide 1: Our vision', 'Slide 2: Sites']);
  assert.match(doc.sections[0].text, /A greener Testshire by 2040\.\nSpeaker notes: Say this slowly\./);
  assert.doesNotMatch(doc.text, /\b7\b/, 'slide numbers are not content');
  assert.deepEqual(doc.sections[1].tables[0].rows, [['Ref', 'Site name'], ['T/E1', 'Depot Road']]);
  const found = detectPolicies(doc);
  assert.deepEqual(found.allocations.map((a) => a.code), ['T/E1'], 'a schedule of sites in a table is an allocation');
});

test('Markdown and plain text become the same kind of sections', () => {
  const md = readDocument({ name: 'plan.md', bytes: Buffer.from(`---\ntitle: x\n---\n# Plan\n\n## 2 Vision\n\nBy **2040** the [area](http://x) will *change*.\n\nSecond line\n---\n\n| Ref | Site name |\n| --- | --- |\n| H1 | Land at Mill Lane |\n\n- Outcome 1: 500 homes\n- Outcome 2: 20 hectares${padding}`) });
  assert.deepEqual(md.sections.map((s) => s.heading), ['Plan', '2 Vision', 'Second line']);
  assert.match(md.sections[1].text, /^By 2040 the area will change\.$/m);
  assert.deepEqual(md.sections[2].tables[0].rows[1], ['H1', 'Land at Mill Lane']);
  assert.deepEqual(detectOutcomes(md).map((o) => o.number), [1, 2]);
  const txt = readDocument({ name: 'plan.txt', bytes: Buffer.from(`NORTHWOLD LOCAL PLAN\n\n3. Spatial strategy\n\nGrowth will go to Wendbury.\n\nPolicy NW1\n\nDevelopment must be well designed.${padding}`) });
  assert.deepEqual(txt.sections.map((s) => [s.level, s.heading]), [[1, 'NORTHWOLD LOCAL PLAN'], [1, '3. Spatial strategy'], [3, 'Policy NW1']]);
  const latin1 = readDocument({ name: 'old.txt', bytes: Buffer.concat([Buffer.from('Caf'), Buffer.from([0xe9]), Buffer.from(` plan${padding}`)]) });
  assert.match(latin1.text, /Café plan/);
});

test('uploads that cannot be checked are refused with a message for the person who sent them', () => {
  const refuse = (name, bytes, pattern, limits) => {
    assert.throws(() => readDocument({ name, bytes, limits }), (err) => err instanceof DocumentError && pattern.test(err.message), `${name}: expected ${pattern}`);
  };
  refuse('plan.pdf', Buffer.from('%PDF-1.7'), /PDF files cannot be checked/);
  refuse('plan.doc', Buffer.from('x'), /older Word format/);
  refuse('plan.xlsx', Buffer.from('x'), /must be a Word document \(\.docx\), PowerPoint presentation \(\.pptx\), Markdown file \(\.md\) or text file \(\.txt\)/);
  refuse('plan.docx', Buffer.alloc(0), /The selected file is empty/);
  refuse('plan.md', Buffer.alloc(2 * 1024 * 1024, 'a'), /must be smaller than 1MB/, { maxBytes: 1024 * 1024 });
  refuse('plan.docx', Buffer.from('this is not a zip at all'), /not a Word document/);
  refuse('plan.docx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), /password protected/);
  refuse('plan.pptx', Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:document><w:body/></w:document>') })), /not a PowerPoint presentation/);
  refuse('plan.md', Buffer.from('Too short.'), /too little text/);
  refuse('plan.md', Buffer.from(`${'word '.repeat(4000)}`), /has about 4,000 words\. The checker can read up to about/, { maxCharacters: 5000 });
  refuse('plan.txt', Buffer.from(zipSync({ a: strToU8('x') })), /not a text file/);
});

test('a zip that unpacks to far more than it says is refused, not unpacked', () => {
  const huge = Buffer.alloc(20 * 1024 * 1024, 0x20);
  const bomb = Buffer.from(zipSync({ 'word/document.xml': huge }, { level: 9 }));
  assert.ok(bomb.length < 100 * 1024);
  assert.throws(() => openZip(bomb, { maxEntryBytes: 1024 * 1024 }).read('word/document.xml'), ZipError);
  // A lying header: declared tiny, really large. maxOutputLength still stops it.
  const zip = openZip(bomb, { maxEntryBytes: 1024 * 1024 });
  assert.equal(zip.names.length, 1);
  assert.throws(() => readDocument({ name: 'bomb.docx', bytes: bomb, limits: {} }), DocumentError);
});

test('the server zip writer and reader agree with fflate in both directions', () => {
  const written = writeZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.xml', data: Buffer.from('<b>ünïcödé</b>') }]);
  const unzipped = unzipSync(new Uint8Array(written));
  assert.equal(strFromU8(unzipped['a.txt']), 'hello');
  assert.equal(strFromU8(unzipped['dir/b.xml']), '<b>ünïcödé</b>');
  assert.deepEqual(writeZip([{ name: 'a.txt', data: 'hello' }]), writeZip([{ name: 'a.txt', data: 'hello' }]), 'same input, same bytes');
  const fromFflate = Buffer.from(zipSync({ 'x/y.xml': strToU8('<y/>'), 'stored.txt': [strToU8('plain'), { level: 0 }] }));
  const zip = openZip(fromFflate);
  assert.equal(zip.text('x/y.xml'), '<y/>');
  assert.equal(zip.text('STORED.TXT'), 'plain', 'part names are case-insensitive');
  assert.equal(zip.read('missing'), null);
  // A corrupted entry fails its checksum.
  const bad = Buffer.from(fromFflate);
  const at = bad.indexOf('plain');
  assert.ok(at > 0);
  bad[at] = 'P'.charCodeAt(0);
  assert.throws(() => openZip(bad).read('stored.txt'), ZipError);
});
