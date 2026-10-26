# Lane L2 — review worker, judge adapter, budget, receipts, wrapper

Read first: `SPEC.md` sections 0, 1, 5–7, 9–12. Red tests you must turn green (do not edit them): every test titled `[L2]` in
`test/funnel-v3/l2-*.test.mjs`. Run: `node --test 'test/funnel-v3/*.test.mjs'`. Code graph: `graphify explain/path` with the
private graph path given by the coordinator — clue only.

**Start condition:** L1 task 1 (contract + migration 006) pushed. Before that, L2 may write `judge.mjs`, `clauses.mjs`,
`decide.mjs`, `budget.mjs` interfaces and the wrapper drafts, which need no schema.

## Files owned (only L2 edits these)
- `src/review/*.mjs` (new): `lease.mjs`, `fetch.mjs`, `check.mjs`, `clauses.mjs`, `decide.mjs`, `judge.mjs`, `schema/judgment.schema.json`,
  `prompt.mjs`, `budget.mjs`, `deliver.mjs`, `freshness.mjs`, `worker.mjs`, `receipt.mjs`, `report.mjs`
- `src/commands/review.mjs` (new), `src/runtime/create-runtime.mjs`, `src/cli/main.mjs` (help line)
- `src/domain/status-machine.mjs`, `src/domain/events.mjs` (guarded restore only), `src/commands/queue.mjs` (`verifyQueuedRole` review closure + actor)
- Outside the repo (private, coordinator gives exact paths): the daily wrapper `daily.py`, `nightly.sh`, the private fetcher's
  `--json` mode, and the nightly reviewer task prompt text (coordinator applies the prompt change).

## Tasks
1. **Judge adapter** (SPEC 6.3.1): `buildCodexArgv`, `codexExecAdapter({ bin, codexHome, model, tier, schemaPath, workDir, timeoutMs, runImpl })`,
   `createJudgeAdapters(reviewPolicy)` (fails without model/codexHome). Check the installed CLI for retry-disabling `-c` keys; record
   `codex --version` in the R3 dep hash. JSON schema file for the judgment (SPEC 6.3.2, including `program` and `area`).
2. **Clauses + decide** (SPEC 6.3.3): `segmentSections`, `clauseAt`, `validateCriterion`, `decide`. Escalation rules exactly as written.
3. **Budget + attempts** (SPEC 7.1–7.2): `createBudget`, `recoverLost` (adoption of a parsable output file, else `lost`).
4. **Leases + fencing** (SPEC 6.0): `acquireRunLease`, `heartbeat`, `finishRun`, `claimItem`, `assertFence`, `StaleLeaseError`.
5. **R1 fetch** (SPEC 6.1): `commandFetcher`, minimal built-in fetcher, `validateSnapshot`; snapshot rows; call L1 `reconcileAliases`
   inside the R1 commit; availability/closure rules using `observation_sightings` + `run_sources`.
6. **R2** (SPEC 6.2) and **R4 deliver** (SPEC 6.4): visibility table for every verdict, user precedence, guarded restore,
   company rules, `annotateMail`, `unhide`, `recheckHolds`; `verifyQueuedRole` closes the review (`review_log(kind='user')`).
7. **Worker** (SPEC 6, 7.3, 7.4): `runReview`, `replan`, ordering/lanes, reserved aged capacity, service targets, breaches,
   freshness; crash hooks (below).
8. **Receipts + CLI** (SPEC 9): `buildReceipt`, `writeReceipt`, `readCurrentReceipt`, `reviewExitCode`, `worstExit`; `career-journal review
   run|bootstrap|replan|list|report|receipt|attach|annotate|unhide|resolve` (bootstrap calls L1 `bootstrapExisting`).
9. **Wrapper (private):** `daily.py` thin wrapper (≈60–80 lines) and `nightly.sh` per SPEC 9; remove the old gates; keep the old
   files on disk but unused. Shell-level check on a staged copy of the data home: forced partial → wrapper exit 2 and notification
   text says partial; overlapping run → 75; failure → 1.

