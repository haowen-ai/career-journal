import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import { recordEvent } from '../../src/domain/events.mjs';

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-event-'));
  const db = openDatabase(path.join(home, 'jobops.db'));
  migrate(db);
  db.prepare(`INSERT INTO applications (id, company, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('acme-role', 'Acme', 'Analyst', 'applied', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');
  try { await run(db); } finally { db.close(); await rm(home, { recursive: true, force: true }); }
}

const event = {
  id: 'mail-001', applicationId: 'acme-role', type: 'application_update', occurredAt: null,
  observedAt: '2026-09-19T02:00:00Z', recordedAt: '2026-09-19T03:00:00Z',
  title: 'Application received', note: 'No decision date was supplied', source: { kind: 'email', messageId: '001' },
};

test('preserves null occurrence time and distinct observation timestamps', async () => fixture(async (db) => {
  assert.deepEqual(recordEvent(db, event), { created: true, eventId: 'mail-001' });
  const row = db.prepare('SELECT occurred_at, observed_at, recorded_at FROM application_events WHERE id = ?').get('mail-001');
  assert.equal(row.occurred_at, null);
  assert.equal(row.observed_at, event.observedAt);
  assert.equal(row.recorded_at, event.recordedAt);
}));

test('replays identical events as a no-op and rejects conflicting content', async () => fixture(async (db) => {
  recordEvent(db, { ...event, statusAfter: 'interview' });
  assert.deepEqual(recordEvent(db, { ...event, statusAfter: 'interview' }), { created: false, eventId: 'mail-001' });
  assert.equal(db.prepare('SELECT status FROM applications WHERE id = ?').get('acme-role').status, 'interview');
  assert.throws(() => recordEvent(db, { ...event, note: 'changed', statusAfter: 'applied' }), /Event id conflict/);
  assert.equal(db.prepare('SELECT status FROM applications WHERE id = ?').get('acme-role').status, 'interview');
}));

test('rejects an illegal status regression', async () => fixture(async (db) => {
  db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('rejected', 'acme-role');
  assert.throws(() => recordEvent(db, { ...event, statusAfter: 'applied' }), /Invalid status transition/);
}));

