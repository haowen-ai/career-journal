import { validJudgment } from './judge.mjs';

const object = (value) => {
  try { const parsed = JSON.parse(value); return parsed && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
};

// The same envelope is used for live responses, crash recovery and durable reuse.
export function judgmentEnvelope(output, { tier, depsHash = null, snapshotHash = null } = {}) {
  if (!validJudgment(output) || !['primary', 'escalation'].includes(tier)) return null;
  return { output, tier, depsHash, snapshotHash };
}

export function rememberJudgment(db, postingId, envelope) {
  if (!envelope?.depsHash || !envelope.snapshotHash) return;
  const row = db.prepare('SELECT evidence_json FROM reviews WHERE posting_id=?').get(postingId);
  if (!row) return;
  const evidence = object(row.evidence_json);
  evidence.judgments = { ...evidence.judgments, [envelope.tier]: envelope };
  db.prepare('UPDATE reviews SET evidence_json=? WHERE posting_id=?').run(JSON.stringify(evidence), postingId);
}

export function cachedJudgment(db, postingId, { tier, depsHash, snapshotHash }) {
  const evidence = object(db.prepare('SELECT evidence_json FROM reviews WHERE posting_id=?').get(postingId)?.evidence_json);
  const matches = (value) => value?.tier === tier && value.depsHash === depsHash && value.snapshotHash === snapshotHash;
  const cached = evidence.judgments?.[tier];
  if (matches(cached)) return cached.output;
  for (const row of db.prepare("SELECT payload_json FROM review_log WHERE posting_id=? AND kind='llm_raw' ORDER BY id DESC").all(postingId)) {
    const payload = object(row.payload_json);
    if (!matches(payload)) continue;
    const envelope = judgmentEnvelope(payload.output, payload);
    if (envelope) { rememberJudgment(db, postingId, envelope); return envelope.output; }
  }
  return null;
}

// Upgrade existing completed reviews before their consumable raw logs expire.
export function preserveJudgments(db) {
  const seen = new Set();
  for (const row of db.prepare("SELECT posting_id,payload_json FROM review_log WHERE kind='llm_raw' ORDER BY id DESC").all()) {
    const payload = object(row.payload_json);
    const key = JSON.stringify([row.posting_id, payload.tier]);
    if (seen.has(key)) continue;
    const envelope = judgmentEnvelope(payload.output, payload);
    if (!envelope?.depsHash || !envelope.snapshotHash) continue;
    seen.add(key);
    rememberJudgment(db, row.posting_id, envelope);
  }
}
