// scripts/lib/diagrams.mjs — accessible SVG diagrams generated from data.
//
// Two renderers, both pure functions of the content:
//   timelineSvg(model)   the 30-month process as a horizontal timeline
//   flowSvg(flow)        a process flow of boxes and arrows, laid out on a
//                        grid the data specifies (col, row) so the renderer
//                        stays small and the result stays predictable
// plus mermaidText(flow), the same flow as Mermaid source, shown under each
// diagram for anyone who wants to reuse it.
//
// Accessibility: every SVG has role="img", a <title> and a <desc> wired up
// with aria-labelledby, colours are paired with shape and text, and every
// page that shows a diagram also shows its content as a list or table.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Wrap text into lines of at most `max` characters, on word boundaries. */
export function wrap(text, max = 26) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

const FONT = 'font-family="Helvetica Neue, Arial, sans-serif"';

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
export function timelineSvg({ phases, stages }, { id = 'timeline' } = {}) {
  const preStages = stages.filter((s) => !s.clock);
  const clocked = stages.filter((s) => s.clock);
  const W = 1100;
  const left = 30, right = 30;
  const preW = 300;                           // the getting-ready zone
  const monthsW = W - left - right - preW - 20;
  const monthX = (m) => left + preW + (m / 32) * monthsW;
  const bandY = 44, bandH = 30;
  const axisY = bandY + bandH + 26;
  const preRowH = 24;
  const clockRowH = 46;
  const preRows = preStages.length;
  const H = axisY + 40 + Math.max(preRows * preRowH, 4 * clockRowH) + 46;
  const g = [];
  const phaseOf = (s) => phases.find((p) => p.id === s.phase);
  // Phase bands; narrow ones get their label above the band.
  const pre = phases.find((p) => p.id === 'get-ready');
  g.push(`<rect x="${left}" y="${bandY}" width="${preW - 8}" height="${bandH}" fill="${pre.colour}" />`);
  g.push(`<text x="${left + 8}" y="${bandY + 20}" fill="#fff" font-size="14" font-weight="bold">${esc(pre.title)} · no time limit</text>`);
  for (const p of phases.filter((p) => p.months)) {
    const [a, b] = p.months;
    const x = monthX(a - 1), w = monthX(b) - x;
    g.push(`<rect x="${x}" y="${bandY}" width="${w - 2}" height="${bandH}" fill="${p.colour}" />`);
    const label = `${p.title} · ${p.label}`;
    if (w > label.length * 7.5 + 12) g.push(`<text x="${x + 6}" y="${bandY + 20}" fill="#fff" font-size="13" font-weight="bold">${esc(label)}</text>`);
    else g.push(`<text x="${x + (w - 2) / 2}" y="${bandY - 8}" text-anchor="${b >= 30 ? 'end' : 'middle'}" fill="#0b0c0c" font-size="12" font-weight="bold">${esc(label)}</text>`);
  }
  // The month axis
  g.push(`<line x1="${left}" y1="${axisY}" x2="${W - right}" y2="${axisY}" stroke="#0b0c0c" stroke-width="2" />`);
  for (let m = 0; m <= 30; m += 3) {
    const x = monthX(m);
    g.push(`<line x1="${x}" y1="${axisY - 5}" x2="${x}" y2="${axisY + 5}" stroke="#0b0c0c" stroke-width="2" />`);
    g.push(`<text x="${x}" y="${axisY + 20}" text-anchor="middle" font-size="12" fill="#0b0c0c">${m === 0 ? 'Gateway 1' : 'Month ' + m}</text>`);
  }
  // Getting ready: one row per task, in order, drawn as a mini list with a tick on the axis.
  preStages.forEach((s, i) => {
    const y = axisY + 44 + i * preRowH;
    const x = left + 14 + (i / Math.max(1, preRows - 1)) * (preW - 60);
    const colour = phaseOf(s).colour;
    g.push(`<line x1="${x}" y1="${axisY}" x2="${x}" y2="${y - 8}" stroke="#b1b4b6" stroke-width="1" stroke-dasharray="3 3" />`);
    if (s.kind === 'gateway') g.push(`<polygon points="${x},${y - 9} ${x + 9},${y} ${x},${y + 9} ${x - 9},${y}" fill="#ffdd00" stroke="#0b0c0c" stroke-width="2" />`);
    else if (s.kind === 'consultation') g.push(`<rect x="${x - 10}" y="${y - 7}" width="20" height="14" fill="${colour}" rx="2" />`);
    else g.push(`<circle cx="${x}" cy="${y}" r="6" fill="#fff" stroke="${colour}" stroke-width="3" />`);
    g.push(`<text x="${x + 14}" y="${y + 4}" font-size="12" fill="#0b0c0c">${esc(s.short)}</text>`);
  });
  // Clocked stages on four alternating rows, placed by month.
  clocked.forEach((s, i) => {
    const [a, b] = s.clock;
    const x1 = monthX(a), x2 = monthX(b), x = (x1 + x2) / 2;
    const y = axisY + 50 + (i % 4) * clockRowH;
    const colour = phaseOf(s).colour;
    g.push(`<line x1="${x}" y1="${axisY}" x2="${x}" y2="${y - 12}" stroke="#b1b4b6" stroke-width="1" stroke-dasharray="3 3" />`);
    if (s.kind === 'gateway') g.push(`<polygon points="${x},${y - 12} ${x + 12},${y} ${x},${y + 12} ${x - 12},${y}" fill="#ffdd00" stroke="#0b0c0c" stroke-width="2" />`);
    else if (s.kind === 'consultation' || s.kind === 'examination') g.push(`<rect x="${x1}" y="${y - 9}" width="${Math.max(14, x2 - x1)}" height="18" fill="${colour}" rx="2" />`);
    else g.push(`<circle cx="${x}" cy="${y}" r="7" fill="#fff" stroke="${colour}" stroke-width="3" />`);
    const anchor = x > W - 120 ? 'end' : 'middle';
    g.push(`<text x="${anchor === 'end' ? x + 10 : x}" y="${y + 27}" text-anchor="${anchor}" font-size="12" fill="#0b0c0c">${esc(s.short)}</text>`);
  });
  // Key
  const ky = H - 16;
  g.push(`<polygon points="${left + 8},${ky - 8} ${left + 16},${ky} ${left + 8},${ky + 8} ${left},${ky}" fill="#ffdd00" stroke="#0b0c0c" stroke-width="2" /><text x="${left + 24}" y="${ky + 4}" font-size="12">gateway</text>`);
  g.push(`<rect x="${left + 100}" y="${ky - 7}" width="26" height="14" fill="#1d70b8" rx="2" /><text x="${left + 134}" y="${ky + 4}" font-size="12">consultation or examination, at its minimum length</text>`);
  g.push(`<circle cx="${left + 470}" cy="${ky}" r="6" fill="#fff" stroke="#1d70b8" stroke-width="3" /><text x="${left + 484}" y="${ky + 4}" font-size="12">task</text>`);
  const desc = `The 30-month local plan process. Getting ready has no time limit and ends at Gateway 1. Preparing the plan runs from month 1 to month 23, examination from month 24 to 29, adoption in months 30 to 31, then monitoring. Gateways are shown as diamonds, consultations and the examination as bars, other tasks as circles. The full sequence is listed in the text below the diagram.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-title ${id}-desc" ${FONT}>
<title id="${id}-title">The 30-month local plan process timeline</title>
<desc id="${id}-desc">${esc(desc)}</desc>
${g.join('\n')}
</svg>`;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------
const KIND_STYLE = {
  step: { fill: '#ffffff', stroke: '#0b0c0c', width: 2 },
  gateway: { fill: '#fff7bf', stroke: '#0b0c0c', width: 3 },
  decision: { fill: '#f3f2f1', stroke: '#505a5f', width: 2, dash: '6 4' },
  good: { fill: '#e8f3ec', stroke: '#00703c', width: 3 },
  bad: { fill: '#fbe9e7', stroke: '#d4351c', width: 3 },
  note: { fill: '#ffffff', stroke: '#b1b4b6', width: 1, dash: '3 3' },
};

export function flowSvg(flow, { id = 'flow' } = {}) {
  const colW = 262, rowH = 120, boxW = 220, boxH = 84, pad = 30;
  const cols = Math.max(...flow.nodes.map((n) => n.col)) + 1;
  const rows = Math.max(...flow.nodes.map((n) => n.row)) + 1;
  const W = pad * 2 + cols * colW - (colW - boxW), H = pad * 2 + rows * rowH - (rowH - boxH);
  const pos = new Map(flow.nodes.map((n) => [n.id, { x: pad + n.col * colW, y: pad + n.row * rowH }]));
  const g = [];
  const mid = (n) => ({ x: pos.get(n).x + boxW / 2, y: pos.get(n).y + boxH / 2 });
  // Edges first, so boxes sit on top.
  for (const e of flow.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    const A = mid(e.from), B = mid(e.to);
    let d, lx, ly;
    if (a.x === b.x) {
      // vertical
      const y1 = a.y < b.y ? a.y + boxH : a.y, y2 = a.y < b.y ? b.y : b.y + boxH;
      d = `M${A.x},${y1} L${A.x},${y2}`; lx = A.x + 8; ly = (y1 + y2) / 2 + 4;
    } else if (a.y === b.y) {
      const x1 = a.x < b.x ? a.x + boxW : a.x, x2 = a.x < b.x ? b.x : b.x + boxW;
      d = `M${x1},${A.y} L${x2},${A.y}`; lx = (x1 + x2) / 2; ly = A.y - 8;
    } else {
      // elbow: out of the side towards the target column, then vertical into the target
      const dir = b.x > a.x ? 1 : -1;
      const x1 = dir > 0 ? a.x + boxW : a.x;
      const yIn = a.y < b.y ? b.y : b.y + boxH;
      d = `M${x1},${A.y} L${B.x},${A.y} L${B.x},${yIn}`; lx = (x1 + B.x) / 2; ly = A.y - 8;
    }
    g.push(`<path d="${d}" fill="none" stroke="#0b0c0c" stroke-width="2" marker-end="url(#${id}-arrow)" />`);
    if (e.label) {
      const w = e.label.length * 7 + 10;
      g.push(`<rect x="${lx - w / 2}" y="${ly - 12}" width="${w}" height="17" fill="#fff" />`);
      g.push(`<text x="${lx}" y="${ly}" text-anchor="middle" font-size="12" fill="#0b0c0c">${esc(e.label)}</text>`);
    }
  }
  for (const n of flow.nodes) {
    const p = pos.get(n.id); const st = KIND_STYLE[n.kind] ?? KIND_STYLE.step;
    g.push(`<rect x="${p.x}" y="${p.y}" width="${boxW}" height="${boxH}" rx="3" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''} />`);
    const lines = wrap(n.text, 30);
    const fs = lines.length > 3 ? 11.5 : 12.5;
    const whenH = n.when ? 14 : 0;
    const y0 = p.y + whenH + (boxH - whenH) / 2 - ((lines.length - 1) * (fs + 2.5)) / 2 + 4;
    if (n.when) g.push(`<text x="${p.x + boxW / 2}" y="${p.y + 13}" text-anchor="middle" font-size="10.5" fill="#505a5f">${esc(n.when)}</text>`);
    lines.forEach((l, i) => g.push(`<text x="${p.x + boxW / 2}" y="${y0 + i * (fs + 2.5)}" text-anchor="middle" font-size="${fs}" fill="#0b0c0c"${n.kind === 'gateway' ? ' font-weight="bold"' : ''}>${esc(l)}</text>`));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-title ${id}-desc" ${FONT}>
<title id="${id}-title">${esc(flow.title)}</title>
<desc id="${id}-desc">${esc(flow.desc)}</desc>
<defs><marker id="${id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#0b0c0c" /></marker></defs>
${g.join('\n')}
</svg>`;
}

export function mermaidText(flow) {
  const lines = ['flowchart TD'];
  for (const n of flow.nodes) {
    const t = n.text.replace(/"/g, "'");
    lines.push(`  ${n.id}${n.kind === 'decision' ? `{"${t}"}` : n.kind === 'gateway' ? `[["${t}"]]` : `["${t}"]`}`);
  }
  for (const e of flow.edges) lines.push(`  ${e.from} -->${e.label ? `|${e.label.replace(/\|/g, '/')}|` : ''} ${e.to}`);
  return lines.join('\n');
}
