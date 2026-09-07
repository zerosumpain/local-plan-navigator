# Local Plan Navigator — design spec

Written 2026-09-07 as the autonomous kick-off of the build. Self-approved; every fork that
would have been a question to John is in the Decision Log at the end.

## The brief

Build a prototype that lives on `/projects` of strangeramblings.com, deliberately NOT in the
site's design system: it should look and feel like a GOV.UK service built to GDS standards,
with branding, but clearly be a prototype. Its purpose is to help local planning authorities
(LPAs) find their way through the local plan-making system in England. The core artefacts:

- Regulation 12 of the Environmental Assessment of Plans and Programmes Regulations 2004
  (SI 2004/1633) — the environmental report
- The 30-month local plan process: an overview (MHCLG guidance, updated 26 March 2026)
- The Planning Inspectorate's procedural guide for examinations and gateways under the Town
  and Country Planning (Local Planning) (England) Regulations 2026 (updated 26 August 2026)
- The National Planning Policy Framework (August 2026 edition, restructured into coded
  policies PM1–17, DM1–10, S1–6, HO1–13 and so on)

Also asked for: a page that shares the prototype's code (well commented), its dependencies
and a download of everything; optional use of a local model for an AI experience, including
"describe a problem and the guidance answers it"; visuals, charts and process flows; a focus
on accessibility and usability. Autonomous end to end.

## What gets built

A static, multi-page GOV.UK-styled site, built from Nunjucks templates that use the
GOV.UK Frontend v6 macros, deployed as a hand-built bundle at
`https://strangeramblings.com/projects/local-plan-navigator/`.

### Pages

