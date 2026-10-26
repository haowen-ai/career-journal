# Lane L1 — storage, identity, collectors, bootstrap

Read first: `SPEC.md` sections 0–5, 8, 11, 12. Red tests you must turn green (do not edit them):
`test/funnel-v3/l1-*.test.mjs` and every test titled `[L1]` in `test/funnel-v3/l2-recovery.test.mjs`.
Run: `node --test 'test/funnel-v3/*.test.mjs'`. Code graph for impact checks:
`graphify explain "<symbol>()" --graph <private graph path given by the coordinator>` — clue only; verify against the code.

## Files owned (only L1 edits these)
- `src/storage/database.mjs`, `src/storage/migrations/006-funnel.mjs` (new), `src/runtime/home.mjs`
- `src/commands/setup.mjs` (newer-schema check only), `src/commands/doctor.mjs` (same), `src/commands/migrate.mjs`, `src/commands/scan.mjs`
- `src/funnel/contract.mjs` (new, **first commit**), `src/funnel/identity.mjs`, `src/funnel/classify.mjs`, `src/funnel/ingest.mjs`,
  `src/funnel/bootstrap.mjs`, `src/funnel/data/countries.json` (new)
- `src/scan/run.mjs`, `src/scan/filter.mjs` (vocabulary only), `src/scan/sources/*.mjs`
- `src/integrations/careerops-scan-bridge.mjs`, `src/integrations/careerops.mjs`
- Existing tests to update for the new semantics: `test/storage/migrations.test.mjs`, `test/scan/sources.test.mjs`
  (and `test/scan/*.test.mjs` only where a helper is deleted together with its test)

## Tasks (in order; commit after each, push to the lane branch)
1. **Contract + migration (day 1, unblocks L2).** `src/funnel/contract.mjs` exactly as SPEC section 11. Migration 006 (SPEC section 2):
   tables, `applications.skip_owner` + legacy backfill, trigger `applications_legacy_scan_guard`. Export
   `assertSchemaNotNewer(db)` from `database.mjs` and call it from `openHomeDatabase`, setup, doctor, the scan dry-run opener and
   migrate. Update `test/storage/migrations.test.mjs` to versions 1–6. Notify the coordinator when this commit is pushed.
2. **Identity** (`src/funnel/identity.mjs`, SPEC section 3): `canonicalUrl`, `providerRequisition`, `aliasesFor`, `resolvePosting`,
   `reconcileAliases`. Do not reuse `dedupe.mjs requisitionKey/canonicalUrl` (they lowercase).
3. **Parsers** (SPEC section 4.1): Simplify keeps inactive/hidden (`listed:false`); Ashby keeps unlisted; Greenhouse unions offices;
   every record carries `partition`, `listed`, `employmentType`, `offices`, `completeness`. Update the Simplify contract comment
   (`simplify.mjs:3-9`: minimal local observations, 180-day retention, never redistributed).
4. **classifyRole** (SPEC section 4.2) with the widened student vocabulary; also widen `filter.mjs` `INTERNSHIP` and the bridge
   `WIDE_TITLE_FILTER` to the same list (legacy path only).
5. **ingestBatch / recordSourceStatus / runScan / scan command** (SPEC sections 4.3, 4.5): one transaction per source batch,
   sightings per run, quarantine, freshness-horizon renewal on reappearance, expected sources, `scanExitCode`, no leads, no
   `held`/`queued` keys.
6. **CareerOps raw emission** (SPEC section 4.4): `collectCareerOpsRaw`, `scanCareerOpsRaw`, bridge command `scan-raw`,
   `parseCareerOpsRaw`; legacy display-line path marked `partial`. No change to CareerOps itself.
7. **Bootstrap** (SPEC section 8): `bootstrapExisting`; provenance registry from the data home.
8. Full suite: every `[L1]` test green; pre-existing suite green; `npm run check:release` unaffected.

