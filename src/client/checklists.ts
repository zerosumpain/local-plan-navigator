// src/client/checklists.ts — ticks that survive a reload, and a running count.
//
// State lives in localStorage under one key per checklist, as a list of the
// ticked item ids. Nothing leaves the browser. Every read and write is
// wrapped, because storage can be unavailable (private windows, locked-down
// browsers) and the page must still work as a plain list.
export function init(): void {
  const root = document.querySelector<HTMLElement>('.lpn-checklist');
  if (!root) return;
  const key = `lpn-checklist:${root.dataset.checklist}`;
  const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const progress = root.querySelector<HTMLElement>('[data-progress]');

  const load = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set(); } };
  const save = (ids: Set<string>) => { try { localStorage.setItem(key, JSON.stringify([...ids])); } catch { /* storage unavailable: ticks last for this page only */ } };

  const ticked = load();
  for (const b of boxes) b.checked = ticked.has(b.value);

  const update = () => {
    const done = boxes.filter((b) => b.checked);
    const musts = boxes.filter((b) => b.closest('.govuk-checkboxes__item')?.querySelector('.lpn-obligation--must'));
    const mustsDone = musts.filter((b) => b.checked);
    if (progress) progress.textContent = `${done.length} of ${boxes.length} ticked · ${mustsDone.length} of ${musts.length} legal requirements ticked.`;
  };
  root.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.type !== 'checkbox') return;
    if (t.checked) ticked.add(t.value); else ticked.delete(t.value);
    save(ticked); update();
  });
  root.querySelector('[data-action="print"]')?.addEventListener('click', () => window.print());
  root.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
    if (!confirm('Clear every tick on this checklist?')) return;
    ticked.clear(); save(ticked);
    for (const b of boxes) b.checked = false;
    update();
  });
  update();
}
