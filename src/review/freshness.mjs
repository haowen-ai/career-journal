import { autoReopenAllowed } from './reopen-policy.mjs';
import { parseJson } from './deliver.mjs';
import { reviewOwnershipJoins, userDecisionSql } from './ownership.mjs';
export function recheckHolds(db, { now, screeningPolicy }) {
  let requeued = 0;
  for (const row of db.prepare("SELECT * FROM reviews WHERE state='held' AND code='quota_full' AND next_due IS NOT NULL").all()) {
    if (Date.parse(row.next_due) > Date.parse(now)) continue;
    db.prepare("UPDATE reviews SET state='due',stage='deliver',hold_owner=NULL,hold_since=NULL,updated_at=? WHERE posting_id=?").run(now, row.posting_id);
    requeued += 1;
  }
  return { requeued };
}

// Decide once: only a queued lead (open by autoReopenAllowed) is re-checked on a schedule. Settled
// negatives and eligible reviews whose application left the queue are never re-queued by a run;
// `review rejudge` is the explicit path for those.
export function scheduleRefresh(db, { now, policy }) {
  let requeued = 0;
  const days = 86400000;
  for (const row of db.prepare(`SELECT r.*,a.status application_status FROM reviews r JOIN postings p ON p.id=r.posting_id
    ${reviewOwnershipJoins} WHERE r.state='done' AND r.decision='eligible' AND a.status='lead' AND NOT ${userDecisionSql}`).all()) {
    if (!autoReopenAllowed({ review: row, application: { status: row.application_status } })) continue;
    const age = (Date.parse(now) - Date.parse(row.updated_at)) / days;
    const deadline = parseJson(row.deadline_json);
    const near = deadline.kind === 'cutoff' && Date.parse(deadline.date) - Date.parse(now) <= 3 * days;
    if (age < (near ? 1 : policy.freshness?.activeDays ?? 7)) continue;
    db.prepare("UPDATE reviews SET state='due',stage='fetch',lane='refresh',next_due=?,updated_at=? WHERE posting_id=?").run(now, now, row.posting_id);
    requeued += 1;
  }
  return { requeued };
}
