// scripts/lib/diagrams.mjs — accessible, animated SVG diagrams generated from data.
//
// Two renderers, both pure functions of the content:
//   timelineSvg(model)   the whole process as a route map: getting ready as a
//                        lead-in, then the 30-month clock as a line coloured by
//                        phase, with every stage a station you can open
//   flowSvg(flow)        a process flow of cards and routed connectors, laid out
//                        on the grid the data specifies (col, row)
// plus mermaidText(flow), the same flow as Mermaid source.
//
// Motion. The SVG is complete and readable as drawn: nothing depends on
// animation, and without JavaScript, or with prefers-reduced-motion, it simply
// shows the finished picture. src/client/viz.ts arms a diagram as it scrolls into
// view and plays it once (cards and stations in order, connectors drawing
// themselves, a marker running the route); the CSS is in src/styles/app.scss
// under "Animated diagrams". Elements carry `--i`, their place in the sequence.
//
// Accessibility: a <title> and <desc> on every diagram, colour always paired
// with shape and words, every page that shows a diagram also shows its content
// as a list or table, and the timeline's stations are real links with names.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;

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

/** Roughly how wide a line of Arial is, in px — enough to keep labels apart. */
const textWidth = (s, size, bold = false) => String(s).length * size * (bold ? 0.58 : 0.53);

const FONT = 'font-family="Arial, Helvetica, sans-serif"';
const INK = '#0b0c0c';
const GREY = '#505a5f';
const RULE = '#b1b4b6';

/** The shared <defs>: a soft card shadow and a glow for moving markers. */
const defs = (id) => `<defs>
<filter id="${id}-shadow" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.2" flood-color="#0b0c0c" flood-opacity="0.14"/></filter>
<filter id="${id}-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>`;

// ---------------------------------------------------------------------------
// Timeline: a route map
// ---------------------------------------------------------------------------

/**
 * Put each label in the first lane where it clears the label before it, nudging
 * it sideways a little if that is all it takes. Returns the lane per label.
 */
function assignLanes(items, lanes, gap = 10, nudge = 36) {
  const ends = new Array(lanes).fill(-Infinity);
  for (const it of items) {
    let placed = false;
    for (let l = 0; l < lanes && !placed; l++) {
      const room = it.x0 - (ends[l] + gap);
      if (room >= 0 || room >= -nudge) {
        const shift = Math.max(0, -room);
        it.x0 += shift; it.x1 += shift; it.lane = l; ends[l] = it.x1; placed = true;
      }
    }
    if (!placed) {
      // Every lane is full here: take the one that ends earliest and push along.
      const l = ends.indexOf(Math.min(...ends));
      const shift = ends[l] + gap - it.x0;
      it.x0 += shift; it.x1 += shift; it.lane = l; ends[l] = it.x1;
    }
  }
  return items;
}

