import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup } from '../../src/commands/setup.mjs';
import { migrateHome } from '../../src/commands/migrate.mjs';
import { openDatabase, migrate, schemaMigrations } from '../../src/storage/database.mjs';
import { defaultConfig } from '../../src/config/defaults.mjs';

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-migrate-'));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

async function createLegacyConfig(home) {
  const directory = path.join(home, '.jobops');
  await mkdir(directory, { recursive: true });
  const config = defaultConfig('2026-09-19T00:00:00Z', 'UTC');
  config.data = { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' };
  config.email.setupState = 'skipped';
  config.careerOps.entrypoint = 'jobops-adapter.mjs';
  await writeFile(path.join(directory, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return path.join(directory, 'jobops.db');
}

test('dry-run reports migrations without creating a database', async () => withHome(async (home) => {
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const database = path.join(home, '.career-journal', 'career-journal.db');
  const report = await migrateHome(home, { dryRun: true });
  assert.equal(report.database, database);
  assert.deepEqual(report.pending, schemaMigrations.map((item) => item.version));
  await assert.rejects(() => stat(database), { code: 'ENOENT' });
}));

test('dry-run inspects an existing database without changing its journal mode', async () => withHome(async (home) => {
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const database = path.join(home, '.career-journal', 'career-journal.db');
  await mkdir(path.dirname(database), { recursive: true });
  const seed = new DatabaseSync(database);
  seed.exec('PRAGMA journal_mode = DELETE;');
  assert.equal(seed.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  seed.close();

  const report = await migrateHome(home, { dryRun: true });

  assert.deepEqual(report.pending, schemaMigrations.map((item) => item.version));
  const inspect = new DatabaseSync(database, { readOnly: true });
  assert.equal(inspect.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  inspect.close();
}));

test('migration apply is idempotent', async () => withHome(async (home) => {
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  assert.deepEqual((await migrateHome(home)).applied, [1, 2]);
  assert.deepEqual((await migrateHome(home)).applied, []);
}));

test('migration upgrades and preserves an alpha.5 legacy database in place', async () => withHome(async (home) => {
  const database = await createLegacyConfig(home);
  const db = openDatabase(database);
  assert.deepEqual(migrate(db, { migrations: [schemaMigrations[0]] }).applied, [1]);
  db.prepare("INSERT INTO applications (id, company, role, status, created_at, updated_at) VALUES ('legacy', 'Legacy Co', 'Role', 'lead', '2026-01-01', '2026-01-01')").run();
  db.close();

  const report = await migrateHome(home);

  assert.equal(report.database, database);
  assert.deepEqual(report.applied, [2]);
  const reopened = openDatabase(database);
  assert.equal(reopened.prepare("SELECT company FROM applications WHERE id = 'legacy'").get().company, 'Legacy Co');
  assert.ok(reopened.prepare('PRAGMA table_info(email_accounts)').all().some((column) => column.name === 'config_json'));
  reopened.close();
  await assert.rejects(() => stat(path.join(home, '.career-journal', 'career-journal.db')), { code: 'ENOENT' });
}));

test('failed migration restores the exact pre-migration database', async () => withHome(async (home) => {
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const database = path.join(home, '.career-journal', 'career-journal.db');
  const db = openDatabase(database);
  migrate(db);
  db.prepare("INSERT INTO applications (id, company, role, status, created_at, updated_at) VALUES ('keep', 'Keep Co', 'Role', 'lead', '2026-01-01', '2026-01-01')").run();
  db.close();
  const before = await readFile(database);
  const failing = [...schemaMigrations, { version: 3, name: 'fail', sql: 'CREATE TABLE transient(value TEXT); INSERT INTO missing_table VALUES (1);' }];
  await assert.rejects(() => migrateHome(home, { migrations: failing }), /missing_table/);
  assert.deepEqual(await readFile(database), before);
  const restored = openDatabase(database);
  assert.equal(restored.prepare("SELECT company FROM applications WHERE id = 'keep'").get().company, 'Keep Co');
  assert.equal(restored.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transient'").get(), undefined);
  restored.close();
}));

test('a locked migration never replaces the live database or loses another committed write', async () => withHome(async (home) => {
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  await migrateHome(home);
  const database = path.join(home, '.career-journal', 'career-journal.db');
  const writer = openDatabase(database);
  writer.exec('PRAGMA busy_timeout = 25; BEGIN IMMEDIATE');
  writer.prepare("INSERT INTO applications (id, company, role, status, created_at, updated_at) VALUES ('concurrent', 'Concurrent Co', 'Role', 'lead', '2026-01-01', '2026-01-01')").run();
  const candidates = [...schemaMigrations, { version: 3, name: 'locked', sql: 'CREATE TABLE should_not_apply(value TEXT);' }];
  await assert.rejects(() => migrateHome(home, { migrations: candidates, busyTimeoutMs: 25 }), /locked/);
  writer.exec('COMMIT');
  writer.close();
  const reopened = openDatabase(database);
  assert.equal(reopened.prepare("SELECT company FROM applications WHERE id = 'concurrent'").get().company, 'Concurrent Co');
  reopened.close();
}));
