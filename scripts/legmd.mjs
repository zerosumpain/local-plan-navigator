// legislation.gov.uk CLML XML -> Markdown. Handles Part/Chapter/P1group (regulation)/P1..P4 nesting,
// Schedules, and the explanatory note. Good enough for reading and for a search corpus.
import fs from 'node:fs';
const [,, inFile, outFile] = process.argv;
let x = fs.readFileSync(inFile, 'utf8');
// Drop commentary/metadata blocks that are not the text of the instrument.
x = x.replace(/<ukm:Metadata[\s\S]*?<\/ukm:Metadata>/g, '')
     .replace(/<Commentaries>[\s\S]*?<\/Commentaries>/g, '')
     .replace(/<CommentaryRef[^>]*\/>/g, '')
     .replace(/<Versions>[\s\S]*?<\/Versions>/g, '');
const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#x2014;|—/g,'—').replace(/\s+/g,' ').trim();
let out = [];
const title = (x.match(/<Title>([^<]*)<\/Title>/)||[])[1];
if (title) out.push('# ' + text(title) + '\n');
// Walk with a simple tokenizer over the tags we care about.
const re = /<(\/?)(Part|Chapter|Pblock|P1group|P1|P2|P3|P4|Schedule|ScheduleBody|Title|Number|Pnumber|Text|ExplanatoryNotes|Tabular|table|tr|td|th)\b[^>]*>|([^<]+)|<[^>]+>/g;
let m; const stack = []; let cur = null; let buf = '';
let depthP = 0; let pending = { num: '', title: '' }; let inTitle = false, inNumber = false, inPnumber = false, inText = false, inTable = false, row = [];
const flushText = () => { if (buf.trim()) { const ind = '  '.repeat(Math.max(0, depthP - 1)); out.push(ind + buf.trim()); } buf = ''; };
while ((m = re.exec(x))) {
  const [, close, tag, chars] = m;
  if (chars !== undefined) { if (inTitle || inNumber || inPnumber || inText || inTable) buf += chars; continue; }
  if (!tag) continue;
  const open = !close;
  switch (tag) {
    case 'Part': case 'Chapter': case 'Schedule': case 'Pblock': case 'ExplanatoryNotes':
      if (open) { stack.push(tag); pending = { num: '', title: '' }; } else stack.pop(); break;
    case 'Number': if (open) { inNumber = true; buf=''; } else { inNumber = false; pending.num = text(buf); buf=''; } break;
    case 'Title':
      if (open) { inTitle = true; buf=''; } else {
        inTitle = false; const t = text(buf); buf='';
        const top = stack[stack.length-1];
        if (top === 'Part' || top === 'Schedule') out.push('\n## ' + (pending.num ? pending.num + ' — ' : '') + t + '\n');
        else if (top === 'Chapter') out.push('\n### ' + (pending.num ? pending.num + ' — ' : '') + t + '\n');
        else if (top === 'Pblock') out.push('\n#### ' + t + '\n');
        else if (top === 'ExplanatoryNotes') out.push('\n## ' + t + '\n');
        else if (top === 'P1group') pending.title = t;
      } break;
    case 'P1group': if (open) { stack.push(tag); pending = { num:'', title:'' }; } else stack.pop(); break;
    case 'P1': case 'P2': case 'P3': case 'P4':
      if (open) { depthP = Number(tag[1]); } else { flushText(); depthP = Math.max(0, Number(tag[1]) - 1); } break;
    case 'Pnumber': if (open) { inPnumber = true; buf=''; } else {
        inPnumber = false; const n = text(buf); buf='';
        if (depthP === 1) { out.push('\n### ' + n + '. ' + pending.title + '\n'); }
        else buf = '(' + n + ') ';
      } break;
    case 'Text': if (open) { inText = true; } else { inText = false; flushText(); } break;
    case 'Tabular': case 'table': inTable = open; if (!open) out.push(''); break;
    case 'tr': if (open) row = []; else { out.push('| ' + row.join(' | ') + ' |'); } break;
    case 'td': case 'th': if (open) buf=''; else { row.push(text(buf)); buf=''; } break;
  }
}
fs.writeFileSync(outFile, out.join('\n').replace(/\n{3,}/g, '\n\n'));
console.log(outFile, fs.statSync(outFile).size, 'bytes');
