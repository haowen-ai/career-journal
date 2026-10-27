import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXPLORATION_SHARE, FETCH_BATCH_MIN, JUDGE_TIME_SHARE, NO_SIGNAL_PROMOTE_DAYS } from '../funnel/contract.mjs';
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
import { userDecided } from './ownership.mjs';
import { cachedJudgment, judgmentEnvelope, rememberJudgment } from './judgment-cache.mjs';
import { postingPartitions } from '../funnel/membership.mjs';
export { scheduleRefresh } from './freshness.mjs';

const DAY = 86400000;
const factsMap = (facts) => Object.fromEntries(facts.map((fact) => [fact.id, dependencyHash(fact)]));
function inputState(inputs) {
  return { facts: factsMap(inputs.facts), rules: dependencyHash(inputs.rules), policy: dependencyHash(inputs.policy),
    screening: dependencyHash(inputs.screeningPolicy), provenance: dependencyHash(inputs.provenance), resume: dependencyHash(inputs.resume?.text ?? null),
    windowsAreas: dependencyHash({ windows: inputs.policy.windows, areas: inputs.policy.areas }),
    code: dependencyHash(Object.fromEntries(['prompt.mjs','schema/judgment.schema.json','decide.mjs','clauses.mjs','deadline.mjs'].map((file) => [file, readFileSync(new URL(file, import.meta.url), 'utf8')]))) };
}

