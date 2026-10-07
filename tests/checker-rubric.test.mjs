// tests/checker-rubric.test.mjs — the plan checker's rubric hangs together.
//
// Every citation must be a passage in the built corpus (so every source link
// in a report goes somewhere), ids are stable and unique, the sections come in
// their fixed order, the regulation 32 items are all there, and the list of
// national decision-making policies is exactly the one in the NPPF text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNppf } from '../scripts/lib/nppf-parse.mjs';
import { rubricProblems } from '../server/checker/rubric.mjs';
import { builtCorpus, root } from './checker-helpers.mjs';

const raw = async () => JSON.parse(await readFile(new URL('../content/checker-rubric.json', import.meta.url), 'utf8'));

test('every cited anchor is a passage in the built corpus', async () => {
  const { corpusFile } = await builtCorpus();
  const passages = new Set(corpusFile.chunks.map((c) => `${c.doc}#${c.anchor}`));
  const rubric = await raw();
  let cites = 0;
  for (const s of rubric.sections) for (const i of s.items) for (const c of i.cites) {
    cites++;
    assert.ok(passages.has(`${c.doc}#${c.anchor}`), `${i.id} cites ${c.doc}#${c.anchor}, which is not in dist/data/corpus.json`);
    assert.ok(c.label, `${i.id}: citation without a label`);
  }
  for (const p of rubric.nationalDecisionMakingPolicies) assert.ok(passages.has(`nppf#${p.code}`), `national policy ${p.code} is not in the corpus`);
  assert.ok(cites > 60);
});

test('the resolved rubric links every citation into the reference library', async () => {
  const { rubric } = await builtCorpus();
  for (const s of rubric.sections) for (const i of s.items) for (const c of i.cites) {
    assert.match(c.href, /^\/reference\/[a-z0-9/-]+#[A-Za-z0-9._:-]+$/, `${i.id}: ${c.href}`);
  }
});

test('ids are unique and stable, sections are in their fixed order, and the shape is sound', async () => {
  const rubric = await raw();
  assert.deepEqual(rubricProblems(rubric), []);
  assert.deepEqual(rubric.sections.map((s) => s.id), ['structure', 'allocations', 'linkage', 'policies', 'prescribed', 'soundness', 'model-plan']);
  assert.deepEqual(rubric.sections.map((s) => s.letter), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  const ids = rubric.sections.flatMap((s) => s.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const s of rubric.sections) for (const i of s.items) assert.ok(i.id.startsWith(s.letter), `${i.id} is not in section ${s.letter}`);
  assert.deepEqual(rubric.statuses.map((s) => s.id), ['met', 'partly', 'missing', 'not-assessable']);
});

test('all twelve prescribed requirements of regulation 32 are checked, and feed the statement of compliance', async () => {
  const rubric = await raw();
  const e = rubric.sections.find((s) => s.id === 'prescribed');
  const refs = e.items.filter((i) => /^32\(/.test(i.ref)).map((i) => i.ref);
  assert.deepEqual(refs, 'abcdefghijkl'.split('').map((l) => `32(${l})`));
  for (const i of e.items) {
    assert.equal(i.statement, 'compliance');
    assert.ok(i.cites.some((c) => c.doc === 'regulations-2026'), `${i.id} cites no regulation`);
  }
  const f = rubric.sections.find((s) => s.id === 'soundness');
  assert.deepEqual(f.items.map((i) => i.ref), ['PM15(1)(a)', 'PM15(1)(b)', 'PM15(1)(c)', 'PM15(1)(d)', 'PM15(1)(e)']);
});

test('every item says where it comes from, and the model plan waits, disabled, for publication', async () => {
  const rubric = await raw();
  for (const s of rubric.sections) for (const i of s.items) assert.ok(rubric.sources[i.source], `${i.id}: unknown source ${i.source}`);
  const g = rubric.sections.find((s) => s.id === 'model-plan');
  assert.equal(g.enabled, false);
  assert.ok(g.items.length && g.items.every((i) => i.source === 'model-plan'));
});

test('derived items only combine items that exist', async () => {
  const rubric = await raw();
  const broken = structuredClone(rubric);
  broken.sections[4].items[1].derive.from.push('Z9');
  assert.match(rubricProblems(broken).join('\n'), /Z9/);
});

test('the national decision-making policies are exactly those the NPPF lists under that heading', async () => {
  const rubric = await raw();
  const { chapters } = parseNppf(await readFile(`${root}content/sources/nppf-2026-08.txt`, 'utf8'));
  const fromText = [];
  for (const c of chapters) {
    if (c.annex) continue;
    let decision = c.num === '3';
    for (const b of c.blocks) {
      if (b.type === 'h3') decision = /National decision-making/.test(b.text) || (c.num === '3' && decision);
      if (b.type === 'policy' && decision) fromText.push(b.code);
    }
  }
  assert.deepEqual(rubric.nationalDecisionMakingPolicies.map((p) => p.code), fromText);
});
