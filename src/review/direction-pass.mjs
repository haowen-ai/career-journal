import { deliver, logReview, parseJson, restoredVerdict } from './deliver.mjs';
import { DIRECTION_CODE, OUT_OF_DIRECTION_CODE, roleDirection, softwareOnlyRole } from './direction.mjs';
import { atomic, claimItem } from './lease.mjs';
import { userDecided } from './ownership.mjs';

// The role-direction startup pass (user rule 2026-10-29). Without fetching or judging it
//  - withdraws visible review-delivered leads whose title is out of direction (a requireAllow title only when the
//    judge's function label is stored and not allowed: older leads without a label were audited by hand),
//  - settles a role_direction review a refresh re-queued while it is still out of direction,
//  - restores a role_direction verdict once the rules let it through.
// The same holds for a role the judge labelled pure software engineering (2026-10-31): settled out_of_direction with
// evidence.roleDirection.software, withdrawn when visible, restored once the rules or its title let it through.
// Exploration-lane out_of_direction settlements carry no such marker and are left alone.
// User decisions are never touched.
export function applyRoleDirection(db, { now, policy = {}, owner = 'review-role-direction' }) {
  return atomic(db, () => {
    let withdrawn = 0; let restored = 0;
    for (const row of db.prepare(`SELECT p.*,r.posting_id,r.state,r.decision,r.code,r.flags_json,r.evidence_json,a.status application_status,a.skip_reason application_skip
      FROM postings p JOIN reviews r ON r.posting_id=p.id LEFT JOIN applications a ON a.id=p.application_id
      WHERE p.merged_into IS NULL AND (r.code=? AND r.state IN ('due','done') OR r.state='done' AND r.decision='eligible'
        OR r.code=? AND r.state IN ('due','done') AND CASE WHEN json_valid(r.evidence_json) THEN json_extract(r.evidence_json,'$.roleDirection.software') END=1)`).all(DIRECTION_CODE, OUT_OF_DIRECTION_CODE)) {
      if (userDecided(db, row)) continue;
      const evidence = parseJson(row.evidence_json);
      const software = row.code === OUT_OF_DIRECTION_CODE;
      if (software && evidence.roleDirection?.software !== true) continue;
      const labelled = Object.hasOwn(evidence, 'function');
      const titled = roleDirection(row.title, policy.direction, { functionValue: evidence.function });
      // In direction only when the title rules pass and the label is not pure software engineering.
      const result = titled.ok && softwareOnlyRole(row.title, evidence.function, policy.direction) ? { ok: false, reason: 'software' } : titled;
      const verdict = () => ({ ...restoredVerdict(row, evidence), ...(labelled ? { functionValue: evidence.function } : {}) });
      if (row.code === DIRECTION_CODE || software) {
        if (!result.ok) {
          if (row.state === 'due') {
            db.prepare(`UPDATE reviews SET state='done',stage='deliver',next_due=NULL,updated_at=? WHERE posting_id=? AND state='due' AND code=?`).run(now, row.id, row.code);
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
