import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate } from '../../src/storage/database.mjs';

test('dry run plans schema versions 1 and 2 without writing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-db-'));
  try {
    const db = openDatabase(path.join(home, 'jobops.db'));
    assert.deepEqual(migrate(db, { dryRun: true }).pending, [1, 2]);
    assert.throws(() => db.prepare('SELECT * FROM applications').all(), /no such table/);
    assert.deepEqual(migrate(db).applied, [1, 2]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    for (const name of ['applications', 'application_events', 'artifacts', 'email_accounts', 'automations', 'decision_traces', 'schema_migrations']) assert.ok(tables.includes(name), name);
    const accountColumns = new Set(db.prepare('PRAGMA table_info(email_accounts)').all().map((column) => column.name));
    for (const name of ['config_json', 'revision', 'last_run_id', 'last_batch_hash', 'last_fetched_at']) assert.ok(accountColumns.has(name), name);
    assert.deepEqual(migrate(db).applied, []);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});
