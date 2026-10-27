import { SUBMITTED_STATUSES } from '../funnel/contract.mjs';

// Bulk readers use the same ownership boundary without one lookup per review.
// These fragments expect reviews r and postings p in the enclosing query.
export const reviewOwnershipJoins = `
  LEFT JOIN applications a ON a.id=p.application_id
  LEFT JOIN (SELECT DISTINCT posting_id FROM review_log WHERE kind='user') u ON u.posting_id=r.posting_id`;
export const userDecisionSql = `(COALESCE(a.applied_at,'')<>''
  OR COALESCE(a.status,'') IN (${[...SUBMITTED_STATUSES, 'prepared'].map((status) => `'${status}'`).join(',')})
  OR COALESCE(a.skip_owner,'') IN ('user','legacy') OR COALESCE(r.code,'')='user_declined' OR u.posting_id IS NOT NULL)`;

// A user decision fences recovery, replanning and dispatch alike.
export function userDecided(db, row) {
  const applicationId = row.application_id ?? db.prepare('SELECT application_id FROM postings WHERE id=?').get(row.posting_id)?.application_id;
  const app = applicationId && db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
  return Boolean(app && (app.applied_at || SUBMITTED_STATUSES.includes(app.status) || app.status === 'prepared'
    || ['user', 'legacy'].includes(app.skip_owner)) || row.code === 'user_declined'
    || db.prepare("SELECT 1 FROM review_log WHERE posting_id=? AND kind='user'").get(row.posting_id));
}
