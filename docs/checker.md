# Plan checker

Written 2026-10-07. The plan checker reads a local planning authority's draft local plan and
checks it against what the law and national policy already say a plan must or should contain:
what it covers, what is missing, and where it is thin. It also drafts the two documents the
Planning Inspectorate asks for at Gateway 2 (as drafts) and Gateway 3: a **statement of
compliance** and a **statement of soundness**. Both are machine-drafted starting points for
officers to finish, not an assessment.

The brief, from MHCLG: "a tool that reads an LPA's draft and checks it against [the model plan
templates] and the NPPF, LURA and regs that govern what goes in them". The model local plan is
announced but not published, so the rubric is built from the 2026 Regulations, the August 2026
NPPF and the government's guidance, as a data file the model plan can be added to later.

## How it is put together

| File | What it does |
|---|---|
| `content/checker-rubric.json` | The rubric: sections in a fixed order, items with stable ids, criteria, keywords and citations. |
| `server/checker/rubric.mjs` | Checks the rubric's shape and resolves every citation against the corpus. The build writes the result to `dist/data/checker-rubric.json`, which is what the server reads. |
| `server/checker/zip.mjs` | Reads and writes zip archives with `node:zlib` alone, with limits against zip bombs. |
| `server/checker/xml.mjs` | A small XML tokenizer (no entity expansion) and an escaper. |
| `server/checker/read-document.mjs` | `.docx`, `.pptx`, `.md` and `.txt` into one structure: sections with headings, text and tables. |
| `server/checker/detect.mjs` | Finds the plan's policies, site allocations and numbered outcomes, in code. |
| `server/checker/retrieve.mjs` | Chooses the passages of the plan each check reads (BM25, deterministic). |
| `server/checker/evidence.mjs` | Verifies that every quote is in the document, and returns the document's own words. |
| `server/checker/prompts.mjs` | Every prompt, word for word. |
| `server/checker/schema.mjs` | Validates the model's answers, and the report (schema version 1). |
| `server/checker/pipeline.mjs` | `runCheck`: one check from document to report. |
| `server/checker/statements.mjs` | The draft statement of compliance and statement of soundness, built from the results. |
| `server/checker/export.mjs` | The statements as Word, the statements or the whole report as Markdown. |
| `server/checker/docx.mjs` | Writes `.docx` files with real Word styles and tables. |
| `server/checker/http.mjs` | The two endpoints, mounted by `server/app.mjs`. |
| `server/codex-complete.mjs` | A `complete` function on the local Codex bridge: the stand-in until `server/llm.mjs` supplies the provider-neutral one. |
| `src/pages/checker.njk`, `src/client/checker.ts` | The page at `/checker/`. |
| `content/samples/`, `scripts/make-sample-plan.mjs` | The fictional sample plan, and the script that makes its `.docx` and `.pptx`. |
| `scripts/check-plan.mjs` | Runs a check from the command line on the bridge, and compares runs. |

The checker never knows which model it is using. It is given a function with this contract:

```js
/** @typedef {(req: { system: string, user: string, maxTokens?: number, temperature?: number, json?: boolean, signal?: AbortSignal }) => Promise<string>} Complete */
```

### Why no runtime dependency

The production image has `"dependencies": {}` and its final stage copies no `node_modules`.
Reading `.docx` and `.pptx` needs unzip, and the export needs zip. Rather than move `fflate` into
`dependencies` and change the Dockerfile to ship `node_modules`, `server/checker/zip.mjs` does both
with `node:zlib` (`inflateRawSync` with `maxOutputLength`, `deflateRawSync`, `crc32`): about 150
lines, no Dockerfile change, and a hard cap on what any entry may unpack to. `fflate` stays a
devDependency: the tests build their Office fixtures with it and read the export back with it, so
the two implementations check each other.

## The rubric

Sections run in this order in every report. Ids are stable.

| | Section | Items | Source |
|---|---|---|---|
| A | Plan structure and contents | A1 vision · A2 no more than ten measurable outcomes · A3 outcomes that can be measured · A4 plan period of 10 years from adoption · A5 spatial strategy and minimum amounts · A6 site allocations · A7 developer contributions, affordable housing as a single figure · A8 monitoring · A9 superseded policies | Regulation 11; NPPF PM2, S2, PM12; vision guidance |
| B | Site allocations | B1 reference · B2 name · B3 area · B4 existing use · B5 allocated use · B6 capacity · B7 delivery timeframe · B8 site-specific requirements and infrastructure, for **each** allocation | NPPF PM2 footnote 8 |
| C | From vision to outcomes to policies | C1 aims and objectives · C2 outcomes flow from the vision · C3 policies set against each outcome · C4 a locally distinctive vision | Vision guidance |
| D | Locally specific policies | D1 does not duplicate, restate or contradict national decision-making policy (the closest national policies cited) · D2 addresses a local issue or supports an allocation, for **each** policy | NPPF PM6(1)(a) to (c), PM2(1)(d), PM15(1)(d) |
| E | Prescribed requirements | E1 to E12: regulation 32(a) to (l) · E13 conformity with a spatial development strategy · E14 where the Gateway 2 advice can be inspected | Regulations 17 and 32 → statement of compliance |
| F | Tests of soundness | F1 positive · F2 appropriate · F3 effective · F4 consistent with national policy · F5 conformity | NPPF PM15 → statement of soundness |
| G | The model local plan | Placeholders, `enabled: false` | NPPF PM6(1)(f) and (g), the model plan when published |

