# Taking the Local Plan Navigator on

For a team picking this prototype up to run it themselves — on their own
infrastructure, behind their own sign-in, with their own model gateway (for
example MHCLG's AI Gateway). Everything here is MIT-licensed code plus Crown
copyright texts under the Open Government Licence; see `LICENCE.md`.

## What you are taking

| Part | Where | Notes |
|---|---|---|
| Static site | `src/`, `content/`, `build.mjs` → `dist/` | GOV.UK Frontend 6 + Nunjucks, built at build time. Works at any mount point. |
| Corpus | `content/sources/` → `dist/data/corpus.json` | The government texts, chunked with an anchor per passage. `npm run fetch-sources` refreshes them. |
| Server | `server/` | Node 22, no runtime dependencies. Serves `dist/`, the Ask API, the plan checker and the admin API. |
| Model client | `server/llm.mjs`, `server/settings.mjs` | One place every model call goes through. Connections are chosen on the admin page. |
| Access | `server/access.mjs` | Its own administrator sign-in (a passphrase) and share links. Or, behind your own sign-in, `ACCESS_MODE=trusted-proxy`. |
| Front | `server/front.mjs` | Routes to the active one of two web slots, for zero-downtime releases. Optional. |
| strangeramblings.com glue | `deploy/`, `.github/workflows/release.yml`, `scripts/release.mjs`, `scripts/verify-*.mjs` | The original host's release lanes. You can delete all of it — see below. |

## Run it locally

```bash
npm ci
npm run build
npm test
npm run preview:service   # http://127.0.0.1:5382/projects/local-plan-navigator/ as the owner
```

Sign in at `/sign-in/` with the passphrase the preview prints; the admin page is at
`/admin/`. Set `LOCAL_PLAN_NAVIGATOR_STATE_DIR` to a writable folder if you want the
connections and share links you make there to persist.

## Run it with its own sign-in

This is how it runs on strangeramblings.com (`ACCESS_MODE=standalone`, the default):

| Variable | Meaning |
|---|---|
| `LOCAL_PLAN_NAVIGATOR_SECRET` | 32+ random characters. Signs admin sessions; encrypts saved keys unless `LOCAL_PLAN_NAVIGATOR_SETTINGS_KEY` is set. |
| `LOCAL_PLAN_NAVIGATOR_ADMIN_PASSWORD_HASH` | `npm run admin-passphrase` makes a passphrase and this hash. Changing it signs every admin out. |
| `LOCAL_PLAN_NAVIGATOR_STATE_DIR` | Writable, persistent folder: saved connections, share links, usage log. |
| `ORIGIN` | The site's own origin. Writes from any other origin are refused. |

Administrators make share links on the admin page — who each is for, and 7, 30 or
90 days or until withdrawn. Anyone with a live link can read, search, ask and run the
plan checker without an account; nobody without one sees anything but a page saying
the prototype is private.

## Run it behind your own sign-in

Set `ACCESS_MODE=trusted-proxy`. The server then takes the signed-in person from a
header your proxy sets, and its own passphrase sign-in and share links are switched off:

| Variable | Meaning |
|---|---|
| `ACCESS_MODE` | `trusted-proxy` (yours) or `sr-gateway` (the original host). |
| `PROXY_IDENTITY_HEADER` | Header carrying the signed-in email. Default `x-ms-client-principal-name`, which Azure App Service / Container Apps authentication ("Easy Auth") sets. |
| `ADMIN_EMAILS` | Comma-separated emails that may use the admin page. Everyone else your proxy lets in can read, search, ask and run the plan checker. |
| `ORIGIN` | The site's own origin, e.g. `https://navigator.example.gov.uk`. Writes from any other origin are refused. |
| `LOCAL_PLAN_NAVIGATOR_STATE_DIR` | Writable, persistent folder for the saved connections and `usage.jsonl` (an Azure Files share on App Service). |
| `LOCAL_PLAN_NAVIGATOR_SETTINGS_KEY` | 32+ random characters. Encrypts saved keys at rest. Changing it means re-entering them. |
| `LOCAL_PLAN_NAVIGATOR_DAILY_CAP` | Model-backed requests per day across everyone (default 400; a plan check counts 5). |
| `HOST`, `PORT` | Where the server listens. |

**Only use `trusted-proxy` when nothing can reach the server except through the
proxy.** It believes the header. Azure App Service authentication strips any copy
of `X-MS-CLIENT-PRINCIPAL-NAME` a browser sends; check the same is true of
whatever proxy you use, and keep the container off the public network otherwise.

A minimal container: build the `Dockerfile` (it already creates the state
directory as the `node` user), start it with `node server/start.mjs` and the
variables above, and mount the state directory.

## Point it at the AI Gateway

Sign in as an admin and open `/projects/local-plan-navigator/admin/`. Add a
connection of type **Azure** and fill in:

- **Address** — the gateway's base URL.
- **How the address is used** — *Azure OpenAI deployment* if the gateway exposes
  `…/openai/deployments/<name>/chat/completions?api-version=…` (the usual shape
  behind Azure API Management), or *OpenAI-style* if it exposes
  `…/chat/completions` and takes the model name in the request.
- **Deployment** or **Model**, and the **API version** if asked.
- **How it signs in** — an API Management subscription key (sent as
  `Ocp-Apim-Subscription-Key` unless you change the header), an Azure OpenAI
  `api-key`, or Microsoft Entra ID client credentials (tenant, client id, client
  secret, scope — a token is fetched and cached until it expires).

Press **Test it**, then **Use this one**. From then on every Ask summary and every
plan check uses it; nothing else changes. The table at the bottom of the admin page
lists each call with its connection, model, time and outcome — never the question,
the document or the answer — and the server appends the same records to
`usage.jsonl` in the state directory.

The prompts are in `server/ask.mjs` (Ask) and `server/checker/` (plan checker).
Both ask for answers only from the passages and rubric they are given; switching
model is the moment to re-run the evaluations.

## Check the answers after switching model

```bash
npm run eval:answers   # LPN_EVAL_BASE_URL, LPN_EVAL_MODEL, LPN_EVAL_API_KEY point it at your gateway
node scripts/eval-retrieval.mjs
```

`eval:answers` asks a fixed set of questions and checks each answer cites its
passages, cites the sources it should, and declines what the corpus does not
cover. Retrieval does not involve the model and should not change.

## Removing the original host's parts

If you are not deploying to strangeramblings.com you can delete `deploy/`,
`.github/workflows/release.yml`, `scripts/release.mjs`, `scripts/verify-kit.mjs` and
`scripts/verify-self-contained.mjs`, and remove `verify-kit` from the `check` script.
Keep `server/front.mjs` only if you want two slots and zero-downtime releases; a
single container running `node server/start.mjs` is enough otherwise.

## Before real users

None of this is code, and all of it is yours to own:

- a DPIA — the plan checker reads councils' unpublished drafts, and Ask questions may contain personal data;
- an Algorithmic Transparency Recording Standard record;
- a GDS service assessment if councils outside the department use it;
- an accessibility audit (the prototype's own statement is at `/accessibility/`);
- penetration testing of the deployed service;
- a decision on retention for `usage.jsonl`.
