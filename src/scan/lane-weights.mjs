// Lane weights (plan 2026-11-14 v4): the fetch time of every CareerOps entry in the most recent finished scan that read
// CareerOps, from that scan's receipt, keyed by entry name (the partition after "<provider>:"). The bridge starts the
// hosts with the largest weights first, so the slowest host is not the last to start. A scheduling hint only: an
// unreadable receipt is passed over, and no readable one gives no hint (null); it never stops the scan.
function weightsOf(text) {
  let sources;
  try { sources = JSON.parse(text)?.sources; } catch { return null; }
  const weights = {};
  for (const source of Array.isArray(sources) ? sources : []) {
    if (source?.source !== 'careerops' || typeof source.partition !== 'string' || source.partition === 'all') continue;
    const name = source.partition.slice(source.partition.indexOf(':') + 1);
    if (Number.isFinite(source.elapsedMs) && source.elapsedMs >= 0) weights[name] = (weights[name] ?? 0) + source.elapsedMs;
  }
  return Object.keys(weights).length ? weights : null;
}

export function previousLaneWeights(db) {
  try {
    // Newest first; a browser read or a board-only scan has no CareerOps timing and is passed over.
    const rows = db.prepare(`SELECT receipt_json FROM runs WHERE kind='scan' AND finished_at IS NOT NULL AND status IN ('ok','partial')
      AND instr(receipt_json, '"careerops"') > 0 ORDER BY started_at DESC`).iterate();
    for (const row of rows) {
      const weights = weightsOf(row.receipt_json);
      if (weights) { rows.return?.(); return weights; }
    }
    return null;
  } catch { return null; }
}
