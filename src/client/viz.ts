// src/client/viz.ts — plays the diagrams' entrance animations.
//
// Every diagram is complete as drawn (scripts/lib/diagrams.mjs, src/lib/gantt.ts).
// This only adds motion, and only when the visitor has not asked for less:
// a figure is "armed" (its parts held back) as the page loads, "played" once
// when most of it is on screen — stations and cards in order, connectors drawing
// themselves, then a marker running the route — and gets a Replay button. With
// prefers-reduced-motion, or without IntersectionObserver, nothing happens and
// the finished diagram is simply there.

const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const timers = new WeakMap<Element, number[]>();

/** Milliseconds a CSS custom property holds on the SVG (e.g. --step: 90ms). */
function ms(svg: SVGSVGElement, name: string, fallback: number): number {
  const v = getComputedStyle(svg).getPropertyValue(name).trim();
  const n = parseFloat(v);
  return Number.isFinite(n) ? (v.endsWith('s') && !v.endsWith('ms') ? n * 1000 : n) : fallback;
}

function play(fig: HTMLElement): void {
  const svg = fig.querySelector('svg');
  if (!svg) return;
  for (const t of timers.get(fig) ?? []) clearTimeout(t);
  const pending: number[] = [];
  timers.set(fig, pending);
  fig.classList.remove('is-playing');
  void fig.offsetWidth; // restart the CSS animations
  fig.classList.add('is-playing');

  // When the drawing is done: the last `--i` in the picture, times the step, plus the lead.
  const steps = [...svg.querySelectorAll<SVGElement>('[style*="--i"]')].map((el) => Number(el.style.getPropertyValue('--i')) || 0);
  const done = ms(svg, '--lead', 300) + (Math.max(0, ...steps) + 1) * ms(svg, '--step', 100) + 450;

  const motions = [...svg.querySelectorAll<SVGAnimationElement>('animateMotion.v-motion')];
  const counter = svg.querySelector<SVGTextElement>('.v-counter__text');
  motions.forEach((m, k) => {
    const at = done + (m.dataset.step ? Number(m.dataset.step) * 720 : 0);
    pending.push(window.setTimeout(() => {
      const dot = m.parentElement;
      const dur = Number(m.dataset.duration ?? 1) * 1000;
      try { m.beginElement(); } catch { return; /* SMIL unsupported: the static picture stands */ }
      dot?.setAttribute('opacity', '1');
      pending.push(window.setTimeout(() => dot?.setAttribute('opacity', '0'), dur + Number(m.dataset.linger ?? 0)));
      const total = Number(m.dataset.counter);
      if (counter && total) {
        const start = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / dur);
          // A clock ticks evenly, and so does the marker beside it.
          counter.textContent = p < 1 ? `Month ${Math.floor(p * total)}` : `${total} months`;
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    }, at));
  });
}

function addReplay(fig: HTMLElement): void {
  if (fig.querySelector('.lpn-viz__replay')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'lpn-viz__replay';
  button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="M8 2a6 6 0 1 1-5.3 3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M1 1.5v5h5z" fill="currentColor"/></svg> Replay';
  button.setAttribute('aria-label', 'Replay the diagram animation');
  button.addEventListener('click', () => play(fig));
  (fig.querySelector('figcaption') ?? fig).insertAdjacentElement('beforebegin', button);
}

const observer = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer?.unobserve(e.target);
      play(e.target as HTMLElement);
    }
  }, { threshold: 0.3 })
  : null;

/** Arm every diagram under `root` that has not been armed yet. */
export function armViz(root: ParentNode = document): void {
  if (!observer || reduce?.matches) return;
  root.querySelectorAll<HTMLElement>('.lpn-viz').forEach((fig) => {
    if (fig.dataset.viz) return;
    fig.dataset.viz = 'armed';
    fig.classList.add('is-armed');
    addReplay(fig);
    observer.observe(fig);
  });
}
