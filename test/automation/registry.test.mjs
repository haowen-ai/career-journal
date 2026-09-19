import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import { BUILT_IN_TASKS, upsertTask, listTasks, disableTask, removeTask, runTask } from '../../src/automation/registry.mjs';
import { automationCommand } from '../../src/commands/automation.mjs';
import { setup } from '../../src/commands/setup.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../../src/config/defaults.mjs';

async function createLegacyHome(home) {
  const directory = path.join(home, '.jobops');
  await mkdir(directory, { recursive: true });
  const config = defaultConfig('2026-09-19T00:00:00Z', 'UTC');
  config.data = { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' };
  config.careerOps.entrypoint = 'jobops-adapter.mjs';
  await writeFile(path.join(directory, 'config.json'), `${JSON.stringify(config)}\n`);
}

test('defines four built-in tasks and requires explicit enabled state', () => {
  assert.deepEqual(Object.keys(BUILT_IN_TASKS), ['mail-sync', 'deadline-review', 'daily-consolidation', 'local-backup']);
  const db = openDatabase(':memory:'); migrate(db);
  assert.throws(() => upsertTask(db, { type: 'mail-sync', timezone: 'UTC', time: '20:00' }), /enabled must be true or false/);
  assert.throws(() => upsertTask(db, { type: 'mail-sync', enabled: true, timezone: 'Moon/Base', time: '20:00' }), /Invalid IANA timezone/);
  db.close();
});

test('repeated configuration updates one stable task', () => {
  const db = openDatabase(':memory:'); migrate(db);
  const first = upsertTask(db, { type: 'deadline-review', enabled: true, timezone: 'UTC', time: '19:00', notificationPolicy: 'actionable' });
  const second = upsertTask(db, { type: 'deadline-review', enabled: true, timezone: 'America/Chicago', time: '21:30', notificationPolicy: 'actionable' });
  assert.equal(first.id, 'career-journal-deadline-review');
  assert.equal(second.id, first.id);
  assert.equal(listTasks(db).length, 1);
  assert.equal(listTasks(db)[0].schedule, '21:30');
  assert.equal(listTasks(db)[0].timezone, 'America/Chicago');
  db.close();
});

test('reconfiguring a legacy automation updates it in place without creating a duplicate', () => {
  const db = openDatabase(':memory:'); migrate(db);
  db.prepare(`INSERT INTO automations
    (id, task_type, enabled, timezone, schedule, notification_policy, cursor, config_json)
    VALUES ('jobops-deadline-review', 'deadline-review', 1, 'UTC', '19:00', 'actionable', 'legacy-cursor', '{}')`).run();

  const updated = upsertTask(db, {
    type: 'deadline-review', enabled: true, timezone: 'America/Chicago', time: '21:30', notificationPolicy: 'failures',
  });

  assert.equal(updated.id, 'jobops-deadline-review');
  assert.equal(updated.cursor, 'legacy-cursor');
  assert.equal(updated.schedule, '21:30');
  assert.equal(listTasks(db).length, 1);
  db.close();
});

test('disable and remove manage task lifecycle', () => {
  const db = openDatabase(':memory:'); migrate(db);
  upsertTask(db, { type: 'local-backup', enabled: true, timezone: 'UTC', time: '23:00', notificationPolicy: 'failures' });
  assert.equal(disableTask(db, 'career-journal-local-backup').enabled, false);
  assert.equal(removeTask(db, 'career-journal-local-backup'), true);
  assert.equal(listTasks(db).length, 0);
  db.close();
});

test('failed runs preserve cursor while successful runs advance it', async () => {
  const db = openDatabase(':memory:'); migrate(db);
  const task = upsertTask(db, { type: 'mail-sync', enabled: true, timezone: 'UTC', time: '20:00', notificationPolicy: 'actionable', cursor: 'before' });
  await assert.rejects(() => runTask(db, task.id, { handler: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal(listTasks(db)[0].cursor, 'before');
  const result = await runTask(db, task.id, { handler: async () => ({ cursor: 'after', changed: 1 }) });
  assert.equal(result.changed, 1);
  assert.equal(listTasks(db)[0].cursor, 'after');
  db.close();
});

test('dry run does not modify attempt or success timestamps', async () => {
  const db = openDatabase(':memory:'); migrate(db);
  const task = upsertTask(db, { type: 'daily-consolidation', enabled: true, timezone: 'UTC', time: '22:00', notificationPolicy: 'failures' });
  const result = await runTask(db, task.id, { dryRun: true, handler: async () => { throw new Error('must not run'); } });
  assert.equal(result.dryRun, true);
  assert.equal(listTasks(db)[0].lastAttemptAt, null);
  db.close();
});

test('local-backup automation creates a backup while unsupported tasks never record success', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-auto-command-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const runtime = { root: process.cwd(), version: 'test' };
    const io = memoryIO();
    await automationCommand({ subcommand: 'configure', options: { home, task: 'local-backup', time: '23:00', enabled: true } }, io, runtime);
    await automationCommand({ subcommand: 'run', options: { home, task: 'local-backup' } }, io, runtime);
    assert.equal((await readdir(path.join(home, '.career-journal', 'backups'))).length, 1);
    await automationCommand({ subcommand: 'configure', options: { home, task: 'deadline-review', time: '20:00', enabled: true } }, io, runtime);
    await assert.rejects(() => automationCommand({ subcommand: 'run', options: { home, task: 'deadline-review' } }, io, runtime), /unavailable/);
    const context = await import('../../src/runtime/home.mjs').then(({ openHomeDatabase }) => openHomeDatabase(home));
    const deadline = listTasks(context.db).find((item) => item.type === 'deadline-review');
    assert.equal(deadline.lastSuccessAt, null);
    assert.match(deadline.error, /unavailable/);
    context.db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('legacy workspace automation remains runnable by task name and stores backups under .jobops', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-auto-legacy-'));
  try {
    await createLegacyHome(home);
    const context = await import('../../src/runtime/home.mjs').then(({ openHomeDatabase }) => openHomeDatabase(home));
    context.db.prepare(`INSERT INTO automations
      (id, task_type, enabled, timezone, schedule, notification_policy, config_json)
      VALUES ('jobops-local-backup', 'local-backup', 1, 'UTC', '23:00', 'actionable', '{}')`).run();
    context.db.close();

    const io = memoryIO();
    await automationCommand({ subcommand: 'configure', options: { home, task: 'local-backup', time: '22:30', enabled: true } }, io, { root: process.cwd(), version: 'test' });
    await automationCommand({ subcommand: 'run', options: { home, task: 'local-backup' } }, io, { root: process.cwd(), version: 'test' });

    const inspect = await import('../../src/runtime/home.mjs').then(({ openHomeDatabase }) => openHomeDatabase(home));
    assert.deepEqual(listTasks(inspect.db).map((task) => task.id), ['jobops-local-backup']);
    inspect.db.close();
    assert.equal((await readdir(path.join(home, '.jobops', 'backups'))).length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('uninstall reports definition removal without claiming OS scheduler removal', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-auto-uninstall-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const io = memoryIO();
    await automationCommand({ subcommand: 'uninstall', options: { home, task: 'deadline-review' } }, io, { root: process.cwd(), version: 'test' });
    const result = JSON.parse(io.stdout);
    assert.equal(result.definitionRemoved, true);
    assert.equal(result.schedulerRegistrationRemoved, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('uninstall removes both CAREER JOURNAL and legacy scheduler definition names', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-auto-uninstall-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const directory = path.join(home, '.career-journal', 'schedulers');
    await mkdir(directory, { recursive: true });
    const files = [
      'io.career-journal.deadline-review.plist',
      'io.job-search-ops.deadline-review.plist',
      'career-journal-deadline-review.cron',
      'career-journal-deadline-review.txt',
      'jobops-deadline-review.cron',
      'jobops-deadline-review.txt',
    ];
    await Promise.all(files.map((file) => writeFile(path.join(directory, file), 'fixture')));

    await automationCommand({ subcommand: 'uninstall', options: { home, task: 'deadline-review' } }, memoryIO(), { root: process.cwd(), version: 'test' });

    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
