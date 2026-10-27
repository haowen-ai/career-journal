# Role-scan funnel v3 — Phase A build spec

> **Superseded where the plan differs.** The screening release is built from
> `docs/superpowers/plans/2026-10-26-screening-funnel.md`. Its "Changes against SPEC" and "Frozen interface contract"
> sections win over this document (for example: no `full_time_only`/`non_us_only` drops, `outside_countries` and
> `posting_excluded` instead, no R2 `out_of_area`, sightings keyed by partition, run kinds `scan|review|daily|prune`).
> The former lane sheets `LANE-L1.md`/`LANE-L2.md` were deleted; their contracts live in the plan's frozen section.
> This file remains the reference for mechanics the plan cites as `SPEC §n`.

Status: build spec for implementation. Branch `feat/funnel-v3` (from `feat/scan-coverage`, 2.2.0).
Scope: **Phase A only** — stop avoidable recall loss within the configured sources. Breadth work (new sources, employer
inventory, partition trend statistics, full gazetteer, porting every fetch adapter to Node, elaborate ranking/report
commands, mail-sync completion barrier) is **deferred** to Phase B/C and must not be started in these lanes.

This document is public. It contains no personal data. Real roles, candidate facts, quotas, application history and
mailbox data stay in the user's data home (`<home>/.career-journal/…`) and in private acceptance lists outside the repo.

Lanes: see the plan's "Lanes, order and gates" (the former `LANE-L1.md`/`LANE-L2.md` sheets were folded into the plan). Red acceptance tests: `test/funnel-v3/*.test.mjs` (each test title starts with its lane), shared harness
`test-utils/funnel-v3.mjs`, synthetic fixtures `test-utils/funnel-v3-fixtures.mjs`. Run them with
`node --test 'test/funnel-v3/*.test.mjs'` (a bare directory argument is not a test pattern). Until both lanes land, the
default `npm test` also runs these red tests and fails on this branch by design; the pre-existing suite is checked with
`node --test $(find test -name '*.test.mjs' -not -path 'test/funnel-v3/*')`. Tests must not be edited by the implementer
except through a coordinator-approved fix to a demonstrable test bug.

---

## 0. Requirements that bind this phase

Phase A is done only when all of these hold (from the third design review, section 3):

