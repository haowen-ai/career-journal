import { createHash } from 'node:crypto';
import { assertStatusTransition, assertReviewRestore, isSubmittedReopen } from './status-machine.mjs';

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function timestamp(value, name, nullable = false) {
  if (nullable && value == null) return null;
  required(value, name);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function normalizedEvent(input) {
  return {
    id: required(input.id, 'event.id'),
    applicationId: required(input.applicationId, 'event.applicationId'),
    type: required(input.type, 'event.type'),
    occurredAt: timestamp(input.occurredAt, 'event.occurredAt', true),
    observedAt: timestamp(input.observedAt, 'event.observedAt'),
    recordedAt: timestamp(input.recordedAt, 'event.recordedAt'),
    title: required(input.title, 'event.title'),
    note: typeof input.note === 'string' ? input.note : '',
    source: canonical(input.source ?? {}),
    statusAfter: input.statusAfter == null ? null : required(input.statusAfter, 'event.statusAfter'),
  };
}

// A submission is recorded once per application: a repeated submitted/application_submitted event (a
// retried mail batch, a second CLI or dashboard call) is a no-op that returns the existing event, unless
// the caller forces a distinct submission. The check runs inside the write transaction for every caller.
// An application withdrawn since its submission is not "already submitted": a new submission reopens it.
export const SUBMISSION_EVENT_TYPES = Object.freeze(['submitted', 'application_submitted']);
const SUBMITTED = new Set(['applied', 'assessment', 'interview', 'offer', 'accepted', 'declined', 'rejected']);

export function recordEvent(db, input, { withinTransaction = false, reviewRestore = false, liftedRule = false, reopenUserWithdrawal = false, force = false } = {}) {
  const event = normalizedEvent(input);
  const contentHash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  if (!withinTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT content_hash FROM application_events WHERE id = ?').get(event.id);
    if (existing) {
      if (existing.content_hash !== contentHash) throw new Error(`Event id conflict: ${event.id}`);
      if (!withinTransaction) db.exec('COMMIT');
      return { created: false, eventId: event.id };
    }
    const application = db.prepare('SELECT status, skip_owner FROM applications WHERE id = ?').get(event.applicationId);
    if (!application) throw new Error(`Unknown application: ${event.applicationId}`);
    if (SUBMISSION_EVENT_TYPES.includes(event.type) && !force && SUBMITTED.has(application.status)) {
      const prior = db.prepare(`SELECT id FROM application_events WHERE application_id = ? AND event_type IN (${SUBMISSION_EVENT_TYPES.map(() => '?').join(',')})
        ORDER BY recorded_at, rowid LIMIT 1`).get(event.applicationId, ...SUBMISSION_EVENT_TYPES);
      if (prior) {
        if (!withinTransaction) db.exec('COMMIT');
        return { created: false, eventId: prior.id, duplicateOf: prior.id };
      }
    }
    if (event.statusAfter) {
      if (reviewRestore && event.type === 'review_restored') {
        const last = db.prepare('SELECT source_json FROM application_events WHERE application_id=? AND status_after IS NOT NULL ORDER BY recorded_at DESC,rowid DESC LIMIT 1').get(event.applicationId);
        const evidence = db.prepare("SELECT r.evidence_json FROM reviews r JOIN postings p ON p.id=r.posting_id WHERE p.application_id=?").all(event.applicationId)
          .map((row) => JSON.parse(row.evidence_json));
        assertReviewRestore(application.status, event.statusAfter, { actor: event.source.actor, lastActor: last && JSON.parse(last.source_json).actor,
          automated: evidence.some((value) => value?.provenance === 'automated'), systemReview: evidence.some((value) => value?.systemReview === true), liftedRule });
      } else assertStatusTransition(application.status, event.statusAfter, { eventType: event.type, skipOwner: application.skip_owner, reopenUserWithdrawal });
    }
    db.prepare(`INSERT INTO application_events
      (id, application_id, event_type, occurred_at, observed_at, recorded_at, title, note, source_json, status_after, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.applicationId, event.type, event.occurredAt, event.observedAt, event.recordedAt, event.title, event.note, JSON.stringify(event.source), event.statusAfter, contentHash);
    if (event.statusAfter) db.prepare('UPDATE applications SET status = ?, stage = ?, updated_at = ? WHERE id = ?')
      .run(event.statusAfter, event.title, event.recordedAt, event.applicationId);
    if (event.statusAfter && isSubmittedReopen(application.status, event.statusAfter, { eventType: event.type, skipOwner: application.skip_owner, reopenUserWithdrawal }))
      db.prepare('UPDATE applications SET skip_reason = NULL, skip_owner = NULL WHERE id = ?').run(event.applicationId);
    if (!withinTransaction) db.exec('COMMIT');
  } catch (error) {
    if (!withinTransaction && db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return { created: true, eventId: event.id };
}
