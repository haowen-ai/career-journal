// Savepoints also work inside a caller's transaction (delivery/recovery).
export function atomic(db, work) {
  const outer = !db.isTransaction;
  db.exec(outer ? 'BEGIN IMMEDIATE' : 'SAVEPOINT review_atomic');
  try {
    const value = work();
    db.exec(outer ? 'COMMIT' : 'RELEASE review_atomic');
    return value;
  } catch (error) {
    db.exec(outer ? 'ROLLBACK' : 'ROLLBACK TO review_atomic; RELEASE review_atomic');
    throw error;
  }
}

export class StaleLeaseError extends Error {
  constructor(postingId) { super(`Stale review lease: ${postingId}`); this.name = 'StaleLeaseError'; }
}

export function acquireRunLease(db, { kind, owner, runId, parentRunId = null, now, staleAfterMs = 600000 }) {
  return atomic(db, () => {
    const running = db.prepare("SELECT * FROM runs WHERE kind=? AND status='running'").all(kind);
    if (running.some((row) => Date.parse(now) - Date.parse(row.heartbeat_at) <= staleAfterMs)) return null;
    for (const row of running) db.prepare("UPDATE runs SET status='interrupted', finished_at=? WHERE run_id=?").run(now, row.run_id);
    db.prepare(`INSERT INTO runs (run_id,kind,parent_run_id,owner,started_at,heartbeat_at,status)
      VALUES (?,?,?,?,?,?,'running')`).run(runId, kind, parentRunId, owner, now, now);
    return { kind, owner, runId, previousRunInterrupted: running.length > 0 };
  });
}

export function heartbeat(db, lease, { now }) {
  const changed = db.prepare("UPDATE runs SET heartbeat_at=? WHERE run_id=? AND owner=? AND status='running'").run(now, lease.runId, lease.owner).changes;
  if (!changed) throw new StaleLeaseError(lease.runId);
}

export function finishRun(db, lease, { status, receipt, now }) {
  const changed = db.prepare("UPDATE runs SET status=?,receipt_json=?,finished_at=?,heartbeat_at=? WHERE run_id=? AND owner=? AND status='running'")
    .run(status, JSON.stringify(receipt), now, now, lease.runId, lease.owner).changes;
  if (!changed) throw new StaleLeaseError(lease.runId);
}

export function claimItem(db, postingId, { owner, now, ttlMs = 1800000 }) {
  return atomic(db, () => {
    const changed = db.prepare(`UPDATE reviews SET state='leased',lease_owner=?,lease_generation=lease_generation+1,lease_until=?
      WHERE posting_id=? AND (state <> 'leased' OR lease_until <= ? OR lease_until IS NULL)`)
      .run(owner, new Date(Date.parse(now) + ttlMs).toISOString(), postingId, now).changes;
    if (!changed) return null;
    return { owner, generation: db.prepare('SELECT lease_generation FROM reviews WHERE posting_id=?').get(postingId).lease_generation };
  });
}

export function assertFence(db, postingId, fence) {
  const row = db.prepare('SELECT lease_owner,lease_generation,state FROM reviews WHERE posting_id=?').get(postingId);
  if (!fence || row?.state !== 'leased' || row.lease_owner !== fence.owner || row.lease_generation !== fence.generation) throw new StaleLeaseError(postingId);
}