The August 2026 NPPF names its tests positive, appropriate, effective, consistent with national
policy and conformity, rather than the older "positively prepared" and "justified"; the rubric
follows the current text.

Each item has an `assess` mode:

- `model`: the language model answers from extracts of the plan, either against `judge` (what
  met, partly and missing mean) or as `conditions`, yes/no statements from which code works out
  the status (met if every one holds, not met if none does, partly otherwise);
- `rule`: code decides (A2 counts the numbered outcomes; A4 compares the plan period with the
  adoption year the model reads from the plan; A6 counts the allocations found);
- `derived`: code combines other items (E2 is the worst of A1, A2 and A9; F4 of A1, A5, A6, A7
  and D1; F5 is E13);
- `officer`: the evidence is outside the plan (Gateway timing, publication, the policies map,
  readiness for examination), so the item is always "cannot assess" and says what the authority
  needs to add.

Every citation is a passage id in the built corpus, so a report's source links go straight to
`/reference/…`; the build fails, and `tests/checker-rubric.test.mjs` fails, on an unknown one. The
list of national decision-making policies (79, from DM1 to HE10) is tested against the NPPF text.

### Adding the model local plan

Add its text to `content/sources/` and `content/sources.json`, write the `model-plan` section's
items (with `judge` or `conditions`, `keywords` and citations to its passages), and set `enabled`
to `true`. Nothing in the code changes: sections and items are read from the data.

## How consistency is enforced

1. **Fixed structure.** Every item of every enabled section is in every report, in rubric order,
   with exactly one status from `met`, `partly`, `missing`, `not-assessable`. Policies, site
   allocations and outcomes are found in code from the headings and tables, so the per-allocation
   and per-policy rows are the same for the same document.
2. **Fixed inputs.** Temperature 0, fixed prompts, fixed batch order, deterministic retrieval.
3. **Small questions.** Where a judgement can be decomposed it is: yes/no conditions, facts (years)
   that code compares, and policies split into clauses with two facts each (does the clause have
   local content; which national policy covers its matter) from which code works out the finding.
4. **Validated answers.** Each answer is checked against a schema; anything wrong is retried once
   with a note saying what was wrong, then the item becomes `not-assessable` with the reason. An
   item is never left out.
5. **Verified quotes.** A quote counts only if it is in the document after normalising whitespace,
   quotation marks, dashes and case; the report shows the document's own words, so every quote on
   the page is verbatim. A `met` or `partly` with no verified quote is lowered one step, and a
   "yes" condition with an unverified quote counts as "no".
6. **Cited sources only.** Citations come from the rubric. A clause that cites anything other than
   a national decision-making policy makes the answer invalid.
7. **Arithmetic in code.** Counts, aggregates across allocations and policies, derived items, the
   summary and both statements are computed, not written by the model.

### Measured on the sample plan

Two runs each, on the local Codex bridge (`gpt-6-luna`), 7 October 2026:

| Document | Model calls | Time | Item statuses that differed | All statuses that differed (with per-allocation and per-policy rows) |
|---|---|---|---|---|
| Sample plan, `.docx` (3,471 words) | 13 to 14 | 43 s (100 s on a run with one 70 s call) | 0 of 42 | 2 of 110 |
| Summary deck, `.pptx` (795 words) | 9 | 34 to 39 s | 1 of 42 | 3 of 88 |

The structure was identical between runs. The remaining differences are borderline clause labels
in section D (whether a clause such as a blanket protection of employment areas departs from
national policy) and one judgement on the deck's aims.

## The report (schema version 1)

`schema` is `"local-plan-navigator/plan-check-report"` and `version` is `1`. A change that removes
or renames a field increments the version.

