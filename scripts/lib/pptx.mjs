// scripts/lib/pptx.mjs — write a plain PowerPoint deck (.pptx) from simple slides.
//
// Used only to make the sample plan's summary deck, so the checker can be
// tried on a presentation. One master, one "Title and Content" layout, a 16:9
// page; each slide has a title, then bullets or a table, and speaker notes.
// The parts and their order follow what PowerPoint itself writes, including a
// complete theme, because PowerPoint refuses a deck missing any of them.
//
//   buildPptx({ title, slides: [{ title, subtitle?, bullets?, table?: { header, rows }, notes? }] }) -> Buffer
import { writeZip } from '../../server/checker/zip.mjs';
import { esc } from '../../server/checker/xml.mjs';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';
const W = 12192000;
const H = 6858000;
const xml = (s) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`;
const rels = (list) => xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`);
const groupProps = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const xfrm = (x, y, cx, cy) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const para = (text, { size, bold, bullet } = {}) => `<a:p>${bullet === false ? '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>' : ''}<a:r><a:rPr lang="en-GB"${size ? ` sz="${size}"` : ''}${bold ? ' b="1"' : ''} dirty="0"/><a:t>${esc(text)}</a:t></a:r></a:p>`;
const placeholder = (id, name, ph, body, geometry = '') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${geometry}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;

