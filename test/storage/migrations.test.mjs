import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate } from '../../src/storage/database.mjs';

test('dry run plans schema version 1 without writing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-db-'));
  try {
    const db = openDatabase(path.join(home, 'jobops.db'));
    assert.deepEqual(migrate(db, { dryRun: true }).pending, [1]);
    assert.throws(() => db.prepare('SELECT * FROM applications').all(), /no such table/);
    assert.deepEqual(migrate(db).applied, [1]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    for (const name of ['applications', 'application_events', 'artifacts', 'email_accounts', 'automations', 'decision_traces', 'schema_migrations']) assert.ok(tables.includes(name), name);
    assert.deepEqual(migrate(db).applied, []);
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

