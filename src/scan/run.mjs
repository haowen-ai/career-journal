import { randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../storage/database.mjs';
import { ingestBatch } from '../funnel/ingest.mjs';
import { buildExpectedManifest, assessSourceHealth } from '../funnel/health.mjs';
import { fetchAtsBoards } from './sources/ats-boards.mjs';
import { fetchCareerOpsRoles } from './sources/careerops.mjs';
import { DEFAULT_SIMPLIFY_TIMEOUT_MS, fetchSimplify, simplifyUrls } from './sources/simplify.mjs';
import { redact } from '../runtime/redact.mjs';
import { assertScanOwner } from '../funnel/scan-lease.mjs';

// All configured partitions are collected in order; each starts only before the deadline.
export async function collectRoles(profile, { fetchImpl, careerOpsConfig, careerOpsDependencies, timeoutMs, deadlineAt, clock = Date.now } = {}) {
  const parts = [];
  const beforeDeadline = () => !deadlineAt || clock() < Date.parse(deadlineAt);
  const options = (defaultTimeoutMs = 30_000) => ({ timeoutMs: deadlineAt ? Math.max(1, Math.min(timeoutMs ?? defaultTimeoutMs, Date.parse(deadlineAt) - clock())) : timeoutMs });
  for (const entry of profile.sources.atsBoards ?? []) {
    if (!beforeDeadline()) break;
    parts.push(await fetchAtsBoards([entry], fetchImpl, options()));
  }
  if (beforeDeadline()) {
    const config = { ...careerOpsConfig };
    if (deadlineAt) config.scanTimeoutMs = Math.max(1, Math.min(config.scanTimeoutMs ?? 1_200_000, Date.parse(deadlineAt) - clock()));
    parts.push(await fetchCareerOpsRoles(profile.sources.careerOps, config, careerOpsDependencies));
  }
  const settings = profile.sources.simplify;
  const urls = simplifyUrls(settings);
  if (!settings?.enabled || !urls.length) {
    if (beforeDeadline()) parts.push(await fetchSimplify(settings, fetchImpl, options()));
  } else for (const [index, url] of urls.entries()) {
    if (!beforeDeadline()) break;
    const part = await fetchSimplify({ ...settings, url, urls: [] }, fetchImpl, options(settings.timeoutMs ?? DEFAULT_SIMPLIFY_TIMEOUT_MS));
    const partition = `simplify:${index + 1}`;
    for (const source of part.sources) source.partition = partition;
    for (const batch of part.batches) { batch.partition = partition; for (const record of batch.records) record.partition = partition; }
    parts.push(part);
  }
  const config = parts.find((part) => Array.isArray(part.configuredPartitions));
  return { sources: parts.flatMap((part) => part.sources), batches: parts.flatMap((part) => part.batches),
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
    policy = {}, collect, fetchImpl = globalThis.fetch, careerOpsConfig, careerOpsDependencies, dryRun = false } = options;
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
  try {
    const collected = await (collect ?? collectRoles)(profile, { fetchImpl, careerOpsConfig, careerOpsDependencies, timeoutMs: options.timeoutMs, deadlineAt, clock });
    if (heartbeatError) throw heartbeatError;
    assertScanOwner(db, runId, owner);
    const counts = { raw: 0, observed: 0, newPostings: 0, reused: 0, dropped: {}, review: 0, quarantined: 0 };
    const reported = collected.sources.map((item) => ({ ...item }));
    for (const batch of collected.batches ?? []) {
      if (batch.rawCount !== batch.records.length) throw new Error(`Collector conservation violation: ${batch.partition}`);
      counts.raw += batch.rawCount;
      const result = ingestBatch(db, { ...batch, runId, runOwner: owner, now: timestamp(), policy, profile });
      heartbeat();
      if (heartbeatError) throw heartbeatError;
      for (const key of ['observed', 'newPostings', 'reused', 'review', 'quarantined']) counts[key] += result[key];
      for (const [code, count] of Object.entries(result.dropped)) counts.dropped[code] = (counts.dropped[code] ?? 0) + count;
      const source = reported.find((item) => item.source === batch.source && item.partition === batch.partition);
      if (!source) throw new Error(`Collector omitted partition status: ${batch.partition}`);
      source.quarantined = (source.quarantined ?? 0) + result.quarantined;
      if (result.quarantined && source.status !== 'error') source.status = 'partial';
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
      const alerts = sources.filter((item) => item.alert).map(({ source, partition, alert }) => ({ source, partition, alert }));
      const attempted = reported.filter((item) => ['ok', 'empty', 'partial', 'error'].includes(item.status));
      const status = attempted.length && attempted.every((item) => item.status === 'error') ? 'failed'
        : sources.some((item) => item.alert && expectedKeys.has(`${item.source}\0${item.partition}`)) ? 'partial' : 'ok';
      const summary = { runId, status, dryRun: false, sources, alerts, counts };
      db.prepare("UPDATE runs SET status=?,heartbeat_at=?,finished_at=?,receipt_json=? WHERE run_id=? AND owner=? AND status='running'").run(status, finishedAt, finishedAt, redact(JSON.stringify(summary)), runId, owner);
      db.exec('COMMIT');
      return summary;
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  } catch (error) {
    const finishedAt = timestamp();
    db.prepare("UPDATE runs SET status='failed',heartbeat_at=?,finished_at=?,receipt_json=? WHERE run_id=? AND owner=? AND status='running'")
      .run(finishedAt, finishedAt, redact(JSON.stringify({ error: error.message })), runId, owner);
    throw error;
  } finally { clearInterval(timer); }
}
