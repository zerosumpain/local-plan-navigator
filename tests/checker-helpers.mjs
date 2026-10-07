// tests/checker-helpers.mjs — shared by the plan checker's tests (not a test itself).
//
//   builtCorpus()      the corpus and resolved rubric, built into a temporary
//                      dist/ exactly as the build does it
//   fakeComplete(opts) a `complete` that answers every kind of prompt the
//                      pipeline sends, from the prompt itself, so a check runs
//                      end to end without a model; switches make it misbehave
//   docxFixture(), pptxFixture()  small Office files built with fflate, an
//                      implementation independent of the server's own zip code
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { buildCorpus } from '../scripts/build-corpus.mjs';
import { resolveRubric } from '../server/checker/rubric.mjs';

export const root = new URL('..', import.meta.url).pathname;

let built;
/** { dist, corpus, rubric } — built once per test file. */
export async function builtCorpus() {
  if (built) return built;
  const dist = await mkdtemp(join(tmpdir(), 'lpn-checker-test-'));
  await mkdir(join(dist, 'data'), { recursive: true });
  const corpus = await buildCorpus({ root, dist });
  const rubric = resolveRubric(JSON.parse(await readFile(join(root, 'content/checker-rubric.json'), 'utf8')), corpus);
  await writeFile(join(dist, 'data/checker-rubric.json'), JSON.stringify(rubric));
  const corpusFile = JSON.parse(await readFile(join(dist, 'data/corpus.json'), 'utf8'));
  built = { dist, corpus, corpusFile, rubric };
  return built;
}

/** The first line of text after `<<marker>> location` in a prompt. */
function firstLineAfter(prompt, marker) {
  const at = prompt.indexOf(`<<${marker}>>`);
  if (at < 0) return '';
  const lines = prompt.slice(at).split('\n').slice(1);
  return (lines.find((l) => l.trim() && !/^(Compare with|\(heading only\)|<<)/.test(l)) ?? '').slice(0, 80);
}

/**
 * A fake model. Options:
 *   invalid: 'once' | 'always'   reply with non-JSON (first try only, or every time)
 *   invent: true                 quote words that are not in the plan
 *   inventNational: true         name a national policy that does not exist
 *   status: 'met'                the status given to every judged item
 *   delayMs: 0
 * It records every request in `.calls`.
 */
export function fakeComplete({ invalid = null, invent = false, inventNational = false, status = 'met', delayMs = 0 } = {}) {
  const seen = new Map();
  const calls = [];
  const complete = async (req) => {
    calls.push(req);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (req.signal?.aborted) throw req.signal.reason;
    const key = req.user.replace(/\n\nYour previous reply could not be used[\s\S]*$/, '');
    const tries = (seen.get(key) ?? 0) + 1;
    seen.set(key, tries);
    if (invalid === 'always' || (invalid === 'once' && tries === 1)) return 'I am sorry, I cannot help with that.';
    const u = req.user;
    const quote = (marker) => (invent ? 'words the plan never says anywhere at all' : firstLineAfter(u, marker));
    if (u.includes('"allocations":[{')) {
      const sites = [...u.matchAll(/<<(S\d+)>>/g)].map((m) => m[1]);
      const fields = [...new Set([...u.matchAll(/^\[(B\d+)\]/gm)].map((m) => m[1]))];
      return JSON.stringify({ allocations: sites.map((id) => ({ id, fields: fields.map((f) => ({ id: f, status, evidence: [quote(id)], note: '' })) })) });
    }
    if (u.includes('"policies":[{"id"')) {
      const policies = [...u.matchAll(/<<(P\d+)>>/g)].map((m) => m[1]);
      return JSON.stringify({ policies: policies.map((id) => {
        const compare = u.slice(u.indexOf(`<<${id}>>`)).match(/Compare with: ([^\n]*)/)?.[1].split(', ')[0];
        return { id, clauses: [{ quote: quote(id), local: false, national: inventNational ? 'ZZ99' : compare, relation: 'repeats' }], explanation: 'It repeats national policy.', localIssue: 'partly', localIssueNote: 'Partly local.' };
      }) });
    }
    if (u.includes('"policies":[{"section"')) return JSON.stringify({ policies: [], allocations: [] });
    const ids = [...u.slice(0, u.indexOf('PLAN OUTLINE')).matchAll(/^\[([A-Z]\d+)\]/gm)].map((m) => m[1]);
    return JSON.stringify({ items: ids.map((id) => ({
      id, status, finding: `The plan covers ${id}.`, evidence: [quote(1)], gaps: [], action: '',
      list: [quote(1)],
      facts: { planStart: 2027, planEnd: 2042, adoption: 2029 },
      conditions: Array.from({ length: 6 }, (_, k) => ({ n: k + 1, answer: 'yes', quote: quote(1) })),
      questions: ['How will this be delivered?'], evidenceDocuments: [],
    })) });
  };
  complete.calls = calls;
  return complete;
}

/** A minimal .docx: styles mapping a renamed heading style, a TOC entry, a table, a text box with its VML fallback, tracked changes. */
export function docxFixture() {
  const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>
${p('Contents', 'TOCHeading')}${p('1 Vision\t3', 'TOC1')}
${p('Testshire Local Plan', 'Title')}
${p('1 Vision', 'Ueberschrift1')}
<w:p><w:r><w:t xml:space="preserve">By 2040 Testshire will </w:t></w:r><w:del><w:r><w:delText>never</w:delText></w:r></w:del><w:ins><w:r><w:t>have</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> grown</w:t></w:r><w:r><w:tab/><w:t>well.</w:t></w:r></w:p>
<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing><w:txbxContent>${p('Text box words')}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict>${p('Text box words')}</w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>
<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Policy T/H1: Land at Mill Lane</w:t></w:r></w:p>
${p('Site area: 4 hectares.')}
<w:tbl><w:tr><w:tc>${p('Ref')}</w:tc><w:tc>${p('Site name')}</w:tc></w:tr><w:tr><w:tc>${p('T/H1')}</w:tc><w:tc>${p('Land at Mill Lane')}${p('second line')}</w:tc></w:tr></w:tbl>
<w:sectPr/></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Ueberschrift1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>
<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Ueberschrift1"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`;
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(styles),
  }));
}

/** A minimal .pptx whose slide order in presentation.xml differs from the file names, with notes and a table. */
export function pptxFixture() {
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const sp = (ph, text) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${text.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
  const slide = (body) => `<p:sld ${NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
  const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const rels = (...r) => strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${r.join('')}</Relationships>`);
  const table = '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Ref</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Site name</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>T/E1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Depot Road</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'ppt/presentation.xml': strToU8(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': rels(rel('rId2', 'slide', 'slides/slide1.xml'), rel('rId3', 'slide', 'slides/slide2.xml')),
    // slide2.xml is listed first, so it is "Slide 1".
    'ppt/slides/slide2.xml': strToU8(slide(sp('title', ['Our vision']) + sp(null, ['A greener Testshire by 2040.']) + sp('sldNum', ['7']))),
    'ppt/slides/_rels/slide2.xml.rels': rels(rel('rId1', 'notesSlide', '../notesSlides/notesSlide9.xml')),
    'ppt/notesSlides/notesSlide9.xml': strToU8(`<p:notes ${NS}><p:cSld><p:spTree>${sp('sldImg', [])}${sp('body', ['Say this slowly.'])}</p:spTree></p:cSld></p:notes>`),
    'ppt/slides/slide1.xml': strToU8(slide(sp('ctrTitle', ['Sites']) + table)),
  }));
}
