// Called under the writer's transaction, so reclamation cannot race the write.
export function assertScanOwner(db, runId, owner) {
  const row = db.prepare('SELECT owner,status FROM runs WHERE run_id=?').get(runId);
  if (row?.owner !== owner || row.status !== 'running') {
    throw Object.assign(new Error('Scan run lease was reclaimed'), { name: 'StaleLeaseError' });
  }
}