## Interface contract (what L2 provides; L1 consumes nothing from L2 except the `review bootstrap` CLI wiring)
```js
// src/review/judge.mjs
buildCodexArgv({ bin, codexHome, model, schemaPath, outputPath, workDir }) → { command, args, env }
codexExecAdapter(opts) → adapter            // adapter.judge(request, { attemptId, outputPath, signal }) → { status, output, rawText, usage, transportRetries, error? }
createJudgeAdapters(reviewPolicy) → { primary, escalation }
// src/review/clauses.mjs
segmentSections(text) → [{ kind: 'required'|'preferred'|'eligibility'|'responsibilities'|'other'|'unknown', start, end, heading }]
clauseAt(text, offset) → { start, end, text }
validateCriterion(text, criterion, facts) → { valid, reason, section, clause, confirmedConflict }
// src/review/decide.mjs
decide({ snapshotText, judgment, facts, policy, tier }) →
   { decision: 'eligible'|'not_eligible'|'unclear', code, escalate, nextAction?, question?, evidence: [{ confirmed, section, clause, factIds, quote }], fit: { level, note } }
// src/review/budget.mjs
createBudget(db, { runId, limit }) → { reserve({ postingId, stage, runner, model, tier, now }) → { id, outputPath } | null,
   markResponded(id, { usage, now }), markFailed(id, { error, now }), used(), remaining() }
recoverLost(db, { attemptDir, now }) → { lost, adopted }
// src/review/lease.mjs
acquireRunLease(db, { kind, owner, runId, now, staleAfterMs = 600000 }) → lease | null
claimItem(db, postingId, { owner, now, ttlMs = 1800000 }) → { owner, generation } | null
assertFence(db, postingId, fence) → void   // throws StaleLeaseError
class StaleLeaseError extends Error
// src/review/fetch.mjs
commandFetcher({ argv, runImpl? }) → { fetch(request) → result }
validateSnapshot(posting /* { id, company, title, url, requisition } */, result) → { identityOk, reason }
// src/review/deliver.mjs
deliver(db, { postingId, verdict, fence, now, policy /* screening policy */ }) →
   { action: 'created'|'bound'|'restored'|'hidden'|'withdrawn'|'unchanged'|'superseded_by_user', applicationId }
annotateMail(db, { postingId, match: 'exact'|'company', messageId, subject, received, matched, now })   // company → event 'mail_note'
unhide(db, { postingId, now })
// src/review/freshness.mjs
recheckHolds(db, { now, screeningPolicy }) → { requeued }
// src/review/worker.mjs
runReview({ db, runId, owner, now, budget, deadlineMs, fetcher, judges: { primary, escalation }, attemptDir, sleep,
            inputs: () => ({ facts, policy, screeningPolicy }), hooks }) → receipt   // status 'busy' when the run lease is held
replan(db, { inputs, now }) → { requeued }
// src/review/receipt.mjs
reviewExitCode(receipt) → 0|1|2|75;  worstExit(codes) → 0|1|2|75
writeReceipt(home, receipt);  readCurrentReceipt(home, { date, runId? }) → { state: 'finished'|'running'|'missing'|'stale', receipt? }
```
Worker conventions the tests rely on:
- All timestamps written during a run use the run's `now` (reviews.updated_at = now for items finished in that run).
- `inputs()` is called at stage start and again at commit; a changed R3 dep hash at commit discards the result, writes
  `review_log(kind='replan')` and re-queues (or re-judges within the same run if budget allows).
- Test hooks (`hooks.afterDispatch({ attempt, outputPath })`, `hooks.afterResponse({ attempt, outputPath, result })`,
  `hooks.afterLlmLog({ attempt })`, `hooks.insideDeliver({ postingId })` — called inside the R4 transaction,
  `hooks.beforeFinish()`) may throw; the worker must let any hook error propagate immediately without cleanup (simulated kill).
- Every judge call is preceded by exactly one `attempts` row; the adapter never retries; R3 errors retry on a later run (or later in
  the same run only through another reserved attempt).
- Receipt fields used by tests: `status`, `previous_run_interrupted`, `counts.{attempts, attempts_lost, escalations}`,
  `breaches[].postingId`, `awaiting_user[].postingId`, `backlog.recommendation`.

## Done when
- All `[L2]` tests pass; pre-existing suite passes; `test/server/api.test.mjs` still passes with the `verifyQueuedRole` change.
- Private staged run (copy of the data home, fake or real judge with budget ≤ 5): receipt written, exit code propagated by
  `daily.py` and `nightly.sh`, report rendered, no application duplicated, attempts ≤ budget.
- Private real-role acceptance list walked on frozen snapshots with expected terminal states recorded (coordinator holds the list).
- Self-check report: files changed, IMPACT MAP rows closed for L2, raw test output, the `codex --version` used and whether retry
  overrides were available.
