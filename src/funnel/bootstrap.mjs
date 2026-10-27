import { bindApplication } from './identity.mjs';
import { SUBMITTED_STATUSES } from './contract.mjs';
import { applicationOwnership } from '../review/ownership.mjs';
import { releaseHolds } from '../review/release-holds.mjs';

export function bootstrapExisting(db, { provenance, now, policy = {}, companyAliases = policy.companyAliases }) {
  const counts = { postings: 0, reused: 0, requeued: 0, held: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    counts.requeued += releaseHolds(db, { now, provenance, codes: ['provenance_unknown'] }).requeued;
    for (const app of db.prepare('SELECT * FROM applications ORDER BY created_at,id').all()) {
      const binding = bindApplication(db, app.id, { now, companyAliases });
      if (binding.action === 'created') counts.postings += 1;
      const id = binding.postingId;
      const existing = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(id);
      if (existing) continue;
      const owner = applicationOwnership(db, app, provenance);
      let state = 'due'; let decision = null; let code = null; let lane = 'refresh'; let holdOwner = null;
      if (SUBMITTED_STATUSES.includes(app.status) || app.applied_at || app.status === 'prepared') {
        state = 'done'; decision = 'reused'; code = app.status === 'prepared' && !app.applied_at ? 'prepared' : 'already_submitted'; counts.reused += 1;
      } else if (owner === 'user') {
        state = 'done'; decision = 'reused'; code = 'user_declined'; counts.reused += 1;
        db.prepare("UPDATE applications SET skip_owner='user' WHERE id=?").run(app.id);
      } else if (app.status === 'withdrawn' || app.skip_reason) {
        lane = 'bootstrap'; counts.requeued += 1;
        db.prepare("UPDATE applications SET skip_owner='review' WHERE id=?").run(app.id);
      } else counts.requeued += 1;
      db.prepare(`INSERT INTO reviews (posting_id,stage,state,decision,code,lane,flags_json,next_due,hold_owner,hold_since,first_seen,updated_at)
        VALUES (?,'fetch',?,?,?,?, '[]',?,?,?,?,?)`)
        .run(id, state, decision, code, lane, state === 'due' ? now : null, holdOwner, holdOwner ? now : null, now, now);
      if (owner === 'review') db.prepare('UPDATE reviews SET evidence_json=? WHERE posting_id=?').run(JSON.stringify({ provenance: 'automated' }), id);
      else if (state === 'due' && lane === 'bootstrap') db.prepare('UPDATE reviews SET evidence_json=? WHERE posting_id=?')
        .run(JSON.stringify({ provenance: 'unknown', systemReview: true }), id);
    }
    db.exec('COMMIT');
    return counts;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
