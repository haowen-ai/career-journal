import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate, schemaMigrations } from '../../src/storage/database.mjs';

test('dry run plans schema versions 1 through 3 without writing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-db-'));
  try {
    const db = openDatabase(path.join(home, 'jobops.db'));
    assert.deepEqual(migrate(db, { dryRun: true }).pending, [1, 2, 3]);
    assert.throws(() => db.prepare('SELECT * FROM applications').all(), /no such table/);
    assert.deepEqual(migrate(db).applied, [1, 2, 3]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    for (const name of ['applications', 'application_events', 'artifacts', 'email_accounts', 'automations', 'decision_traces', 'application_tasks', 'schema_migrations']) assert.ok(tables.includes(name), name);
    const accountColumns = new Set(db.prepare('PRAGMA table_info(email_accounts)').all().map((column) => column.name));
    for (const name of ['config_json', 'revision', 'last_run_id', 'last_batch_hash', 'last_fetched_at']) assert.ok(accountColumns.has(name), name);
    assert.deepEqual(migrate(db).applied, []);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function withDatabase(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-db-'));
  const db = openDatabase(path.join(home, 'jobops.db'));
  try { await run(db); } finally { db.close(); await rm(home, { recursive: true, force: true }); }
}

const insertApplication = (db, id) => db.prepare(`INSERT INTO applications (id, company, role, status, created_at, updated_at)
  VALUES (?, 'Acme', 'Intern', 'applied', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run(id);

test('migration 3 creates application_tasks with constraints, defaults, index, and cascade', async () => withDatabase(async (db) => {
  migrate(db);
  const columns = db.prepare('PRAGMA table_info(application_tasks)').all();
  assert.deepEqual(columns.map((column) => column.name), [
    'id', 'application_id', 'kind', 'title', 'platform', 'due_at', 'due_note', 'status', 'note', 'source_json', 'created_at', 'updated_at',
  ]);
  const nullable = Object.fromEntries(columns.map((column) => [column.name, column.notnull === 0]));
  assert.equal(nullable.platform, true);
  assert.equal(nullable.due_at, true);
  for (const name of ['application_id', 'kind', 'title', 'due_note', 'status', 'note', 'source_json', 'created_at', 'updated_at']) assert.equal(nullable[name], false, name);
  const indexColumns = db.prepare("PRAGMA index_info('application_tasks_status_due_idx')").all().map((column) => column.name);
  assert.deepEqual(indexColumns, ['status', 'due_at']);

  insertApplication(db, 'acme-intern');
  db.prepare(`INSERT INTO application_tasks (id, application_id, kind, title, created_at, updated_at)
    VALUES ('task-1', 'acme-intern', 'assessment', 'Online assessment', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run();
  assert.deepEqual({ ...db.prepare("SELECT due_at, due_note, status, note, source_json FROM application_tasks WHERE id = 'task-1'").get() },
    { due_at: null, due_note: '', status: 'open', note: '', source_json: '{}' });
  const insert = (id, kind, status) => db.prepare(`INSERT INTO application_tasks (id, application_id, kind, title, status, created_at, updated_at)
    VALUES (?, 'acme-intern', ?, 'Step', ?, '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run(id, kind, status);
  assert.throws(() => insert('bad-kind', 'quiz', 'open'), /CHECK constraint failed/);
  assert.throws(() => insert('bad-status', 'interview', 'skipped'), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO application_tasks (id, application_id, kind, title, created_at, updated_at)
    VALUES ('orphan', 'missing', 'other', 'Step', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run(), /FOREIGN KEY constraint failed/);
  db.prepare("DELETE FROM applications WHERE id = 'acme-intern'").run();
  assert.equal(db.prepare('SELECT COUNT(*) count FROM application_tasks').get().count, 0);
}));

test('an already-migrated version 2 database upgrades to version 3 in place', async () => withDatabase(async (db) => {
  assert.deepEqual(migrate(db, { migrations: schemaMigrations.slice(0, 2) }).applied, [1, 2]);
  insertApplication(db, 'kept');
  assert.deepEqual(migrate(db, { dryRun: true }).pending, [3]);
  assert.deepEqual(migrate(db).applied, [3]);
  assert.equal(db.prepare("SELECT company FROM applications WHERE id = 'kept'").get().company, 'Acme');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM application_tasks').get().count, 0);
  assert.deepEqual(db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row })), [
    { version: 1, name: 'initial' },
    { version: 2, name: 'email-account-settings' },
    { version: 3, name: 'application-tasks' },
  ]);
  assert.deepEqual(migrate(db).applied, []);
}));
