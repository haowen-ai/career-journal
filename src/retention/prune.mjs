import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, readFile, realpath, rm, rmdir, utimes, writeFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { workspaceDirectory, loadConfig } from '../config/store.mjs';
import { resolveMaterialPath } from '../domain/profile.mjs';
import { inventory, measureStorage, rotateBackups, tableBytes } from './storage.mjs';
import { recoverLost } from '../review/budget.mjs';
import { preserveJudgments } from '../review/judgment-cache.mjs';
import { preservePartitions } from '../funnel/membership.mjs';

const DAY = 86_400_000;
const MB = 1024 * 1024;
const DEFAULTS = Object.freeze({
  observationsDays: 30, sightingsDays: 45, runSourcesDays: 90, sourceSamplesDays: 180,
  runsDays: 90, runCompactDays: 30, rawLogDays: 14, rawLogMaxRows: 20_000, logDays: 180,
  snapshotsDays: 30, negativePayloadDays: 60, closedPayloadDays: 30, snapshotsMaxBytes: 300 * MB,
  attemptsDays: 90, attemptOutputsDays: 14, attemptsMaxBytes: 200 * MB,
  receiptsDays: 30, dailyReceiptsDays: 90, receiptsMaxBytes: 50 * MB,
  workDays: 30, compressedWorkDays: 180, workMaxBytes: 200 * MB, backupsKeep: 4, workPaths: [],
});

