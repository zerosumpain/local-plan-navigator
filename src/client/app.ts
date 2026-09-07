// src/client/app.ts — the one script every page loads.
//
// It starts GOV.UK Frontend's components (accordion, tabs, error summary and
// so on), then loads the module for the page it is on, if there is one. The
// page announces itself with data-page on <body>, set by the build. Each tool
// lives in its own module and is only fetched on the page that needs it, so a
// visitor reading the process map never downloads the search index or a
// model engine.
import { initAll } from 'govuk-frontend';

initAll();

const loaders: Record<string, () => Promise<{ init: () => void }>> = {
  search: () => import('./search'),
  ask: () => import('./ask'),
  planner: () => import('./planner'),
  checklist: () => import('./checklists'),
  question: () => import('./where-am-i'),
  result: () => import('./where-am-i'),
  code: () => import('./code'),
};

const page = document.body.dataset.page ?? '';
loaders[page]?.().then((m) => m.init()).catch((err) => console.error(`[lpn] ${page} failed to start`, err));
