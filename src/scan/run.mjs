import { randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../storage/database.mjs';
import { createIngestContext, ingestBatch } from '../funnel/ingest.mjs';
import { buildExpectedManifest, assessSourceHealth } from '../funnel/health.mjs';
import { fetchAtsBoards } from './sources/ats-boards.mjs';
import { fetchCareerOpsRoles } from './sources/careerops.mjs';
import { DEFAULT_SIMPLIFY_TIMEOUT_MS, fetchSimplify, simplifyUrls } from './sources/simplify.mjs';
import { redact } from '../runtime/redact.mjs';
import { assertScanOwner } from '../funnel/scan-lease.mjs';
import { baselinedLists, knownListingsOf, listKey, recordBaselines } from '../funnel/seen.mjs';

// All configured partitions are collected in order; each starts only before the deadline.
// `onBatch(batch)` receives CareerOps entries the moment each one is fetched; they are then left out of
// the returned `batches`. Every other batch is returned for the caller to ingest after collection.
// `knownListings` ({ partition: Set(listing ids) } of baselined CareerOps lists, or null) lets a provider skip the
// detail requests of listings the journal already has (plan 2026-11-14 v2 step 2).
export async function collectRoles(profile, { fetchImpl, careerOpsConfig, careerOpsDependencies, timeoutMs, deadlineAt, clock = Date.now, onBatch, knownListings = null } = {}) {
  const parts = [];
  const beforeDeadline = () => !deadlineAt || clock() < Date.parse(deadlineAt);
  const options = (defaultTimeoutMs = 30_000) => ({ timeoutMs: deadlineAt ? Math.max(1, Math.min(timeoutMs ?? defaultTimeoutMs, Date.parse(deadlineAt) - clock())) : timeoutMs });
  // Wall time of one partition's whole fetch, retries included. CareerOps times its entries itself.
  const timed = async (fetch) => {
    const started = performance.now();
    const part = await fetch();
    const elapsedMs = Math.round(performance.now() - started);
    for (const source of part.sources) source.elapsedMs ??= elapsedMs;
    return part;
  };
  for (const entry of profile.sources.atsBoards ?? []) {
    if (!beforeDeadline()) break;
    parts.push(await timed(() => fetchAtsBoards([entry], fetchImpl, options())));
  }
  if (beforeDeadline()) {
    const config = { ...careerOpsConfig };
    if (deadlineAt) config.scanTimeoutMs = Math.max(1, Math.min(config.scanTimeoutMs ?? Infinity, Date.parse(deadlineAt) - clock()));
    parts.push(await fetchCareerOpsRoles(profile.sources.careerOps, config, careerOpsDependencies, { onBatch, knownListings }));
  }
  const settings = profile.sources.simplify;
  const urls = simplifyUrls(settings);
  if (!settings?.enabled || !urls.length) {
    if (beforeDeadline()) parts.push(await fetchSimplify(settings, fetchImpl, options()));
  } else for (const [index, url] of urls.entries()) {
    if (!beforeDeadline()) break;
    const part = await timed(() => fetchSimplify({ ...settings, url, urls: [] }, fetchImpl, options(settings.timeoutMs ?? DEFAULT_SIMPLIFY_TIMEOUT_MS)));
    const partition = `simplify:${index + 1}`;
    for (const source of part.sources) source.partition = partition;
    for (const batch of part.batches) { batch.partition = partition; for (const record of batch.records) record.partition = partition; }
    parts.push(part);
  }
  const config = parts.find((part) => Array.isArray(part.configuredPartitions));
  // A spooled CareerOps scan keeps its rows on disk until each batch is ingested; dispose() removes them.
  const disposers = parts.map((part) => part.dispose).filter((dispose) => typeof dispose === 'function');
  return { sources: parts.flatMap((part) => part.sources), batches: parts.flatMap((part) => part.batches),
    ...(disposers.length ? { dispose: () => { for (const dispose of disposers) dispose(); } } : {}),
    ...(config ? { careerOpsPartitions: config.configuredPartitions } : {}) };
}

function startRun(db, runId, parentRunId, owner, now) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const running = db.prepare("SELECT * FROM runs WHERE kind='scan' AND status='running'").all();
    for (const row of running) {
      if (Date.parse(now) - Date.parse(row.heartbeat_at) < 600_000) throw Object.assign(new Error('A scan run is already running'), { code: 75 });
      db.prepare("UPDATE runs SET status='interrupted',finished_at=? WHERE run_id=?").run(now, row.run_id);
    }
    db.prepare(`INSERT INTO runs (run_id,kind,parent_run_id,owner,started_at,heartbeat_at,status) VALUES (?,'scan',?,?,?,?,'running')`).run(runId, parentRunId ?? null, owner, now, now);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function runScan(options) {
  const { db, profile, runId = `scan-${randomUUID()}`, parentRunId, now = new Date().toISOString(), deadlineAt,
    policy = {}, collect, fetchImpl = globalThis.fetch, careerOpsConfig, careerOpsDependencies, dryRun = false, incremental = { enabled: false } } = options;
  if (deadlineAt && !Number.isFinite(Date.parse(deadlineAt))) throw new Error('deadlineAt must be an ISO datetime');
  if (dryRun) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'cj-scan-preview-'));
    let preview;
    try {
      const database = path.join(temporary, 'preview.db');
      await backup(db, database);
      preview = openDatabase(database);
      return { ...await runScan({ ...options, db: preview, runId, now, dryRun: false }), dryRun: true };
    } finally { preview?.close(); await rm(temporary, { recursive: true, force: true }); }
  }
  const owner = randomUUID();
  startRun(db, runId, parentRunId, owner, now);
  const started = Date.now();
  const clock = () => Date.parse(now) + Date.now() - started;
  const timestamp = () => new Date(clock()).toISOString();
  let heartbeatError;
  const heartbeat = () => {
    try {
      const result = db.prepare("UPDATE runs SET heartbeat_at=? WHERE run_id=? AND owner=? AND status='running'").run(timestamp(), runId, owner);
      if (!result.changes) throw new Error('Scan run lease was reclaimed');
    } catch (error) { heartbeatError = error; }
  };
  const timer = setInterval(heartbeat, 30_000);
  let collected;
  try {
    const counts = { raw: 0, observed: 0, stored: 0, countedOnly: 0, countedOnlyBy: {}, newPostings: 0, reused: 0, dropped: {}, review: 0, quarantined: 0, skippedKnown: 0, new: 0 };
    // Incremental scanning (plan 2026-11-14 v2): lists with a completed baseline skip the listings they already
    // recorded; every other list is processed in full and records its ids (the baseline run). Read once, at the start.
    const baselines = incremental?.enabled ? baselinedLists(db) : new Set();
    const ingestedLists = new Set();
    const ingest = [];
    const warnings = [];
    // What each batch wrote, by source and partition. The collector's final source list is known only after
    // collection, so these are merged into it then.
    const written = new Map();
    // Candidate, submission and sighting indexes are read once per run (at the first batch) and kept current by each batch.
    let context = null;
    const ingestOne = (batch) => {
      // Read once: a spooled batch loads its rows from disk each time `records` is asked for.
      const records = batch.records;
      if (batch.rawCount !== records.length) throw new Error(`Collector conservation violation: ${batch.partition}`);
      counts.raw += batch.rawCount;
      context ??= createIngestContext(db, { policy });
      const skip = baselines.has(listKey(batch.source, batch.partition));
      const result = ingestBatch(db, { ...batch, records, runId, runOwner: owner, now: timestamp(), policy, profile, context, seen: { skip } });
      ingestedLists.add(listKey(batch.source, batch.partition));
      heartbeat();
      if (heartbeatError) throw heartbeatError;
      // Every fetched record is stored, counted only, quarantined, or skipped as already seen: exactly one of the four.
      if (result.stored + result.countedOnly + result.quarantined + result.skippedKnown !== batch.rawCount) throw new Error(`Ingest conservation violation: ${batch.partition}`);
      for (const key of ['observed', 'stored', 'countedOnly', 'newPostings', 'reused', 'review', 'quarantined', 'skippedKnown', 'new']) counts[key] += result[key];
      for (const warning of result.warnings ?? []) if (!warnings.includes(warning)) warnings.push(warning);
      for (const [code, count] of Object.entries(result.dropped)) counts.dropped[code] = (counts.dropped[code] ?? 0) + count;
      for (const [code, count] of Object.entries(result.countedOnlyBy)) counts.countedOnlyBy[code] = (counts.countedOnlyBy[code] ?? 0) + count;
      ingest.push({ source: batch.source, partition: batch.partition, fetched: batch.rawCount, stored: result.stored, countedOnly: result.countedOnly,
        quarantined: result.quarantined, skippedKnown: result.skippedKnown, new: result.new, elapsedMs: result.elapsedMs });
      const key = `${batch.source}\0${batch.partition}`;
      const total = written.get(key) ?? { source: batch.source, partition: batch.partition, fetched: 0, stored: 0, countedOnly: 0, ingestElapsedMs: 0, quarantined: 0, skippedKnown: 0, new: 0 };
      total.fetched += batch.rawCount;
      total.stored += result.stored;
      total.countedOnly += result.countedOnly;
      total.ingestElapsedMs += result.elapsedMs;
      total.quarantined += result.quarantined;
      total.skippedKnown += result.skippedKnown;
      total.new += result.new;
      written.set(key, total);
    };
    // A CareerOps entry is screened and written the moment its fetch finishes, while other entries are still
    // being fetched (user 2026-11-09: a finished company must not wait for the slowest one). If the process
    // dies mid-fetch, the entries written so far stay in the database under this run id (observations,
    // sightings, reviews); the run row stays 'running' until the next scan start marks it 'interrupted'.
    // That is accepted: no rows are lost, and no receipt is written for a run that did not finish.
    const onBatch = (batch) => {
      if (heartbeatError) throw heartbeatError;
      assertScanOwner(db, runId, owner);
      ingestOne(batch);
    };
    const knownListings = baselines.size ? knownListingsOf(db, 'careerops', baselines) : null;
    collected = await (collect ?? collectRoles)(profile, { fetchImpl, careerOpsConfig, careerOpsDependencies, timeoutMs: options.timeoutMs, deadlineAt, clock, onBatch, knownListings });
    if (heartbeatError) throw heartbeatError;
    assertScanOwner(db, runId, owner);
    // Batches the collector returned (boards, Simplify, a CareerOps scan that did not stream) are written now.
    for (const batch of collected.batches ?? []) ingestOne(batch);
    const reported = collected.sources.map((item) => ({ ...item }));
    for (const total of written.values()) {
      const source = reported.find((item) => item.source === total.source && item.partition === total.partition);
      if (!source) throw new Error(`Collector omitted partition status: ${total.partition}`);
      // Health keeps reading the fetched census (count/rawCount); these say what was written.
      source.fetched = (source.fetched ?? 0) + total.fetched;
      source.stored = (source.stored ?? 0) + total.stored;
      source.countedOnly = (source.countedOnly ?? 0) + total.countedOnly;
      source.ingestElapsedMs = (source.ingestElapsedMs ?? 0) + total.ingestElapsedMs;
      source.quarantined = (source.quarantined ?? 0) + total.quarantined;
      source.skippedKnown = (source.skippedKnown ?? 0) + total.skippedKnown;
      source.new = (source.new ?? 0) + total.new;
      if (total.quarantined && source.status !== 'error') source.status = 'partial';
    }
    // Only a complete configuration inventory can retire a known CareerOps partition.
    // A response without it extends the saved inventory, even when only some entries report.
    const careerOpsPartitions = Array.isArray(collected.careerOpsPartitions) ? collected.careerOpsPartitions
      : [...new Set([...reported.filter((item) => item.source === 'careerops' && item.partition !== 'all').map((item) => item.partition),
        ...db.prepare("SELECT partition FROM expected_partitions WHERE source='careerops' AND retired_at IS NULL AND partition<>'all'").all().map((item) => item.partition)])];
    const manifest = buildExpectedManifest(profile, { careerOpsPartitions });
    // An injected collector can supply its own list name when no URL inventory exists.
    for (const source of ['simplify', 'careerops']) if ((profile.sources.expected ?? []).includes(source)) {
      const known = reported.filter((item) => item.source === source);
      const placeholder = manifest.findIndex((item) => item.source === source && item.partition === 'all');
      if (placeholder >= 0 && known.length && !known.some((item) => item.partition === 'all')) manifest.splice(placeholder, 1, ...known.map(({ source, partition }) => ({ source, partition })));
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      assertScanOwner(db, runId, owner);
      const finishedAt = timestamp();
      const sources = assessSourceHealth(db, { runId, now: finishedAt, manifest, reported });
      const expectedKeys = new Set(manifest.map((item) => `${item.source}\0${item.partition}`));
      // A CareerOps step that fails (timeout, abort) after some entries were already streamed and stored reports
      // those entries plus `careerops/all` as an error. `all` is not a configured partition, so it is not put in
      // the manifest (it would be registered as expected and retired later), but it still counts for the run
      // status: entries the step never reached are unknown, so the run is at best partial.
      const careerOpsStepFailed = reported.some((item) => item.source === 'careerops' && item.partition === 'all' && item.status === 'error')
        && reported.some((item) => item.source === 'careerops' && item.partition !== 'all');
      if (careerOpsStepFailed) expectedKeys.add('careerops\0all');
      const alerts = sources.filter((item) => item.alert).map(({ source, partition, alert, failStreak }) => ({ source, partition, alert, ...(failStreak ? { failStreak } : {}) }));
      const attempted = reported.filter((item) => ['ok', 'empty', 'partial', 'error'].includes(item.status));
      const status = attempted.length && attempted.every((item) => item.status === 'error') ? 'failed'
        : sources.some((item) => item.alert && expectedKeys.has(`${item.source}\0${item.partition}`)) ? 'partial' : 'ok';
      // Lists read in full by this finished run are baselined; from the next run on they skip known listings.
      recordBaselines(db, { runId, now: finishedAt, sources, ingested: ingestedLists });
      const summary = { runId, status, dryRun: false, sources, alerts, counts, ingest, ...(warnings.length ? { warnings } : {}) };
      db.prepare("UPDATE runs SET status=?,heartbeat_at=?,finished_at=?,receipt_json=? WHERE run_id=? AND owner=? AND status='running'").run(status, finishedAt, finishedAt, redact(JSON.stringify(summary)), runId, owner);
      db.exec('COMMIT');
      return summary;
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  } catch (error) {
    const finishedAt = timestamp();
    db.prepare("UPDATE runs SET status='failed',heartbeat_at=?,finished_at=?,receipt_json=? WHERE run_id=? AND owner=? AND status='running'")
      .run(finishedAt, finishedAt, redact(JSON.stringify({ error: error.message })), runId, owner);
    throw error;
  } finally { clearInterval(timer); collected?.dispose?.(); }
}
