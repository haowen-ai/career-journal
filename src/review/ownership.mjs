import { SUBMITTED_STATUSES } from '../funnel/contract.mjs';

// Bulk readers use the same ownership boundary without one lookup per review.
// These fragments expect reviews r and postings p in the enclosing query.
export const reviewOwnershipJoins = `
  LEFT JOIN applications a ON a.id=p.application_id
  LEFT JOIN (SELECT DISTINCT posting_id FROM review_log WHERE kind='user') u ON u.posting_id=r.posting_id`;
export const explicitUserDecisionSql = `(COALESCE(a.applied_at,'')<>''
  OR COALESCE(a.status,'') IN (${[...SUBMITTED_STATUSES, 'prepared'].map((status) => `'${status}'`).join(',')})
  OR COALESCE(a.skip_owner,'')='user' OR COALESCE(r.code,'')='user_declined' OR u.posting_id IS NOT NULL)`;
export const userDecisionSql = `(${explicitUserDecisionSql} OR COALESCE(a.skip_owner,'')='legacy')`;

// A user decision fences recovery, replanning and dispatch alike.
export function userDecided(db, row) {
  const applicationId = row.application_id ?? db.prepare('SELECT application_id FROM postings WHERE id=?').get(row.posting_id)?.application_id;
  const app = applicationId && db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
  return Boolean(app && (app.applied_at || SUBMITTED_STATUSES.includes(app.status) || app.status === 'prepared'
    || ['user', 'legacy'].includes(app.skip_owner)) || row.code === 'user_declined'
    || db.prepare("SELECT 1 FROM review_log WHERE posting_id=? AND kind='user'").get(row.posting_id));
}

const startsWithAny = (note, prefixes) => prefixes.some((prefix) => String(note ?? '').startsWith(prefix));
export function applicationOwnership(db, app, provenance) {
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
