import { deliver, logReview, parseJson, restoredVerdict } from './deliver.mjs';
import { DIRECTION_CODE, roleDirection } from './direction.mjs';
import { atomic, claimItem } from './lease.mjs';
import { userDecided } from './ownership.mjs';

// The role-direction startup pass (user rule 2026-10-29). Without fetching or judging it
//  - withdraws visible review-delivered leads whose title is out of direction (a requireAllow title only when the
//    judge's function label is stored and not allowed: older leads without a label were audited by hand),
//  - settles a role_direction review a refresh re-queued while it is still out of direction,
//  - restores a role_direction verdict once the rules let it through.
// User decisions are never touched.
export function applyRoleDirection(db, { now, policy = {}, owner = 'review-role-direction' }) {
  return atomic(db, () => {
    let withdrawn = 0; let restored = 0;
    for (const row of db.prepare(`SELECT p.*,r.posting_id,r.state,r.decision,r.code,r.flags_json,r.evidence_json,a.status application_status,a.skip_reason application_skip
      FROM postings p JOIN reviews r ON r.posting_id=p.id LEFT JOIN applications a ON a.id=p.application_id
      WHERE p.merged_into IS NULL AND (r.code=? AND r.state IN ('due','done') OR r.state='done' AND r.decision='eligible')`).all(DIRECTION_CODE)) {
      if (userDecided(db, row)) continue;
      const evidence = parseJson(row.evidence_json);
      const labelled = Object.hasOwn(evidence, 'function');
      const result = roleDirection(row.title, policy.direction, { functionValue: evidence.function });
      const verdict = () => ({ ...restoredVerdict(row, evidence), ...(labelled ? { functionValue: evidence.function } : {}) });
      if (row.code === DIRECTION_CODE) {
        if (!result.ok) {
          if (row.state === 'due') {
            db.prepare(`UPDATE reviews SET state='done',stage='deliver',next_due=NULL,updated_at=? WHERE posting_id=? AND state='due' AND code=?`).run(now, row.id, DIRECTION_CODE);
            logReview(db, row.id, { now, payload: { action: 'role_direction_settled' } });
          }
          continue;
        }
        const fence = claimItem(db, row.id, { owner, now });
        if (!fence) continue;
        deliver(db, { postingId: row.id, fence, now, policy, verdict: verdict() });
        restored += 1;
        continue;
      }
      if (result.ok || result.reason === 'require_allow' && !labelled) continue;
      // Only visible leads; hidden ones keep their own reason.
      if (!row.application_id || row.application_status !== 'lead' || row.application_skip) continue;
      const fence = claimItem(db, row.id, { owner, now });
      if (!fence) continue;
      deliver(db, { postingId: row.id, fence, now, policy, verdict: verdict() });
      withdrawn += 1;
    }
    return { withdrawn, restored };
  });
}
