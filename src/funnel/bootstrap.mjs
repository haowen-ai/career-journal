import { bindApplication } from './identity.mjs';
import { SUBMITTED_STATUSES } from './contract.mjs';

const startsWithAny = (note, prefixes) => prefixes.some((prefix) => String(note ?? '').startsWith(prefix));
function ownership(db, app, provenance) {
  if (app.skip_owner === 'user') return 'user';
  const events = db.prepare('SELECT * FROM application_events WHERE application_id=? ORDER BY recorded_at,rowid').all(app.id);
  const statusEvents = events.filter((event) => event.status_after);
  const last = statusEvents.at(-1);
  const source = last ? JSON.parse(last.source_json || '{}') : {};
  const markers = provenance.userDeclineMarkers ?? [];
  if (startsWithAny(app.skip_reason, markers) || startsWithAny(last?.note, markers) || source.actor === 'user') return 'user';
  if (app.status !== 'withdrawn') {
    return startsWithAny(app.skip_reason, provenance.automatedSkipPrefixes ?? []) ? 'review' : 'legacy';
  }
  // Only the final, attributable automated withdrawal permits restoration. Any later user event wins.
  const automated = last && last.status_after === 'withdrawn' && !app.applied_at
    && (source.actor === 'review-worker' || (last.event_type === 'queue_skipped' && startsWithAny(last.note, provenance.automatedSkipPrefixes ?? [])));
  if (automated) {
    const index = events.indexOf(last);
    const laterUser = events.slice(index + 1).some((event) => {
      const actor = JSON.parse(event.source_json || '{}').actor;
      return actor === 'user' || (!actor && /^(?:manual_|user_|queue_)/.test(event.event_type));
    });
    return laterUser ? 'user' : 'review';
  }
  if (last && (source.kind === 'manual' || source.kind === 'user' || source.kind === 'event-command')) return 'user';
  return 'legacy';
}

export function bootstrapExisting(db, { provenance, now, policy = {}, companyAliases = policy.companyAliases }) {
  const counts = { postings: 0, reused: 0, requeued: 0, held: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const app of db.prepare('SELECT * FROM applications ORDER BY created_at,id').all()) {
      const binding = bindApplication(db, app.id, { now, companyAliases });
      if (binding.action === 'created') counts.postings += 1;
      const id = binding.postingId;
      const existing = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(id);
      if (existing) continue;
      const owner = ownership(db, app, provenance);
      let state = 'due'; let decision = null; let code = null; let lane = 'refresh'; let holdOwner = null;
      if (SUBMITTED_STATUSES.includes(app.status) || app.applied_at) {
        state = 'done'; decision = 'reused'; code = 'already_submitted'; counts.reused += 1;
      } else if (app.status === 'withdrawn' && owner === 'user') {
        state = 'done'; decision = 'reused'; code = 'user_declined'; counts.reused += 1;
        db.prepare("UPDATE applications SET skip_owner='user' WHERE id=?").run(app.id);
      } else if (app.status === 'withdrawn' || app.skip_reason) {
        if (owner === 'review') {
          lane = 'bootstrap'; counts.requeued += 1;
          db.prepare("UPDATE applications SET skip_owner='review' WHERE id=?").run(app.id);
        } else {
          state = 'held'; decision = 'unclear'; code = 'provenance_unknown'; holdOwner = 'user'; counts.held += 1;
          if (app.skip_reason && app.skip_owner == null) db.prepare("UPDATE applications SET skip_owner='legacy' WHERE id=?").run(app.id);
        }
      } else counts.requeued += 1;
      db.prepare(`INSERT INTO reviews (posting_id,stage,state,decision,code,lane,flags_json,next_due,hold_owner,hold_since,first_seen,updated_at)
        VALUES (?,'fetch',?,?,?,?, '[]',?,?,?,?,?)`)
        .run(id, state, decision, code, lane, state === 'due' ? now : null, holdOwner, holdOwner ? now : null, now, now);
      if (owner === 'review') db.prepare('UPDATE reviews SET evidence_json=? WHERE posting_id=?').run(JSON.stringify({ provenance: 'automated' }), id);
    }
    db.exec('COMMIT');
    return counts;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
