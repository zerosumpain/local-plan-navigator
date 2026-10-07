// tests/eval-answers.test.mjs — the answer checks, without calling a model.
//
// scripts/eval-answers.mjs judges real answers; these make sure the judging
// itself is right, on answers shaped like the ones models actually give.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentences, paragraphs, citationsIn, checkAnswer } from '../scripts/eval-answers.mjs';

const passages = [{ id: 'nppf#fn-8' }, { id: 'site-selection-stage-2#availability:1' }, { id: 'procedural-guide#7-4-procedure-at-the-hearing-sessions:2' }];
const byName = (checks) => Object.fromEntries(checks.map((c) => [c.name, c.ok]));

test('sentences end at full stops, and a citation after the stop stays with its sentence', () => {
  assert.deepEqual(sentences('Sites need a reference.[1] They need a capacity [1]. Then a timeframe.'), ['Sites need a reference.[1]', 'They need a capacity [1].', 'Then a timeframe.']);
});

test('abbreviations and numbers do not end a sentence, but "No." does', () => {
  assert.deepEqual(sentences('See s. 15C and reg. 32 of the Regulations [1]. Allow 1.5 hectares, e.g. on brownfield land [2].'), ['See s․ 15C and reg․ 32 of the Regulations [1].', 'Allow 1․5 hectares, e․g․ on brownfield land [2].']);
  assert.deepEqual(sentences('No. You do not need to test every site [1].'), ['No.', 'You do not need to test every site [1].']);
});

test('paragraphs and bullet points are kept apart', () => {
  assert.deepEqual(paragraphs('First point [1].\n- Second point [2].'), [['First point [1].'], ['Second point [2].']]);
});

test('an answer that cites every sentence passes', () => {
  const checks = byName(checkAnswer({ expect: ['nppf#fn-8'] }, 'Each allocation needs a site reference, name and area [1]. It also needs a delivery timeframe [1][2].', passages));
  assert.deepEqual(checks, { 'citations exist': true, 'every sentence cites': true, 'nothing left uncited': true, 'expected sources cited': true, 'not a refusal': true });
});

test('one citation at the end of a paragraph passes the loose check but not the strict one', () => {
  const checks = byName(checkAnswer({ expect: ['procedural-guide'] }, 'Usually not. Hearings focus on the soundness of the submitted plan. Omission sites are not normally discussed. [3]', passages));
  assert.equal(checks['every sentence cites'], false);
  assert.equal(checks['nothing left uncited'], true);
  assert.equal(checks['expected sources cited'], true);
});

test('a sentence with no citation after it fails both checks', () => {
  const checks = byName(checkAnswer({ expect: ['nppf'] }, 'Allocations need a reference [1]. Inspectors also like maps.', passages));
  assert.equal(checks['every sentence cites'], false);
  assert.equal(checks['nothing left uncited'], false);
});

test('a citation to a passage the model was not given fails', () => {
  assert.equal(byName(checkAnswer({ expect: ['nppf'] }, 'Allocations need a reference [4].', passages))['citations exist'], false);
  assert.deepEqual(citationsIn('A [1][2] and [10].'), [1, 2, 10]);
});

test('expected sources match by source, or by passage including its continuation chunks', () => {
  assert.equal(byName(checkAnswer({ expect: ['site-selection-stage-2'] }, 'Assign each site a five-year band [2].', passages))['expected sources cited'], true);
  assert.equal(byName(checkAnswer({ expect: ['site-selection-stage-2#availability'] }, 'Assign each site a five-year band [2].', passages))['expected sources cited'], true);
  assert.equal(byName(checkAnswer({ expect: ['site-selection-stage-1'] }, 'Assign each site a five-year band [2].', passages))['expected sources cited'], false);
});

test('declines are recognised, and an uncited refusal of an answerable question fails', () => {
  const offTopic = { decline: 'off-topic' };
  assert.equal(byName(checkAnswer(offTopic, 'I can help with local plan-making in England, but cooking a Sunday roast is outside that scope.', passages))['declines (off-topic)'], true);
  assert.equal(byName(checkAnswer(offTopic, 'Roast it at 180 degrees for an hour.', passages))['declines (off-topic)'], false);
  assert.equal(byName(checkAnswer({ decline: 'not covered' }, 'These passages do not specify a Community Infrastructure Levy rate [1].', passages))['declines (not covered)'], true);
  assert.equal(byName(checkAnswer({ expect: ['nppf'] }, 'The passages do not cover this.', passages))['not a refusal'], false);
});
