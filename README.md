# Local Plan Navigator

A prototype, in the style of a GOV.UK service, that helps local planning authorities in
England find their way through the 30-month local plan process: the stages, the three
gateways, site allocations, the plan-making law, the National Planning Policy Framework
and the government's guidance, in one place, with tools that say what to do next.

The deployment path is <https://strangeramblings.com/projects/local-plan-navigator/>.
It is private, and shared like the other /projects apps on strangeramblings.com: the
owner sees it through the site's own sign-in, and anyone else needs a link from the Share
button on its /projects card. That tie to the site is one removable layer
(`server/sr-projects.mjs` and `gateway/`); spun up anywhere else, the navigator runs on
its own share links and admin sign-in instead (`docs/handover.md`). This is not a
government service; it has no connection with MHCLG or the Planning Inspectorate.

## What is on it

- **Process map** — every stage from getting ready to monitoring, the legally fixed
  sequence, and a page per stage with what you must, should and could do, timings, and
  the regulation or guidance each comes from.
- **Gateways** — the three checkpoints compared, with process-flow diagrams.
- **Site allocations** — what each allocation should contain (NPPF policy PM2 and its
  footnote 8, field by field), the four stages of site selection, the evidence expected,
  where sites come up in the 30 months, and the pitfalls the guidance names.
- **Where is my plan?** — a one-question-per-page flow that ends in a tailored "what to do
  next" page.
- **Timeline planner** — a Gateway 1 date becomes every milestone, with the statutory
  minimums checked, as a table, a chart, a CSV, and the plan-timetable dataset the
  Planning Data (England) Regulations 2026 require.
- **Checklists** — Gateway 1 readiness, the Gateway 2 pack, the Gateway 3 documents and
  twelve prescribed requirements, submission, adoption, site allocations; ticks persist in
  the browser.
- **Search** and **Ask** — one index over all the sources; on the Ask page a language
  model writes a cited summary of the passages: the website's own model by default (an
  endpoint on the server that sent the page — owner-only on strangeramblings.com, and
  `npm run preview:service` locally), or one running in the browser for a private, offline answer — the only option in a
  downloaded copy.
- **Plan checker** — upload a draft local plan (Word, PowerPoint, Markdown or text) and get a
  report against the 2026 Regulations, the NPPF and the guidance: what it covers, what is missing,
  where it is thin, with every quote found word for word in the plan, plus a draft statement of
  compliance and statement of soundness to download as Word. A fictional sample plan is built in.
  See `docs/checker.md`.
- **Reference library** — the sources with an anchor on every section, regulation, policy
  and NPPF footnote: the plan-making sections of the PCPA 2004 (as amended by LURA 2023)
  and of LURA 2023, the 2026 Regulations, the SEA and Planning Data Regulations, the NPPF,
  the procedural guide, MHCLG's new-system guidance including site selection, and the
  plan-making parts of the land availability, viability and flood risk practice guidance.
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
node scripts/eval-retrieval.mjs  # does search find the right passage? (after a build)
npm run eval:answers   # are the Ask answers cited and grounded? (calls a model; see below)
npm run check-plan -- dist/samples/northwold-draft-local-plan.docx --runs 2
                     # check a plan on the local Codex bridge and compare two runs