export function retentionPolicy(reviewPolicy) {
  const overrides = reviewPolicy?.retention ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('retention must be an object');
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Unknown retention option: ${key}`);
  }
  const policy = { ...DEFAULTS, ...overrides };
  for (const [key, value] of Object.entries(policy)) {
    if (key === 'workPaths') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('retention.workPaths must be paths');
    } else if (!Number.isSafeInteger(value) || value < 0 || (key === 'backupsKeep' && value < 1)) {
      throw new Error(`Invalid retention.${key}`);
    }
  }
  return { ...policy, workPaths: [...policy.workPaths] };
}

const within = (file, root) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function canonicalPath(file) {
  try { return await realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { return path.join(await realpath(path.dirname(file)), path.basename(file)); }
    catch (parentError) { if (parentError.code !== 'ENOENT') throw parentError; return path.resolve(file); }
  }
}

async function workRoots(home, directory, policy) {
  const config = await loadConfig(home);
  const protectedPaths = ['profile', 'artifacts', 'attempts', 'runs', 'backups'].map((name) => path.join(directory, name));
  const database = path.resolve(home, config.data.database);
  protectedPaths.push(database, `${database}-wal`, `${database}-shm`, path.resolve(home, config.data.artifacts),
    path.join(directory, 'config.json'), path.join(directory, 'retention-roots.json'));
  const profile = await readJson(path.join(directory, 'profile', 'profile.json'));
  for (const key of ['resumePath', 'transcriptPath']) {
    if (profile?.materials?.[key]) protectedPaths.push(resolveMaterialPath(profile.materials[key]));
  }
  const roots = [];
  const canonicalProtected = await Promise.all(protectedPaths.map(async (file) => {
    try { return await realpath(file); } catch (error) { if (error.code === 'ENOENT') return file; throw error; }
  }));
  // Reports are managed implicitly, but must pass the same material protection.
  const reportsRoot = path.join(directory, 'reports');
  for (const configured of [...policy.workPaths, reportsRoot]) {
    let root = path.resolve(home, configured);
    try {
      root = await realpath(root);
      if (!(await lstat(root)).isDirectory()) throw new Error('retention.workPaths requires directory roots');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (canonicalProtected.some((file) => within(file, root) || within(root, file))) {
      throw new Error('retention.workPaths overlaps permanent history or another managed tree');
    }
    if (!roots.some((existing) => within(root, existing))) {
      for (let i = roots.length - 1; i >= 0; i -= 1) if (within(roots[i], root)) roots.splice(i, 1);
      roots.push(root);
    }
  }
  return { roots, reportsRoot };
}

async function protectedReceipts(directory, db, explicit) {
  const ids = new Set(explicit);
  const latest = path.join(directory, 'runs', 'latest.json');
  const pointer = await readJson(latest);
  if (typeof pointer === 'string') ids.add(path.basename(pointer, '.json'));
  else if (pointer) {
    if (pointer.run_id) ids.add(pointer.run_id);
    for (const key of ['path', 'file', 'receipt', 'receipt_path']) {
      if (typeof pointer[key] === 'string') ids.add(path.basename(pointer[key], '.json'));
    }
  }
  for (const row of db.prepare("SELECT run_id, parent_run_id, status FROM runs").all()) {
    if (ids.has(row.parent_run_id) || row.status === 'running') ids.add(row.run_id);
  }
  return ids;
}

async function removeEmptyDirectories(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = path.join(root, entry.name);
      await removeEmptyDirectories(child);
      try { await rmdir(child); }
      catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
    }
  }
}

export async function prune(db, home, { now, policy, dryRun = true, protectRunIds = [] }) {
  const when = new Date(now).getTime();
  if (!Number.isFinite(when)) throw new Error('Invalid pruning date');
  policy = retentionPolicy({ retention: policy });
  const cutoff = (days) => new Date(when - days * DAY).toISOString();
  const directory = await realpath(workspaceDirectory(home));
  // Validate destructive roots before backups, recovery or any deletion.
  const { roots, reportsRoot } = await workRoots(home, directory, policy);
  const protectedIds = await protectedReceipts(directory, db, protectRunIds);
  const removed = {};
  const tally = (category, values) => {
    const entry = removed[category] ??= { rows: 0, files: 0, bytes: 0 };
    for (const [key, n] of Object.entries(values)) entry[key] += n;
  };
  if (!dryRun) {
    const backups = await inventory(path.join(directory, 'backups', 'weekly'));
    const rotated = await rotateBackups(home, { now, policy });
    const deleted = backups.filter((file) => rotated.removed.some((root) => within(file.path, root)));
    tally('backups', { files: deleted.length, bytes: deleted.reduce((sum, file) => sum + file.bytes, 0) });
  }
  let freed = 0;
  const attemptDir = path.join(directory, 'attempts');
  const attempts = db.prepare('SELECT * FROM attempts').all();
  const pendingAttemptIds = new Set();
  db.exec('SAVEPOINT retention_prune');
  try {
    await recoverLost(db, { attemptDir, now, before: cutoff(1) });
    db.prepare(`UPDATE reviews SET state='due',lease_owner=NULL,lease_until=NULL,
      lease_generation=lease_generation+1,next_due=?,updated_at=?
      WHERE state='leased' AND lease_until<=?`).run(now, now, now);
    preserveJudgments(db);
    preservePartitions(db);
    db.exec('CREATE TEMP TABLE IF NOT EXISTS retention_pending_logs (id INTEGER PRIMARY KEY, attempt_id TEXT); DELETE FROM retention_pending_logs');
    const seen = new Set();
    for (const row of db.prepare(`SELECT l.id, l.attempt_id, l.posting_id, COALESCE(a.tier, 'unknown') tier
      FROM review_log l JOIN reviews r ON r.posting_id = l.posting_id LEFT JOIN attempts a ON a.id = l.attempt_id
      WHERE l.kind = 'llm_raw' AND r.stage IN ('judge','deliver') AND r.state IN ('due','leased','held')
      ORDER BY l.at DESC, l.id DESC`).all()) {
      const key = JSON.stringify([row.posting_id, row.tier]);
      if (seen.has(key)) continue;
      seen.add(key);
      db.prepare('INSERT INTO retention_pending_logs (id, attempt_id) VALUES (?, ?)').run(row.id, row.attempt_id);
      if (row.attempt_id) pendingAttemptIds.add(row.attempt_id);
    }
    const erase = (category, table, where, ...params) => {
      const before = tableBytes(db, table);
      const rows = db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params).changes;
      const bytes = before - tableBytes(db, table);
      freed += bytes;
      tally(category, { rows, bytes });
    };
    erase('observation_sightings', 'observation_sightings', 'seen_at < ?', cutoff(policy.sightingsDays));
    erase('observations', 'observations', `id IN (
      SELECT id FROM (SELECT id, observed_at,
        row_number() OVER (PARTITION BY posting_id, source, partition ORDER BY observed_at, id) first_row,
        row_number() OVER (PARTITION BY posting_id, source, partition ORDER BY observed_at DESC, id DESC) last_row
        FROM observations) WHERE first_row > 1 AND last_row > 1 AND observed_at < ?)
      AND NOT EXISTS (SELECT 1 FROM observation_sightings s WHERE s.observation_id = observations.id)`, cutoff(policy.observationsDays));
    erase('run_sources', 'run_sources', `run_id IN (SELECT run_id FROM runs WHERE started_at < ? AND status <> 'running')
      OR NOT EXISTS (SELECT 1 FROM runs WHERE runs.run_id = run_sources.run_id)`, cutoff(policy.runSourcesDays));
    erase('source_samples', 'source_samples', 'sampled_at < ?', cutoff(policy.sourceSamplesDays));
    for (const run of db.prepare("SELECT run_id, kind, started_at, receipt_json FROM runs WHERE status <> 'running'").all()) {
      if (protectedIds.has(run.run_id)) continue;
      if (run.started_at < cutoff(policy.runsDays)) {
        erase('runs', 'runs', 'run_id = ?', run.run_id);
      } else if (run.kind !== 'daily' && run.started_at < cutoff(policy.runCompactDays)) {
        const receipt = JSON.parse(run.receipt_json);
        db.prepare('UPDATE runs SET receipt_json = ? WHERE run_id = ?')
          .run(JSON.stringify({ status: receipt.status ?? db.prepare('SELECT status FROM runs WHERE run_id = ?').get(run.run_id).status, counts: receipt.counts ?? {} }), run.run_id);
      }
    }
    const consumed = "kind = 'llm_raw' AND id NOT IN (SELECT id FROM retention_pending_logs)";
    erase('review_log', 'review_log', `${consumed} AND at < ?`, cutoff(policy.rawLogDays));
    const protectedCount = db.prepare('SELECT count(*) n FROM retention_pending_logs').get().n;
    erase('review_log', 'review_log', `${consumed} AND id NOT IN (
      SELECT id FROM review_log WHERE ${consumed} ORDER BY at DESC, id DESC LIMIT ?)`, Math.max(0, policy.rawLogMaxRows - protectedCount));
    erase('review_log', 'review_log', "kind IN ('outcome','error','replan') AND at < ?", cutoff(policy.logDays));
    const current = `snapshots.id = (SELECT s.id FROM snapshots s WHERE s.posting_id = snapshots.posting_id ORDER BY s.fetched_at DESC, s.id DESC LIMIT 1)
      OR EXISTS (SELECT 1 FROM reviews r, json_tree(r.evidence_json) j WHERE r.posting_id = snapshots.posting_id AND j.value = snapshots.content_hash)
      OR EXISTS (SELECT 1 FROM reviews r, json_tree(r.dep_hashes_json) j WHERE r.posting_id = snapshots.posting_id AND j.value = snapshots.content_hash)`;
    erase('snapshots', 'snapshots', `fetched_at < ? AND NOT (${current})`, cutoff(policy.snapshotsDays));
    const prunePayload = (where, ...params) => {
      const before = tableBytes(db, 'snapshots');
      const rows = db.prepare(`UPDATE snapshots SET text = NULL, fields_json = '{}', sections_json = '[]', text_pruned_at = ?
        WHERE text_pruned_at IS NULL AND (${where})`).run(now, ...params).changes;
      const bytes = Math.max(0, before - tableBytes(db, 'snapshots'));
      freed += bytes;
      tally('snapshot_payloads', { rows, bytes });
    };
    prunePayload(`EXISTS (SELECT 1 FROM reviews r WHERE r.posting_id = snapshots.posting_id
      AND r.decision = 'not_eligible' AND r.updated_at < ? AND snapshots.fetched_at < ?)`, cutoff(policy.negativePayloadDays), cutoff(policy.negativePayloadDays));
    prunePayload(`EXISTS (SELECT 1 FROM postings p LEFT JOIN applications a ON a.id = p.application_id
      WHERE p.id = snapshots.posting_id AND (
        (a.applied_at IS NOT NULL AND a.applied_at < ?) OR
        (a.status IN ('withdrawn','rejected','declined','accepted') AND a.updated_at < ?) OR
        (p.availability = 'closed_verified' AND p.updated_at < ?)))`, cutoff(policy.closedPayloadDays), cutoff(policy.closedPayloadDays), cutoff(policy.closedPayloadDays));
    for (const snapshot of db.prepare(`SELECT id FROM snapshots WHERE text_pruned_at IS NULL AND NOT (${current}) ORDER BY fetched_at, id`).all()) {
      if (tableBytes(db, 'snapshots') <= policy.snapshotsMaxBytes) break;
      prunePayload('id = ?', snapshot.id);
    }
    erase('attempts', 'attempts', `state IN ('responded','adopted','failed','lost') AND COALESCE(finished_at, dispatched_at) < ?
      AND id NOT IN (SELECT attempt_id FROM retention_pending_logs WHERE attempt_id IS NOT NULL)`, cutoff(policy.attemptsDays));
    db.exec(dryRun ? 'ROLLBACK TO retention_prune; RELEASE retention_prune' : 'RELEASE retention_prune');
  } catch (error) {
    db.exec('ROLLBACK TO retention_prune; RELEASE retention_prune');
    throw error;
  }

  // All asynchronous filesystem work happens after releasing SQLite's writer.
  const unchanged = async (file) => {
    try {
      const info = await lstat(file.path);
      return info.isFile() && info.size === file.bytes && info.mtimeMs === file.mtime && info.ino === file.inode;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const trimFiles = async (category, files, maxBytes, ageLimit, prunable) => {
    let bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const candidates = files.filter(prunable).sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
    for (const file of candidates) {
      if (!prunable(file)) continue;
      if (when - file.mtime < ageLimit * DAY && bytes <= maxBytes) continue;
      if (!dryRun) {
        if (!await unchanged(file)) continue;
        await rm(file.path);
      }
      bytes -= file.bytes;
      tally(category, { files: 1, bytes: file.bytes });
    }
  };
  const outputFiles = new Map((await inventory(attemptDir)).map((file) => [file.path, file]));
  // Keep the original attempt metadata even after its terminal row was pruned.
  const knownOutputs = new Map(await Promise.all(attempts.filter((item) => item.output_path)
    .map(async (item) => [await canonicalPath(item.output_path), item])));
  const activeOutputs = new Set(await Promise.all(db.prepare("SELECT output_path FROM attempts WHERE state = 'dispatched' AND output_path IS NOT NULL")
    .all().map((row) => canonicalPath(row.output_path))));
  await trimFiles('attempt_outputs', [...outputFiles.values()], policy.attemptsMaxBytes, policy.attemptOutputsDays,
    (file) => {
      const item = knownOutputs.get(file.path);
      return !pendingAttemptIds.has(item?.id)
        && !activeOutputs.has(file.path)
        && (!item || !db.prepare("SELECT 1 FROM attempts WHERE id = ? AND state = 'dispatched'").get(item.id))
        && (item || file.path.endsWith('.json'));
    });
  const receipts = await inventory(path.join(directory, 'runs'));
  for (const id of await protectedReceipts(directory, db, protectRunIds)) protectedIds.add(id);
  const receiptInfo = new Map();
  for (const file of receipts) {
    if (!file.path.endsWith('.json') || ['latest.json', 'eval-latest.json'].includes(path.basename(file.path))) continue;
    const receipt = await readJson(file.path);
    if (receipt?.run_id && ['daily', 'scan', 'review', 'prune'].includes(receipt.kind)) receiptInfo.set(file.path, receipt);
  }
  const receiptCandidates = receipts.filter((file) => {
    const info = receiptInfo.get(file.path);
    return info && !protectedIds.has(info.run_id ?? path.basename(file.path, '.json')) && info.status !== 'running';
  });
  // Apply the age inventory before the shared receipt byte cap.
  const aged = receiptCandidates.filter((file) => when - file.mtime >=
    (receiptInfo.get(file.path).kind === 'daily' ? policy.dailyReceiptsDays : policy.receiptsDays) * DAY);
  const agedPaths = new Set(aged.map((file) => file.path));
  await trimFiles('receipts', aged, 0, 0, () => true);
  await trimFiles('receipts', receipts.filter((file) => !agedPaths.has(file.path)), policy.receiptsMaxBytes, Infinity,
    (file) => receiptCandidates.some((item) => item.path === file.path));

  const work = new Map();
  for (const root of roots) {
    for (const file of await inventory(root)) work.set(file.path, file);
  }
  for (const file of work.values()) {
    if (file.path.endsWith('.gz') || file.path.endsWith('.new') || when - file.mtime < policy.workDays * DAY) continue;
    if (!dryRun) {
      let archive = `${file.path}.gz`;
      const temporary = `${archive}.${randomUUID()}.new`;
      try {
        if (!await unchanged(file)) continue;
        await pipeline(createReadStream(file.path), createGzip(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        if (!await unchanged(file)) continue;
        try { await link(temporary, archive); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          archive = `${file.path}.${randomUUID()}.gz`;
          await link(temporary, archive);
        }
        await utimes(archive, new Date(when), new Date(when));
        await rm(file.path);
        const archived = await lstat(archive);
        work.delete(file.path);
        work.set(archive, { path: archive, bytes: archived.size, mtime: archived.mtimeMs, inode: archived.ino });
        tally('work_compression', { files: 1, bytes: Math.max(0, file.bytes - archived.size) });
      } finally { await rm(temporary, { force: true }); }
    } else tally('work_compression', { files: 1 });
  }
  await trimFiles('work', [...work.values()], policy.workMaxBytes, policy.compressedWorkDays,
    (file) => file.path.endsWith('.gz'));
  if (!dryRun) {
    await writeFile(path.join(directory, 'retention-roots.json'), `${JSON.stringify({ workPaths: roots.filter((root) => root !== reportsRoot) })}\n`, { mode: 0o600 });
    for (const root of roots) {
      try { await removeEmptyDirectories(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  let vacuumed = false;
  if (!dryRun && freed >= MB) {
    db.exec('VACUUM');
    vacuumed = true;
  }
  return { removed, vacuumed, storage: await measureStorage(home, db) };
}