| Route | What it does |
|---|---|
| `/` | Start page. What the tool is, who it is for, the "prototype, not a government service" banner, four entry points (process map, where am I, planner, ask). |
| `/process/` | The full 30-month process as an accessible timeline (SVG generated from data, plus a text equivalent), with the legally required sequence marked. |
| `/process/<stage>/` | One page per stage (13 stages, from "getting ready" to "monitoring"): what you must do, what you should do, outputs, who is involved, timings, the regulations and guidance behind it, and what comes next. |
| `/gateways/gateway-1/`, `-2/`, `-3/` | Each gateway: purpose, timing rules, what to submit, what the assessor does, what to publish afterwards, what happens if it fails. Gateway 2 and 3 have process-flow diagrams. |
| `/where-am-i/…` | A one-question-per-page flow (GDS question pages) that works out which stage a plan is at and returns a tailored "what to do next" result. |
| `/planner/` | Timeline planner: enter a Gateway 1 date (or a notice date) and get every milestone with its statutory constraint, as a table and a Gantt-style chart. |
| `/checklists/<name>/` | Interactive checklists that persist in the browser: Gateway 1 readiness (the 5 areas), Gateway 2 pack, Gateway 3 submission documents + the 12 prescribed requirements + practical readiness, examination submission, adoption. |
| `/environmental-assessment/` | Regulation 12 explained: what the environmental report must contain (Schedule 2), consulting the consultation bodies (5 weeks), where SEA sits in the 30 months, adoption statement (reg 16), monitoring (reg 17). |
| `/national-policy/` | What the NPPF asks of a local plan: PM2 contents, the five tests of soundness (PM15), the plan-making policies chapter by chapter, and the transitional rules (Annex A). |
| `/examination/` | Submission, hearings, main modifications, pauses, the report — from the procedural guide. |
| `/search/` | Full-text search across all sources (client-side, MiniSearch) with source-linked passages. |
| `/ask/` | "Describe your problem": retrieval over the same corpus, then optionally a local model (running in the visitor's browser) writes a grounded, cited answer. Works without the model: the passages are the answer. |
| `/reference/<source>/` | The source texts, rendered with anchors so every citation is a link. |
| `/glossary/` | Terms and abbreviations. |
| `/about/`, `/accessibility/`, `/sources/` | What this is, the accessibility statement, provenance and licences. |
| `/code/` | The code page: every source file, well commented, rendered with syntax highlighting; the dependency list with versions and licences; a zip download of the whole repository; the GitHub link. |

### Architecture

```
content/          data the pages are built from
  sources/        the government texts (Markdown/plain text, Crown copyright, OGL v3)
  stages.json     the process model: stages, gateways, timings, tasks, references
  navigator.json  the where-am-i question flow
  checklists.json checklists
  glossary.json   terms
src/
  layouts/        base.njk (GOV.UK page template, generic header, phase banner, own footer)
  partials/       shared macros (citation, stage card, timeline)
  pages/          one .njk per page; stage/gateway/checklist pages are generated from data
  styles/app.scss govuk-frontend + a small prototype layer (banner, timeline, code page)
  client/         TypeScript: govuk init, search, ask (engine worker), planner, checklists,
                  where-am-i, code page
scripts/          fetch-sources (re-download + convert), build-corpus (chunk + index),
                  render diagrams, zip, smoke + a11y tests
build.mjs         the one build: corpus → pages → sass → esbuild → copy → zip
dist/             the bundle that is deployed
```

Build tools: Node 22, Nunjucks (the GOV.UK Prototype Kit's own templating), Sass (to compile
GOV.UK Frontend with the font and asset settings this deployment needs), esbuild (client
bundles, with code-splitting so the two model engines only load on the Ask page), fflate
(the zip). Test tools: node:test for pure logic; Playwright (from the site's install) for the
smoke and accessibility runs; axe-core injected into the Playwright page.

### Local AI

One `LocalModel` interface, two engines, chosen at runtime:

1. **WebLLM** (`@mlc-ai/web-llm`) on WebGPU — the good experience. Default model
   `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`, with a smaller and a larger option.
2. **transformers.js** (`@huggingface/transformers`) on WASM — the fallback where there is
   no WebGPU. `HuggingFaceTB/SmolLM2-360M-Instruct` (ONNX, q4). Slow, but it works
   everywhere, and it is the path that can be tested on the build box.

Both run in a Web Worker so the page never freezes. Nothing is sent to any server: the model
weights are fetched from Hugging Face's CDN by the visitor's browser and cached there; the
question, the passages and the answer never leave the browser. The page says all of this
before anything downloads, states the size, and needs an explicit click.

Grounding: the question is run through the same MiniSearch index as `/search/`, the top
passages go into the prompt, the model is told to answer only from them and to cite `[n]`,
and the citations are rendered as links to `/reference/…`. If retrieval finds nothing, the
model is not called.

### Accessibility and usability

GOV.UK Frontend gives the baseline (focus states, contrast, skip link, landmarks, error
summary pattern, 44px targets). On top of that: every diagram has a `<title>`, a `<desc>`
and a full text equivalent next to it; charts never encode meaning in colour alone;
`prefers-reduced-motion` is respected; nothing depends on JavaScript except the three
interactive tools, each of which has a stated no-JS fallback; the accessibility statement
lists what was tested and what is known to be imperfect; axe runs in the smoke test.

### Deployment

The bundle is rsynced to `data/jkai-projects/local-plan-navigator/` on homeserv and the VPS
(the `bundle-deploy` precedent). The svelte repo gets a one-line registration in
`STATIC_PROJECT_KEYS` (so the page is first-party, un-sandboxed and public) and a card in
`src/routes/projects/cards.ts`, shipped through the normal gate → PR → CI path. The
bundle goes up FIRST; until the key is registered an unregistered slug is private, so
nothing half-built is public.

## Decision Log

| # | Fork | Options | Chosen | Why | Reversible? |
|---|---|---|---|---|---|
| 1 | Where the code lives | (a) SvelteKit route in SR-Main, (b) own repo + static bundle in `data/jkai-projects/` | **b** | Every "tool" precedent that breaks the site's design system is a static bundle (scs-earnings, terminal-descent). A GOV.UK stack (Nunjucks + Sass) does not belong inside the Svelte build. The download-everything page is trivial when the project is its own repo. | Yes |
| 2 | GOV.UK branding | (a) the crown + GDS Transport as if it were on GOV.UK, (b) GOV.UK Frontend's `generic-header` (v6, designed for services NOT on GOV.UK), no crown, no crest, no Transport font, Arial stack | **b** | The crown, the coat of arms and GDS Transport are Crown copyright and licensed only to services on GOV.UK. Everything else in GOV.UK Frontend is MIT. The result still reads unmistakably as a GOV.UK-style service, and the phase banner + "Prototype" tag make the status explicit. | Yes |
| 3 | Templating | (a) Nunjucks + govuk-frontend macros rendered at build time, (b) hand-written HTML, (c) a Vite MPA plugin | **a** | It is the GOV.UK Prototype Kit's own approach, so the code page shows exactly what a GDS designer would expect; it is fully static; the build is ~150 readable lines. | Yes |
| 4 | Process diagrams | (a) Mermaid rendered in the browser (3 MB of JS, not accessible), (b) Mermaid at build time (needs a browser in the build), (c) SVG generated from the stage data at build time with a text equivalent | **c** (with the Mermaid source of each flow shown in a details block for people who want it) | Accessible by construction, no runtime dependency, and the same data drives the pages, the planner and the diagrams so they cannot disagree. | Yes |
| 5 | "Local model" | (a) the site's LLM gateway (not local, costs money), (b) Ollama on homeserv (not reachable from a public page), (c) in-browser model: WebLLM/WebGPU with a transformers.js/WASM fallback | **c** | The only reading of "local" that works on a public static page: the model runs on the visitor's machine, nothing is sent anywhere, no cost to John. The WASM fallback exists because headless Chromium on the build box has no WebGPU, so it is the path that can be tested here, and it also covers Firefox. | Yes |
| 6 | Default model | Qwen2.5-1.5B-Instruct (≈1 GB) vs Llama-3.2-1B (≈0.7 GB) vs Qwen3/3.5 | **Qwen2.5-1.5B** default, Llama-3.2-1B and Qwen2.5-3B as options | Best answer quality per megabyte among the well-tested WebLLM builds; Apache-2.0; no thinking-mode traps. | Yes |
| 7 | Where-am-I without JavaScript | (a) server-side smart answer (no server), (b) pure-link decision tree, (c) radios + Continue with JS, each question a real page, `<noscript>` pointing at the process map | **c** | Real URLs and back-button behaviour like a GDS question page; the no-JS fallback is honest and useful. | Yes |
| 8 | Corpus scope | (a) only the four named artefacts, (b) plus the ten linked MHCLG guides, the 2026 Regulations themselves and the SEA Regulations in full | **b** | The four artefacts cite these constantly (the procedural guide refers to "regulation 32" a dozen times); a navigator that cannot show regulation 32 is not much of a navigator. All are OGL v3. | Yes |
| 9 | NPPF text | (a) hand-typed summaries only, (b) full text extracted from the PDF with a structure parser | **b** plus summaries | An accessible HTML NPPF does not exist yet ("will be available soon" on GOV.UK); the prototype states the extraction is automatic and links the PDF. | Yes |
| 10 | Visibility at launch | public on merge vs private until John looks | **public on merge**, bundle deployed first | The brief says "resides in /projects"; the key defaults public; a private launch would need John's toggle, which is a stop. | Yes (one toggle) |
| 11 | Spec location | SR-Main `docs/superpowers/specs/` vs this repo's `docs/` | this repo | The project is its own repo; the PR in SR-Main links here. | Yes |
| 12 | Language | British English, GOV.UK style (plain words, sentence case, "must/should/could") | as stated | GDS content design standard. | — |
| 13 | Who writes the summary (added mid-run, 2026-09-07, on John's instruction "use codex from SR") | (a) in-browser models only, (b) the site's Codex provider only, (c) both, site model by default | **c** | The site's model (Codex, billed to the ChatGPT subscription) gives far better summaries than anything a browser can run, so it is the default; the in-browser engines stay as the private, offline option and as the path that can be tested on the build box. The endpoint takes passage ids, not text, so nothing typed can become "guidance" in the prompt; it is rate-limited per IP, capped per day, and its role is registered so the operator can change the model. | Yes |
