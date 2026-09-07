# Build plan

Phases run in order; each ends with its verification. Files listed are the ones created or
changed in that phase.

## Phase 1 — foundation
`build.mjs`, `src/layouts/base.njk`, `src/partials/*.njk`, `src/styles/app.scss`,
`src/client/app.ts`, `src/pages/index.njk`, `public/assets/*`, `scripts/serve.mjs`.
Verify: `npm run build` exits 0; `dist/index.html` contains the phase banner and the
generic header; the CSS references no font file; a Playwright screenshot looks like GOV.UK.

## Phase 2 — content model and generated pages
`content/stages.json`, `content/navigator.json`, `content/checklists.json`,
`content/glossary.json`, `scripts/lib/diagrams.mjs`, `scripts/build-corpus.mjs`,
`scripts/lib/nppf-parse.mjs`, `src/pages/{process,stage,gateway,environmental-assessment,
national-policy,examination,glossary,about,accessibility,sources,reference}.njk`.
Verify: `node --test tests/` (data integrity: every reference resolves, every next-stage
exists, every citation anchor exists in the corpus); every page in the sitemap renders.

## Phase 3 — interactive tools
`src/lib/schedule.ts` (shared date maths), `src/client/{search,ask,planner,checklists,
where-am-i}.ts`, `src/client/engines/{types,webllm.worker,transformers.worker}.ts`,
`src/pages/{search,ask,planner,checklist,question,result}.njk`.
Verify: node tests for schedule maths and retrieval; Playwright drives each tool; the ask
page runs against a mock engine (`?engine=mock`) and, once, against the real WASM engine.

## Phase 4 — code page, download, tests, accessibility
`scripts/lib/code-page.mjs`, `scripts/lib/zip.mjs`, `src/pages/code.njk`,
`scripts/smoke.mjs` (console errors, axe, links), `README.md`.
Verify: zip unpacks and `npm install && npm run build` works from it; axe reports no
serious or critical violations on any page; no broken internal links.

## Phase 5 — ship
Bundle → `~/strange_rambling_svelte/data/jkai-projects/local-plan-navigator/` → VPS.
SR-Main worktree: `src/lib/projects/visibility.ts` (register key), `src/routes/projects/
cards.ts` (card). Gate on porkserv → PR → merge → CI deploys. GitHub repo created and pushed.
Verify: `curl -sS https://strangeramblings.com/projects/local-plan-navigator/ | grep -F
"Local Plan Navigator"`; Playwright against production: every page 200, no console errors,
the tools work; the card is on /projects.
