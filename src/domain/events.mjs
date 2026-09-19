import { createHash } from 'node:crypto';
import { assertStatusTransition } from './status-machine.mjs';

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

export function recordEvent(db, input) {
  const event = normalizedEvent(input);
  const contentHash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  const existing = db.prepare('SELECT content_hash FROM application_events WHERE id = ?').get(event.id);
  if (existing) {
    if (existing.content_hash !== contentHash) throw new Error(`Event id conflict: ${event.id}`);
    return { created: false, eventId: event.id };
  }
  const application = db.prepare('SELECT status FROM applications WHERE id = ?').get(event.applicationId);
  if (!application) throw new Error(`Unknown application: ${event.applicationId}`);
  if (event.statusAfter) assertStatusTransition(application.status, event.statusAfter);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO application_events
      (id, application_id, event_type, occurred_at, observed_at, recorded_at, title, note, source_json, status_after, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.applicationId, event.type, event.occurredAt, event.observedAt, event.recordedAt, event.title, event.note, JSON.stringify(event.source), event.statusAfter, contentHash);
    if (event.statusAfter) db.prepare('UPDATE applications SET status = ?, stage = ?, updated_at = ? WHERE id = ?')
      .run(event.statusAfter, event.title, event.recordedAt, event.applicationId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { created: true, eventId: event.id };
}