```

`npm run eval:answers` sends eight fixed questions through the page's retrieval and the
server's prompt to an OpenAI-compatible chat endpoint and checks every answer for
citations, the expected sources and declines. It defaults to the local Codex bridge;
point it elsewhere with `LPN_EVAL_BASE_URL`, `LPN_EVAL_MODEL` and `LPN_EVAL_API_KEY`.

Node 22 or later. `dist/` is static and works at any mount point because its links
are relative. The standalone production server in `server/` serves that bundle and
the APIs; who may see it is decided by its access mode (below). The downloadable
bundle does not require the server.

## Run it locally

```bash
npm run preview:service   # http://127.0.0.1:5382/projects/local-plan-navigator/ as the owner
PREVIEW_ACCESS=share npm run preview:service       # as a /projects share-link holder
PREVIEW_ACCESS=none npm run preview:service        # as a stranger
PREVIEW_ACCESS=standalone npm run preview:service  # its own sign-in and share links
```

The preview signs what the estate gateway would sign. The local pre-production stack
on porkserv runs the owner and share-link views from `~/docker/local/compose.lpn-mhclg-beta.yaml`.
Run `npm run check`, `npm test` and `npm run build` before packaging a change. For the
optional browser smoke run, install a local Chromium with `npx playwright install chromium`
and run `npm run smoke` while the static preview is serving.

## Production boundary

Three interchangeable access modes (`ACCESS_MODE`), all in `server/app.mjs`:

| Mode | Where | Who gets in |
|---|---|---|
| `sr-projects` (default) | strangeramblings.com | The owner, through the site's sign-in; anyone with a live link from the Share button on the /projects card; everyone, if the card is toggled Public. |
| `standalone` | anywhere else | An administrator with the navigator's own passphrase; anyone with a share link made on its own admin page. |
| `trusted-proxy` | behind your own sign-in (e.g. Azure App Service authentication) | Whoever the proxy lets through; `ADMIN_EMAILS` may also use the admin page. |

The plan checker's `/check` takes uploads of up to 15 MB and streams progress (with a
heartbeat every 15 seconds, so proxies keep the stream open); `/check/export` returns Word or
Markdown. Everyone else is sent to a page saying the prototype is private and how to get a link;
the APIs answer 401. Only an admin (the owner, on strangeramblings.com) may use `/admin/`.

**On strangeramblings.com** the shared estate gateway (`sr-gateway`, the `gateway`
service in `deploy/compose.yaml`) owns `/projects/local-plan-navigator` and
`/api/projects/local-plan-navigator`. On every request it asks Main's session authority
who is calling and whether they may see this project — Main applies the project's
visibility row, the owner preview and the /projects share links (`?t=`, then the
`psh_local-plan-navigator` cookie) — and signs the answer into a request-bound
assertion (`deploy/app.json` `sessionClaims: ["project"]`) that `server/sr-projects.mjs`
reads. A share recipient's token is kept in that cookie for the pages and the API, so
links between pages keep working; their questions are rate-limited by address and count
towards the daily cap. Like every /projects app, the navigator is unavailable while Main
is. **This is the only part that knows about the site**: delete `server/sr-projects.mjs`,
`gateway/` and the Dockerfile line that copies it, and run another mode (`docs/handover.md`).

The app environment file needs `OWNER_EMAIL`, `LOCAL_PLAN_NAVIGATOR_GATEWAY_KEY` (the same
value as the gateway's) and `LOCAL_PLAN_NAVIGATOR_SECRET` (32+ random characters; it encrypts
the saved model keys unless `LOCAL_PLAN_NAVIGATOR_SETTINGS_KEY` is set). `CODEX_BRIDGE_URL`
(default `http://127.0.0.1:5207`) and `LOCAL_PLAN_NAVIGATOR_MODEL` (default `gpt-6-luna`)
only seed the first connection: once the owner saves connections on the admin page, they
live in the `state` volume (`/var/lib/local-plan-navigator/`, with `usage.jsonl`). Keep
the repository's `PROBE_URL` variable unset while the project is private, because an
anonymous release probe cannot read a private page. The release workflow remains gated
by `RELEASE_ENABLED`. The shared gateway image is pinned separately in `APP_GATEWAY_IMAGE`;
it never reloads `app.json`, so after a release that changes it, recreate it from the new
release's compose:

```bash
docker compose --env-file /etc/sr-local-plan-navigator/images.env \
  -f /opt/sr-local-plan-navigator/releases/<release>/compose.yaml up -d --no-deps --force-recreate gateway
curl -s -H 'Host: strangeramblings.com' http://127.0.0.1:5370/__gateway/health   # same active slot as before
```

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