export function replan(db, { inputs, now }) {
  const current = typeof inputs === 'function' ? inputs() : inputs;
  const state = inputState(current);
  let requeued = 0;
  atomic(db, () => {
    for (const row of db.prepare('SELECT r.*,p.application_id FROM reviews r JOIN postings p ON p.id=r.posting_id').all()) {
      if (userDecided(db, row)) continue;
      const stored = parseJson(row.dep_hashes_json);
      const old = stored.inputs;
      if (!old) continue;
      const factsChanged = dependencyHash(old.facts) !== dependencyHash(state.facts);
      const evidence = parseJson(row.evidence_json);
      const used = new Set([...(evidence.factsUsed ?? []), ...current.facts.filter((f) => f.polarity === 'constraint').map((f) => f.id)]);
      const usedChanged = [...used].some((id) => old.facts?.[id] !== state.facts[id]);
      const otherChanged = ['rules','policy','screening','provenance','resume','code'].some((part) => old[part] !== state[part]);
      const windowsChanged = old.windowsAreas !== state.windowsAreas;
      const answered = Boolean(db.prepare("SELECT 1 FROM review_log WHERE posting_id=? AND kind='user'").get(row.posting_id));
      const relevantFacts = factsChanged && (usedChanged || row.decision === 'not_eligible' || row.code === 'missing_fact' && !answered);
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

function ordered(rows, { now, policy, budget }) {
  const age = (row) => (Date.parse(now) - Date.parse(row.first_seen)) / DAY;
  const deadline = (row) => { const d = parseJson(row.deadline_json); return d.kind === 'cutoff' ? Date.parse(d.date) : Infinity; };
  const soon = (row) => deadline(row) <= Date.parse(now) + 7 * DAY;
  const aged = (row) => row.lane === 'aged' || row.lane !== 'no_student_signal' && age(row) >= (policy.serviceTargets?.agedAfterDays ?? 2);
  const byAge = (a, b) => a.first_seen.localeCompare(b.first_seen) || a.posting_id.localeCompare(b.posting_id);
  const sorted = [...rows].sort(byAge); const chosen = [];
  const take = (candidates, count = Infinity) => { for (const row of candidates) if (!chosen.includes(row) && count-- > 0) chosen.push(row); };
  const deadlines = sorted.filter(soon).sort((a, b) => deadline(a) - deadline(b) || byAge(a,b));
  // One imminent deadline, then reserved shares, then the rest of the paid order.
  take(deadlines, 1);
  take(sorted.filter(aged), Math.max(1, Math.ceil(budget * (policy.serviceTargets?.agedReserveShare ?? .25))));
  take(sorted.filter((r) => r.lane === 'no_student_signal'), budget >= 1 ? Math.max(1, Math.ceil(budget * EXPLORATION_SHARE)) : 0);
  take(deadlines); take(sorted.filter(aged));
  for (const lane of ['bootstrap','new','refresh','no_student_signal']) take(sorted.filter((r) => r.lane === lane));
  take(sorted); return chosen;
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
    previous_run_interrupted: false, counts: { attempts: 0, attempts_lost: 0, escalations: 0, fetched: 0 }, breaches: [], awaiting_user: [], backlog: {}, warnings: [], errors: [] };
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
    for (const row of db.prepare('SELECT r.*,p.application_id FROM reviews r JOIN postings p ON p.id=r.posting_id').all()) {
      if (userDecided(db, row) || row.decision === 'eligible' || row.decision === 'reused' || row.decision === 'dropped') continue;
      const old = parseJson(row.dep_hashes_json);
      if (!old.runtime || dependencyHash(old.runtime) === dependencyHash(runtimeDeps)) continue;
      db.prepare("UPDATE reviews SET state='due',stage='judge',next_due=?,hold_owner=NULL,hold_since=NULL,lease_owner=NULL,lease_until=NULL,dep_hashes_json=?,updated_at=? WHERE posting_id=?")
        .run(now, JSON.stringify({ ...old, runtime: runtimeDeps, invalidated: true }), now, row.posting_id);
      logReview(db, row.posting_id, { now, stage: 'judge', kind: 'replan', payload: { reason: 'judge dependencies changed' } });
    }
  });
  db.prepare("UPDATE reviews SET state='due',stage='fetch',hold_owner=NULL WHERE state='held' AND code='unavailable' AND next_due<=?").run(now);
  db.prepare("UPDATE reviews SET lane='aged' WHERE lane='no_student_signal' AND first_seen<=?").run(new Date(Date.parse(now) - NO_SIGNAL_PROMOTE_DAYS * DAY).toISOString());
  attemptDir ??= await mkdtemp(path.join(os.tmpdir(), 'cj-review-attempts-'));
  await mkdir(attemptDir, { recursive: true, mode: 0o700 });
  const seen = new Set();
  const exploration = new Set(db.prepare("SELECT * FROM reviews WHERE state='due' AND lane='no_student_signal' AND (next_due IS NULL OR next_due<=?)").all(now)
    .filter((row) => !userDecided(db, row)).map((row) => row.posting_id));
  const explorationTarget = Math.min(exploration.size, budget ? Math.max(1, Math.ceil(budget * EXPLORATION_SHARE)) : 0);
  const explorationReserved = () => {
    const spent = db.prepare('SELECT posting_id,1+transport_retries n FROM attempts WHERE run_id=?').all(runId)
      .filter((row) => exploration.has(row.posting_id)).reduce((sum, row) => sum + row.n, 0);
    const available = [...exploration].filter((id) => {
      const row = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(id);
      return row && ['due','leased'].includes(row.state) && (!row.next_due || row.next_due <= now) && !userDecided(db, row);
    }).length;
    return Math.min(available, Math.max(0, explorationTarget - spent));
  };
  const failures = {};
  let primaryStopped = false;
  let lastHeartbeat = start;
  const tick = () => { if (leaseError) throw leaseError; if (clock() - lastHeartbeat >= 60000) { keepAlive(); if (leaseError) throw leaseError; lastHeartbeat = clock(); } };
  const release = (id, fence, { stage, nextDue = now } = {}) => atomic(db, () => {
    assertFence(db, id, fence);
    db.prepare("UPDATE reviews SET state='due',stage=COALESCE(?,stage),next_due=?,lease_owner=NULL,lease_until=NULL WHERE posting_id=?").run(stage ?? null, nextDue, id);
  });
  const due = () => ordered(db.prepare("SELECT * FROM reviews WHERE state='due' AND (next_due IS NULL OR next_due<=?)").all(now).filter((r) => !seen.has(r.posting_id) && !userDecided(db, r)), { now, policy: current.policy, budget });
  const refreshInputs = async () => { current = await inputs(); return current; };
  async function commitVerdict(id, fence, verdict) {
    atomic(db, () => {
      hooks.insideDeliver?.({ postingId: id });
      deliver(db, { postingId: id, verdict, fence, now, policy: current.screeningPolicy });
    });
  }
  async function fetchItem(row) {
    const id = row.posting_id;
    const fence = claimItem(db, id, { owner, now }); if (!fence) return;
    const posting = db.prepare('SELECT * FROM postings WHERE id=?').get(id);
    const url = /^https?:/.test(posting.canonical_url) ? posting.canonical_url : `https://${posting.canonical_url}`;
    const alias = db.prepare("SELECT alias FROM posting_aliases WHERE posting_id=? AND kind IN ('req','company_req') ORDER BY CASE kind WHEN 'req' THEN 0 ELSE 1 END LIMIT 1").get(id);
    const requisition = alias?.alias.split(':').at(-1) ?? providerRequisition(url)?.id ?? null;
    let result;
    try { result = await fetcher.fetch({ postingId: id, url, known: { company: posting.company, title: posting.title, requisition } }); }
    catch (error) { result = { ok: false, error: error.message }; }
    receipt.counts.fetched += 1;
    tick();
    const validation = validateSnapshot({ ...posting, url, requisition }, result);
    await refreshInputs();
    atomic(db, () => {
      assertFence(db, id, fence);
      db.prepare('UPDATE reviews SET attempts=attempts+1 WHERE posting_id=?').run(id);
      if (result.closedWording && (validation.identityOk || validation.reason === 'too_short') || validation.reason === 'not_found' && absentFromCensuses(db, id)) {
        db.prepare("UPDATE postings SET availability='closed_verified',updated_at=? WHERE id=?").run(now, id);
        deliver(db, { postingId: id, fence, verdict: { decision: 'not_eligible', code: 'closed_verified' }, now, policy: current.screeningPolicy });
        seen.add(id); return;
      }
      if (!validation.identityOk) {
        const review = db.prepare('SELECT attempts FROM reviews WHERE posting_id=?').get(id);
        const unavailable = validation.reason === 'not_found';
        if (unavailable) db.prepare("UPDATE postings SET availability='unavailable',updated_at=? WHERE id=?").run(now, id);
        logReview(db, id, { now, stage: 'fetch', kind: 'error', payload: { error: validation.reason } });
        if (review.attempts >= 3) deliver(db, { postingId: id, fence, now, policy: current.screeningPolicy, verdict: { decision: 'unclear', code: 'browser_review', question: `Open the official posting: ${url}` } });
        else release(id, fence, { stage: 'fetch', nextDue: new Date(Date.parse(now) + (unavailable ? [1,3,7][Math.min(review.attempts - 1,2)] : 1) * DAY).toISOString() });
        db.prepare('UPDATE reviews SET last_error=? WHERE posting_id=?').run(validation.reason, id);
        seen.add(id); return;
      }
      db.prepare("UPDATE postings SET availability='open',updated_at=? WHERE id=?").run(now, id);
      const reconciliation = reconcileAliases(db, id, aliasesFor({ company: posting.company, url: result.finalUrl ?? url, requisitionId: result.requisitionId }, { companyAliases: current.screeningPolicy.companyAliases }), { now, fence });
      if (reconciliation.action !== 'added') { seen.add(id); return; }
      const hash = dependencyHash({ text: result.text, title: result.title, requisitionId: result.requisitionId, locations: result.locations, jsonLd: result.jsonLd });
      db.prepare(`INSERT INTO snapshots(id,posting_id,content_hash,fetched_at,final_url,http_status,method,identity_ok,fields_json,sections_json,text)
        VALUES (?,?,?,?,?,?,?,1,?,?,?)`).run(randomUUID(), id, hash, now, result.finalUrl ?? url, result.httpStatus ?? 200, result.method ?? 'html', JSON.stringify({ ...result, text: undefined }), JSON.stringify(segmentSections(result.text)), result.text);
      release(id, fence, { stage: 'judge' });
    });
  }

  async function judgeItem(row) {
    const id = row.posting_id; seen.add(id);
    const fence = claimItem(db, id, { owner, now }); if (!fence) return;
    const posting = db.prepare('SELECT * FROM postings WHERE id=?').get(id);
    const snapshot = db.prepare('SELECT * FROM snapshots WHERE posting_id=? AND identity_ok=1 AND text IS NOT NULL ORDER BY fetched_at DESC,rowid DESC LIMIT 1').get(id);
    if (!snapshot) { release(id, fence, { stage: 'fetch' }); return; }
    const stageInputs = await refreshInputs();
    const startState = inputState(stageInputs);
    const stored = parseJson(row.dep_hashes_json);
    // Persist dependencies before dispatch so recovered output has a known context.
    atomic(db, () => {
      assertFence(db, id, fence);
      db.prepare('UPDATE reviews SET dep_hashes_json=? WHERE posting_id=?').run(JSON.stringify({ ...stored, inputs: startState, runtime: runtimeDeps,
        stageStartedAt: now, snapshot: snapshot.content_hash, invalidated: false }), id);
    });
    let final;
    for (const tier of ['primary','escalation']) {
      if (expired()) { receipt.stop_reason = 'deadline'; break; }
      const adapter = judges[tier];
      const request = await buildJudgeRequest({ posting, snapshot, sections: parseJson(snapshot.sections_json, []), inputs: stageInputs, adapter, tier });
      const depsHash = dependencyHash(request.deps.parts);
      if (tier === 'primary' && !evalCurrent(stageInputs.evalRecord, request.deps).current && !receipt.warnings.includes('eval_stale')) receipt.warnings.push('eval_stale');
      let output = !stored.invalidated && cachedJudgment(db, id, { tier, depsHash, snapshotHash: snapshot.content_hash });
      if (!output) {
        if (tier === 'primary' && primaryStopped) break;
        if (activeCooldown(db, `judge:${tier}`, { now })) { receipt.stop_reason ??= 'quota_cooldown'; if (tier === 'primary') primaryStopped = true; break; }
        // Hold the full retry allowance while exploration is outstanding.
        // Higher lanes may continue next run after exploration has been served.
        if (!exploration.has(id) && explorationReserved() > 0 && spending.remaining() <= explorationReserved() * (1 + maxRetries)) break;
        const attempt = atomic(db, () => {
          assertFence(db, id, fence);
          return spending.reserve({ postingId: id, stage: 'judge', runner: adapter.runner, model: adapter.model, tier, now });
        });
        if (!attempt) { receipt.stop_reason ??= 'budget'; break; }
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
          });
          failures[tier] = null;
          await hooks.afterLlmLog?.({ attempt });
        } else {
          spending.markFailed(attempt.id, { error: result.error ?? result.status, transportRetries: result.transportRetries, now });
          if (result.status === 'quota') {
            setCooldown(db, `judge:${tier}`, { until: new Date(Date.parse(now) + stageInputs.policy.budgets.quotaCooldownHours * 3600000).toISOString(), reason: 'quota' });
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
      final = decide({ snapshotText: snapshot.text, judgment: output, facts: stageInputs.facts, policy: stageInputs.policy, tier, firstSeen: posting.first_seen });
      if (tier === 'primary' && final.escalate) { final = null; continue; }
      break;
    }
    const commitInputs = await refreshInputs();
    if (dependencyHash(inputState(commitInputs)) !== dependencyHash(startState)) {
      logReview(db, id, { now, stage: 'judge', kind: 'replan', payload: { reason: 'inputs changed during judgment' } });
      atomic(db, () => {
        assertFence(db, id, fence);
        db.prepare('UPDATE reviews SET dep_hashes_json=? WHERE posting_id=?').run(JSON.stringify({ inputs: inputState(commitInputs), runtime: runtimeDeps, invalidated: true }), id);
      });
      release(id, fence, { stage: 'judge' }); return;
    }
    if (final) await commitVerdict(id, fence, final);
    else release(id, fence, { stage: 'judge' });
  }

  let drainingCycle = false;
  try {
    for (;;) {
      tick();
      const candidates = due(); if (!candidates.length) break;
      if (expired()) { receipt.stop_reason = 'deadline'; break; }
      const ready = candidates.filter((row) => row.stage !== 'fetch' && row.stage !== 'scan');
      const firstNeedsFetch = ['fetch','scan'].includes(candidates[0].stage);
      const canFetch = !primaryStopped && spending.remaining() >= 1 && receipt.counts.fetched < maxFetches
        && clock() - start < duration * JUDGE_TIME_SHARE;
      if (ready.length && (drainingCycle || !(firstNeedsFetch && canFetch))) {
        if (primaryStopped && receipt.stop_reason !== 'quota') break;
        const batch = ready.slice(0, concurrency);
        await Promise.all(batch.map(judgeItem));
        if (primaryStopped && !due().some((r) => r.stage === 'judge')) break;
        continue;
      }
      drainingCycle = false;
      if (primaryStopped || spending.remaining() < 1) { receipt.stop_reason ??= 'budget'; break; }
      if (receipt.counts.fetched >= maxFetches) { receipt.stop_reason ??= 'fetch_budget'; break; }
      if (clock() - start >= duration * JUDGE_TIME_SHARE && receipt.counts.fetched) { receipt.stop_reason ??= 'deadline'; break; }
      const batch = candidates.filter((r) => ['scan','fetch'].includes(r.stage)).slice(0, Math.min(Math.max(concurrency, FETCH_BATCH_MIN), maxFetches - receipt.counts.fetched));
      if (!batch.length) break;
      for (const row of batch) {
        if (expired()) { receipt.stop_reason = 'deadline'; break; }
        if (clock() - start >= duration * JUDGE_TIME_SHARE && due().some((r) => !['scan','fetch'].includes(r.stage))) break;
        await fetchItem(row);
      }
      drainingCycle = true;
    }
    receipt.counts.attempts = db.prepare('SELECT COUNT(*) n FROM attempts WHERE run_id=?').get(runId).n;
    receipt.counts.escalations = db.prepare("SELECT COUNT(*) n FROM attempts WHERE run_id=? AND tier='escalation'").get(runId).n;
    const pending = db.prepare("SELECT * FROM reviews WHERE state IN ('due','held','failed')").all();
    const targets = current.policy.serviceTargets;
    for (const row of pending) {
      const age = (Date.parse(now) - Date.parse(row.first_seen)) / DAY;
      if (row.hold_owner === 'user') receipt.awaiting_user.push({ postingId: row.posting_id, age_days: age, code: row.code, question: parseJson(row.evidence_json).question });
      else if (row.code === 'system_failure' || age >= targets.maxWaitNights) receipt.breaches.push({ postingId: row.posting_id, age_days: age, code: row.code });
    }
    const noSignal = pending.filter((r) => r.lane === 'no_student_signal' && r.state === 'due');
    receipt.backlog = { due: pending.filter((r) => r.state === 'due').length,
      no_student_signal: { due: noSignal.length, oldest_days: Math.max(0, ...noSignal.map((r) => (Date.parse(now) - Date.parse(r.first_seen)) / DAY)) },
      recommendation: receipt.breaches.length ? `raise budget to ${Math.max(budget + 1, Math.ceil(pending.length / Math.max(1, targets.maxWaitNights)))}` : null };
    if (receipt.status !== 'failed' && (receipt.stop_reason || receipt.breaches.length || pending.some((r) => r.state === 'failed'))) receipt.status = 'partial';
    await hooks.beforeFinish?.();
    receipt.finished = now;
    const safeReceipt = JSON.parse(redact(JSON.stringify(receipt)));
    finishRun(db, lease, { status: receipt.status, receipt: safeReceipt, now });
    return safeReceipt;
  } catch (error) { throw error; } // Crash hooks intentionally leave durable run/item state for recovery.
  } finally { clearInterval(heartbeatTimer); }
}
