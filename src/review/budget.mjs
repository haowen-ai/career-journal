import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { atomic } from './lease.mjs';
import { redact } from '../runtime/redact.mjs';

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

export async function recoverLost(db, { attemptDir, now }) {
  let lost = 0; let adopted = 0;
  for (const row of db.prepare("SELECT * FROM attempts WHERE state='dispatched'").all()) {
    let output = null;
    if (row.output_path && attemptDir) {
      try {
        if ((await stat(row.output_path)).size > 2_000_000) throw new Error('too_large');
        const parsed = JSON.parse(await readFile(row.output_path, 'utf8')); output = parsed.output ?? parsed;
      } catch { /* absent or incomplete output is lost */ }
      if (!output || typeof output !== 'object' || !Array.isArray(output.alternatives) || !Array.isArray(output.criteria)) output = null;
    }
    atomic(db, () => {
      if (output) {
        const contextRow = db.prepare("SELECT payload_json FROM review_log WHERE attempt_id=? AND kind='outcome' ORDER BY id DESC LIMIT 1").get(row.id);
        const context = contextRow ? JSON.parse(contextRow.payload_json).attemptContext : null;
        db.prepare("UPDATE attempts SET state='adopted',finished_at=? WHERE id=?").run(now, row.id);
        db.prepare("INSERT INTO review_log(posting_id,at,stage,kind,attempt_id,payload_json) VALUES (?,?,?,'llm_raw',?,?)")
          .run(row.posting_id, now, row.stage, row.id, redact(JSON.stringify({ output, tier: row.tier, ...context })));
        adopted += 1;
      } else {
        db.prepare("UPDATE attempts SET state='lost',finished_at=?,error='response not recoverable' WHERE id=?").run(now, row.id);
        db.prepare('UPDATE reviews SET lost_attempts=lost_attempts+1 WHERE posting_id=?').run(row.posting_id);
        lost += 1;
      }
      db.prepare(`UPDATE reviews SET state=CASE WHEN lost_attempts>=2 THEN 'held' ELSE 'due' END,
        code=CASE WHEN lost_attempts>=2 THEN 'system_failure' ELSE code END,
        hold_owner=CASE WHEN lost_attempts>=2 THEN 'system' ELSE hold_owner END,
        hold_since=CASE WHEN lost_attempts>=2 THEN ? ELSE hold_since END,
        lease_owner=NULL,lease_until=NULL,next_due=?,updated_at=? WHERE posting_id=?`).run(now, now, now, row.posting_id);
    });
  }
  return { lost, adopted };
}
