import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { migrateHome } from '../../src/commands/migrate.mjs';
import { openDatabase, migrate, schemaMigrations } from '../../src/storage/database.mjs';

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-migrate-'));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('dry-run reports migrations without creating a database', async () => withHome(async (home) => {
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const database = path.join(home, '.jobops', 'jobops.db');
  const report = await migrateHome(home, { dryRun: true });
  assert.deepEqual(report.pending, schemaMigrations.map((item) => item.version));
  await assert.rejects(() => stat(database), { code: 'ENOENT' });
}));

test('migration apply is idempotent', async () => withHome(async (home) => {
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  assert.deepEqual((await migrateHome(home)).applied, [1]);
  assert.deepEqual((await migrateHome(home)).applied, []);
}));

test('failed migration restores the exact pre-migration database', async () => withHome(async (home) => {
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const database = path.join(home, '.jobops', 'jobops.db');
  const db = openDatabase(database);
  migrate(db);
  db.prepare("INSERT INTO applications (id, company, role, status, created_at, updated_at) VALUES ('keep', 'Keep Co', 'Role', 'lead', '2026-01-01', '2026-01-01')").run();
  db.close();
  const before = await readFile(database);
  const failing = [...schemaMigrations, { version: 2, name: 'fail', sql: 'CREATE TABLE transient(value TEXT); INSERT INTO missing_table VALUES (1);' }];
  await assert.rejects(() => migrateHome(home, { migrations: failing }), /missing_table/);
  assert.deepEqual(await readFile(database), before);
  const restored = openDatabase(database);
  assert.equal(restored.prepare("SELECT company FROM applications WHERE id = 'keep'").get().company, 'Keep Co');
  assert.equal(restored.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transient'").get(), undefined);
  restored.close();
}));
