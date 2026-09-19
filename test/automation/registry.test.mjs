import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import { BUILT_IN_TASKS, upsertTask, listTasks, disableTask, removeTask, runTask } from '../../src/automation/registry.mjs';
import { automationCommand } from '../../src/commands/automation.mjs';
import { setup } from '../../src/commands/setup.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  assert.equal(first.id, 'jobops-deadline-review');
  assert.equal(second.id, first.id);
  assert.equal(listTasks(db).length, 1);
  assert.equal(listTasks(db)[0].schedule, '21:30');
  assert.equal(listTasks(db)[0].timezone, 'America/Chicago');
  db.close();
});

test('disable and remove manage task lifecycle', () => {
  const db = openDatabase(':memory:'); migrate(db);
  upsertTask(db, { type: 'local-backup', enabled: true, timezone: 'UTC', time: '23:00', notificationPolicy: 'failures' });
  assert.equal(disableTask(db, 'jobops-local-backup').enabled, false);
  assert.equal(removeTask(db, 'jobops-local-backup'), true);
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
    assert.equal((await readdir(path.join(home, '.jobops', 'backups'))).length, 1);
    await automationCommand({ subcommand: 'configure', options: { home, task: 'deadline-review', time: '20:00', enabled: true } }, io, runtime);
    await assert.rejects(() => automationCommand({ subcommand: 'run', options: { home, task: 'deadline-review' } }, io, runtime), /unavailable/);
    const context = await import('../../src/runtime/home.mjs').then(({ openHomeDatabase }) => openHomeDatabase(home));
    const deadline = listTasks(context.db).find((item) => item.type === 'deadline-review');
    assert.equal(deadline.lastSuccessAt, null);
    assert.match(deadline.error, /unavailable/);
    context.db.close();
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