## Interface contract (what L1 provides; L2 relies on exactly this)
```js
// src/storage/database.mjs
assertSchemaNotNewer(db) → void            // throws /schema N is newer than this CAREER JOURNAL/
// src/funnel/contract.mjs — frozen constants (SPEC section 11)
// src/funnel/identity.mjs
canonicalUrl(url) → string | null
providerRequisition(url) → { provider, tenant, id } | null      // provider 'generic' for query ids, tenant = host
aliasesFor(record, { companyAliases } = {}) → [{ alias, kind }]
resolvePosting(db, record, { now }) → { postingId, created, matchedBy, links: [{ postingId, kind: 'maybe_same' }] }   // inside caller txn
reconcileAliases(db, postingId, aliases, { now, fence? }) → { action: 'added' | 'bound' | 'quarantined', postingId, boundTo? }
   // 'bound': postings.merged_into set, review moved to the target (reused if the target is submitted/declined)
   // 'quarantined': posting_links(conflict) + reviews.state='held', code='identity_conflict', hold_owner='user'
   // when called inside an open transaction (R1 commit), it must not BEGIN/COMMIT itself
// src/funnel/classify.mjs
classifyRole(record, { policy, identity: { submitted?, userDeclined? } = {} }) → { kind: 'reuse'|'drop'|'review', code, evidence, flags: [] }
// src/funnel/ingest.mjs
ingestBatch(db, { runId, source, partition, records, now, policy }) →
   { observed, newPostings, reused, dropped: { [code]: n }, review, quarantined }
recordSourceStatus(db, { runId, source, partition, status, count, errors, truncated, expected, detail })
// src/funnel/bootstrap.mjs
bootstrapExisting(db, { provenance, now }) → { postings, reused, requeued, held }      // idempotent
// src/scan/run.mjs
runScan({ db, profile, runId, now, policy, collect? , fetchImpl?, careerOpsConfig?, careerOpsDependencies? }) →
   { runId, status: 'ok'|'partial'|'failed', sources: [...], counts: { observed, newPostings, reused, dropped, review, quarantined } }
   // collect() (injectable) → { sources: [{ source, partition, status, count, detail? }], batches: [{ source, partition, records }] }
// src/commands/scan.mjs
scanExitCode(summary) → 0 | 1 | 2
// src/integrations/careerops-scan-bridge.mjs
collectCareerOpsRaw({ portals, providers, resolveProvider, makeHttpCtx }) → { roles: [...], partitions: [{ partition, status, count, error?, truncated }] }
scanCareerOpsRaw(root, { execute, env, timeoutMs }) → { roles, partitions }     // spawns `<bridge> scan-raw` with temp CAREER_OPS_ROOT
// src/scan/sources/careerops.mjs
parseCareerOpsRaw(result) → { roles, sources: [{ source: 'careerops', partition, status, count, detail? }], status }
```
Rows L1 writes that L2 reads: `postings`, `posting_aliases`, `posting_links`, `observations`, `observation_sightings`,
`run_sources`, `runs(kind='scan')`, `reviews` (state `due`/`held`/`done`, `lane`, `flags_json`, `stage='fetch'` for new work).
L1 never writes `snapshots`, `attempts`, `review_log(kind in llm_raw|delivery|user)` or application rows (bootstrap only sets
`skip_owner`).

Ownership boundary: L2 owns everything that runs inside `review run` (R1–R4), `status-machine.mjs`, `events.mjs`, `queue.mjs`,
`src/commands/review.mjs` and the runtime registration. If L1 needs a change there, write it in the lane notes for the coordinator.

## Done when
- All `[L1]` tests in `test/funnel-v3/` pass; pre-existing suite passes (`node --test $(find test -name '*.test.mjs' -not -path 'test/funnel-v3/*')`).
- `career-journal migrate --dry-run` on a copy of a 2.2.0 database lists 006; `--apply` then `review bootstrap` (L2 wires the CLI;
  call `bootstrapExisting` directly until then) leaves application rows unchanged except `skip_owner`.
- `scan run --json` on a staged copy prints the new summary and exits 0/2/1 by the rules; no application rows are created.
- Self-check report lists every file changed, each IMPACT MAP row closed for L1, and the raw test output.
