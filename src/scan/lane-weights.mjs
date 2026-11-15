// Lane weights (plan 2026-11-14 v4): the fetch time of every CareerOps entry in the most recent finished scan that read
// CareerOps, from that scan's receipt, keyed by entry name (the partition after "<provider>:"). The bridge starts the
// hosts with the largest weights first, so the slowest host is not the last to start. A scheduling hint only.
export function previousLaneWeights(db) {
  const row = db.prepare(`SELECT receipt_json FROM runs WHERE kind='scan' AND finished_at IS NOT NULL AND status IN ('ok','partial')
    AND EXISTS (SELECT 1 FROM json_each(runs.receipt_json, '$.sources') WHERE json_extract(value, '$.source')='careerops'
      AND json_extract(value, '$.partition') <> 'all' AND json_type(value, '$.elapsedMs') IN ('integer','real'))
    ORDER BY started_at DESC LIMIT 1`).get();
  if (!row) return null;
  const weights = {};
  for (const source of JSON.parse(row.receipt_json).sources ?? []) {
    if (source?.source !== 'careerops' || typeof source.partition !== 'string' || source.partition === 'all') continue;
    const name = source.partition.slice(source.partition.indexOf(':') + 1);
    if (Number.isFinite(source.elapsedMs) && source.elapsedMs >= 0) weights[name] = (weights[name] ?? 0) + source.elapsedMs;
  }
  return Object.keys(weights).length ? weights : null;
}