export function timelineSvg({ phases, stages }, { id = 'timeline', href = null } = {}) {
  const W = 1200;
  const left = 34, right = 34;
  const leadX0 = left + 6, clockX0 = 392;            // Gateway 1 is month 0
  const onwardsW = 84;                                // monitoring runs on past the clock
  const clockX1 = W - right - onwardsW;               // month 31
  const monthX = (m) => (m <= 31 ? clockX0 + (m / 31) * (clockX1 - clockX0) : clockX1 + Math.min(1, (m - 31) / 5) * onwardsW);
  const trackY = 176;
  const phase = Object.fromEntries(phases.map((p) => [p.id, p]));
  const pre = stages.filter((s) => !s.clock);
  const clocked = stages.filter((s) => s.clock);
  const g = [];

  // Where each stage sits on the line. Getting-ready stages are spaced evenly
  // along the lead-in in their order; the rest are placed by month.
  const preStep = (clockX0 - 40 - leadX0) / Math.max(1, pre.length - 1);
  const stops = [
    ...pre.map((s, i) => ({ s, x: leadX0 + 18 + i * preStep, x1: null })),
    ...clocked.map((s) => {
      const [a, b] = s.clock;
      const span = s.kind === 'consultation' || s.kind === 'examination';
      return span ? { s, x: (monthX(a) + monthX(b)) / 2, xa: monthX(a), xb: monthX(b), span: true } : { s, x: s.kind === 'gateway' ? monthX(a) + (b > a ? (monthX(b) - monthX(a)) / 2 : 0) : (monthX(a) + monthX(Math.min(b, 31.6))) / 2 };
    }),
  ].sort((p, q) => p.x - q.x);
  // Submission opens the examination and the Inspector's report closes it, so
  // they sit on its two ends rather than crowding in beside it.
  for (const span of stops.filter((st) => st.span && st.s.kind === 'examination')) {
    for (const st of stops.filter((t) => !t.span && t.s.kind !== 'gateway' && t.s.clock)) {
      if (st.s.clock[1] === span.s.clock[0]) st.x = span.xa;
      else if (st.s.clock[0] === span.s.clock[1]) st.x = span.xb;
    }
  }
  // Then keep neighbouring stations clear of each other.
  stops.sort((p, q) => p.x - q.x);
  let prev = null;
  for (const st of stops) {
    if (st.span) continue;
    if (prev) {
      const gap = prev.s.kind === 'gateway' || st.s.kind === 'gateway' ? 32 : 26;
      if (st.x - prev.x < gap) st.x = prev.x + gap;
    }
    prev = st;
  }
  // Spans first, so stations on their ends sit on top of them.
  stops.sort((p, q) => (p.span === q.span ? p.x - q.x : p.span ? -1 : 1));
  [...stops].sort((p, q) => p.x - q.x).forEach((st, i) => { st.i = i; });

  // --- header: the clock bracket and the live month readout -----------------
  const bx0 = monthX(0), bx1 = monthX(30);
  g.push(`<g class="v-fade" style="--i:0">
<text x="${left}" y="34" font-size="15" font-weight="bold" fill="${INK}">Getting ready</text>
<text x="${left}" y="54" font-size="13" fill="${GREY}">No time limit — three steps must happen in order</text>
<path d="M${bx0},62 V54 H${bx1} V62" fill="none" stroke="${INK}" stroke-width="1.5"/>
<text x="${bx0 + 10}" y="40" font-size="15" font-weight="bold" fill="${INK}">The 30-month clock</text>
<text x="${bx0 + 166}" y="40" font-size="13" fill="${GREY}">from Gateway 1 to adoption</text>
</g>`);
  g.push(`<g class="v-counter" aria-hidden="true"><rect x="${bx1 - 128}" y="18" width="128" height="30" rx="15" fill="${INK}"/><text class="v-counter__text" x="${bx1 - 64}" y="38" text-anchor="middle" font-size="14" font-weight="bold" fill="#fff">30 months</text></g>`);

  // --- phase chapters above the line -----------------------------------------
  const chapters = [
    { p: phase['get-ready'], x0: leadX0, x1: clockX0 - 4 },
    ...phases.filter((p) => p.months).map((p) => ({ p, x0: monthX(p.months[0] - 1), x1: p.id === 'monitor' ? W - right : monthX(p.months[1]) })),
  ].filter((c) => c.p);
  const chapterLabels = assignLanes(chapters.map((c) => {
    const w = textWidth(c.p.title, 13, true) + 8;
    const cx = (c.x0 + c.x1) / 2;
    return { c, x0: Math.max(c.x0, Math.min(cx - w / 2, c.x1 - w)), x1: 0, w };
  }).map((l) => ({ ...l, x1: l.x0 + l.w })), 2, 6, 0);
  chapterLabels.forEach((l, k) => {
    const y = l.lane === 0 ? 110 : 90;
    g.push(`<g class="v-fade" style="--i:${k + 1}"><rect x="${r1(l.c.x0)}" y="118" width="${r1(Math.max(4, l.c.x1 - l.c.x0 - 3))}" height="4" rx="2" fill="${l.c.p.colour}"/>
<text x="${r1(l.x0)}" y="${y}" font-size="13" font-weight="bold" fill="${l.c.p.colour === '#b58840' ? '#594d00' : l.c.p.colour}">${esc(l.c.p.title)}</text>${l.lane ? `<line x1="${r1(l.x0 + 3)}" y1="${y + 4}" x2="${r1(l.x0 + 3)}" y2="117" stroke="${l.c.p.colour}" stroke-width="1.5"/>` : ''}</g>`);
  });

  // --- the line: a dashed lead-in, then the clock coloured by phase ----------
  const line = [];
  line.push(`<line x1="${leadX0}" y1="${trackY}" x2="${clockX0}" y2="${trackY}" stroke="${phase['get-ready'].colour}" stroke-width="6" stroke-linecap="round" stroke-dasharray="2 12"/>`);
  for (const p of phases.filter((p) => p.months)) {
    const x0 = monthX(p.months[0] - 1), x1 = p.id === 'monitor' ? W - right - 14 : monthX(p.months[1]);
    line.push(`<line x1="${r1(x0)}" y1="${trackY}" x2="${r1(x1)}" y2="${trackY}" stroke="${p.colour}" stroke-width="8"${p.id === 'prepare' ? ' stroke-linecap="round"' : ''}/>`);
  }
  // Monitoring carries on: an arrowhead off the end of the line.
  line.push(`<path d="M${W - right - 16},${trackY - 9} L${W - right},${trackY} L${W - right - 16},${trackY + 9} z" fill="${phase.monitor.colour}"/>`);
  // Month ticks under the line.
  for (let m = 0; m <= 30; m += 3) {
    const x = r1(monthX(m));
    line.push(`<line x1="${x}" y1="${trackY + 9}" x2="${x}" y2="${trackY + 15}" stroke="${GREY}" stroke-width="1.5"/><text x="${x}" y="${trackY + 28}" text-anchor="middle" font-size="11" fill="${GREY}">${m === 0 ? 'Month 0' : m}</text>`);
  }
  g.push(`<g class="v-wipe">${line.join('')}</g>`);

  // --- labels under the line, in lanes, with leaders -------------------------
  const laneY0 = trackY + 62, laneH = 40, lanes = 4;
  const labelled = assignLanes(stops.map((st) => {
    const lines = wrap(st.s.short, 17);
    const w = Math.max(...lines.map((l) => textWidth(l, 12.5, st.s.kind === 'gateway'))) + 4;
    const x0 = Math.min(W - right - w, Math.max(left, st.x - w / 2));
    return { st, lines, w, x0, x1: x0 + w };
  }).sort((p, q) => p.x0 - q.x0), lanes, 12, 30);

  // --- stations ---------------------------------------------------------------
  for (const st of stops) {
    const s = st.s, colour = phase[s.phase]?.colour ?? GREY;
    const lab = labelled.find((l) => l.st === st);
    const ly = laneY0 + lab.lane * laneH;
    const shape = [];
    shape.push(st.span
      ? `<rect class="v-focus" opacity="0" x="${r1(st.xa - 6)}" y="${trackY - 17}" width="${r1(Math.max(16, st.xb - st.xa) + 12)}" height="34" rx="17" fill="#ffdd00"/>`
      : `<circle class="v-focus" opacity="0" cx="${r1(st.x)}" cy="${trackY}" r="21" fill="#ffdd00"/>`);
    if (st.span) {
      shape.push(`<rect x="${r1(st.xa)}" y="${trackY - 11}" width="${r1(Math.max(16, st.xb - st.xa))}" height="22" rx="11" fill="#fff" stroke="${colour}" stroke-width="3"/>`);
      shape.push(`<rect x="${r1(st.xa + 5)}" y="${trackY - 4}" width="${r1(Math.max(6, st.xb - st.xa - 10))}" height="8" rx="4" fill="${colour}" opacity="0.35"/>`);
    } else if (s.kind === 'gateway') {
      shape.push(`<circle class="v-ring" cx="${r1(st.x)}" cy="${trackY}" r="15" fill="none" stroke="#ffdd00" stroke-width="3" opacity="0"/>`);
      shape.push(`<path d="M${r1(st.x)},${trackY - 15} L${r1(st.x + 15)},${trackY} L${r1(st.x)},${trackY + 15} L${r1(st.x - 15)},${trackY} z" fill="#ffdd00" stroke="${INK}" stroke-width="2.5"/>`);
    } else if (s.kind === 'adoption') {
      shape.push(`<circle cx="${r1(st.x)}" cy="${trackY}" r="11" fill="${colour}" stroke="#fff" stroke-width="3"/><path d="M${r1(st.x - 5)},${trackY} l3.5,3.5 l6.5,-7" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`);
    } else {
      shape.push(`<circle cx="${r1(st.x)}" cy="${trackY}" r="${s.phase === 'get-ready' ? 7 : 8}" fill="#fff" stroke="${colour}" stroke-width="3.5"/>`);
    }
    const tx = lab.x0 + lab.w / 2;
    const label = lab.lines.map((l, k) => `<tspan x="${r1(tx)}" dy="${k ? 14 : 0}">${esc(l)}</tspan>`).join('');
    const leader = `<path d="M${r1(st.x)},${trackY + (s.kind === 'gateway' ? 17 : 13)} V${ly - 22} L${r1(tx)},${ly - 14}" fill="none" stroke="${RULE}" stroke-width="1"/>`;
    const text = `<text x="${r1(tx)}" y="${ly}" text-anchor="middle" font-size="12.5" fill="${INK}"${s.kind === 'gateway' ? ' font-weight="bold"' : ''}>${label}</text>`;
    const name = `${s.title}. ${s.when ?? ''}`.trim();
    const open = href ? `<a href="${esc(href(s.id))}" class="v-station" aria-label="${esc(name)}"><title>${esc(name)}</title>` : `<g class="v-station"><title>${esc(name)}</title>`;
    g.push(`<g class="v-label" style="--i:${st.i}">${leader}${text}</g>`);
    g.push(`${open}<g class="v-pop" style="--i:${st.i}">${shape.join('')}</g>${href ? '</a>' : '</g>'}`);
  }

  // --- the clock running: a marker from Gateway 1 to adoption ----------------
  const adoption = stops.find((st) => st.s.kind === 'adoption');
  const runTo = adoption ? adoption.x : monthX(30);
  g.push(`<g class="v-runner" aria-hidden="true"><circle r="9" fill="#ffdd00" stroke="${INK}" stroke-width="2.5" filter="url(#${id}-glow)" opacity="0"><animateMotion id="${id}-run" class="v-motion" data-duration="5" data-linger="900" data-counter="30" begin="indefinite" dur="5s" fill="freeze" path="M${r1(clockX0)},${trackY} L${r1(runTo)},${trackY}"/></circle></g>`);

  // --- key ----------------------------------------------------------------------
  const usedLanes = Math.max(...labelled.map((l) => l.lane)) + 1;
  const H = laneY0 + (usedLanes - 1) * laneH + 14 * 2 + 50;
  const ky = H - 18;
  g.push(`<g class="v-fade" style="--i:3" font-size="12.5" fill="${INK}">
<path d="M${left + 9},${ky - 9} L${left + 18},${ky} L${left + 9},${ky + 9} L${left},${ky} z" fill="#ffdd00" stroke="${INK}" stroke-width="2"/><text x="${left + 26}" y="${ky + 4}">gateway</text>
<rect x="${left + 104}" y="${ky - 8}" width="34" height="16" rx="8" fill="#fff" stroke="#1d70b8" stroke-width="2.5"/><text x="${left + 146}" y="${ky + 4}">consultation or examination, at its minimum length</text>
<circle cx="${left + 470}" cy="${ky}" r="7" fill="#fff" stroke="#1d70b8" stroke-width="3"/><text x="${left + 484}" y="${ky + 4}">task</text>
${href ? `<text x="${W - right}" y="${ky + 4}" text-anchor="end" fill="${GREY}">Select a stage to open it</text>` : ''}
</g>`);

  const desc = 'The 30-month local plan process as a route. Getting ready has no time limit and ends at Gateway 1: the SEA check, the timetable, the notice to commence, governance and the project initiation document, the scoping consultation, and baselining and vision. The 30-month clock starts at Gateway 1. Preparing the plan runs from month 1 to month 23, with the content and evidence consultation around months 7 to 9, Gateway 2 around months 14 to 16, the proposed plan consultation around months 18 to 21 and Gateway 3 around month 22. Examination runs from month 24 to 29, adoption in months 30 to 31, then monitoring. The same sequence is listed in words below the diagram.';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="lpn-svg lpn-svg--timeline" ${href ? 'role="group"' : 'role="img"'} aria-labelledby="${id}-title" aria-describedby="${id}-desc" ${FONT}>
<title id="${id}-title">The 30-month local plan process timeline</title>
<desc id="${id}-desc">${esc(desc)}</desc>
${defs(id)}
${g.join('\n')}
</svg>`;
}

// ---------------------------------------------------------------------------
// Flow: cards and routed connectors
// ---------------------------------------------------------------------------
const KIND = {
  step: { accent: '#1d70b8', fill: '#ffffff', border: '#b1b4b6' },
  gateway: { accent: '#ffdd00', fill: '#fffbe0', border: INK, tag: 'Gateway' },
  decision: { accent: GREY, fill: '#f3f2f1', border: GREY, dash: '5 4', tag: 'Decision' },
  good: { accent: '#00703c', fill: '#f0f8f3', border: '#00703c', tag: 'Outcome' },
  bad: { accent: '#d4351c', fill: '#fdf1ef', border: '#d4351c', tag: 'Not yet' },
  note: { accent: RULE, fill: '#ffffff', border: RULE, dash: '3 3' },
};

/** A polyline with its corners rounded, as an SVG path. */
function rounded(points, radius = 10) {
  let d = `M${r1(points[0][0])},${r1(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1], [x, y] = points[i], [nx, ny] = points[i + 1];
    const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const ax = x - ((x - px) / l1) * r, ay = y - ((y - py) / l1) * r;
    const bx = x + ((nx - x) / l2) * r, by = y + ((ny - y) / l2) * r;
    d += ` L${r1(ax)},${r1(ay)} Q${r1(x)},${r1(y)} ${r1(bx)},${r1(by)}`;
  }
  const last = points[points.length - 1];
  return d + ` L${r1(last[0])},${r1(last[1])}`;
}

