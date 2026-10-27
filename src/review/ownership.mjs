import { SUBMITTED_STATUSES } from '../funnel/contract.mjs';

// A user decision fences recovery, replanning and dispatch alike.
export function userDecided(db, row) {
  const applicationId = row.application_id ?? db.prepare('SELECT application_id FROM postings WHERE id=?').get(row.posting_id)?.application_id;
  const app = applicationId && db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
  return Boolean(app && (app.applied_at || SUBMITTED_STATUSES.includes(app.status) || app.status === 'prepared'
    || ['user', 'legacy'].includes(app.skip_owner)) || row.code === 'user_declined'
    || db.prepare("SELECT 1 FROM review_log WHERE posting_id=? AND kind='user'").get(row.posting_id));
}
