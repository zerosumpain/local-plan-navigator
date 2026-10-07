// src/lib/gantt.ts — a Gantt-style chart of a Schedule as an SVG string.
//
// Used in the browser by the planner and at build time for the worked
// example, so it has no DOM dependencies. Milestones are grouped under their
// phase, the 30 months from Gateway 1 are shaded so a late adoption is plain to
// see, and every bar and diamond is labelled in text — phase is shown by
// grouping AND colour, never colour alone. Classes and `--i` drive the entrance
// animation in src/client/viz.ts; without it the chart is simply drawn.
import type { Schedule, Milestone } from './schedule.ts';
import { parseIso, formatDate, addMonths } from './schedule.ts';

const PHASES: { id: Milestone['phase']; title: string; colour: string }[] = [
  { id: 'get-ready', title: 'Getting ready', colour: '#505a5f' },
  { id: 'prepare', title: 'Preparing the plan', colour: '#1d70b8' },
  { id: 'examine', title: 'Examination', colour: '#6f2da8' },
  { id: 'adopt', title: 'Adoption', colour: '#00703c' },
];
const INK = '#0b0c0c', GREY = '#505a5f', RULE = '#b1b4b6';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n: number) => Math.round(n * 10) / 10;

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}

export function ganttSvg(schedule: Schedule, { id = 'gantt' } = {}): string {
  const all = schedule.milestones.filter((x) => x.phase !== 'monitor');
  const W = 1180, labelW = 372, chartX0 = labelW + 24, chartX1 = W - 24, top = 64;
  const t0 = parseIso(all[0].start).getTime();
  const tEnd = Math.max(...all.map((r) => parseIso(r.end).getTime()));
  const g1 = all.find((r) => r.id === 'gateway-1');
  const g1t = g1 ? parseIso(g1.start).getTime() : t0;
  const clockEnd = addMonths(new Date(g1t), 30).getTime();
  const t1 = Math.max(tEnd, clockEnd) + 20 * 86400000;
  const x = (t: number) => chartX0 + ((t - t0) / (t1 - t0)) * (chartX1 - chartX0);

  // Rows: a header per phase, then its milestones; long labels take two lines.
  type Row = { kind: 'phase'; phase: (typeof PHASES)[number]; y: number; h: number } | { kind: 'item'; m: Milestone; lines: string[]; y: number; h: number; i: number };
  const rows: Row[] = [];
  let y = top, i = 0;
  for (const phase of PHASES) {
    const items = all.filter((m) => m.phase === phase.id);
    if (!items.length) continue;
    rows.push({ kind: 'phase', phase, y, h: 30 });
    y += 30;
    for (const m of items) {
      const lines = wrap(m.label, 50).slice(0, 2);
      const h = lines.length > 1 ? 40 : 28;
      rows.push({ kind: 'item', m, lines, y, h, i: i++ });
      y += h;
    }
    y += 6;
  }
  const H = y + 16;
  const g: string[] = [];

  // The calendar: years along the top, quarters as gridlines.
  const first = new Date(t0);
  for (let d = new Date(Date.UTC(first.getUTCFullYear(), Math.floor(first.getUTCMonth() / 3) * 3, 1)); d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + 3)) {
    const px = x(d.getTime());
    if (px < chartX0 - 1) continue;
    const isYear = d.getUTCMonth() === 0;
    g.push(`<line x1="${r1(px)}" y1="${top - 14}" x2="${r1(px)}" y2="${H - 16}" stroke="${isYear ? RULE : '#e5e6e7'}" stroke-width="1"/>`);
    g.push(`<text x="${r1(px + 4)}" y="${top - 18}" font-size="11" fill="${GREY}">${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}</text>`);
    if (isYear) g.push(`<text x="${r1(px + 4)}" y="${top - 36}" font-size="13" font-weight="bold" fill="${INK}">${d.getUTCFullYear()}</text>`);
  }

  // The 30 months from Gateway 1, shaded; the end marked.
  const cx0 = x(g1t), cx1 = x(clockEnd);
  g.push(`<g class="v-wipe"><rect x="${r1(cx0)}" y="${top - 8}" width="${r1(cx1 - cx0)}" height="${r1(H - top - 8)}" fill="#ffdd00" opacity="0.10"/>
<line x1="${r1(cx1)}" y1="${top - 10}" x2="${r1(cx1)}" y2="${H - 16}" stroke="${INK}" stroke-width="1.5" stroke-dasharray="5 4"/>
<rect x="${r1(cx1 - 112)}" y="${top - 12}" width="112" height="20" rx="10" fill="${INK}"/><text x="${r1(cx1 - 56)}" y="${top + 2}" text-anchor="middle" font-size="11.5" font-weight="bold" fill="#fff">30 months ends</text></g>`);

  for (const row of rows) {
    if (row.kind === 'phase') {
      g.push(`<g class="v-fade"><rect x="0" y="${row.y + 6}" width="6" height="18" rx="2" fill="${row.phase.colour}"/><text x="16" y="${row.y + 20}" font-size="14" font-weight="bold" fill="${INK}">${esc(row.phase.title)}</text><line x1="16" y1="${row.y + 28}" x2="${chartX1}" y2="${row.y + 28}" stroke="#e5e6e7"/></g>`);
      continue;
    }
    const { m, lines, h } = row;
    const colour = PHASES.find((p) => p.id === m.phase)?.colour ?? GREY;
    const mid = row.y + h / 2;
    if (row.i % 2 === 0) g.push(`<rect x="0" y="${row.y}" width="${W}" height="${h}" fill="#f3f2f1" opacity="0.55"/>`);
    g.push(`<text x="${labelW}" y="${r1(mid + 4.5 - (lines.length - 1) * 7.5)}" text-anchor="end" font-size="13" fill="${INK}">${lines.map((l, k) => `<tspan x="${labelW}" dy="${k ? 15 : 0}">${esc(l)}</tspan>`).join('')}</text>`);
    const a = x(parseIso(m.start).getTime()), b = x(parseIso(m.end).getTime());
    const when = m.kind === 'window' ? `${formatDate(m.start)} – ${formatDate(m.end)}` : m.kind === 'deadline' ? `by ${formatDate(m.start)}` : formatDate(m.start);
    const tip = `<title>${esc(m.label)}: ${esc(when)}</title>`;
    if (m.kind === 'window') {
      g.push(`<rect class="v-grow" style="--i:${row.i}" x="${r1(a)}" y="${r1(mid - 8)}" width="${r1(Math.max(6, b - a))}" height="16" rx="8" fill="${colour}">${tip}</rect>`);
    } else {
      const fill = m.kind === 'deadline' ? '#d4351c' : colour;
      g.push(`<path class="v-pop" style="--i:${row.i}" d="M${r1(a)},${r1(mid - 9)} L${r1(a + 9)},${r1(mid)} L${r1(a)},${r1(mid + 9)} L${r1(a - 9)},${r1(mid)} z" fill="${fill}" stroke="#fff" stroke-width="1.5">${tip}</path>`);
    }
    // The date beside it, or before it when it would run off the edge.
    const end = m.kind === 'window' ? Math.max(b, a + 6) : a;
    const textW = when.length * 6.2;
    const after = end + 14 + textW < W - 4;
    g.push(`<text class="v-fade" style="--i:${row.i}" x="${r1(after ? end + 14 : (m.kind === 'window' ? a : a) - 14)}" y="${r1(mid + 4)}" font-size="11.5" fill="${m.kind === 'deadline' ? '#aa2a16' : GREY}"${after ? '' : ' text-anchor="end"'}>${esc(when)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="lpn-svg lpn-gantt" role="img" aria-labelledby="${id}-title ${id}-desc" font-family="Arial, Helvetica, sans-serif">
<title id="${id}-title">Timetable chart</title>
<desc id="${id}-desc">Each milestone from the table drawn against a calendar and grouped by phase: bars for consultations, gateways and the examination, diamonds for single dates, red diamonds for statutory deadlines. The 30 months from Gateway 1 are shaded and their end marked. The table carries the same dates.</desc>
${g.join('\n')}
</svg>`;
}
