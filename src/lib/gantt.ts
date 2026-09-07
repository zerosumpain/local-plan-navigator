// src/lib/gantt.ts — a Gantt-style chart of a Schedule as an SVG string.
//
// Used in the browser by the planner and at build time for the worked
// example, so it has no DOM dependencies. Each bar is labelled in text and
// its phase is shown by colour AND by grouping, never colour alone.
import type { Schedule } from './schedule.ts';
import { parseIso, formatDate } from './schedule.ts';

const PHASE_COLOUR: Record<string, string> = { 'get-ready': '#505a5f', prepare: '#1d70b8', examine: '#6f2da8', adopt: '#00703c', monitor: '#b58840' };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function ganttSvg(schedule: Schedule, { id = 'gantt' } = {}): string {
  const rows = schedule.milestones.filter((x) => x.phase !== 'monitor');
  const labelW = 340, W = 1100, rowH = 28, top = 34, bottom = 20;
  const H = top + rows.length * rowH + bottom;
  const t0 = parseIso(rows[0].start).getTime();
  const t1 = parseIso(rows[rows.length - 1].end).getTime();
  const x = (t: number) => labelW + ((t - t0) / (t1 - t0)) * (W - labelW - 20);
  const g: string[] = [];
  // Month gridlines, one per quarter, labelled with the month
  const first = parseIso(rows[0].start);
  for (let d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1)); d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + 3)) {
    const px = x(d.getTime());
    g.push(`<line x1="${px.toFixed(1)}" y1="${top - 8}" x2="${px.toFixed(1)}" y2="${H - bottom}" stroke="#b1b4b6" stroke-width="1" />`);
    g.push(`<text x="${px.toFixed(1)}" y="${top - 12}" text-anchor="middle" font-size="11" fill="#505a5f">${d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })}</text>`);
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const colour = PHASE_COLOUR[r.phase];
    g.push(`<text x="${labelW - 10}" y="${y + 17}" text-anchor="end" font-size="13" fill="#0b0c0c">${esc(r.label.length > 48 ? r.label.slice(0, 46) + '…' : r.label)}</text>`);
    const a = x(parseIso(r.start).getTime()), b = x(parseIso(r.end).getTime());
    if (r.kind === 'window') {
      g.push(`<rect x="${a.toFixed(1)}" y="${y + 5}" width="${Math.max(4, b - a).toFixed(1)}" height="16" fill="${colour}" rx="2"><title>${esc(r.label)}: ${formatDate(r.start)} to ${formatDate(r.end)}</title></rect>`);
    } else if (r.kind === 'deadline') {
      g.push(`<polygon points="${a},${y + 4} ${a + 9},${y + 13} ${a},${y + 22} ${a - 9},${y + 13}" fill="#d4351c"><title>${esc(r.label)}: by ${formatDate(r.start)}</title></polygon>`);
    } else {
      g.push(`<polygon points="${a},${y + 4} ${a + 9},${y + 13} ${a},${y + 22} ${a - 9},${y + 13}" fill="${colour}"><title>${esc(r.label)}: ${formatDate(r.start)}</title></polygon>`);
    }
    g.push(`<text x="${(r.kind === 'window' ? b : a) + 12}" y="${y + 17}" font-size="11" fill="#505a5f">${formatDate(r.start)}${r.kind === 'window' ? ' – ' + formatDate(r.end) : ''}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="lpn-gantt" role="img" aria-labelledby="${id}-title ${id}-desc" font-family="Helvetica Neue, Arial, sans-serif">
<title id="${id}-title">Timetable chart</title>
<desc id="${id}-desc">Each milestone from the table above drawn against a calendar: bars for consultations, gateways and the examination, diamonds for single dates, red diamonds for statutory deadlines. The table carries the same dates.</desc>
${g.join('\n')}
</svg>`;
}
