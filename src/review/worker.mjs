import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FETCH_BATCH_MIN, JUDGE_TIME_SHARE } from '../funnel/contract.mjs';
import { aliasesFor, reconcileAliases, providerRequisition } from '../funnel/identity.mjs';
import { createBudget, recoverLost } from './budget.mjs';
import { acquireRunLease, heartbeat, finishRun, claimItem, assertFence, atomic } from './lease.mjs';
import { activeCooldown, setCooldown } from './cooldown.mjs';
import { buildJudgeRequest } from './prompt.mjs';
import { dependencyHash, evalCurrent } from './inputs.mjs';
import { segmentSections } from './clauses.mjs';
import { decide } from './decide.mjs';
import { validateSnapshot } from './fetch.mjs';
import { deliver, logReview, parseJson } from './deliver.mjs';
import { scheduleRefresh, recheckHolds } from './freshness.mjs';
import { redact } from '../runtime/redact.mjs';
import { reviewOwnershipJoins, userDecisionSql } from './ownership.mjs';
import { createReviewScheduler } from './schedule.mjs';
import { cachedJudgment, judgmentEnvelope, rememberJudgment } from './judgment-cache.mjs';
import { postingPartitions } from '../funnel/membership.mjs';
import { awaitingUserSummary } from './awaiting-user.mjs';
export { scheduleRefresh } from './freshness.mjs';

const DAY = 86400000;
const explorationLane = (row) => ['no_student_signal', 'out_of_direction'].includes(row.lane);
const postingUrl = (posting) => /^https?:/.test(posting.canonical_url) ? posting.canonical_url : `https://${posting.canonical_url}`;
const factsMap = (facts) => Object.fromEntries(facts.map((fact) => [fact.id, dependencyHash(fact)]));
const judgmentInputsHash = (parts) => dependencyHash(Object.fromEntries(Object.entries(parts).filter(([key]) => key !== 'decide')));
export function inputState(inputs) {
  return { facts: factsMap(inputs.facts), rules: dependencyHash(inputs.rules), policy: dependencyHash({ policy: inputs.policy, jobType: inputs.profile?.search?.jobType ?? null }),
    screening: dependencyHash(inputs.screeningPolicy), provenance: dependencyHash(inputs.provenance), resume: dependencyHash(inputs.resume?.text ?? null),
    windowsAreas: dependencyHash({ windows: inputs.policy.windows, areas: inputs.policy.areas, jobType: inputs.profile?.search?.jobType ?? null }),
    code: dependencyHash(Object.fromEntries(['prompt.mjs','schema/judgment.schema.json','decide.mjs','clauses.mjs','deadline.mjs'].map((file) => [file, readFileSync(new URL(file, import.meta.url), 'utf8')]))) };
}

export function replan(db, { inputs, now }) {
  const current = typeof inputs === 'function' ? inputs() : inputs;
  const state = inputState(current);
  let requeued = 0;
  atomic(db, () => {
    for (const row of db.prepare(`SELECT r.*,p.application_id FROM reviews r JOIN postings p ON p.id=r.posting_id
      ${reviewOwnershipJoins} WHERE NOT ${userDecisionSql}`).all()) {
      const stored = parseJson(row.dep_hashes_json);
      const old = stored.inputs;
      if (!old) continue;
      const factsChanged = dependencyHash(old.facts) !== dependencyHash(state.facts);
      const evidence = parseJson(row.evidence_json);
      const used = new Set([...(evidence.factsUsed ?? []), ...current.facts.filter((f) => f.polarity === 'constraint').map((f) => f.id)]);
      const usedChanged = [...used].some((id) => old.facts?.[id] !== state.facts[id]);
      const otherChanged = ['rules','policy','screening','provenance','resume','code'].some((part) => old[part] !== state[part]);
      const windowsChanged = old.windowsAreas !== state.windowsAreas;
      const relevantFacts = factsChanged && (usedChanged || row.decision === 'not_eligible' || row.code === 'missing_fact');
      const relevantOther = otherChanged && (row.decision !== 'eligible' || windowsChanged);
      if (relevantFacts || relevantOther) {
        db.prepare("UPDATE reviews SET state='due',stage='judge',next_due=?,hold_owner=NULL,hold_since=NULL,lease_owner=NULL,lease_until=NULL,dep_hashes_json=?,updated_at=? WHERE posting_id=?")
          .run(now, JSON.stringify({ ...stored, inputs: state, invalidated: true }), now, row.posting_id);
        if (row.decision === 'eligible' && row.application_id) db.prepare("UPDATE applications SET fit_note=COALESCE(fit_note,'') || ' rechecking' WHERE id=?").run(row.application_id);
        logReview(db, row.posting_id, { now, stage: 'judge', kind: 'replan', payload: { factsChanged, otherChanged } });
        requeued += 1;
      }
    }
  });
  return { requeued };
}