1. **Unsuppressed distinct-record intake** — every distinct record a configured source returns reaches CJ as an
   observation, before any title, location, URL or company+title dedupe gate (including CareerOps's own gates).
2. **Conservative, evidence-based rejection** — the scan stage drops only on certain facts (section 4); review rejects only on
   validated whole-clause evidence (section 6.3). Uncertain geography, terms, direction, degree tags never reject.
3. **Exact identity reconciliation** — case-preserving identity, provider-specific normalization only, alias reconciliation
   after enrichment, never a new lead for a posting already bound to an application (section 3).
4. **Durable pending work and old-state recovery** — one `reviews` row per posting; bootstrap of existing leads and
   checker withdrawals; uncertain provenance stays held (section 8).
5. **Consistent downstream policy and atomic visibility** — R4 applies create / bind / restore / hide / withdraw for
   **every** verdict on unsubmitted applications in one transaction, never overriding user actions (section 6.4).
6. **Bounded follow-up** — numeric service targets, reserved capacity, breach reporting (section 7).
7. **Honest source / error / exit reporting** — run receipts, partial status, exit codes through `daily.py`/`nightly.sh`
   (section 9).
8. **End-to-end regression tests** — `test/funnel-v3/` plus the private real-role list.

Model runner: the judge is reached only through a **judge adapter** (section 6.3.1). The default runner is the Codex CLI
(`codex exec --output-schema`) on a ChatGPT subscription, with a primary (cheaper) model and an escalation (stronger)
model, each configured with its own `CODEX_HOME`. No paid API SDK, no automatic retries, every attempt reserved through the
central budget before dispatch.

---

## 1. Architecture (one database, one CLI)

```
scan run   ──► observations + postings/aliases + sightings + reviews(due|dropped|reused)   one txn per source batch
               (no model calls, no leads)
review run ──► R1 fetch + identity validation ─► R2 free structured checks ─► R3 judge (adapter) ─► R4 deliver
               (run lease, item leases with fencing, central budget, receipt)
daily.py   ──► scan run → review run → mail notes → review report → exit worst status
nightly.sh ──► python3 daily.py; rc=$?; notification from the receipt; exit $rc
```

New code lives under `src/funnel/` (L1) and `src/review/` (L2). The shared contract module `src/funnel/contract.mjs`
(section 11) is the only file both lanes import from each other's area.

---

## 2. Schema migration `006-funnel`

File `src/storage/migrations/006-funnel.mjs`, registered in `schemaMigrations` (`src/storage/database.mjs:10`).
Runs in the existing `BEGIN IMMEDIATE` loop. All timestamps ISO-8601 UTC. All JSON columns are `TEXT NOT NULL DEFAULT '{}'`
or `'[]'`.

| Table | Columns (types abbreviated) | Notes |
|---|---|---|
| `postings` | `id TEXT PK, company, title, canonical_url, first_seen, last_seen, listed INT, availability TEXT CHECK IN ('open','unavailable','closed_claimed','closed_verified'), application_id NULL REFERENCES applications(id), merged_into NULL REFERENCES postings(id), created_at, updated_at` | `merged_into` is the non-destructive reconciliation pointer (section 3.4). |
| `posting_aliases` | `alias TEXT PK, posting_id, kind CHECK IN ('source','req','company_req','url'), created_at` | An alias belongs to exactly one posting. |
| `posting_links` | `left_id, right_id, kind CHECK IN ('maybe_same','conflict'), reason, created_at, PK(left_id,right_id,kind)` | Fuzzy similarity and contradictory identity. Never merges. |
| `observations` | `id TEXT PK, posting_id, source, source_id, partition, first_run_id, observed_at, fields_json, completeness_json, listed INT, content_hash, UNIQUE(posting_id, source, content_hash)` | Fields as received (section 4.1). |
| `observation_sightings` | `run_id, posting_id, observation_id, source, partition, seen_at, PK(run_id, posting_id, source)` | **Run membership**: one row per census sighting even when content is unchanged (needed for the two-census closure rule). |
| `runs` | `run_id TEXT PK, kind CHECK IN ('scan','review','daily'), owner, started_at, heartbeat_at, finished_at, status CHECK IN ('running','ok','partial','failed','interrupted'), receipt_json` | One unexpired `running` row per kind = the run lease. |
| `run_sources` | `run_id, source, partition, status CHECK IN ('ok','partial','error','skipped','disabled'), count, errors, truncated INT, expected INT, detail, PK(run_id, source, partition)` | Source health per run. |
| `snapshots` | `id TEXT PK, posting_id, content_hash, fetched_at, final_url, http_status, method CHECK IN ('ats_api','jsonld','html','manual'), identity_ok INT, identity_reason, fields_json, sections_json, text` | Private text, data home only. |
| `reviews` | `posting_id TEXT PK, stage CHECK IN ('scan','fetch','check','judge','deliver'), state CHECK IN ('due','leased','held','done','failed'), decision NULL CHECK IN ('dropped','reused','not_eligible','eligible','unclear'), code, lane CHECK IN ('deadline','aged','bootstrap','new','refresh','no_student_signal'), flags_json, attempts INT, paid_attempts INT, lost_attempts INT, next_due, lease_owner, lease_generation INT NOT NULL DEFAULT 0, lease_until, last_error, evidence_json, dep_hashes_json, deadline_json, hold_owner CHECK IN ('system','user') NULL, hold_since, first_seen, updated_at` | Single current state per posting. |
| `review_log` | `id INTEGER PK, posting_id, at, stage, kind CHECK IN ('outcome','llm_raw','error','replan','delivery','user'), attempt_id NULL, payload_json` | Append-only. Raw model output stored here. |
| `attempts` | `id TEXT PK, run_id, posting_id, stage, runner, model, tier CHECK IN ('primary','escalation'), state CHECK IN ('dispatched','responded','failed','lost','adopted'), dispatched_at, finished_at, output_path, usage_json, transport_retries INT, error` | Persisted **before** dispatch (section 7.2). |

Column added to `applications`: `skip_owner TEXT NULL CHECK IN ('review','user','legacy')`. Migration sets
`skip_owner='legacy'` for every existing non-null `skip_reason`.

Writer fence (review P1 "stale writer after migration"):
- `openHomeDatabase` (`src/runtime/home.mjs:6-21`), `setup` (`src/commands/setup.mjs:76,152-158`), `doctor`
  (`src/commands/doctor.mjs:108`) and the dry-run opener (`src/commands/scan.mjs:26-30`) refuse a database whose highest
  applied migration version is **greater** than the highest version this build knows (message: "database schema N is newer
  than this CAREER JOURNAL; upgrade").
- Migration 006 installs trigger `applications_legacy_scan_guard`: `BEFORE INSERT ON applications WHEN NEW.external_id GLOB
  '[a-z]*:*' AND NEW.external_id NOT GLOB 'posting:*'` → `RAISE(ABORT, 'legacy scan writer blocked by schema 6')`. The pre-006
  scan path inserted leads with `external_id = "<source>:<sourceId>"` (`src/scan/run.mjs:49-55`); new R4 inserts use
  `external_id = 'posting:<posting_id>'`. Manual `application add` with a colon-bearing external id must use the new
  `--external-id` validation that rejects `[a-z]+:` prefixes (documented in the CLI help).
- Cut-over procedure: disable the old nightly job, back up the DB, `migrate --apply`, run `review bootstrap`, re-enable the
  new wrapper. Old wrappers that read the removed `held`/`queued` scan keys fail loudly (exit ≠ 0) rather than writing.

---

## 3. Identity

Module `src/funnel/identity.mjs` (L1). The old `src/scan/dedupe.mjs` stays only for `companyKey`/`titleSimilarity`
helpers; its `dedupeRoles` is no longer called by the scan, and its ≥0.9 title drop and "likely submitted" drop
(`dedupe.mjs:204-214`) are not ported.

### 3.1 `canonicalUrl(url)`
- `http(s)` only; credentials rejected. Drop scheme. Lowercase the **host only**; strip a leading `www.`.
- Path keeps its case; trailing slashes trimmed.
- Query: remove only the allowlist `utm_*`, `gh_src`, `ref`, `source`, `src`, `lever-source`, `lever-origin`, `iis`, `iisn`, `icims`,
  `trk`. Every other parameter (including `token`, `gh_jid`, `jobId`, `jid`, `reqId`) is identity and is kept with its
  value's case. Remaining parameters are sorted by key (stable for equal keys).
- Fragment: kept only when it starts with `#/` (single-page job routes); otherwise dropped.

### 3.2 `providerRequisition(url)` — provider-specific normalization only
Returns `{ provider, tenant, id }` or `null`. Normalization is applied only where the provider guarantees equivalence:

| Provider | Id source | Normalization |
|---|---|---|
| Greenhouse | `/jobs/<digits>`, `gh_jid`, embed `token=<digits>` | digits only |
| Lever, Ashby | UUID path segment | lowercase (UUIDs are case-insensitive) |
| Workday (`*.myworkdayjobs.com`, `myworkdaysite.com`) | trailing `_<REQ>` of the last path segment | uppercase; tenant = first host label |
| Oracle HCM, iCIMS, SmartRecruiters | numeric id | digits only |
| SuccessFactors career sites | numeric path segment followed by `/?ats=successfactors` or `/job/<slug>/<digits>/` | digits only |
| Generic `jobId`/`job_id`/`reqId`/`requisitionId`/`jid` query | parameter value | **none** (case preserved) |

The existing `requisitionKey` lowercases generic ids (`src/scan/dedupe.mjs:124-126`); that behaviour must not be used.

### 3.3 Aliases
`aliasesFor(record, { companyAliases })` returns, in this order:
- `source:<source>:<sourceId>` (kind `source`)
- `req:<provider>:<tenant|->:<id>` (kind `req`) from `providerRequisition(url)`
- `company_req:<companyKey>:<id>` (kind `company_req`) from the provider id **or** an explicit `requisitionId` /
  bootstrapped `external_id`. Explicit ids keep their case except that a **requisition-shaped** id (`^[A-Za-z]{0,4}[-_]?\d{3,}(?:-\d+)?$`)
  is uppercased so that `R900519`, `r900519` and Workday's `_R900519` meet. Anything else is exact.
- `url:<canonicalUrl>` (kind `url`)

### 3.4 Resolution and reconciliation
- `resolvePosting(db, record)` — inside the caller's transaction. Exact hit on any alias → that posting (follow
  `merged_into`). Otherwise create a posting and insert all aliases. Fuzzy title similarity ≥ 0.6 with a posting of the
  same company key (`titleSimilarity`/`titleContainment`) adds a `posting_links(maybe_same)` row and a review flag; it
  never reuses a decision and never inherits a submitted status.
- `reconcileAliases(db, postingId, aliases, { fence })` — called by R1 after enrichment (new requisition id, final URL):
  1. alias unowned → add it to `postingId`;
  2. alias owned by `P2` and `postingId` has **no conflicting authoritative alias** (`req`/`company_req`) → **bind**: set
     `postings.merged_into = P2` for `postingId`, keep both postings' observations and sightings, move the open review
     onto `P2` (if `P2` is bound to a submitted or user-declined application the review ends `reused`; if `P2` is bound
     to an unsubmitted application, `P2` gets the newest snapshot and continues). **Never** create a second application;
  3. alias owned by `P2` while `postingId` already owns a **different** authoritative requisition → **quarantine**:
     `posting_links(conflict)`, the review goes `held` with code `identity_conflict` and `hold_owner='user'`.
- A matching title never overrides a conflicting authoritative requisition (R1 validation, section 6.1).

---

## 4. Scan stage (L1)

### 4.1 Observation fields and completeness
Each source adapter returns records with: `source, sourceId, partition, company, title, url, locations[], offices[],
remote (true|false|null), workplaceType, employmentType (explicit value or null), categories[], terms[], degrees[],
description, postedAt, listed (true|false), requisitionId` and `completeness = { locations: complete|partial|unknown,
arrangement: known|unknown, description: full|tags|none, employment_type: explicit|absent }`.

| Adapter | locations | arrangement | description | employment_type |
|---|---|---|---|---|
| Greenhouse list (`content=true`) | complete (`location` **∪** `offices[]`) | unknown | full | absent |
| Lever list | complete (`allLocations`) | known (`workplaceType`) | full | explicit (`commitment`) |
| Ashby list | complete (`location` ∪ `secondaryLocations`) | known (`isRemote`/`workplaceType`) | full | explicit (`employmentType`) |
| Simplify | partial | unknown | tags | absent |
| CareerOps raw (section 4.4) | partial (unless the provider marks complete) | unknown | full if the provider returned a description, else none | absent |

Parsers keep `active=false`, `is_visible=false` (Simplify, `simplify.mjs:17`) and `isListed=false` (Ashby,
`ats-boards.mjs:81`) as records with `listed=false`. Greenhouse unions `location.name` and `offices[]`
(`ats-boards.mjs:26-33` currently prefers the primary location).

### 4.2 `classifyRole(observation, ctx)` — deterministic drops only on certain facts
Returns `{ kind: 'reuse'|'drop'|'review', code, evidence, flags }`.

| Kind / code | Condition (all required) |
|---|---|
| `reuse` / `already_submitted` | exact alias hit on a posting bound to an application in a submitted status (`applied, assessment, interview, offer, accepted, declined, rejected`). Zero work. |
| `reuse` / `user_declined` | exact alias hit on a posting whose application was withdrawn with **user** provenance (section 8.2). |
| `drop` / `company_excluded` | exact company key in `screening-policy.userExcludedCompanies`. |
| `drop` / `non_us_only` | `completeness.locations = complete` **and** `arrangement = known` and not US-remote **and** every location names an explicit non-US country (ISO country name/code list shipped as data). |
| `drop` / `full_time_only` | `employment_type = explicit` and its value is full-time **and** `completeness.description = full` **and** no student signal in title, categories or full description. Workday `timeType` is not an employment category. |
| `review` | everything else, with flags: `listed_false`, `partial_locations`, `generic_title`, `no_student_signal` (full description, no student signal, no employment category), `maybe_same:<postingId>`, `term_tag_conflict`, `degree_tag`, `state_only_location` … Flags never drop. |

Student signal (title, categories or description): intern(s/ship), co-op/coop, apprentice(ship), placement, working student,
summer analyst/associate, student, fellow(ship), resident/residency, graduate program, early career / university / campus
program, "summer 20xx program", "currently enrolled", class-year (`class of 20xx`).

Review lanes set at scan: `new` by default; `no_student_signal` for that flag (lowest lane, decision D1 below);
`deadline` when a source deadline is known ≤ 7 days.

### 4.3 `ingestBatch` — one transaction per source batch
`ingestBatch(db, { runId, source, partition, records, now, policy })` inside `BEGIN IMMEDIATE`:
resolve posting → insert observation (`INSERT OR IGNORE` on content hash) → insert sighting for this run → classify →
upsert `reviews` (a posting already `done`/`held` keeps its state unless the content hash changed, `listed` flipped to
true, or the posting reappears after its freshness horizon, section 7.4) → update `postings.last_seen/listed`. A record that
fails validation (no title, no http(s) URL) is counted `quarantined` with its raw JSON in `review_log(kind='error')`
under a synthetic posting id `quarantine:<hash>`; nothing is silently skipped. Any exception rolls back the whole batch.

Conservation invariant (tested): `observed = reused + dropped + review + quarantined` per batch, and a second identical
ingest changes no row except new sightings.

`runScan` (`src/scan/run.mjs:105`) becomes: acquire `runs(kind='scan')`, collect sources, `ingestBatch` per source batch,
`recordSourceStatus` per partition, finish the run with status and return
`{ runId, status, sources, counts: { observed, newPostings, reused, dropped: {code: n}, review, quarantined } }`.
It no longer creates applications, no longer calls `scoreFit`/`dedupeRoles`, and its JSON has **no** `held`/`queued` keys.

### 4.4 CareerOps raw emission (bridge)
`src/integrations/careerops-scan-bridge.mjs` gains command `scan-raw` (the default for CJ from this release):
- runs with cwd = CareerOps root, imports CareerOps's own `providers/_registry.mjs` (`loadProviders`, `resolveProvider`),
  `providers/_http.mjs` (`makeHttpCtx`) and `plugins/_engine.mjs` (`mergeProviderPlugins`) — CareerOps code executed,
  never copied;
- reads `portals.yml` (`tracked_companies` + `job_boards`) with CareerOps's `js-yaml`;
- calls `provider.fetch(entry, ctx)` for every entry and emits **every** returned job as structured JSON
  (`company, title, url (as returned, case preserved), locations[], description, postedAt, requisitionId, partition =
  <provider>:<entry name>`), **before** CareerOps's title, location, posting-age, content, visa, blacklist, cooldown,
  URL-lowercasing (`scan.mjs:1242`) and company+title (`scan.mjs:2886-2907`) gates;
- reports per entry `{ partition, status ok|error|partial, count, error, truncated }`; `jobs.workdayTruncated === true` →
  `partial`; a thrown fetch → `error` with the message (no more discarded `errors`, `bridge:138`);
- runs under a temporary `CAREER_OPS_ROOT` containing only a copy of `portals.yml`, so CareerOps user data
  (applications, blacklist, profile cooldowns) cannot suppress records (`path-resolver.mjs` honours `CAREER_OPS_ROOT`);
- the old `scan` command (`scan.mjs --dry-run --json` + display-line parsing) remains only as a fallback when the raw imports
  are missing; then the source status is `partial` with detail `legacy display-line bridge`.

Optional CareerOps change (separate PR to CareerOps, not required for Phase A): tag `jobs.workdayTruncated = true` also when
`stopReason === 'cap'` (`providers/workday.mjs:622-637` only logs to stderr today).

### 4.5 Expected sources
Profile `sources.expected: ['careerops','simplify','atsBoards']`. An expected source that is disabled, skipped, errored or
partial makes the scan run `partial`. All attempted partitions erroring → `failed`. Zero records with every partition `ok` →
`ok` (genuine empty census) and is distinguishable from all-error in the receipt.

---

## 5. Policy inputs (data home, never in the repo)

- `<home>/.career-journal/profile/screening-policy.json` — `userExcludedCompanies`, company/program `rules` with
  `limit, used, usedConfirmed, window, resetAt, blocked, blockReason, distinctApplicationsInWindow, program`.
- `<home>/.career-journal/profile/facts.json` — `[{ id, statement, polarity: has|lacks|constraint|unconfirmed, value? }]`.
- `<home>/.career-journal/profile/review-policy.json` — allowed areas (summer areas, off-season/co-op areas), function
  scope, fit adjustments, service targets, budget defaults, judge configuration (models, codex homes), fetcher command.
- `<home>/.career-journal/profile/review-provenance.json` — exact checker reason prefixes that identify **automated**
  historical `queue_skipped` withdrawals, and markers that identify user declines (section 8.2).

Geography in Phase A (no full gazetteer): R2 may reject only when every official structured place names a US state
outside the allowed-states set or an explicit non-US country, the set is complete and remote scope is known not-US. Any
place inside an allowed state (city/county membership needed) goes to R3, which receives the policy text with the county
lists. Short state codes match only in `City, ST` position.

---

## 6. Review worker (L2) — `career-journal review run [--budget N] [--deadline-min M] [--run-id R] [--json]`

### 6.0 Run and item leases, fencing
- Run lease = `runs` row `kind='review', status='running'`; a second invocation while it is live exits **75**. A lease whose
  `heartbeat_at` is > 10 min old is reclaimed: the old row becomes `interrupted`, the next receipt sets
  `previous_run_interrupted: true`. Heartbeat every 60 s.
- Item claim: `UPDATE reviews SET state='leased', lease_owner=?, lease_generation=lease_generation+1, lease_until=?` →
  the claimer keeps `(owner, generation)`. Item lease 30 min, renewed per stage.
- **Fencing**: every stage commit runs `UPDATE … WHERE posting_id=? AND lease_owner=? AND lease_generation=?` and checks
  one row changed, inside the same transaction as its effects; otherwise it throws `StaleLeaseError` and rolls back. A
  worker that outlived its lease therefore cannot commit after takeover.
- **Dependency check at commit**: each stage records the dep hash it started from (section 6.5); the commit recomputes the
  current dep hash and, if it differs, discards the result and re-queues the earliest affected stage.

### 6.1 R1 fetch + identity validation (free)
- Fetcher boundary: `commandFetcher({ argv })` runs a configured command that reads one JSON request
  `{ postingId, url, known: { company, title, requisition } }` on stdin and prints one JSON result
  `{ ok, httpStatus, finalUrl, method, title, requisitionId, company, locations[], offices[], remote, workplaceType,
  employmentType, text, jsonLd, closedWording, error }`. The existing private Python fetcher may be wrapped with a
  `--json` mode; CJ ships a minimal built-in fetcher (Greenhouse/Lever/Ashby detail APIs + JSON-LD) used when no command is
  configured. Porting the remaining endpoints to Node is Phase B.
- `validateSnapshot(posting, result)` → `identityOk` + reason:
  `not_found` (404/410) → `availability='unavailable'` + rechecks at +1, +3, +7 days (never `closed_verified`);
  `host_mismatch` (final host not the ATS/employer host); `challenge` (login/captcha/search page markers);
  `req_conflict` (fetched requisition ≠ the posting's authoritative requisition — **title equality does not rescue it**);
  `wrong_posting` (no requisition and normalized title not matching); `too_short` (< 600 chars and no JSON-LD JobPosting
  and no requirements-like section). Renamed title with the same requisition is valid.
- On success: snapshot row, `reconcileAliases` with any new authoritative alias (section 3.4), structured location fields
  captured in full.
- Failure: retry later in the same run (+2 min, +10 min), then next nights; after 3 failed nights →
  `held(browser_review)`, `hold_owner='user'`, link in the report.
- `closed_verified` only on explicit closed wording, **or** detail absent **and** the posting missing from two consecutive
  successful censuses of its partition (`observation_sightings` + `run_sources.status='ok'`).
- `review attach --posting <id> --file <txt>` stores a `method='manual'` snapshot (replaces positional `jd_pre/` files).

### 6.2 R2 free structured checks
- Drop `out_of_area` only under the section 5 geography rule; anything uncertain continues to R3. Never a term rejection.
- Same snapshot content hash and same R3 dep hash → reuse the stored R3 judgment (no attempt).

### 6.3 R3 judgment
#### 6.3.1 Judge adapter (interface)
```js
// src/review/judge.mjs
adapter = { id, runner: 'codex' | 'fake' | …, model, tier: 'primary' | 'escalation',
            async judge(request, { attemptId, outputPath, signal }) →
              { status: 'ok' | 'refused' | 'invalid' | 'error' | 'timeout', output, rawText, usage, transportRetries } }
```
- `codexExecAdapter({ bin, codexHome, model, tier, schemaPath, workDir, timeoutMs, spawnImpl })`. Argv built by
  `buildCodexArgv`: `exec --ephemeral --skip-git-repo-check --ignore-rules -s read-only -C <emptyWorkDir> -m <model>
  --output-schema <schemaPath> -o <outputPath> --json -` with env `CODEX_HOME=<codexHome>`; the prompt goes on stdin. No API
  key, no `OPENAI_API_KEY`, no SDK. Retry-disabling `-c` overrides are passed if the installed CLI supports them (confirm
  against `codex --version` and record it in the R3 dep hash); every `--json` event that reports a reconnect/retry is
  counted into `transportRetries` and the receipt. The adapter itself never retries.
- Two configured adapters: `primary` (cheaper model, e.g. on the backup Codex home) and `escalation` (stronger model, main
  Codex home). Model names and Codex homes come only from `review-policy.json` (no hardcoded defaults in code; missing
  config fails the run with a clear error).
- Tests use a fake adapter that returns scripted outputs and counts calls.

#### 6.3.2 Request and output schema
Input: facts (`facts.json`), policy text (allowed areas incl. county lists, terms, in-scope functions, exclusions, program
rules), the snapshot split into numbered sections as delimited data. Output (JSON Schema shipped in `src/review/schema/`):
- `alternatives[]`: `{ term: { label, year, kind?, start, end, quote }, offices: [{ place, area: <an area key from the user policy>|outside|unknown, quote }], remote: { scope: us|state:<ST>|none|non_us, quote } }`. Code checks `area` against the place where it can (explicit state code outside the allowed states → `outside`; a state-wide allowed area such as a whole state matches its state code); an `outside` claim for a place inside an allowed state is a semantic rejection and escalates — one per
  distinct work-window/location combination stated by the posting; never cross-combined;
- `criteria[]`: `{ key: degree|graduation|authorization|clearance|defense|return_offer|requirement|closed|function,
  status: meets|conflicts|unclear, quote, clause_alternatives[], fact_ids[] }`;
- `function`: one of `ai_ml|data|analytics|data_eng|quant|product_ai_data|product_general|tpm_epm|fde|sales|hardware|other`
  with a quote;
- `program`: `{ name_quote, country_scope_quote }` (needed by program-scoped company rules, section 6.4.3);
- `deadline`: `{ kind cutoff|posting_end|rolling|none, date, time, tz, precision, quote }` (no invented 23:59);
- `fit`: `{ level high|medium|low, strengths[], gaps[] }`.

#### 6.3.3 Validation and decision in code (`src/review/clauses.mjs`, `src/review/decide.mjs`)
- `segmentSections(text)` splits the snapshot by deterministic heading patterns into `required`, `preferred`,
  `eligibility`, `responsibilities`, `other`, `unknown`. The model-reported section is ignored.
- Every quote must occur in the snapshot (whitespace/quote-mark normalized); its offset determines the section. A quote not
  found → criterion discarded.
- `clauseAt(text, offset)` returns the whole bullet (or sentence when there are no bullets). A **conflict** is confirmed only
  when: the quote covers the whole clause (≥ 90 % of its normalized length); the clause is in a `required` or `eligibility`
  section; for qualification conflicts every OR-alternative of the clause (markers: ` or `, `/`, `one of`, `any of`,
  `such as`, `e.g.`, `including`) is listed in `clause_alternatives` and each has a `lacks`/`constraint` fact; the clause has
  no "or equivalent (practical) experience" marker. Unconfirmed conflicts are not rejections.
- `not_eligible` needs ≥ 1 confirmed conflict. Preferred/unknown-section quotes never block. Missing positive evidence where
  it is required (an alternative with a 2027 term **and** an allowed office or US remote, per the union policy:
  Summer 2027 ∧ allowed area, or 2027 off-season/co-op ∧ (co-op area ∨ US remote)) → `unclear`. Absence of
  citizenship/clearance/no-return-offer wording is fine.
- **Escalation**: every semantic rejection proposed by the primary model (`not_eligible`, function `sales`/`hardware`/`other`
  that would exclude, closed wording), every invalid or partial quote on a negative, and every contradictory alternative is
  re-judged by the escalation adapter. Only an escalation-tier result that passes validation can produce `not_eligible`.
  Escalation unavailable or budget exhausted → item stays `due` (lane `aged` next night), never rejected.
- `function = sales` with analytics content → `unclear(user_review)` (policy call). `refused` / `invalid` from the
  escalation tier → `unclear`.
- Fit adjustments come from `review-policy.json fit` (e.g. `quant: 'low'` forces a function to low, `productGeneralLowerBy: 1` lowers
  general product roles one level); eligible low fit stays eligible (visible, sorted last).
- `unclear` → `held` with `code`, a one-line question and `nextAction: user_review | browser_review`, `hold_owner='user'`.

### 6.4 R4 deliver — every verdict, one transaction (`src/review/deliver.mjs`)
Inside `BEGIN IMMEDIATE`: fence check → **reread** the bound application (`status`, `skip_reason`, `skip_owner`, last event)
→ apply the table → write `review_log(kind='delivery')` → set `reviews.state` → read back the application row and the review
row in the same transaction; any mismatch rolls back and the item stays `due` (run `partial`).

#### 6.4.1 Visibility table (application not submitted, not user-touched)
| Verdict | No application | Visible lead | Hidden lead (`skip_owner='review'`) | Withdrawn by review/automated checker | `prepared` |
|---|---|---|---|---|---|
| eligible | create lead (`external_id='posting:<id>'`), fit/location/deadline/source fields, event `review_delivered` | bind, update fit/deadline | unhide (clear skip_reason/owner), event | **restore** via guarded `withdrawn→lead` (event `review_restored`) | unchanged, clear review hold |
| unclear / held / unavailable / quota hold | create **hidden** lead (`skip_owner='review'`, reason `待核: <code> — <question>`) | hide | update reason | stays withdrawn | flag only (reason, no status change) |
| not_eligible / dropped(out_of_area) / closed_verified / company_excluded | nothing | withdraw (event `review_withdrawn`, `source.actor='review-worker'`, evidence) | withdraw | unchanged | flag only — prepared materials are never withdrawn |

#### 6.4.2 Never override the user
- Submitted statuses, user-declined withdrawals, `skip_owner IN ('user','legacy')` and any application whose last event is a
  user event newer than the stage start → **no change**; the review records `superseded_by_user`.
- Guarded restore `withdrawn→lead`: added to `status-machine.mjs` as a transition allowed **only** through
  `deliver()` when the last status event has `source.actor='review-worker'` (or bootstrap-classified automated provenance,
  section 8.2) and the posting is not user-declined. `assertStatusTransition('withdrawn','lead')` stays invalid for every
  other caller.
- `queue verify` (`src/commands/queue.mjs:55-91`) becomes a user action: it closes the review (`decision` from the user,
  `review_log(kind='user')`) in the same transaction and marks its event `source.actor='user'` unless called with
  `--actor review-worker`.

#### 6.4.3 Company rules at R4 (from `screening-policy.json`)
`excluded` → withdraw/no lead. `quota_full` (`used`/`usedConfirmed` ≥ `limit` and window known) → hold with recheck at window
end. `quota_reconciliation` (`blockReason: quota-reconciliation-pending`, or `blocked: true` with
`distinctApplicationsInWindow: null`) → hold until the policy file hash changes; **never** released by window expiry.
`allowed_recount` (`blocked: false` with a recount note) → lead with note. Program-scoped rule (program or country scope)
→ matched against R3 `program`; no program evidence → `quota_unclear` hold.

#### 6.4.4 Mail
Mail lookup stays in the wrapper and runs after `review run`, only for leads delivered in that run.
`review annotate --posting <id> --mail <exact|company> --message-id <id> --subject <s> --received <iso> --matched <token>`:
`company` → note event only (lead stays visible). `exact` (the confirmation mail contains the posting's exact requisition id or
exact canonical URL) → hide as `already_applied_mail` with `skip_owner='review'` and the evidence; reversible with
`review unhide --posting <id>` or any user status change. No prose / "same program" judgments.

### 6.5 Dependency hashes and replan
Per stage `dep_hashes_json`: `scan` = classify code version + policy subset; `fetch` = fetcher code/command version;
`check` = R2 code version + geography policy; `judge` = snapshot hash + facts hash + prompt + schema + adapter (runner, model,
tier, CLI version) + decision code version; `deliver` = screening-policy hash + fit rules + deliver code version.
`review replan` (also at the start of every `review run`) re-queues reviews whose stored hash differs at the earliest
affected stage, skipping submitted, user-declined and `hold_owner='user'` items whose question is unanswered. Idempotent.

---

## 7. Budget, ordering, liveness

### 7.1 Budget = model attempts
`--budget N` caps **attempts** per run across both tiers. Every `codex exec` invocation is one attempt whether it succeeds,
fails, times out or is lost. `src/review/budget.mjs`: `reserve()` inserts an `attempts` row with `state='dispatched'` and
commits **before** spawning; returns `null` when the cap is reached (the item stays `due`, no partial rows).

### 7.2 Ambiguous outcomes (no exactly-once claim)
- Response received → one transaction: `review_log(kind='llm_raw')` + `attempts.state='responded'` + usage.
- Crash after dispatch, before that commit → next run `recoverLost()`: if the attempt's `output_path` file exists and parses
  → `adopted` (logged, no second call); else `lost` (counted against that run's budget, `reviews.lost_attempts+1`, item back to
  `due`). Two lost attempts on one item → `held(system_failure)`, `hold_owner='system'`, reported as a breach.
- Crash after `llm_raw` commit, before decision → resume decides from the logged output; no new attempt.

### 7.3 Ordering and reserved capacity
Free stages (R1/R2) run first over all due items within `--deadline-min`. Paid order: (1) deadline known ≤ 7 days, earliest
first; (2) **aged** — items waiting ≥ `agedAfterDays` (default 2), oldest first, with ≥ 25 % of the budget reserved;
(3) bootstrap; (4) new FIFO by `first_seen`; (5) refresh; (6) `no_student_signal`. Unknown deadlines are ordered by age, so
they cannot starve.

### 7.4 Service targets and breaches (numeric)
`review-policy.json serviceTargets` defaults: `maxWaitNights = 3` for system-owned work (due → terminal or user-owned hold);
`deadlineMaxWaitNights = 1` for deadline ≤ 7 days; `userHoldTargetDays = 2` for user-owned holds (`browser_review`,
`user_review`). A system-owned item past its target is a **breach**: listed in the receipt `breaches[]`, run status
`partial` (exit 2), and the notification says so. User-owned holds past target are reported separately (`awaiting_user[]`
with age) and are not system breaches. The receipt reports `eta_nights = backlog / max(1, budget − arrivals_7d_avg)` and,
when `eta_nights > maxWaitNights`, `recommendation: 'raise budget to N'`.

Freshness: active leads re-fetched every 7 days, daily within 3 days of a deadline; `unavailable` rechecked 1/3/7 days then
weekly for 30 days; `not_eligible` and `dropped(out_of_area)` re-fetched every 14 days for 60 days. After a horizon expires,
a new sighting with a changed content hash, a `listed` flip, or a reappearance after ≥ 14 days unseen renews the review
(stage `fetch`). Same hash costs nothing.

---

## 8. Bootstrap of existing state (L1) — `career-journal review bootstrap`

### 8.1 Postings for every application
Every `applications` row gets a posting + aliases (`job_url`, `external_id`, `source/source_id`) bound via
`postings.application_id`, so submitted and declined history is found by identity.

### 8.2 Provenance
- Automated: a `queue_skipped` event whose `note` starts with a prefix listed in `review-provenance.json
  automatedSkipPrefixes`, application has no `applied_at`, that event is the last status event, and no later event of a user
  type exists. New withdrawals from this release carry `source.actor` explicitly.
- User: notes matching `userDeclineMarkers`, an excluded company, or any status change recorded by a user command.
- Anything else → **unknown** → `held(provenance_unknown)`, `hold_owner='user'`, never auto-restored.

### 8.3 Review rows created
| Existing state | Review |
|---|---|
| submitted status | `done / reused(already_submitted)` |
| user-declined withdrawal | `done / reused(user_declined)` |
| automated withdrawal | `due`, lane `bootstrap`, stage `fetch` (restore allowed if eligible) |
| unknown-provenance withdrawal | `held(provenance_unknown)` |
| hidden/held lead, legacy reason matching an automated prefix | `due`, lane `bootstrap`; `skip_owner` set to `review` |
| hidden/held lead, other reason | `held`, `skip_owner='legacy'`, `hold_owner='user'` |
| visible lead / prepared | `due`, lane `refresh` |
Bootstrap is idempotent (second run changes nothing).

---

## 9. Receipts and exit codes

- Receipt (`runs.receipt_json` and `<home>/.career-journal/runs/<run_id>.json`, plus `runs/latest.json` pointer):
  `{ schema: 1, run_id, run_date, kind, started, finished, status, previous_run_interrupted,
  sources: [{ source, partition, status, count, errors, truncated, expected }],
  counts: { observed, new_postings, dropped_by_code, reused, quarantined, fetched, attempts, attempts_lost, escalations,
  eligible, not_eligible, held, failed, delivered, superseded_by_user },
  backlog: { due, oldest_days, max_wait_days, due_7d_deadline, eta_nights, recommendation },
  breaches: [], awaiting_user: [], transport_retries }`.
- `readCurrentReceipt(home, { date, runId })` returns `{ state: 'finished'|'running'|'missing'|'stale' }` — a receipt from an
  earlier date is `stale`, never "today's".
- Exit codes: `scan run` 0 ok / 2 partial / 1 failed; `review run` 0 ok / 2 partial (breach, budget exhausted with due items past
  target, delivery failure, upstream partial) / 1 failed / **75** busy. `worstExit(codes)`: any 1 → 1; else any 75 → 75; else
  any 2 → 2; else 0.
- `daily.py` (outside the repo) becomes a thin wrapper: generate `run_id`; `scan run --json --run-id`; `review run --budget
  --deadline-min --run-id --json`; mail notes; `review report --run-id --lang zh` → `reports/<date>.md`; exit `worstExit`.
  Removed from it: the double scan, positional `jd/NN.txt`, all Jev / API gates (eligibility, mail prose, requirements, fit,
  `UNCONFIRMED` regex — its facts move to `facts.json` as `unconfirmed`), and the unconditional `exit 0`.
- `nightly.sh`: `python3 daily.py > LOG 2>&1; rc=$?` captured immediately; notification text from
  `career-journal review receipt --latest --summary zh`; graphify refresh may run after but cannot change `rc`; `exit $rc`.
- The 21:15 reviewer task reads only `readCurrentReceipt` output + `review list --held --json`; it resolves held items with
  `review resolve` / `queue verify` (user actions), and if the receipt is `running` or `missing` polls every 5 min up to 60 min,
  then reports "not finished".

---

## 10. Decisions still open (defaults apply until answered)

- **D1 `no_student_signal` volume.** With CareerOps raw emission every full-time posting at every tracked employer becomes an
  observation. Default: such postings get a free R1 fetch and then wait in the lowest lane (no paid attempt while any higher
  lane has due work; reported as `no_student_signal_backlog`, not a breach). Alternative (user choice): free drop when the
  complete official text has no student signal (re-checked on content change, audited weekly). The default never drops.
- **D2 primary model** for the judge (cheaper tier) and the escalation model; both are configuration.
- **D3 nightly attempt budget** for the census; measure the first 3 nights, then resize.

---

## 11. Shared contract module `src/funnel/contract.mjs` (owned by L1, frozen for L2)

Exports exactly these frozen objects (values are the strings used in the schema above):
`REVIEW_STAGES = ['scan','fetch','check','judge','deliver']`, `REVIEW_STATES = ['due','leased','held','done','failed']`,
`DECISIONS = ['dropped','reused','not_eligible','eligible','unclear']`, `LANES = ['deadline','aged','bootstrap','new',
'refresh','no_student_signal']`, `DROP_CODES = ['company_excluded','non_us_only','full_time_only','out_of_area']`,
`REUSE_CODES = ['already_submitted','user_declined']`, `HOLD_CODES = ['user_review','browser_review','identity_conflict',
'provenance_unknown','system_failure','quota_full','quota_reconciliation','quota_unclear','unavailable','already_applied_mail']`,
`SUBMITTED_STATUSES = ['applied','assessment','interview','offer','accepted','declined','rejected']`,
`EXIT = { OK: 0, FAILED: 1, PARTIAL: 2, BUSY: 75 }`, `ACTOR = { WORKER: 'review-worker', USER: 'user', BOOTSTRAP: 'bootstrap' }`,
`EXTERNAL_ID_PREFIX = 'posting:'`. Changing it requires a coordinator-approved edit to this section first.

---

## 12. IMPACT MAP — every caller/consumer that must change

Found with the code graph (`graphify explain`/`path` on `runScan`, `dedupeRoles`, `canonicalUrl`, `requisitionKey`,
`filterRole`, `listQueue`, `verifyQueuedRole`, `parseSimplify`, `parseGreenhouse`, `parseAshby`, `scanCareerOps`,
`parseScanOutput`, `insertLead`, `openHomeDatabase`, `assertStatusTransition`, `existingApplications`) and verified by reading
the code; cross-project consumers mapped by reading the wrapper and scheduled-task prompts manually (the graph does not see
JSON consumers).

### 12.1 This repository
| File:line | Today | Change | Lane |
|---|---|---|---|
| `src/storage/database.mjs:10` | `schemaMigrations` 1–5 | add `migration006`; newer-schema refusal helper | L1 |
| `src/storage/migrations/006-funnel.mjs` (new) | — | section 2 | L1 |
| `src/runtime/home.mjs:11-19` | checks pending known migrations only | refuse newer unknown schema | L1 |
| `src/commands/setup.mjs:76,152-158`; `src/commands/doctor.mjs:108`; `src/commands/scan.mjs:26-30`; `src/commands/migrate.mjs:10-29` | pending-migration checks | same newer-schema refusal; migrate prints 006 | L1 |
| `src/scan/run.mjs:22-31` `collectRoles` | flat role list | per-source batches with partition + completeness | L1 |
| `src/scan/run.mjs:42-102` `insertLead` | creates leads at scan | **removed** from scan (lead creation moves to R4) | L1 |
| `src/scan/run.mjs:105-184` `runScan` | filter → dedupe → fit → insert; JSON `held/queued/dropped/duplicates` | section 4.3 ingestion; new JSON | L1 |
| `src/scan/run.mjs:33-36` `existingApplications` | feeds dedupe | replaced by alias lookup | L1 |
| `src/scan/filter.mjs:377-401` `filterRole` (and `checkJobType` `:145-158`, `INTERNSHIP` `:143`) | hard drops on season/direction/degree/location/job type | replaced in the scan path by `classifyRole`; `INTERNSHIP` vocabulary widened (section 4.2); `rankLocation` kept for queue ordering (`queue.mjs:29-32`) | L1 |
| `src/scan/dedupe.mjs:79-129,131-139,167-224` | lowercasing `requisitionKey`/`canonicalUrl`, fuzzy drops | not used by scan; superseded by `src/funnel/identity.mjs` | L1 |
| `src/scan/sources/simplify.mjs:3-9,17` | drops inactive; contract comment | keep inactive with `listed=false`; comment: minimal local observations, 180-day retention, never redistributed | L1 |
| `src/scan/sources/ats-boards.mjs:26-33,81` | GH primary-only location; Ashby drops unlisted | union offices; keep unlisted; completeness | L1 |
| `src/scan/sources/careerops.mjs:9-41` | parses bridge display roles | parse raw structured emission, per-partition status | L1 |
| `src/integrations/careerops-scan-bridge.mjs:23-26,50-87,96-122,138` | narrow title filter, display-line parsing, errors dropped | `scan-raw` command (section 4.4); legacy path flagged partial | L1 |
| `src/integrations/careerops.mjs:116-147` | `detectCareerOpsScan`/`runCareerOpsScan` | request `scan-raw`; pass temp `CAREER_OPS_ROOT` | L1 |
| `src/commands/scan.mjs:60-63,83-99` `scanFailed`/`scanCommand` | exit 1 only when all fail | exit 0/2/1; `--run-id`; new summary text | L1 |
| `src/scan/fit.mjs` (`scoreFit`) via `run.mjs:139` | rule/Jev fit at scan | not called at scan; fit comes from R3 | L1 (removal) |
| `src/domain/status-machine.mjs:9` | `withdrawn` terminal | guarded restore only via `deliver()` (section 6.4.2) | L2 |
| `src/domain/events.mjs:37-60` `recordEvent` → `assertStatusTransition` | | accepts the guarded restore token from `deliver()` only | L2 |
| `src/commands/queue.mjs:44-48` `listQueue` | `status='lead' AND skip_reason IS NULL` | unchanged semantics (R4 keeps `skip_reason` the visibility switch); sort keeps low fit last | — (verify) |
| `src/commands/queue.mjs:55-91` `verifyQueuedRole` | user/agent skip → withdrawn | closes the review as a user decision; `source.actor` | L2 |
| `src/commands/queue.mjs:100-153` `scoreQueuedRoles` | rescoring via Jev/LLM | leave; not used by the funnel | — |
| `src/commands/review.mjs` (new), `src/runtime/create-runtime.mjs:19-40`, `src/cli/main.mjs:5-27` | — | register `review` (run, bootstrap, replan, list, report, receipt, attach, annotate, unhide, resolve) | L2 (bootstrap subcommand calls L1's `bootstrapExisting`) |
| `src/server/routes.mjs:49-52`; `web/dashboard-model.js:12,154,252,306-352`; `web/app.js:470-500` | read `skip_reason` for queue/held cards | unchanged contract (`skip_reason` + status); optional "低优先" label from `fit='low'` | — (verify only) |
| `test/storage/migrations.test.mjs:8-15` | expects versions 1–5 | expect 1–6 | L1 |
| `test/scan/sources.test.mjs` (Simplify/Ashby/GH/bridge cases) | old drop/primary-location behaviour | update to new semantics | L1 |
| `test/scan/dedupe.test.mjs`, `test/scan/filter.test.mjs`, `test/scan/fit.test.mjs` | legacy helpers | keep while helpers exist; delete tests only with their code | L1 |
| `test/server/api.test.mjs:13` | uses `verifyQueuedRole` | still passes with the review closure | L2 |

### 12.2 Outside the repository (private wrapper in the user's data home; exact paths in the private lane notes)
| File:line | Today | Change | Lane |
|---|---|---|---|
| wrapper `daily.py:64-66,158-182` | double scan (dry + real), reads `held` JSON, id lookup by source_id/url | single `scan run --run-id` | L2 |
| `daily.py:184-203` | positional `fetch_jd.py` → `jd/NN.txt`, `jd_pre/NN.txt` | removed; R1 fetcher; `review attach` | L2 |
| `daily.py:209-236,255-302` | Claude API + Jev eligibility / requirement / fit gates, quant/PM regex, low-fit skip | removed (R3 + R4) | L2 |
| `daily.py:238-253` | company-level mail prose gate via Jev | exact-req mail notes only (`review annotate`) | L2 |
| `daily.py:304-325` | writes via `queue verify`, swallows errors | removed; R4 delivers | L2 |
| `daily.py:329-378` | report + `SUMMARY` line; always `return 0` | `review report`; `worstExit` | L2 |
| private fetcher `fetch_jd.py:36-108` | positional pipe output | add `--json` single-request mode matching section 6.1 (optional; built-in fetcher otherwise) | L2 |
| wrapper `nightly.sh:10-14` | greps `SUMMARY`, never propagates rc, graphify `|| true` before notify | section 9 | L2 |
| nightly reviewer scheduled-task prompt (lines 8, 12-13, 17) | reads log `SUMMARY`, releases held via `queue verify` | read `readCurrentReceipt` + `review list --held`; resolve via `review resolve`/`queue verify` | L2 (prompt text; coordinator applies) |
| an older, unregistered scan task prompt (line 24) | runs `scan run` directly | leave unregistered; do not re-enable | — |
| CareerOps `providers/workday.mjs:622-637` | cap truncation only logged | optional: tag `workdayTruncated` (separate CareerOps PR) | optional |
