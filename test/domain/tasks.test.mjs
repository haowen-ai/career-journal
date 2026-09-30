import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import { compareTasksByDue, deriveTaskId, listTasks, normalizeDueAt, setTaskStatus, upsertTask } from '../../src/domain/tasks.mjs';

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-task-'));
  const db = openDatabase(path.join(home, 'jobops.db'));
  migrate(db);
  db.prepare(`INSERT INTO applications (id, company, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('acme-role', 'Acme', 'Intern', 'assessment', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');
  try { await run(db); } finally { db.close(); await rm(home, { recursive: true, force: true }); }
}

test('accepts only real ISO timestamps that carry an offset', () => {
  for (const value of ['2026-10-01T23:59:00-07:00', '2026-10-01T23:59Z', '2026-10-01T23:59:59.123+05:30', '2026-12-31T10:00:00+14:00']) {
    assert.equal(normalizeDueAt(value), value);
  }
  assert.equal(normalizeDueAt(' 2026-10-01T23:59:00Z '), '2026-10-01T23:59:00Z');
  assert.equal(normalizeDueAt(null), null);
  for (const value of ['2026-10-01', '2026-10-01T23:59:00', '2026-02-29T10:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T10:00:00+15:00', 'Oct 1, 2026', '', true]) {
    assert.throws(() => normalizeDueAt(value), /ISO 8601 timestamp with a UTC offset/, String(value));
  }
});

test('derives the same id for the same application, kind, and normalized title', () => {
  const id = deriveTaskId('acme-role', 'assessment', 'HackerRank  OA');
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(deriveTaskId('acme-role', 'assessment', 'hackerrank oa'), id);
  assert.notEqual(deriveTaskId('acme-role', 'interview', 'HackerRank OA'), id);
  assert.notEqual(deriveTaskId('other-role', 'assessment', 'HackerRank OA'), id);
});

test('orders by absolute deadline, then creation time, with missing deadlines last', () => {
  const tasks = [
    { id: 'none', dueAt: null, createdAt: '2026-09-01T00:00:00Z' },
    { id: 'late', dueAt: '2026-10-02T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'offset', dueAt: '2026-10-01T20:00:00-07:00', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'tie-b', dueAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-02T00:00:00Z' },
    { id: 'tie-a', dueAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' },
  ].sort(compareTasksByDue);
  assert.deepEqual(tasks.map((task) => task.id), ['tie-a', 'tie-b', 'late', 'offset', 'none']);
});

test('upsert leaves an unchanged task untouched and status changes bump only updatedAt', async () => fixture(async (db) => {
  const input = { applicationId: 'acme-role', kind: 'assessment', title: 'Online assessment', dueAt: '2026-10-01T23:59:00Z' };
  const created = upsertTask(db, input, '2026-09-20T00:00:00Z');
  assert.deepEqual(upsertTask(db, input, '2026-09-21T00:00:00Z'), created);
  const done = setTaskStatus(db, created.id, 'done', '2026-09-22T00:00:00Z');
  assert.equal(done.status, 'done');
  assert.equal(done.createdAt, '2026-09-20T00:00:00Z');
  assert.equal(done.updatedAt, '2026-09-22T00:00:00Z');
  assert.deepEqual(upsertTask(db, input, '2026-09-23T00:00:00Z'), done);
  assert.throws(() => setTaskStatus(db, created.id, 'archived'), /Task status must be open or done/);
  assert.throws(() => setTaskStatus(db, 'missing', 'done'), /Unknown task: missing/);
  assert.deepEqual(listTasks(db, { applicationId: 'acme-role' }).map((task) => task.id), [created.id]);
  assert.deepEqual(listTasks(db, { applicationId: 'other' }), []);
}));
