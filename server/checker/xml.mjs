// server/checker/xml.mjs — just enough XML for Office files, in both directions.
//
// Reading: `xmlTokens(xml)` is a small streaming tokenizer. It yields
// { type: 'open', name, attrs }, { type: 'close', name } and
// { type: 'text', text } in document order; a self-closing tag yields an open
// and a close. It decodes only the five predefined entities and numeric
// character references, and skips comments, processing instructions and any
// DOCTYPE, so an uploaded file cannot define entities that expand (the
// "billion laughs") or reach outside itself. Namespaces are left as prefixes
// ("w:p", "a:t"): Office always writes the conventional ones.
//
// Writing: `esc()` escapes text and attribute values, and drops the control
// characters XML 1.0 forbids, which would otherwise make Word refuse the file.

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (whole, ref) => {
    if (ref[0] !== '#') return NAMED[ref];
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return ''; }
  });
}

/** Find the `>` that closes the tag starting at `lt`, ignoring any inside quoted attribute values. */
function tagEnd(xml, lt) {
  let quote = '';
  for (let i = lt + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

const ATTR = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function* xmlTokens(xml) {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { yield { type: 'text', text: decodeEntities(xml.slice(i)) }; return; }
    if (lt > i) yield { type: 'text', text: decodeEntities(xml.slice(i, lt)) };
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      yield { type: 'text', text: xml.slice(lt + 9, e < 0 ? n : e) };
      i = e < 0 ? n : e + 3;
      continue;
    }
    const gt = tagEnd(xml, lt);
    if (gt < 0) return; // truncated: stop rather than guess
    i = gt + 1;
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') continue; // <?xml …?>, <!DOCTYPE …>
    let raw = xml.slice(lt + 1, gt);
    if (raw[0] === '/') { yield { type: 'close', name: raw.slice(1).trim() }; continue; }
    const selfClosing = raw.endsWith('/');
    if (selfClosing) raw = raw.slice(0, -1);
    const space = raw.search(/\s/);
    const name = space < 0 ? raw : raw.slice(0, space);
    const attrs = {};
    if (space >= 0) for (const m of raw.slice(space).matchAll(ATTR)) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
    yield { type: 'open', name, attrs };
    if (selfClosing) yield { type: 'close', name };
  }
}

/** Escape text for an XML element or attribute, dropping characters XML 1.0 cannot hold. */
export function esc(s) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
