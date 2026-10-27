import { atomic } from './lease.mjs';
import { parseJson, logReview } from './deliver.mjs';
import { applicationOwnership, reviewOwnershipJoins, explicitUserDecisionSql } from './ownership.mjs';
import { cachedJudgment } from './judgment-cache.mjs';
import { dependencyHash, screeningPolicyParts } from './inputs.mjs';

export const MODEL_HOLD_CODES = Object.freeze(['missing_fact', 'requirement_unclear', 'user_review', 'term_or_area']);
const RELEASE_CODES = [...MODEL_HOLD_CODES, 'provenance_unknown'];
export const releasedInputsHash = (inputs) => dependencyHash({ facts: inputs.facts, rules: inputs.rules,
  policy: screeningPolicyParts(inputs.policy), screeningPolicy: inputs.screeningPolicy, provenance: inputs.provenance,
  resume: inputs.resume?.text ?? null, jobType: inputs.profile?.search?.jobType ?? null });

// This changes queue ownership only. Cached judgments and the application's
// hidden state remain available until a subsequent worker delivers its verdict.
export function releaseHolds(db, { now, provenance = {}, inputs, codes = RELEASE_CODES } = {}) {
  const report = { requeued: 0, by_stage: { fetch: 0, judge: 0 }, by_code: {} };
  return atomic(db, () => {
    const rows = db.prepare(`SELECT r.*,p.application_id FROM reviews r JOIN postings p ON p.id=r.posting_id
      ${reviewOwnershipJoins} WHERE r.state='held' AND r.hold_owner='user' AND p.merged_into IS NULL
      AND r.lane NOT IN ('no_student_signal','out_of_direction') AND NOT ${explicitUserDecisionSql}
      AND r.code IN (${RELEASE_CODES.map(() => '?').join(',')}) ORDER BY r.first_seen,r.posting_id`).all(...RELEASE_CODES);
    for (const row of rows) {
      if (!codes.includes(row.code)) continue;
      const app = row.application_id && db.prepare('SELECT * FROM applications WHERE id=?').get(row.application_id);
      if (app && applicationOwnership(db, app, provenance) === 'user') continue;
      const snapshot = db.prepare(`SELECT content_hash FROM snapshots WHERE posting_id=? AND identity_ok=1 AND text IS NOT NULL
        ORDER BY fetched_at DESC,rowid DESC LIMIT 1`).get(row.posting_id);
      const stored = parseJson(row.dep_hashes_json);
      const evidence = parseJson(row.evidence_json);
      const cached = snapshot && ['primary', 'escalation'].some((tier) => {
        const depsHash = stored.runtime?.[tier] ? dependencyHash(stored.runtime[tier]) : evidence.judgments?.[tier]?.depsHash;
        return depsHash && cachedJudgment(db, row.posting_id, { tier, depsHash, snapshotHash: snapshot.content_hash, remember: false });
      });
      const stage = cached ? 'judge' : 'fetch';
      // Explicit release authorizes replay of the retained judgments, including
      // pre-H1 prompt/model hashes. Keep those hashes intact and fence that replay
      // to the release's screening inputs and the same official snapshot.
      if (cached && inputs) stored.releasedHold = { inputs: releasedInputsHash(inputs), snapshot: snapshot.content_hash };
      if (row.code === 'provenance_unknown' || app?.skip_owner === 'legacy') {
        evidence.systemReview = true;
        evidence.provenance ??= 'unknown';
        if (app?.skip_owner === 'legacy') db.prepare("UPDATE applications SET skip_owner='review' WHERE id=?").run(app.id);
      }
      db.prepare(`UPDATE reviews SET state='due',stage=?,hold_owner=NULL,hold_since=NULL,next_due=?,lease_owner=NULL,lease_until=NULL,
        lease_generation=lease_generation+1,evidence_json=?,dep_hashes_json=?,updated_at=? WHERE posting_id=?`)
        .run(stage, now, JSON.stringify(evidence), JSON.stringify(stored), now, row.posting_id);
      logReview(db, row.posting_id, { now, stage, kind: 'replan', payload: { reason: 'release model hold', code: row.code } });
      report.requeued += 1;
      report.by_stage[stage] += 1;
      report.by_code[row.code] = (report.by_code[row.code] ?? 0) + 1;
    }
    return report;
  });
}