function absentFromCensuses(db, postingId) {
  const partitions = postingPartitions(db, postingId);
  return partitions.length > 0 && partitions.every(({ source, partition, lastSeen }) => {
    const recent = db.prepare(`SELECT s.run_id,r.started_at FROM run_sources s JOIN runs r ON r.run_id=s.run_id
      WHERE s.source=? AND s.partition=? AND s.status IN ('ok','empty') ORDER BY r.started_at DESC,r.rowid DESC LIMIT 2`).all(source, partition);
    return recent.length === 2 && recent.every((r) => r.started_at >= lastSeen && !db.prepare('SELECT 1 FROM observation_sightings WHERE run_id=? AND posting_id=? AND source=? AND partition=?').get(r.run_id, postingId, source, partition));
  });
}

export async function runReview({ db, runId, parentRunId = null, owner, now, budget, maxFetches = Infinity, concurrency = 1,
  deadlineMs, deadlineAt, clock = Date.now, fetcher, judges, attemptDir, sleep, inputs, hooks = {} }) {
  const receipt = { schema: 1, kind: 'review', run_id: runId, parent_run_id: parentRunId, started: now, finished: null, status: 'ok', stop_reason: null,
    previous_run_interrupted: false, counts: { attempts: 0, attempts_lost: 0, escalations: 0, fetched: 0 }, sampling: { judged: 0, found: 0 },
    breaches: [], awaiting_user: [], awaiting_user_summary: [], backlog: {}, warnings: [], errors: [] };
  const lease = acquireRunLease(db, { kind: 'review', owner, runId, parentRunId, now });
  if (!lease) return { ...receipt, status: 'busy' };
  receipt.previous_run_interrupted = lease.previousRunInterrupted;
  const start = clock();
  let leaseError;
  const keepAlive = () => {
    try {
      const wallNow = new Date(Date.parse(now) + clock() - start).toISOString();
      atomic(db, () => {
        heartbeat(db, lease, { now: wallNow });
        db.prepare("UPDATE reviews SET lease_until=? WHERE state='leased' AND lease_owner=?")
          .run(new Date(Date.parse(wallNow) + 1800000).toISOString(), owner);
      });
    } catch (error) { leaseError = error; }
  };
  const heartbeatTimer = setInterval(keepAlive, 60000); heartbeatTimer.unref?.();
  try {
  const duration = Math.min(deadlineMs ?? Infinity, deadlineAt ? Date.parse(deadlineAt) - Date.parse(now) : Infinity);
  if (!(duration >= 0)) throw new Error('Invalid review deadline');
  const expired = () => clock() - start >= duration;
  const maxRetries = Math.max(...Object.values(judges).map((a) => a.maxTransportRetries ?? 2));
  const spending = createBudget(db, { runId, limit: budget, concurrency, maxTransportRetries: maxRetries });
  const recovered = await recoverLost(db, { attemptDir, now });
  receipt.counts.attempts_lost = recovered.lost;
  db.prepare("UPDATE reviews SET state='due',lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1 WHERE state='leased' AND (lease_until<=? OR ?)").run(now, lease.previousRunInterrupted ? 1 : 0);
  let current = await inputs();
  const runtimeDeps = {};
  for (const tier of ['primary','escalation']) {
    const request = await buildJudgeRequest({ posting: {}, snapshot: { text: '' }, sections: [], inputs: current, adapter: judges[tier], tier });
    runtimeDeps[tier] = request.deps.parts;
    if (!evalCurrent(current.evalRecord, request.deps).current && !receipt.warnings.includes('eval_stale')) receipt.warnings.push('eval_stale');
  }
  scheduleRefresh(db, { now, policy: current.policy }); recheckHolds(db, { now, screeningPolicy: current.screeningPolicy }); replan(db, { inputs: current, now });
  // Actual adapter/CLI dependencies are available only after adapter.ready.
  atomic(db, () => {
    for (const row of db.prepare(`SELECT r.* FROM reviews r JOIN postings p ON p.id=r.posting_id
      ${reviewOwnershipJoins} WHERE NOT ${userDecisionSql}`).all()) {
      if (row.decision === 'eligible' || row.decision === 'reused' || row.decision === 'dropped') continue;
      const old = parseJson(row.dep_hashes_json);
      const lastDecision = old.decisionRuntime ?? old.runtime;
      if (!lastDecision || Object.entries(lastDecision).every(([tier, parts]) => dependencyHash(parts) === dependencyHash(runtimeDeps[tier]))) continue;
      db.prepare("UPDATE reviews SET state='due',stage='judge',next_due=?,hold_owner=NULL,hold_since=NULL,lease_owner=NULL,lease_until=NULL,dep_hashes_json=?,updated_at=? WHERE posting_id=?")
        .run(now, JSON.stringify({ ...old, invalidated: true }), now, row.posting_id);
      logReview(db, row.posting_id, { now, stage: 'judge', kind: 'replan', payload: { reason: 'judge dependencies changed' } });
    }
  });
  db.prepare("UPDATE reviews SET state='due',stage='fetch',hold_owner=NULL WHERE state='held' AND code='unavailable' AND next_due<=?").run(now);
  attemptDir ??= await mkdtemp(path.join(os.tmpdir(), 'cj-review-attempts-'));
  await mkdir(attemptDir, { recursive: true, mode: 0o700 });
  const seen = new Set();
  // Also exclude legacy pending work created from unlisted-only observations.
  // Previously listed postings and reviews with no census observations retain
  // their existing scheduling and absence-based closure behavior.
  const unlistedOnly = new Set(db.prepare('SELECT posting_id FROM observations GROUP BY posting_id HAVING MAX(listed)=0').all().map((row) => row.posting_id));
  const reviewable = (row) => !unlistedOnly.has(row.posting_id);
  const scheduler = createReviewScheduler(db, { now, owner, policy: current.policy, budget, unlistedOnly });
  const { explorationTarget } = scheduler;
  const explored = new Set();
  const markSeen = (row) => { seen.add(row.posting_id); if (explorationLane(row)) explored.add(row.posting_id); };
  let explorationSpent = 0;
  const explorationReserved = () => {
    // Failed sample fetches consume admission slots, but cannot spend attempts
    // this run. Keep reservations for admitted judges until their work settles.
    const slots = explorationTarget - explored.size + [...judging].filter((id) => explored.has(id)).length;
    return explorationSpent >= explorationTarget || slots <= 0 ? 0
      : Math.min(slots, scheduler.explorationAvailable(), explorationTarget - explorationSpent);
  };
  const failures = {};
  let primaryStopped = false;
  const fetching = new Set();
  const judging = new Set();
  const activeHosts = new Set();
  const active = new Set();
  let poolFailure;
  let lastHeartbeat = start;
  const tick = () => { if (leaseError) throw leaseError; if (clock() - lastHeartbeat >= 60000) { keepAlive(); if (leaseError) throw leaseError; lastHeartbeat = clock(); } };
  const release = (id, fence, { stage, nextDue = now } = {}) => atomic(db, () => {
    assertFence(db, id, fence);
    db.prepare("UPDATE reviews SET state='due',stage=COALESCE(?,stage),next_due=?,lease_owner=NULL,lease_until=NULL WHERE posting_id=?").run(stage ?? null, nextDue, id);
  });
  const refreshInputs = async () => { current = await inputs(); return current; };
  async function commitVerdict(id, fence, verdict, dependencies) {
    atomic(db, () => {
      hooks.insideDeliver?.({ postingId: id });
      deliver(db, { postingId: id, verdict, fence, now, policy: current.screeningPolicy });
      if (dependencies) db.prepare('UPDATE reviews SET dep_hashes_json=? WHERE posting_id=?').run(JSON.stringify(dependencies), id);
    });
  }
  async function fetchItem(row) {
    const id = row.posting_id;
    const fence = claimItem(db, id, { owner, now }); if (!fence) return;
    const posting = db.prepare('SELECT * FROM postings WHERE id=?').get(id);
    const url = postingUrl(posting);
    const alias = db.prepare("SELECT alias FROM posting_aliases WHERE posting_id=? AND kind IN ('req','company_req') ORDER BY CASE kind WHEN 'req' THEN 0 ELSE 1 END LIMIT 1").get(id);
    const requisition = alias?.alias.split(':').at(-1) ?? providerRequisition(url)?.id ?? null;
    let result;
    // Count dispatches synchronously so concurrent starts see the exact fetch cap.
    receipt.counts.fetched += 1;
    try { result = await fetcher.fetch({ postingId: id, url, known: { company: posting.company, title: posting.title, requisition } }); }
    catch (error) { result = { ok: false, error: error.message }; }
    tick();
    const validation = validateSnapshot({ ...posting, url, requisition }, result);
    await refreshInputs();
    atomic(db, () => {
      assertFence(db, id, fence);
      db.prepare('UPDATE reviews SET attempts=attempts+1 WHERE posting_id=?').run(id);
      if (result.closedWording && (validation.identityOk || validation.reason === 'too_short') || validation.reason === 'not_found' && absentFromCensuses(db, id)) {
        db.prepare("UPDATE postings SET availability='closed_verified',updated_at=? WHERE id=?").run(now, id);
        deliver(db, { postingId: id, fence, verdict: { decision: 'not_eligible', code: 'closed_verified' }, now, policy: current.screeningPolicy });
        markSeen(row); return;
      }
      if (!validation.identityOk) {
        const review = db.prepare('SELECT attempts FROM reviews WHERE posting_id=?').get(id);
        const unavailable = validation.reason === 'not_found';
        if (unavailable) db.prepare("UPDATE postings SET availability='unavailable',updated_at=? WHERE id=?").run(now, id);
        logReview(db, id, { now, stage: 'fetch', kind: 'error', payload: { error: validation.reason } });
        if (review.attempts >= 3) deliver(db, { postingId: id, fence, now, policy: current.screeningPolicy, verdict: { decision: 'unclear', code: 'browser_review', question: `Open the official posting: ${url}` } });
        else release(id, fence, { stage: 'fetch', nextDue: new Date(Date.parse(now) + (unavailable ? [1,3,7][Math.min(review.attempts - 1,2)] : 1) * DAY).toISOString() });
        db.prepare('UPDATE reviews SET last_error=? WHERE posting_id=?').run(validation.reason, id);
        markSeen(row); return;
      }
      db.prepare("UPDATE postings SET availability='open',updated_at=? WHERE id=?").run(now, id);
      const reconciliation = reconcileAliases(db, id, aliasesFor({ company: posting.company, url: result.finalUrl ?? url, requisitionId: result.requisitionId }, { companyAliases: current.screeningPolicy.companyAliases }), { now, fence, companyAliases: current.screeningPolicy.companyAliases });
      if (reconciliation.action !== 'added') { markSeen(row); return; }
      const hash = dependencyHash({ text: result.text, title: result.title, requisitionId: result.requisitionId, locations: result.locations, jsonLd: result.jsonLd });
      db.prepare(`INSERT INTO snapshots(id,posting_id,content_hash,fetched_at,final_url,http_status,method,identity_ok,fields_json,sections_json,text)
        VALUES (?,?,?,?,?,?,?,1,?,?,?)`).run(randomUUID(), id, hash, now, result.finalUrl ?? url, result.httpStatus ?? 200, result.method ?? 'html', JSON.stringify({ ...result, text: undefined }), JSON.stringify(segmentSections(result.text)), result.text);
      release(id, fence, { stage: 'judge' });
    });
  }

  async function judgeItem(row) {
    const id = row.posting_id; markSeen(row);
    const fence = claimItem(db, id, { owner, now }); if (!fence) return;
    const posting = db.prepare('SELECT * FROM postings WHERE id=?').get(id);
    const snapshot = db.prepare('SELECT * FROM snapshots WHERE posting_id=? AND identity_ok=1 AND text IS NOT NULL ORDER BY fetched_at DESC,rowid DESC LIMIT 1').get(id);
    if (!snapshot) { release(id, fence, { stage: 'fetch' }); return; }
    const stageInputs = await refreshInputs();
    const startState = inputState(stageInputs);
    const stored = parseJson(row.dep_hashes_json);
    // runtime retains the parts that produced each judgment, including legacy
    // records already invalidated by replan. inputs.code is only a mixed change
    // signal; runtime proves whether the model inputs actually changed.
    const dependencies = { ...stored, inputs: startState, runtime: { ...runtimeDeps, ...stored.runtime },
      stageStartedAt: now, snapshot: snapshot.content_hash, invalidated: false };
    const decisionRuntime = {};
    const persistDependencies = () => db.prepare('UPDATE reviews SET dep_hashes_json=? WHERE posting_id=?').run(JSON.stringify(dependencies), id);
    atomic(db, () => {
      assertFence(db, id, fence);
      persistDependencies();
    });
    let final;
    for (const tier of ['primary','escalation']) {
      if (expired()) { receipt.stop_reason = 'deadline'; break; }
      const adapter = judges[tier];
      const request = await buildJudgeRequest({ posting, snapshot, sections: parseJson(snapshot.sections_json, []), inputs: stageInputs, adapter, tier });
      const depsHash = dependencyHash(request.deps.parts);
      if (tier === 'primary' && !evalCurrent(stageInputs.evalRecord, request.deps).current && !receipt.warnings.includes('eval_stale')) receipt.warnings.push('eval_stale');
      let parts = request.deps.parts;
      let output = cachedJudgment(db, id, { tier, depsHash, snapshotHash: snapshot.content_hash });
      const previous = stored.runtime?.[tier];
      if (!output && previous && judgmentInputsHash(previous) === judgmentInputsHash(parts)) {
        // A decision-code change can replay even an invalidated review. Look up
        // the original hash, never relabel an old judgment with today's hash.
        output = cachedJudgment(db, id, { tier, depsHash: dependencyHash(previous), snapshotHash: snapshot.content_hash });
        if (output) parts = previous;
      }
      if (output) {
        atomic(db, () => {
          assertFence(db, id, fence);
          dependencies.runtime[tier] = parts;
          persistDependencies();
        });
      }
      if (!output) {
        if (tier === 'primary' && primaryStopped) break;
        if (activeCooldown(db, `judge:${tier}`, { now })) { receipt.stop_reason ??= 'quota_cooldown'; if (tier === 'primary') primaryStopped = true; break; }
        // Hold the full retry allowance while exploration is outstanding.
        // Higher lanes may continue next run after exploration has been served.
        const reserved = explorationLane(row) ? 0 : explorationReserved();
        if (reserved > 0 && spending.remaining() <= reserved * (1 + maxRetries)) break;
        const attempt = atomic(db, () => {
          assertFence(db, id, fence);
          const reservedAttempt = spending.reserve({ postingId: id, stage: 'judge', runner: adapter.runner, model: adapter.model, tier, now });
          if (reservedAttempt) {
            dependencies.runtime[tier] = request.deps.parts;
            persistDependencies(); // Recovery must see the dispatched tier's actual parts.
          }
          return reservedAttempt;
        });
        if (!attempt) { receipt.stop_reason ??= 'budget'; break; }
        if (explorationLane(row)) explorationSpent += 1;
        const outputPath = path.join(attemptDir, `${attempt.id}.json`); attempt.outputPath = outputPath;
        atomic(db, () => {
          assertFence(db, id, fence);
          db.prepare('UPDATE attempts SET output_path=? WHERE id=?').run(outputPath, attempt.id);
          logReview(db, id, { now, stage: 'judge', kind: 'outcome', attemptId: attempt.id,
            payload: { attemptContext: { tier, depsHash, snapshotHash: snapshot.content_hash, fence } } });
        });
        await hooks.afterDispatch?.({ attempt, outputPath });
        const controller = new AbortController();
        const timeLeft = duration - (clock() - start);
        const timer = Number.isFinite(timeLeft) ? setTimeout(() => controller.abort(), Math.max(1, timeLeft + (adapter.timeoutMs ?? 120000))) : null;
        let result;
        try { result = await adapter.judge(request, { attemptId: attempt.id, outputPath, signal: controller.signal }); }
        catch (error) { result = { status: 'error', error: error.message, transportRetries: 0 }; }
        finally { clearTimeout(timer); }
        tick();
        await hooks.afterResponse?.({ attempt, outputPath, result });
        if (result.status === 'ok') {
          output = result.output;
          // Adapter output files are recovery inputs; fake adapters use the same persistence boundary.
          await writeFile(outputPath, JSON.stringify(output), { mode: 0o600 });
          atomic(db, () => {
            assertFence(db, id, fence);
            logReview(db, id, { now, stage: 'judge', kind: 'llm_raw', attemptId: attempt.id, payload: { output, tier, depsHash, snapshotHash: snapshot.content_hash } });
            rememberJudgment(db, id, judgmentEnvelope(output, { tier, depsHash, snapshotHash: snapshot.content_hash }));
            spending.markResponded(attempt.id, { usage: result.usage, transportRetries: result.transportRetries, now });
            if (explorationLane(row)) explorationSpent += result.transportRetries ?? 0;
          });
          failures[tier] = null;
          await hooks.afterLlmLog?.({ attempt });
        } else {
          spending.markFailed(attempt.id, { error: result.error ?? result.status, transportRetries: result.transportRetries, now });
          if (explorationLane(row)) explorationSpent += result.transportRetries ?? 0;
          if (result.status === 'quota') {
            setCooldown(db, `judge:${tier}`, { until: new Date(Date.parse(now) + (stageInputs.policy.budgets?.quotaCooldownHours ?? 6) * 3600000).toISOString(), reason: 'quota' });
            receipt.stop_reason = 'quota'; if (tier === 'primary') primaryStopped = true;
          } else {
            const error = result.error ?? result.status;
            const code = result.errorCode ?? error;
            if (receipt.status !== 'failed') receipt.status = 'partial';
            if (!receipt.errors.includes(error)) receipt.errors.push(error);
            failures[tier] = failures[tier]?.code === code ? { code, count: failures[tier].count + 1 } : { code, count: 1 };
            if (failures[tier].count >= 3) { receipt.status = 'failed'; receipt.stop_reason = 'adapter_failure'; primaryStopped = true; }
            logReview(db, id, { now, stage: 'judge', kind: 'error', attemptId: attempt.id, payload: { error } });
          }
          break;
        }
      }
      decisionRuntime[tier] = request.deps.parts;
      final = decide({ snapshotText: snapshot.text, judgment: output, facts: stageInputs.facts, policy: stageInputs.policy, tier,
        firstSeen: posting.first_seen, jobType: stageInputs.profile?.search?.jobType });
      if (tier === 'primary' && final.escalate) { final = null; continue; }
      break;
    }
    const commitInputs = await refreshInputs();
    if (dependencyHash(inputState(commitInputs)) !== dependencyHash(startState)) {
      logReview(db, id, { now, stage: 'judge', kind: 'replan', payload: { reason: 'inputs changed during judgment' } });
      atomic(db, () => {
        assertFence(db, id, fence);
        db.prepare('UPDATE reviews SET dep_hashes_json=? WHERE posting_id=?').run(JSON.stringify({ ...dependencies, inputs: inputState(commitInputs), invalidated: true }), id);
      });
      release(id, fence, { stage: 'judge' }); return;
    }
    if (final) {
      // Track the applied decision separately so retained judgment provenance
      // does not requeue a settled review on every subsequent run.
      await commitVerdict(id, fence, final, { ...dependencies, decisionRuntime });
      if (explorationLane(row)) {
        receipt.sampling.judged += 1;
        if (db.prepare('SELECT decision FROM reviews WHERE posting_id=?').get(id).decision === 'eligible') receipt.sampling.found += 1;
      }
    } else release(id, fence, { stage: 'judge' });
  }

  function dispatch(row, pool, work, host) {
    const id = row.posting_id;
    pool.add(id);
    if (host) activeHosts.add(host);
    const task = work(row).catch((error) => { poolFailure ??= { error }; }).finally(() => {
      pool.delete(id);
      if (host) activeHosts.delete(host);
      active.delete(task);
    });
    active.add(task);
  }

  try {
    const fetchAhead = Math.max(concurrency * 2, FETCH_BATCH_MIN);
    const needsFetch = (row) => ['scan','fetch'].includes(row.stage);
    const canFetch = () => !expired() && clock() - start < duration * JUDGE_TIME_SHARE
      && !primaryStopped && spending.remaining() >= 1 && receipt.counts.fetched < maxFetches;
    const hosts = new Map();
    const hostFor = (row) => {
      if (!hosts.has(row.posting_id)) hosts.set(row.posting_id, new URL(postingUrl(row)).host);
      return hosts.get(row.posting_id);
    };
    let queue = [];
    try {
      for (;;) {
        if (poolFailure) break;
        tick();
        const fetchingAllowed = canFetch();
        const { rows: available, pending } = scheduler.refill({ seen, fetching, queued: queue, policy: current.policy,
          explorationLeft: Math.max(0, explorationTarget - explored.size), fetchAllowed: fetchingAllowed,
          limit: Math.max(queue.length, Math.min(fetchAhead, Math.max(1, spending.remaining()) + fetching.size)) });
        if (expired()) {
          if (pending || fetching.size) receipt.stop_reason = 'deadline';
          break;
        }
        const rows = new Map(available.map((row) => [row.posting_id, row]));
        // Keep the admitted order as slots refill: rebuilding the due list must
        // not repeatedly put another deadline ahead of reserved lane capacity.
        const schedulable = (row) => fetchingAllowed || fetching.has(row.posting_id) || !needsFetch(row);
        queue = queue.filter((id) => rows.has(id) && schedulable(rows.get(id)));
        const queued = new Set(queue);
        for (const row of available) {
          if (queue.length >= fetchAhead) break;
          if (!queued.has(row.posting_id) && schedulable(row)) queue.push(row.posting_id);
        }
        const candidates = queue.map((id) => rows.get(id));
        let started = 0;
        if (!primaryStopped || receipt.stop_reason === 'quota') {
          for (const row of candidates) {
            if (judging.size >= concurrency || expired()) break;
            if (fetching.has(row.posting_id) || needsFetch(row)) {
              // Preserve paid order while fetching is available. Once fetching
              // stops, drain already-fetched work until the actual deadline.
              if (canFetch() || fetching.has(row.posting_id) && clock() - start < duration * JUDGE_TIME_SHARE) break;
              continue;
            }
            dispatch(row, judging, judgeItem);
            started += 1;
          }
        }
        // Fetch independently of judging, with a bounded ready buffer. Busy hosts
        // do not occupy slots that another host can use (T4).
        for (const row of candidates) {
          if (fetching.size >= concurrency || !canFetch()) break;
          if (fetching.has(row.posting_id) || !needsFetch(row)) continue;
          const host = hostFor(row);
          if (activeHosts.has(host)) continue;
          dispatch(row, fetching, fetchItem, host);
        }
        if (!active.size) {
          if (pending) {
            if (primaryStopped || spending.remaining() < 1) receipt.stop_reason ??= 'budget';
            else if (receipt.counts.fetched >= maxFetches) receipt.stop_reason ??= 'fetch_budget';
            else if (clock() - start >= duration * JUDGE_TIME_SHARE) receipt.stop_reason ??= 'deadline';
          }
          break;
        }
        if (started) continue; // Fill the buffer vacated by newly started judges.
        // Any completion can supply a ready item or free a judge/fetch slot.
        await Promise.race(active);
      }
    } finally {
      // No task may write after the receipt is closed or an error is propagated.
      await Promise.all(active);
    }
    if (poolFailure) throw poolFailure.error;
    receipt.counts.attempts = db.prepare('SELECT COUNT(*) n FROM attempts WHERE run_id=?').get(runId).n;
    receipt.counts.escalations = db.prepare("SELECT COUNT(*) n FROM attempts WHERE run_id=? AND tier='escalation'").get(runId).n;
    const pending = db.prepare("SELECT * FROM reviews WHERE state IN ('due','held','failed')").all().filter(reviewable);
    const maxWaitNights = current.policy.serviceTargets?.maxWaitNights ?? 7;
    for (const row of pending) {
      const age = (Date.parse(now) - Date.parse(row.first_seen)) / DAY;
      if (row.hold_owner === 'user') receipt.awaiting_user.push({ postingId: row.posting_id, age_days: age, code: row.code, question: parseJson(row.evidence_json).question });
      else if (row.code === 'system_failure' || age >= maxWaitNights) receipt.breaches.push({ postingId: row.posting_id, age_days: age, code: row.code });
    }
    receipt.awaiting_user_summary = awaitingUserSummary(pending);
    const noSignal = pending.filter((r) => r.lane === 'no_student_signal' && r.state === 'due');
    const outOfDirection = pending.filter((r) => r.lane === 'out_of_direction' && r.state === 'due');
    receipt.backlog = { due: pending.filter((r) => r.state === 'due').length,
      no_student_signal: { due: noSignal.length, oldest_days: Math.max(0, ...noSignal.map((r) => (Date.parse(now) - Date.parse(r.first_seen)) / DAY)) },
      out_of_direction: { due: outOfDirection.length, oldest_days: Math.max(0, ...outOfDirection.map((r) => (Date.parse(now) - Date.parse(r.first_seen)) / DAY)) },
      recommendation: receipt.breaches.length ? `raise budget to ${Math.max(budget + 1, Math.ceil(pending.length / Math.max(1, maxWaitNights)))}` : null };
    if (receipt.status !== 'failed' && (receipt.stop_reason || receipt.breaches.length || pending.some((r) => r.state === 'failed'))) receipt.status = 'partial';
    await hooks.beforeFinish?.();
    receipt.finished = now;
    const safeReceipt = JSON.parse(redact(JSON.stringify(receipt)));
    finishRun(db, lease, { status: receipt.status, receipt: safeReceipt, now });
    return safeReceipt;
  } catch (error) { throw error; } // Crash hooks intentionally leave durable run/item state for recovery.
  } finally { clearInterval(heartbeatTimer); }
}