const THEME = (name) => xml(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements>
<a:clrScheme name="Navigator"><a:dk1><a:srgbClr val="0B0C0C"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1D70B8"/></a:dk2><a:lt2><a:srgbClr val="F3F2F1"/></a:lt2><a:accent1><a:srgbClr val="1D70B8"/></a:accent1><a:accent2><a:srgbClr val="00703C"/></a:accent2><a:accent3><a:srgbClr val="D4351C"/></a:accent3><a:accent4><a:srgbClr val="FFDD00"/></a:accent4><a:accent5><a:srgbClr val="4C2C92"/></a:accent5><a:accent6><a:srgbClr val="505A5F"/></a:accent6><a:hlink><a:srgbClr val="1D70B8"/></a:hlink><a:folHlink><a:srgbClr val="4C2C92"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Navigator"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Navigator"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`);

const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const TITLE_BOX = xfrm(609600, 365125, 10972800, 1000125);
const BODY_BOX = xfrm(609600, 1600200, 10972800, 4525963);

const MASTER = xml(`<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${groupProps}
${placeholder(2, 'Title Placeholder 1', '<p:ph type="title"/>', para('Title'), TITLE_BOX)}
${placeholder(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', para('Text'), BODY_BOX)}
</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3600" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`);

const LAYOUT = xml(`<p:sldLayout ${NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${groupProps}
${placeholder(2, 'Title 1', '<p:ph type="title"/>', para('Title'))}
${placeholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', para('Text'))}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);

const NOTES_MASTER = xml(`<p:notesMaster ${NS}><p:cSld><p:spTree>${groupProps}
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(381000, 685800, 6096000, 3429000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>
${placeholder(3, 'Notes Placeholder 2', '<p:ph type="body" sz="quarter" idx="3"/>', para('Notes', { bullet: false }), xfrm(685800, 4343400, 5486400, 4114800))}
</p:spTree></p:cSld>${CLR_MAP}</p:notesMaster>`);

function table({ header, rows }) {
  const cols = header.length;
  const colW = Math.floor(10972800 / cols);
  const line = (tag) => `<a:${tag} w="12700"><a:solidFill><a:srgbClr val="B1B4B6"/></a:solidFill></a:${tag}>`;
  const cell = (text, head) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB" sz="1400"${head ? ' b="1"' : ''} dirty="0"/><a:t>${esc(text)}</a:t></a:r></a:p></a:txBody><a:tcPr>${line('lnL')}${line('lnR')}${line('lnT')}${line('lnB')}${head ? '<a:solidFill><a:srgbClr val="F3F2F1"/></a:solidFill>' : ''}</a:tcPr></a:tc>`;
  const row = (cells, head) => `<a:tr h="370840">${Array.from({ length: cols }, (_, i) => cell(cells[i] ?? '', head)).join('')}</a:tr>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="609600" y="1600200"/><a:ext cx="${colW * cols}" cy="${370840 * (rows.length + 1)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join('')}</a:tblGrid>${row(header, true)}${rows.map((r) => row(r, false)).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function slideXml(s) {
  const title = placeholder(2, 'Title 1', '<p:ph type="title"/>', para(s.title));
  let body = '';
  if (s.subtitle || s.bullets?.length) {
    const ps = [...(s.subtitle ? [para(s.subtitle, { bullet: false })] : []), ...(s.bullets ?? []).map((b) => para(b))].join('');
    body = placeholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', ps, s.table ? xfrm(609600, 1600200, 10972800, 900000) : '');
  }
  let frame = '';
  if (s.table) {
    frame = table(s.table);
    if (body) frame = frame.replace('<a:off x="609600" y="1600200"/>', '<a:off x="609600" y="2600000"/>');
  }
  return xml(`<p:sld ${NS}><p:cSld><p:spTree>${groupProps}${title}${body}${frame}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
}

const notesXml = (text) => xml(`<p:notes ${NS}><p:cSld><p:spTree>${groupProps}
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>
${placeholder(3, 'Notes Placeholder 2', '<p:ph type="body" idx="3"/>', String(text).split('\n').map((t) => para(t, { bullet: false })).join(''))}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);

export function buildPptx({ title = 'Presentation', slides = [], created = '2026-01-01T00:00:00Z' }) {
  const n = slides.length;
  const files = [];
  const types = [
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT}.presentationml.notesMaster+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT}.theme+xml"/>`,
    `<Override PartName="/ppt/theme/theme2.xml" ContentType="${CT}.theme+xml"/>`,
    `<Override PartName="/ppt/presProps.xml" ContentType="${CT}.presentationml.presProps+xml"/>`,
    `<Override PartName="/ppt/viewProps.xml" ContentType="${CT}.presentationml.viewProps+xml"/>`,
    `<Override PartName="/ppt/tableStyles.xml" ContentType="${CT}.presentationml.tableStyles+xml"/>`,
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    `<Override PartName="/docProps/app.xml" ContentType="${CT}.extended-properties+xml"/>`,
  ];
  slides.forEach((_, i) => {
    types.push(`<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}.presentationml.slide+xml"/>`);
    types.push(`<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="${CT}.presentationml.notesSlide+xml"/>`);
  });
  files.push({ name: '[Content_Types].xml', data: xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types.join('')}</Types>`) });
  files.push({ name: '_rels/.rels', data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`) });
  files.push({ name: 'ppt/presentation.xml', data: xml(`<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`) });
  files.push({ name: 'ppt/_rels/presentation.xml.rels', data: rels([
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'theme', 'theme/theme1.xml'], ['rId3', 'presProps', 'presProps.xml'],
    ['rId4', 'viewProps', 'viewProps.xml'], ['rId5', 'tableStyles', 'tableStyles.xml'], ['rId6', 'notesMaster', 'notesMasters/notesMaster1.xml'],
    ...slides.map((_, i) => [`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`]),
  ]) });
  files.push({ name: 'ppt/presProps.xml', data: xml(`<p:presentationPr ${NS}/>`) });
  files.push({ name: 'ppt/viewProps.xml', data: xml(`<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`) });
  files.push({ name: 'ppt/tableStyles.xml', data: xml('<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>') });
  files.push({ name: 'ppt/theme/theme1.xml', data: THEME('Navigator') });
  files.push({ name: 'ppt/theme/theme2.xml', data: THEME('Navigator notes') });
  files.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: MASTER });
  files.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]) });
  files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT });
  files.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]) });
  files.push({ name: 'ppt/notesMasters/notesMaster1.xml', data: NOTES_MASTER });
  files.push({ name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: rels([['rId1', 'theme', '../theme/theme2.xml']]) });
  slides.forEach((s, i) => {
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(s) });
    files.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'notesSlide', `../notesSlides/notesSlide${i + 1}.xml`]]) });
    files.push({ name: `ppt/notesSlides/notesSlide${i + 1}.xml`, data: notesXml(s.notes ?? '') });
    files.push({ name: `ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`, data: rels([['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'], ['rId2', 'slide', `../slides/slide${i + 1}.xml`]]) });
  });
  files.push({ name: 'docProps/core.xml', data: xml(`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Local Plan Navigator (prototype)</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`) });
  files.push({ name: 'docProps/app.xml', data: xml(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Local Plan Navigator</Application><Slides>${n}</Slides><Notes>${n}</Notes></Properties>`) });
  return writeZip(files);
}
