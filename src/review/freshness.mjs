import { parseJson } from './deliver.mjs';
import { SUBMITTED_STATUSES } from '../funnel/contract.mjs';
export function recheckHolds(db, { now, screeningPolicy }) {
  let requeued = 0;
  for (const row of db.prepare("SELECT * FROM reviews WHERE state='held' AND code='quota_full' AND next_due IS NOT NULL").all()) {
    if (Date.parse(row.next_due) > Date.parse(now)) continue;
    db.prepare("UPDATE reviews SET state='due',stage='deliver',hold_owner=NULL,hold_since=NULL,updated_at=? WHERE posting_id=?").run(now, row.posting_id);
    requeued += 1;
  }
  return { requeued };
}

export function scheduleRefresh(db, { now, policy }) {
  let requeued = 0;
  const days = 86400000;
  for (const row of db.prepare(`SELECT r.*,p.application_id,p.availability,a.status,a.applied_at,a.skip_owner
    FROM reviews r JOIN postings p ON p.id=r.posting_id LEFT JOIN applications a ON a.id=p.application_id WHERE r.state='done'`).all()) {
    if (row.applied_at || SUBMITTED_STATUSES.includes(row.status) || row.status === 'prepared' || ['user','legacy'].includes(row.skip_owner) || row.code === 'user_declined') continue;
    if (db.prepare("SELECT 1 FROM review_log WHERE posting_id=? AND kind='user'").get(row.posting_id)) continue;
    const age = (Date.parse(now) - Date.parse(row.updated_at)) / days;
    const deadline = parseJson(row.deadline_json);
    const near = deadline.kind === 'cutoff' && Date.parse(deadline.date) - Date.parse(now) <= 3 * days;
    const every = row.decision === 'eligible' ? (near ? 1 : policy.freshness?.activeDays ?? 7) : policy.freshness?.negativeRecheckDays ?? 14;
    if (row.decision !== 'eligible' && (Date.parse(now) - Date.parse(row.first_seen)) / days > (policy.freshness?.negativeHorizonDays ?? 60)) continue;
    if (age < every) continue;
    db.prepare("UPDATE reviews SET state='due',stage='fetch',lane='refresh',next_due=?,updated_at=? WHERE posting_id=?").run(now, now, row.posting_id);
    requeued += 1;
  }
  return { requeued };
}
