# Local Plan Navigator

A prototype, in the style of a GOV.UK service, that helps local planning authorities in
England find their way through the 30-month local plan process: the stages, the three
gateways, the 2026 Regulations, the SEA Regulations and the National Planning Policy
Framework, in one place, with tools that say what to do next.

Live at <https://strangeramblings.com/projects/local-plan-navigator/>. Not a government
service; no connection with MHCLG or the Planning Inspectorate.

## What is on it

- **Process map** — every stage from getting ready to monitoring, the legally fixed
  sequence, and a page per stage with what you must, should and could do, timings, and
  the regulation or guidance each comes from.
- **Gateways** — the three checkpoints compared, with process-flow diagrams.
- **Where is my plan?** — a one-question-per-page flow that ends in a tailored "what to do
  next" page.
- **Timeline planner** — a Gateway 1 date becomes every milestone, with the statutory
  minimums checked, as a table, a chart and a CSV.
- **Checklists** — Gateway 1 readiness, the Gateway 2 pack, the Gateway 3 documents and
  twelve prescribed requirements, submission, adoption; ticks persist in the browser.
- **Search** and **Ask** — one index over all the sources; on the Ask page a language
  model writes a cited summary of the passages: the website's own model by default (a
  small, rate-limited endpoint on strangeramblings.com), or one running in the visitor's
  browser for a private, offline answer.
- **Reference library** — the sources in full with an anchor on every regulation and policy.
- **Code** — every file of this repository, rendered and commented, plus a zip.

## Build it

```bash
npm install
npm run build        # renders dist/
npm run serve        # http://localhost:5177/projects/local-plan-navigator/
npm test             # data integrity, schedule maths, and every internal link
npm run smoke        # Playwright + axe-core over every page and the tools (needs Playwright)
npm run fetch-sources  # refresh content/sources/ from GOV.UK and legislation.gov.uk
```

Node 22 or later. There is no server: `dist/` is static and works at any mount point
because every link is relative.

## How it is put together

`build.mjs` runs seven steps in order: the government texts in `content/sources/` are
chunked into a search corpus and rendered as reference pages; every page in
`scripts/site-map.mjs` is rendered from its Nunjucks template with the GOV.UK Frontend
macros; the Sass is compiled with the settings a service that is not on GOV.UK needs (no
crown, no GDS Transport); the client TypeScript is bundled with esbuild and split so the two
model engines only load on the Ask page; static files are copied; the code page's zip is
made. Everything that describes the process — the map, the stage pages, the planner, the
diagrams, the question flow — reads `content/stages.json`, so they cannot drift apart.

The design decisions, with the alternatives considered, are in `docs/spec.md`.

## Licences

The code is MIT. The government texts are Crown copyright under the Open Government
Licence v3.0. GOV.UK Frontend is MIT; its crown logo, coat of arms and typeface are not
used. See `LICENCE.md`.
