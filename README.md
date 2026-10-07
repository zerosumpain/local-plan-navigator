# Local Plan Navigator

A prototype, in the style of a GOV.UK service, that helps local planning authorities in
England find their way through the 30-month local plan process: the stages, the three
gateways, the 2026 Regulations, the SEA Regulations and the National Planning Policy
Framework, in one place, with tools that say what to do next.

The deployment path is <https://strangeramblings.com/projects/local-plan-navigator/>.
It is private, and decides who may see it by itself: an administrator signs in with the
navigator's own passphrase, and makes share links on its admin page for anyone else. It
relies on nothing else on strangeramblings.com except its card on /projects. This is not
a government service; it has no connection with MHCLG or the Planning Inspectorate.

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
the APIs, with its own sign-in and share links. The downloadable bundle does not
require the server.

## Run it locally

```bash
npm run preview:service   # http://127.0.0.1:5382/projects/local-plan-navigator/
```

Sign in at `/sign-in/` with the preview passphrase it prints, then use the admin page
to make a share link and open it in a private window to see what a recipient sees.
The local pre-production stack on porkserv runs the same thing the way production
does — the front in front of a web slot — from `~/docker/local/compose.lpn-mhclg-beta.yaml`.
Run `npm run check`, `npm test` and `npm run build` before packaging a change. For the
optional browser smoke run, install a local Chromium with `npx playwright install chromium`
and run `npm run smoke` while the static preview is serving.

## Production boundary

The navigator decides who may see it without asking any other service, so it keeps
working whatever the rest of strangeramblings.com is doing. Its only tie to the site
is the card on /projects that links to it.

- **The front** (`server/front.mjs`, the `gateway` service in `deploy/compose.yaml`,
  from this app's own image) owns `/projects/local-plan-navigator` and
  `/api/projects/local-plan-navigator` on the gateway port that ingress already routes
  to. It reads `routing.json` on every request and proxies to the active web slot,
  falls back to the previous slot for a page request if the active one is down, and
  restates `x-forwarded-for` from Cloudflare's `cf-connecting-ip`. It holds no secrets.
- **The web process** (`server/app.mjs`, `server/access.mjs`) lets in an administrator
  signed in with the passphrase whose scrypt hash is `LOCAL_PLAN_NAVIGATOR_ADMIN_PASSWORD_HASH`
  (make one with `npm run admin-passphrase`), or anyone holding a live share link made on
  the admin page (only the token's SHA-256 is kept, in the state volume). Everyone else is
  sent to a page saying the prototype is private and how to get a link; the APIs answer
  401. Share recipients' requests are rate-limited by address and count towards the
  daily cap. Admin sessions and share cookies last twelve hours.

The app environment file needs `LOCAL_PLAN_NAVIGATOR_SECRET` (32+ random characters; it
signs admin sessions and, unless `LOCAL_PLAN_NAVIGATOR_SETTINGS_KEY` is set, encrypts the
saved model keys) and `LOCAL_PLAN_NAVIGATOR_ADMIN_PASSWORD_HASH`. `CODEX_BRIDGE_URL`
(default `http://127.0.0.1:5207`) and `LOCAL_PLAN_NAVIGATOR_MODEL` (default `gpt-6-luna`)
only seed the first connection: once the admin saves connections on the admin page, they
live in the `state` volume (`/var/lib/local-plan-navigator/settings.json`, with
`shares.json` and `usage.jsonl`). Keep the repository's `PROBE_URL` variable unset while
the project is private, because an anonymous release probe cannot read a private page.
The release workflow remains gated by `RELEASE_ENABLED`. It switches web slots only; the
front is pinned separately in `APP_GATEWAY_IMAGE` to an image of this app and only needs
recreating when `server/front.mjs` changes:

```bash
sudo sed -i 's|^APP_GATEWAY_IMAGE=.*|APP_GATEWAY_IMAGE=sr-local-plan-navigator:<release>|' /etc/sr-local-plan-navigator/images.env
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
