import { deliver, logReview, parseJson, restoredVerdict } from './deliver.mjs';
import { DIRECTION_CODE, OUT_OF_DIRECTION_CODE, roleDirection, softwareOnlyRole } from './direction.mjs';
import { atomic, claimItem } from './lease.mjs';
import { userDecided } from './ownership.mjs';

// The role-direction startup pass (user rule 2026-10-29). Without fetching or judging it
//  - withdraws visible review-delivered leads (done, or due for a freshness refresh) whose title is out of direction (a requireAllow title only when the
//    judge's function label is stored and not allowed: older leads without a label were audited by hand),
//  - settles a role_direction review a refresh re-queued while it is still out of direction,
//  - restores a due role_direction verdict once the rules let it through, unless a replan invalidated it (re-judged).
// Decide once: only open work is selected (due reviews and queued leads). A settled direction rejection
// stays settled when the rules change; `review rejudge --code role_direction` reopens it explicitly.
// The same holds for a role the judge labelled pure software engineering (2026-10-31): settled out_of_direction with
// evidence.roleDirection.software, withdrawn when visible, restored once the rules or its title let it through.
// Exploration-lane out_of_direction settlements carry no such marker and are left alone, and a scan drop (decision
// 'dropped') wins over a stale marker.
// User decisions are never touched.
export function applyRoleDirection(db, { now, policy = {}, owner = 'review-role-direction' }) {
  return atomic(db, () => {
    let withdrawn = 0; let restored = 0;
    for (const row of db.prepare(`SELECT p.*,r.posting_id,r.state,r.decision,r.code,r.flags_json,r.evidence_json,r.dep_hashes_json,a.status application_status,a.skip_reason application_skip
      FROM postings p JOIN reviews r ON r.posting_id=p.id LEFT JOIN applications a ON a.id=p.application_id
      WHERE p.merged_into IS NULL AND (r.code=? AND r.state='due' AND COALESCE(r.decision,'')<>'dropped' OR r.state='due' AND r.decision='eligible'
        OR r.state='done' AND r.decision='eligible' AND a.status='lead'
        OR r.code=? AND r.state='due' AND r.decision='not_eligible' AND CASE WHEN json_valid(r.evidence_json) THEN json_extract(r.evidence_json,'$.roleDirection.software') END=1)`).all(DIRECTION_CODE, OUT_OF_DIRECTION_CODE)) {
      if (userDecided(db, row)) continue;
      const evidence = parseJson(row.evidence_json);
      const software = row.code === OUT_OF_DIRECTION_CODE;
      if (software && evidence.roleDirection?.software !== true) continue;
      const labelled = Object.hasOwn(evidence, 'function');
      // anyFunctionCompanies (role-direction.json) are honoured here exactly as at delivery.
      const company = { company: row.company, aliases: policy.companyAliases };
      const titled = roleDirection(row.title, policy.direction, { functionValue: evidence.function, ...company });
      // In direction only when the title rules pass and the label is not pure software engineering.
      const result = titled.ok && softwareOnlyRole(row.title, evidence.function, policy.direction, company) ? { ok: false, reason: 'software' } : titled;
      const verdict = () => ({ ...restoredVerdict(row, evidence), ...(labelled ? { functionValue: evidence.function } : {}) });
      if (row.code === DIRECTION_CODE || software) {
        if (!result.ok) {
          if (row.state === 'due') {
            db.prepare(`UPDATE reviews SET state='done',stage='deliver',next_due=NULL,updated_at=? WHERE posting_id=? AND state='due' AND code=?`).run(now, row.id, row.code);
            logReview(db, row.id, { now, payload: { action: 'role_direction_settled' } });
          }
          continue;
        }
        // A replan invalidated the kept verdict (screening inputs changed): it stays due to be re-judged, never restored.
        if (parseJson(row.dep_hashes_json).invalidated) continue;
        const fence = claimItem(db, row.id, { owner, now });
        if (!fence) continue;
        deliver(db, { postingId: row.id, fence, now, policy, verdict: verdict() });
        restored += 1;
        continue;
      }
      if (result.ok || result.reason === 'require_allow' && !labelled) continue;
      // Only visible leads (also ones a freshness refresh re-queued); hidden ones keep their own reason.
      if (!row.application_id || row.application_status !== 'lead' || row.application_skip) continue;
      const fence = claimItem(db, row.id, { owner, now });
      if (!fence) continue;
      deliver(db, { postingId: row.id, fence, now, policy, verdict: verdict() });
      withdrawn += 1;
    }
    return { withdrawn, restored };
  });
}