```text
{
  schema, version, generatedAt (ISO 8601), rubricVersion, notice,
  document: { name, type: docx | pptx | md | txt, typeName, bytes, characters, words, sha256,
              sectionCount, outline: [{ id, heading, level, locator }] },
  detected: { method: headings | model | none,
              allocations: [{ id, code, title, locator, checked }],
              policies:    [{ id, code, title, locator, checked }],
              outcomes:    [{ number, text, locator }], notes: [text] },
  sections: [{ id, letter, title, summary, mode: items | per-allocation | per-policy, items: [Item] }],
  pending:  [{ id, letter, title, summary, items: [{ id, title }] }],      disabled rubric sections
  summary:  { counts: { met, partly, missing, not-assessable }, total,
              sections: [{ id, letter, title, counts, total }] },
  statements: {
    compliance: { title, planName, notice, intro: [text], parts: [{ heading, entries: [Entry] }] },
    soundness:  { title, planName, notice, intro: [text], entries: [Entry], evidenceBase: [text] }
  },
  run: { modelCalls, retries, unanswered, answerProblems: [text], durationMs }
}

Item: { id, ref, title, requirement, source, assessedBy: model | rule | derived | officer,
        status, finding, evidence: [{ quote, sectionId, locator }], gaps: [text], action,
        citations: [{ label, href: "/reference/…#anchor", sourceTitle }], notes: [text],
        conditions?: [{ text, answer: yes | no, quote, locator }],
        questions?: [text], evidenceDocuments?: [text],          soundness tests
        instances?: [Instance] }                                  sections B and D

Instance: { id, label, locator, status, evidence: [{ quote, sectionId, locator }], note,
            finding?: adds-local-detail | partly-restates | restates | inconsistent,   D1 only
            findingLabel?, national?: [{ code, title, href }],
            clauses?: [{ quote, local, national, relation: repeats | contradicts | null }] }

Entry: { id, ref, title, requirement, status, shows, evidence: [{ quote, locator }], gaps,
         action, completeBy: check | authority, questions?, evidenceDocuments? }
```

`locator` says where in the plan: the heading path ("5 Site allocations › Policy NW/H1: Land north
of Wendbury"), "Slide 6: Site allocations", or a table row. `generatedAt` and `run` are the only
fields that differ between runs of the same document by design.

## The HTTP API

Both endpoints sit behind the app's signed owner identity, take requests only from the site's own
origin, and answer errors as `{ message }`, written to be shown to the user as it is.

**`POST /api/projects/local-plan-navigator/check`** — the plan as `multipart/form-data` (field
`plan`), or as the raw body with its name in `X-File-Name`. A file that cannot be checked gets a
4xx at once (`{ message, field: "plan-file" }`: 400, 413 too large, 415 wrong type). Otherwise a
`text/event-stream`:

```text
event: progress   data: { "type": "progress", "step": 3, "total": 17, "message": "Checked: Site allocations (1 of 2)" }
event: report     data: { "type": "report", "report": { … } }
event: error      data: { "type": "error", "message": "The check could not be completed. Try again in a few minutes." }
```

with a comment line every 15 seconds so proxies keep the stream open. 409 if the user already has
a check running, 429 after six checks in an hour, 503 when two checks are already running or the
day's 60 are used.

**`POST /api/projects/local-plan-navigator/check/export`** — `{ report, format: "docx" | "md",
part: "statements" | "report" }`. The report is validated against the schema; the answer is the
file, with `Content-Disposition: attachment`.

## Limits and privacy

- Uploads up to 15 MB and about 100,000 words (650,000 characters); anything else is refused with
  a message saying why and what to do.
- At most 40 allocations and 60 policies are checked in detail (the rest are listed), 70 model
  calls in all, three at once, each at most 150 seconds, the whole check at most 8 minutes. A
  3,500-word plan takes about 14 calls.
- The file is held in memory for the request only. Nothing from it is written to disk or logged.
  The parts each check needs are sent to the model provider. The report lives in the browser
  until it is downloaded.

## Running it locally

```bash
npm run build
node scripts/check-plan.mjs dist/samples/northwold-draft-local-plan.docx --runs 2
```

This uses the Codex bridge on `127.0.0.1:5207`, writes each report and the raw model replies to
`.cache/checks/`, and prints how many statuses differed between the runs. `npm run
preview:service` serves the page with the checker behind it.

## Known limitations

- The model reads extracts chosen by search, not the whole plan, so a requirement met somewhere
  the search does not look can be reported as missing. The outline of headings goes with every
  call to reduce this.
- Policies and allocations are found from "Policy XX1: Title" headings and from tables with a
  reference column. A plan written another way falls back to the model reading the outline.
- It cannot see the evidence base, the policies map or the consultation statements, so the
  regulation 32 items that depend on them are for the authority to complete, and the statement
  of soundness lists only the evidence the plan itself names.
- Word footnotes, headers, comments and text in images, charts or SmartArt are not read; PDFs and
  scanned documents are not accepted.
- Borderline clause-by-clause judgements in section D can still vary between runs.
- Text in a plan can try to steer the model. Quotes are verified, citations are fixed and the
  structure is fixed, but a status can still be influenced; this is a first read for officers.
- The limits and allowances are held in memory and reset when the server restarts.
