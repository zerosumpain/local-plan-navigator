# Local Plan Navigator

A prototype, in the style of a GOV.UK service, that helps local planning authorities in
England find their way through the 30-month local plan process: the stages, the three
gateways, the 2026 Regulations, the SEA Regulations and the National Planning Policy
Framework, in one place, with tools that say what to do next.

The deployment path is <https://strangeramblings.com/projects/local-plan-navigator/>.
It is private by default: the owner sees it, and anyone else needs a share link minted
with the Share button on its /projects card. This is not a government service; it has no
connection with MHCLG or the Planning Inspectorate.

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
  model writes a cited summary of the passages: the website's own model by default (an
  endpoint on the server that sent the page — owner-only on strangeramblings.com, and
  `npm run preview:service` locally), or one running in the browser for a private, offline answer — the only option in a
  downloaded copy.
- **Reference library** — the sources in full with an anchor on every regulation and policy.
- **Code** — every file of this repository, rendered and commented, plus a zip.
- **Admin** (`/admin/`, owner only) — which model connection answers: the site's Codex
  bridge, an Azure gateway such as MHCLG's AI Gateway (API Management subscription key,
  Azure OpenAI key or Entra ID), or any OpenAI-compatible endpoint; test a connection,
  switch to it, and see every model call logged (never its content).

Taking it on to run yourselves? Start with [`docs/handover.md`](docs/handover.md).

## Build it

```bash
npm install
npm run build        # renders dist/
npm run serve        # http://localhost:5177/projects/local-plan-navigator/
npm test             # data integrity, schedule maths, and every internal link
npm run smoke        # Playwright + axe-core over every page and the tools (needs Playwright)
npm run fetch-sources  # refresh content/sources/ from GOV.UK and legislation.gov.uk
```

Node 22 or later. `dist/` is static and works at any mount point because its links
are relative. The standalone production server in `server/` serves that bundle and
the Ask API. It requires a signed owner identity from the estate gateway. The
downloadable bundle does not require the server.

## Run the isolated service preview

From `/home/john/docker/local`, run:

```bash
docker compose -f compose.yaml -f compose.local-plan-navigator.yaml up -d --wait local-plan-navigator
```

Open <http://127.0.0.1:5382/projects/local-plan-navigator/>. The preview uses
a synthetic local identity and does not connect to the production Codex bridge.
Use the browser model mode to test an answer locally. Run `npm run check`,
`npm test`, and `npm run build` in this repository before packaging a change.
For the optional browser smoke run, install a local Chromium with
`npx playwright install chromium` and run `npm run smoke` while the static
preview is serving.

## Production boundary

The dedicated gateway owns `/projects/local-plan-navigator` and
`/api/projects/local-plan-navigator/ask`. On every request it asks Main's session
authority who is calling and whether they may see this project — Main applies the
project's visibility row on /projects, the owner preview and the /projects share
links (`?t=`, then the `psh_local-plan-navigator` cookie) — and signs the answer
into a request-bound assertion (`deploy/app.json` `sessionClaims: ["project"]`).
The web process lets in the owner (`OWNER_EMAIL`, or Main's owner decision), a live
share link, or a public project, and answers 404 to everyone else, on every page,
asset and API call. A share recipient's token is kept in the per-project cookie,
set for both the pages and the API, so links between pages keep working; their
questions are rate-limited by address and count towards the daily cap.
Both processes bind to loopback; ingress is defined in SR-Infra. The gateway
server comes from SR-Infra's immutable `sr-gateway` image. This repository
retains only the signed-identity contract required by its web process.

The production setup uses `deploy/compose.yaml` and `deploy/app.json`. Set a
32-character-or-longer `LOCAL_PLAN_NAVIGATOR_GATEWAY_KEY` to the same value in
the gateway and app environment files, `AUTH_SECRET` in the gateway file, and
`OWNER_EMAIL` in the app file. Set `CODEX_BRIDGE_URL` only if the bridge differs
from `http://127.0.0.1:5207`. The default model is `gpt-6-luna`; override it
with `LOCAL_PLAN_NAVIGATOR_MODEL` if needed. Both only seed the first connection:
once the owner saves connections on the admin page, they live in the `state` volume
(`/var/lib/local-plan-navigator/settings.json`, keys encrypted under a key derived
from `LOCAL_PLAN_NAVIGATOR_SETTINGS_KEY`, or the gateway key if that is unset). Keep the repository's `PROBE_URL`
variable unset while the project is private, because an anonymous public
release probe cannot read a private page. The release workflow remains
gated by `RELEASE_ENABLED` until the production runner and service are ready.
The shared gateway image is pinned separately in `APP_GATEWAY_IMAGE` and rolled
per application with SR-Infra's `scripts/rollout-gateway.mjs`.

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
