import { deliver, logReview, parseJson, restoredVerdict } from './deliver.mjs';
import { companyExcluded } from './excluded.mjs';
import { atomic, claimItem } from './lease.mjs';
import { userDecided } from './ownership.mjs';

const CODE = 'company_excluded';

// The company-exclusion startup pass (profile/company-overrides.json excludedCompanies and
// excludedCompanyPatterns, user decisions of 2026-10-29). Without fetching or judging it
//  - settles due and held reviews at an excluded company (so no paid judgment is spent on them),
//  - withdraws visible review-delivered leads there (hidden ones keep their own reason),
//  - settles again an override exclusion a refresh re-queued while the company stays excluded,
//  - restores an override exclusion once the user lifts it: a judged lead from its kept verdict,
//    an unjudged review back to the fetch queue.
// User decisions (applied, prepared, user-skipped, user-logged) are never touched. Each row is
// settled in its own short transaction.
export function applyCompanyExclusion(db, { now, policy = {}, owner = 'review-company-exclusion' }) {
  let withdrawn = 0; let settled = 0; let restored = 0;
  // Pick the candidates by company first: the backlog of due reviews is large, and only
  // rows at an excluded company (or an override exclusion to re-check) need a transaction.
  const rows = db.prepare(`SELECT p.id,p.company,r.code,r.evidence_json FROM postings p JOIN reviews r ON r.posting_id=p.id
    WHERE p.merged_into IS NULL AND (r.state IN ('due','held') OR r.state='done' AND (r.decision='eligible' OR r.code=?))`).all(CODE)
    .filter((row) => row.code === CODE ? parseJson(row.evidence_json).companyExcluded?.source === 'user' : companyExcluded(row.company, policy)?.source === 'user');
  for (const { id } of rows) {
    atomic(db, () => {
      const row = db.prepare(`SELECT p.*,r.posting_id,r.state,r.decision,r.code,r.flags_json,r.evidence_json,a.status application_status,a.skip_reason application_skip
        FROM postings p JOIN reviews r ON r.posting_id=p.id LEFT JOIN applications a ON a.id=p.application_id WHERE p.id=?`).get(id);
      if (!row || userDecided(db, row)) return;
      const evidence = parseJson(row.evidence_json);
      const excluded = companyExcluded(row.company, policy);
      const userOwned = row.code === CODE && evidence.companyExcluded?.source === 'user';
      if (userOwned) {
        if (excluded) {
          if (row.state === 'due' || row.state === 'held') {
            db.prepare(`UPDATE reviews SET state='done',stage='deliver',decision='not_eligible',next_due=NULL,hold_owner=NULL,hold_since=NULL,updated_at=?
              WHERE posting_id=? AND state IN ('due','held') AND code=?`).run(now, id, CODE);
            logReview(db, id, { now, payload: { action: 'company_excluded_settled', match: excluded.match } });
            settled += 1;
          }
          return;
        }
        if (row.state !== 'done') return;
        if (evidence.companyExcluded.judged === true) {
          const fence = claimItem(db, id, { owner, now });
          if (!fence) return;
          deliver(db, { postingId: id, fence, now, policy, verdict: restoredVerdict(row, evidence) });
        } else {
          const { companyExcluded: _, ...rest } = evidence;
          const kept = evidence.companyExcluded.provenance ? { ...rest, provenance: evidence.companyExcluded.provenance } : (({ provenance: __, ...other }) => other)(rest);
          db.prepare(`UPDATE reviews SET state='due',stage='fetch',decision=NULL,code=NULL,next_due=?,hold_owner=NULL,hold_since=NULL,evidence_json=?,updated_at=?
            WHERE posting_id=? AND state='done' AND code=?`).run(now, JSON.stringify(kept), now, id, CODE);
          logReview(db, id, { now, stage: 'fetch', payload: { action: 'company_excluded_restored', judged: false } });
        }
        restored += 1;
        return;
      }
      if (!excluded || excluded.source !== 'user') return;
      if (row.state === 'done') {
        if (row.decision !== 'eligible') return;
        // Only visible leads; hidden ones keep their own reason.
        if (!row.application_id || row.application_status !== 'lead' || row.application_skip) return;
      } else if (row.application_status === 'withdrawn') {
        // A refreshed review whose lead was already withdrawn: settle the review only, so it is not judged;
        // the application keeps its own reason and events.
        const settledEvidence = { ...evidence, companyExcluded: { source: 'user', match: excluded.match, judged: false, provenance: evidence.provenance ?? null }, provenance: 'automated' };
        db.prepare(`UPDATE reviews SET state='done',stage='deliver',decision='not_eligible',code=?,evidence_json=?,next_due=NULL,hold_owner=NULL,hold_since=NULL,
          lease_owner=NULL,lease_until=NULL,updated_at=? WHERE posting_id=? AND state IN ('due','held')`).run(CODE, JSON.stringify(settledEvidence), now, id);
        logReview(db, id, { now, payload: { action: 'company_excluded_settled', match: excluded.match, applicationUntouched: true } });
        settled += 1;
        return;
      }
      const fence = claimItem(db, id, { owner, now });
      if (!fence) return;
      deliver(db, { postingId: id, fence, now, policy, verdict: row.state === 'done' ? restoredVerdict(row, evidence) : { decision: 'not_eligible', code: CODE } });
      if (row.state === 'done') withdrawn += 1; else settled += 1;
    });
  }
  return { withdrawn, settled, restored };
}
