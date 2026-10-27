import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openHomeDatabase } from '../runtime/home.mjs';
import { workspaceDirectory } from '../config/store.mjs';
import { prune, retentionPolicy } from '../retention/prune.mjs';

export async function pruneCommand(parsed, io) {
  if (parsed.subcommand) throw new Error('Usage: career-journal prune [--apply] [--run-id <id>] [--parent-run-id <id>] [--protect <id>]… [--json]');
  const home = parsed.options.home ?? process.cwd();
  let reviewPolicy = {};
  try { reviewPolicy = JSON.parse(await readFile(path.join(workspaceDirectory(home), 'profile', 'review-policy.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const policy = retentionPolicy(reviewPolicy);
  const dryRun = parsed.options.apply !== true;
  const now = new Date().toISOString();
  const runId = parsed.options['run-id'] ?? `prune-${randomUUID()}`;
  const parentRunId = parsed.options['parent-run-id'] ?? null;
  const protect = parsed.options.protect === undefined ? [] : [parsed.options.protect].flat();
  if (typeof runId !== 'string' || !runId || (parentRunId !== null && (typeof parentRunId !== 'string' || !parentRunId))
    || protect.some((id) => typeof id !== 'string' || !id)) throw new Error('Prune run IDs must be nonempty strings');
  const { db } = await openHomeDatabase(home);
  let started = false;
  try {
    // Command lifecycle belongs here: the library contract has no run ID and
    // dry-run callers must not write a run, a backup, or any other persistent row.
    if (!dryRun) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const active = db.prepare("SELECT 1 FROM runs WHERE kind = 'prune' AND status = 'running' AND heartbeat_at > ?")
          .get(new Date(Date.parse(now) - 600_000).toISOString());
        if (active) { db.exec('ROLLBACK'); return 75; }
        db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE kind = 'prune' AND status = 'running'").run(now);
        db.prepare(`INSERT INTO runs (run_id, kind, parent_run_id, owner, started_at, heartbeat_at, status, receipt_json)
          VALUES (?, 'prune', ?, 'retention', ?, ?, 'running', '{}')`).run(runId, parentRunId, now, now);
        db.exec('COMMIT');
        started = true;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    const result = await prune(db, home, { now, policy, dryRun, protectRunIds: [...protect, runId] });
    const finished = new Date().toISOString();
    if (started) db.prepare("UPDATE runs SET status = 'ok', finished_at = ?, heartbeat_at = ?, receipt_json = ? WHERE run_id = ?")
      .run(finished, finished, JSON.stringify({ status: 'ok', counts: result.removed }), runId);
    io.out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const finished = new Date().toISOString();
    if (started) db.prepare("UPDATE runs SET status = 'failed', finished_at = ?, heartbeat_at = ?, receipt_json = ? WHERE run_id = ?")
      .run(finished, finished, JSON.stringify({ status: 'failed', counts: {} }), runId);
    throw error;
  } finally { db.close(); }
}
