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


test('a submitted event reopens a withdrawal the user did not make', async () => fixture(async (db) => {
  for (const [owner, type] of [['review', 'submitted'], ['legacy', 'application_submitted'], [null, 'submitted']]) {
    db.prepare("UPDATE applications SET status='withdrawn', skip_reason='only MBA', skip_owner=? WHERE id='acme-role'").run(owner);
    recordEvent(db, { ...event, id: `submit-${owner}`, type, statusAfter: 'applied' });
    const row = db.prepare("SELECT status, skip_reason, skip_owner FROM applications WHERE id='acme-role'").get();
    assert.deepEqual({ ...row }, { status: 'applied', skip_reason: null, skip_owner: null });
  }
}));

test('withdrawn stays closed for the user own withdrawal or a non-submitted event', async () => fixture(async (db) => {
  db.prepare("UPDATE applications SET status='withdrawn', skip_reason='not interested', skip_owner='user' WHERE id='acme-role'").run();
  assert.throws(() => recordEvent(db, { ...event, type: 'submitted', statusAfter: 'applied' }), /Invalid status transition: withdrawn -> applied/);
  db.prepare("UPDATE applications SET skip_owner='review' WHERE id='acme-role'").run();
  assert.throws(() => recordEvent(db, { ...event, id: 'mail-002', statusAfter: 'applied' }), /Invalid status transition: withdrawn -> applied/);
  assert.throws(() => recordEvent(db, { ...event, id: 'mail-003', type: 'submitted', statusAfter: 'interview' }), /Invalid status transition: withdrawn -> interview/);
  assert.equal(db.prepare("SELECT status FROM applications WHERE id='acme-role'").get().status, 'withdrawn');
}));

test('an explicit override reopens a user-owned withdrawal only for a submitted event', async () => fixture(async (db) => {
  db.prepare("UPDATE applications SET status='withdrawn', skip_reason='dup', skip_owner='user' WHERE id='acme-role'").run();
  assert.throws(() => recordEvent(db, { ...event, statusAfter: 'applied' }, { reopenUserWithdrawal: true }), /Invalid status transition/);
  recordEvent(db, { ...event, id: 'mail-002', type: 'submitted', statusAfter: 'applied' }, { reopenUserWithdrawal: true });
  const row = db.prepare("SELECT status, skip_reason, skip_owner FROM applications WHERE id='acme-role'").get();
  assert.deepEqual({ ...row }, { status: 'applied', skip_reason: null, skip_owner: null });
}));