export function flowSvg(flow, { id = 'flow' } = {}) {
  const cardW = 236, gapX = 64, gapY = 46, pad = 26, lineH = 16.5;
  const cols = Math.max(...flow.nodes.map((n) => n.col)) + 1;
  const rows = Math.max(...flow.nodes.map((n) => n.row)) + 1;
  const cell = new Map(flow.nodes.map((n) => [`${n.col},${n.row}`, n]));
  // Card heights from their wrapped text; each row is as tall as its tallest card.
  const layout = new Map(flow.nodes.map((n) => {
    const lines = wrap(n.text, 28);
    // A header (the step number, and a tag and the timing beside it), then the text.
    const st = KIND[n.kind] ?? KIND.step;
    const meta = wrap([st.tag && n.kind !== 'note' ? st.tag.toUpperCase() : null, n.when].filter(Boolean).join(' · '), 31).filter(Boolean);
    const extra = Math.max(0, meta.length - 1) * 14;
    const h = 46 + extra + lines.length * lineH + 8;
    return [n.id, { n, lines, meta, extra, h }];
  }));
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(64, ...flow.nodes.filter((n) => n.row === r).map((n) => layout.get(n.id).h)));
  const rowY = rowH.reduce((acc, h, r) => { acc.push(r ? acc[r - 1] + rowH[r - 1] + gapY : pad + 6); return acc; }, []);
  const colX = (c) => pad + c * (cardW + gapX);
  for (const L of layout.values()) {
    L.x = colX(L.n.col);
    L.y = rowY[L.n.row] + (rowH[L.n.row] - L.h) / 2;
    L.cx = L.x + cardW / 2; L.cy = L.y + L.h / 2;
  }
  const W = pad * 2 + cols * cardW + (cols - 1) * gapX + 14;
  const H = rowY[rows - 1] + rowH[rows - 1] + pad + 4;
  const order = new Map(flow.nodes.map((n, i) => [n.id, i]));
  const empty = (c, r) => !cell.has(`${c},${r}`);
  const between = (a, b) => Array.from({ length: Math.max(0, Math.abs(b - a) - 1) }, (_, k) => Math.min(a, b) + k + 1);

  /** The route for one connector, as points, and where its label sits. */
  function route(e) {
    const A = layout.get(e.from), B = layout.get(e.to);
    const ac = A.n.col, ar = A.n.row, bc = B.n.col, br = B.n.row;
    if (ac === bc) {
      const clear = between(ar, br).every((r) => empty(ac, r));
      if (clear) {
        return br > ar ? { pts: [[A.cx, A.y + A.h], [B.cx, B.y]], label: [A.cx + 10, (A.y + A.h + B.y) / 2] }
          : { pts: [[A.cx, A.y], [B.cx, B.y + B.h]], label: [A.cx + 10, (A.y + B.y + B.h) / 2] };
      }
      // Something in the way: loop round the right-hand side.
      const gx = A.x + cardW + gapX / 2;
      return { pts: [[A.x + cardW, A.cy], [gx, A.cy], [gx, B.cy], [B.x + cardW, B.cy]], label: [gx + 6, (A.cy + B.cy) / 2] };
    }
    const dir = bc > ac ? 1 : -1;
    const sideA = dir > 0 ? A.x + cardW : A.x, sideB = dir > 0 ? B.x : B.x + cardW;
    if (ar === br && between(ac, bc).every((c) => empty(c, ar))) {
      return { pts: [[sideA, A.cy], [sideB, B.cy]], label: [(sideA + sideB) / 2, A.cy - 9] };
    }
    if (br > ar) {
      // Down then across into the side, if the source's column is clear down to the target's row…
      if (empty(ac, br) && between(ar, br).every((r) => empty(ac, r))) {
        return { pts: [[A.cx, A.y + A.h], [A.cx, B.cy], [sideB, B.cy]], label: [A.cx + 10, A.y + A.h + 18] };
      }
      // …otherwise along the gap below the source row and down into the top.
      const gy = rowY[ar] + rowH[ar] + gapY / 2;
      return { pts: [[A.cx, A.y + A.h], [A.cx, gy], [B.cx, gy], [B.cx, B.y]], label: [(A.cx + B.cx) / 2, gy - 8] };
    }
    // Back up to an earlier row in another column: run up the gutter between them.
    const gx = dir > 0 ? A.x + cardW + gapX / 2 : A.x - gapX / 2;
    const into = dir > 0 ? B.x : B.x + cardW;
    return { pts: [[dir > 0 ? A.x + cardW : A.x, A.cy], [gx, A.cy], [gx, B.cy], [into, B.cy]], label: [gx, (A.cy + B.cy) / 2], loop: true };
  }

  const edges = [], heads = [], labels = [], runs = [];
  flow.edges.forEach((e, k) => {
    const { pts, label, loop } = route(e);
    const d = rounded(pts);
    const [px, py] = pts[pts.length - 2], [x, y] = pts[pts.length - 1];
    const ang = Math.atan2(y - py, x - px);
    const hx = (t, s) => r1(x - Math.cos(ang) * t + Math.cos(ang + Math.PI / 2) * s);
    const hy = (t, s) => r1(y - Math.sin(ang) * t + Math.sin(ang + Math.PI / 2) * s);
    const step = Math.max(order.get(e.from), order.get(e.to));
    edges.push(loop
      ? `<path class="v-fade" style="--i:${step}" d="${d}" fill="none" stroke="${GREY}" stroke-width="2" stroke-dasharray="6 5"/>`
      : `<path class="v-draw" style="--i:${step}" pathLength="1" d="${d}" fill="none" stroke="${INK}" stroke-width="2"/>`);
    heads.push(`<path class="v-fade" style="--i:${step + 1}" d="M${r1(x)},${r1(y)} L${hx(11, 5.5)},${hy(11, 5.5)} L${hx(11, -5.5)},${hy(11, -5.5)} z" fill="${loop ? GREY : INK}"/>`);
    if (e.label) {
      const w = textWidth(e.label, 12, true) + 16;
      labels.push(`<g class="v-fade" style="--i:${step + 1}"><rect x="${r1(label[0] - w / 2)}" y="${r1(label[1] - 11)}" width="${r1(w)}" height="20" rx="10" fill="#fff" stroke="${e.label === 'no' || e.label === 'not done' ? '#d4351c' : e.label === 'yes' || e.label === 'work done' ? '#00703c' : GREY}" stroke-width="1.5"/><text x="${r1(label[0])}" y="${r1(label[1] + 3.5)}" text-anchor="middle" font-size="12" font-weight="bold" fill="${INK}">${esc(e.label)}</text></g>`);
    }
    runs.push({ d, k });
  });

  const cards = flow.nodes.map((n, i) => {
    const L = layout.get(n.id), st = KIND[n.kind] ?? KIND.step;
    const parts = [];
    parts.push(`<rect x="${r1(L.x)}" y="${r1(L.y)}" width="${cardW}" height="${r1(L.h)}" rx="8" fill="${st.fill}" stroke="${st.border}" stroke-width="${n.kind === 'gateway' ? 2.5 : 1.5}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''} filter="url(#${id}-shadow)"/>`);
    parts.push(`<path d="M${r1(L.x + 8)},${r1(L.y)} h-0.5 a8,8 0 0 0 -7.5,8 v${r1(L.h - 16)} a8,8 0 0 0 7.5,8 h0.5 z" fill="${st.accent}"/>`);
    // The step number, then a tag or the timing on the first line.
    parts.push(`<circle cx="${r1(L.x + 26)}" cy="${r1(L.y + 21)}" r="11" fill="${n.kind === 'gateway' ? INK : st.accent}"/><text x="${r1(L.x + 26)}" y="${r1(L.y + 25.5)}" text-anchor="middle" font-size="12" font-weight="bold" fill="${n.kind === 'gateway' ? '#ffdd00' : '#fff'}">${i + 1}</text>`);
    L.meta.forEach((m, k) => parts.push(`<text x="${r1(L.x + 44)}" y="${r1(L.y + 25.5 + k * 14)}" font-size="11" font-weight="bold" letter-spacing="0.3" fill="${GREY}">${esc(m)}</text>`));
    L.lines.forEach((line, k) => parts.push(`<text x="${r1(L.x + 16)}" y="${r1(L.y + 54 + L.extra + k * lineH)}" font-size="13.5" fill="${INK}"${n.kind === 'gateway' ? ' font-weight="bold"' : ''}>${esc(line)}</text>`));
    return `<g class="v-card" style="--i:${i}">${parts.join('')}</g>`;
  });

  // One marker per connector, run in order once the drawing is done.
  const runner = runs.map(({ d, k }) => `<circle r="6" fill="#1d70b8" stroke="#fff" stroke-width="2.5" filter="url(#${id}-glow)" opacity="0"><animateMotion id="${id}-run-${k}" class="v-motion" data-step="${k}" data-duration="0.7" begin="indefinite" dur="0.7s" fill="freeze" path="${d}"/></circle>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${r1(H)}" class="lpn-svg lpn-svg--flow" role="img" aria-labelledby="${id}-title ${id}-desc" ${FONT}>
<title id="${id}-title">${esc(flow.title)}</title>
<desc id="${id}-desc">${esc(flow.desc)}</desc>
${defs(id)}
<g>${edges.join('')}</g>
<g>${cards.join('')}</g>
<g>${heads.join('')}${labels.join('')}</g>
<g class="v-runner" aria-hidden="true">${runner}</g>
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
