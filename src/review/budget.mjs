import { randomUUID } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomic } from './lease.mjs';
import { redact } from '../runtime/redact.mjs';
import { userDecided } from './ownership.mjs';
import { judgmentEnvelope, rememberJudgment } from './judgment-cache.mjs';

export function createBudget(db, { runId, limit, concurrency = 1, maxTransportRetries = 2 }) {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxTransportRetries) || maxTransportRetries < 0) throw new Error('Invalid attempt budget');
  const used = () => db.prepare('SELECT COALESCE(SUM(1+transport_retries),0) n FROM attempts WHERE run_id=?').get(runId).n;
  const remaining = () => Math.max(0, limit - used());
  return {
    used, remaining,
    reserve({ postingId, stage, runner, model, tier, now }) {
      return atomic(db, () => {
        if (remaining() < 1 || db.prepare("SELECT COUNT(*) n FROM attempts WHERE run_id=? AND state='dispatched'").get(runId).n >= concurrency) return null;
        const id = randomUUID();
        db.prepare(`INSERT INTO attempts (id,run_id,posting_id,stage,runner,model,tier,state,dispatched_at)
          VALUES (?,?,?,?,?,?,?,'dispatched',?)`).run(id, runId, postingId, stage, runner, model, tier, now);
        db.prepare('UPDATE reviews SET paid_attempts=paid_attempts+1 WHERE posting_id=?').run(postingId);
        return { id, outputPath: null };
      });
    },
    markResponded(id, { usage = {}, transportRetries = 0, now }) {
      db.prepare("UPDATE attempts SET state='responded',usage_json=?,transport_retries=?,finished_at=? WHERE id=? AND run_id=? AND state='dispatched'")
        .run(JSON.stringify(usage), transportRetries, now, id, runId);
    },
    markFailed(id, { error, transportRetries = 0, now }) {
      db.prepare("UPDATE attempts SET state='failed',error=?,transport_retries=?,finished_at=? WHERE id=? AND run_id=? AND state='dispatched'")
        .run(String(error), transportRetries, now, id, runId);
    },
  };
}

export async function recoverLost(db, { attemptDir, now, before = now }) {
  let lost = 0; let adopted = 0;
  let root;
  try { root = attemptDir && await realpath(attemptDir); } catch { /* no recoverable files */ }
  for (const row of db.prepare("SELECT * FROM attempts WHERE state='dispatched' AND dispatched_at<=? ORDER BY dispatched_at,id").all(before)) {
    const run = db.prepare('SELECT status,heartbeat_at FROM runs WHERE run_id=?').get(row.run_id);
    if (run?.status === 'running' && Date.parse(now) - Date.parse(run.heartbeat_at) <= 600000) continue;
    const contextRow = db.prepare("SELECT payload_json FROM review_log WHERE attempt_id=? AND kind='outcome' ORDER BY id DESC LIMIT 1").get(row.id);
    const context = contextRow ? JSON.parse(contextRow.payload_json).attemptContext : null;
    let output = null;
    if (row.output_path && root) {
      try {
        const file = await realpath(row.output_path);
        const relative = path.relative(root, file);
        const info = await lstat(file);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !info.isFile() || info.size > 2_000_000) throw new Error('unrecoverable file');
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        output = judgmentEnvelope(parsed.output ?? parsed, { ...context, tier: row.tier });
      } catch { /* absent or incomplete output is lost */ }
    }
    atomic(db, () => {
      // File IO can race another recovery or a user/worker commit. Close the
      // attempt independently; only its still-current review claim may move.
      if (!db.prepare("SELECT 1 FROM attempts WHERE id=? AND state='dispatched'").get(row.id)) return;
      const review = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(row.posting_id);
      const newer = db.prepare('SELECT 1 FROM attempts WHERE posting_id=? AND dispatched_at>? LIMIT 1').get(row.posting_id, row.dispatched_at);
      const fence = context?.fence;
      const current = review && !userDecided(db, review) && !newer
        && (fence ? review.state === 'leased' && review.lease_owner === fence.owner && review.lease_generation === fence.generation
          : ['due','leased'].includes(review.state) && review.updated_at <= row.dispatched_at
            && (review.state !== 'leased' || review.lease_until <= now));
      if (output) {
        db.prepare("UPDATE attempts SET state='adopted',finished_at=? WHERE id=?").run(now, row.id);
        if (current) {
          db.prepare("INSERT INTO review_log(posting_id,at,stage,kind,attempt_id,payload_json) VALUES (?,?,?,'llm_raw',?,?)")
            .run(row.posting_id, now, row.stage, row.id, redact(JSON.stringify(output)));
          rememberJudgment(db, row.posting_id, output);
        }
        adopted += 1;
      } else {
        db.prepare("UPDATE attempts SET state='lost',finished_at=?,error='response not recoverable' WHERE id=?").run(now, row.id);
        db.prepare('UPDATE reviews SET lost_attempts=lost_attempts+1 WHERE posting_id=?').run(row.posting_id);
        lost += 1;
      }
      if (!current) return;
      db.prepare(`UPDATE reviews SET state=CASE WHEN lost_attempts>=2 THEN 'held' ELSE 'due' END,
        code=CASE WHEN lost_attempts>=2 THEN 'system_failure' ELSE code END,
        hold_owner=CASE WHEN lost_attempts>=2 THEN 'system' ELSE hold_owner END,
        hold_since=CASE WHEN lost_attempts>=2 THEN ? ELSE hold_since END,
        lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1,next_due=?,updated_at=? WHERE posting_id=?`).run(now, now, now, row.posting_id);
    });
  }
  return { lost, adopted };
}
