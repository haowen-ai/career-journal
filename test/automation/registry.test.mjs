import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import {
  BUILT_IN_TASKS,
  upsertTask,
  listTasks,
  disableTask,
  removeTask,
  runTask,
  markTaskRegistration,
  clearTaskRegistration,
  isCurrentTaskClaim,
  isCurrentTaskRegistration,
  verifyTaskRegistration,
  taskEmailAccountIds,
} from '../../src/automation/registry.mjs';
import { runDeadlineReview, runDailyConsolidation } from '../../src/automation/tasks.mjs';
import { automationCommand } from '../../src/commands/automation.mjs';
import { setup } from '../../src/commands/setup.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../../src/config/defaults.mjs';
import { loadConfig } from '../../src/config/store.mjs';

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
  assert.doesNotMatch(BUILT_IN_TASKS['deadline-review'].description, /deadline/i);
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

test('mail-sync stores a normalized mailbox selection and binds registration to the full set', () => {
  const db = openDatabase(':memory:'); migrate(db);
  const first = upsertTask(db, {
    type: 'mail-sync', enabled: true, timezone: 'UTC', time: '20:00',
    accountIds: ['host:school@example.test', 'host:personal@example.test', 'host:school@example.test'],
    notificationPolicy: 'actionable',
  });
  assert.equal(first.accountId, 'host:personal@example.test');
  assert.deepEqual(taskEmailAccountIds(first), ['host:personal@example.test', 'host:school@example.test']);
  markTaskRegistration(db, first.id, { driver: 'codex', externalId: 'mail-job' });
  const registered = listTasks(db)[0];
  assert.equal(isCurrentTaskClaim(registered), true);

  const changed = upsertTask(db, {
    type: 'mail-sync', enabled: true, timezone: 'UTC', time: '20:00',
    accountIds: ['host:personal@example.test'], notificationPolicy: 'actionable',
    config: registered.config,
  });
  assert.deepEqual(taskEmailAccountIds(changed), ['host:personal@example.test']);
  assert.equal(changed.config.registration, undefined);
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

test('local-backup and deadline-review handlers run while host mail-sync requires its connector', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-auto-command-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const runtime = { root: process.cwd(), version: 'test' };
    const io = memoryIO();
    await automationCommand({ subcommand: 'configure', options: { home, task: 'local-backup', time: '23:00', enabled: true } }, io, runtime);
    await automationCommand({ subcommand: 'run', options: { home, task: 'local-backup' } }, io, runtime);
    assert.equal((await readdir(path.join(home, '.career-journal', 'backups'))).length, 1);
    await automationCommand({ subcommand: 'configure', options: { home, task: 'deadline-review', time: '20:00', enabled: true } }, io, runtime);
    await automationCommand({ subcommand: 'run', options: { home, task: 'deadline-review' } }, io, runtime);
    await automationCommand({ subcommand: 'configure', options: { home, task: 'mail-sync', time: '20:05', enabled: true } }, io, runtime);
    await assert.rejects(() => automationCommand({ subcommand: 'run', options: { home, task: 'mail-sync' } }, io, runtime), /selected job-search mailbox|host-managed/);
    const context = await import('../../src/runtime/home.mjs').then(({ openHomeDatabase }) => openHomeDatabase(home));
    const deadline = listTasks(context.db).find((item) => item.type === 'deadline-review');
    const mail = listTasks(context.db).find((item) => item.type === 'mail-sync');
    assert.ok(deadline.lastSuccessAt);
    assert.equal(deadline.error, null);
    assert.match(mail.error, /selected job-search mailbox|host-managed/);
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

test('install creates and verifies a native scheduler registration and refuses mail sync without a connector wrapper', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-auto-install-attested-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
      provisionAutomations: true,
    });
    const runtime = {
      root: process.cwd(), version: 'test', platform: 'darwin',
      scheduler: {
        install: async () => ({
          installed: true,
          kind: 'launchd',
          path: '/Users/candidate/Library/LaunchAgents/io.career-journal.deadline-review.plist',
          probe: { ok: true, detail: 'installed', evidenceDigest: `sha256:${'a'.repeat(64)}` },
        }),
      },
    };
    const io = memoryIO();
    await automationCommand({ subcommand: 'install', options: { home, task: 'deadline-review' } }, io, runtime);
    const installed = JSON.parse(io.stdout);
    assert.equal(installed.installed, true);

    const inspect = await import('../../src/runtime/home.mjs').then(({ openHomeDatabase }) => openHomeDatabase(home));
    const deadline = listTasks(inspect.db).find((task) => task.type === 'deadline-review');
    assert.equal(deadline.config.registration.status, 'verified');
    assert.equal(deadline.config.registration.externalId, 'io.career-journal.deadline-review');
    inspect.db.close();

    await automationCommand({ subcommand: 'register-external', options: {
      home, task: 'mail-sync', driver: 'launchd', 'external-id': 'mail-host-job',
    } }, memoryIO(), runtime);
    await assert.rejects(
      () => automationCommand({ subcommand: 'install', options: { home, task: 'mail-sync' } }, memoryIO(), runtime),
      /IMAPS|trusted external scheduler/i,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('external scheduler registration stores an unverified claim and binding revision', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-auto-external-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
      provisionAutomations: true,
    });
    await automationCommand({ subcommand: 'configure', options: {
      home, task: 'daily-consolidation', time: '22:00', timezone: 'UTC', enabled: true,
    } }, memoryIO(), { root: process.cwd(), version: 'test' });
    await automationCommand({ subcommand: 'configure', options: {
      home, task: 'local-backup', time: '23:00', timezone: 'UTC', enabled: true,
    } }, memoryIO(), { root: process.cwd(), version: 'test' });
    let output = '';
    for (const taskType of ['mail-sync', 'deadline-review', 'daily-consolidation', 'local-backup']) {
      const io = memoryIO();
      await automationCommand({ subcommand: 'register-external', options: {
        home, task: taskType, driver: 'codex', 'external-id': `automation-${taskType}`,
      } }, io, { root: process.cwd(), version: 'test' });
      output = io.stdout;
    }
    const task = JSON.parse(output);
    assert.equal(task.config.registration.driver, 'codex');
    assert.equal(task.config.registration.externalId, 'automation-local-backup');
    assert.equal(task.config.registration.status, 'pending-verification');
    assert.equal(task.config.registration.verified, false);
    assert.match(task.config.registration.registeredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(task.config.registration.schedule, '23:00');
    assert.equal(task.config.registration.timezone, 'UTC');
    assert.equal(task.config.registration.accountId, null);
    assert.match(task.config.registration.bindingRevision, /^[a-f0-9]{64}$/);
    assert.equal((await loadConfig(home)).automation.setupState, 'pending-registration');

    await automationCommand({ subcommand: 'update', options: {
      home, task: 'deadline-review', time: '21:00',
    } }, memoryIO(), { root: process.cwd(), version: 'test' });
    assert.equal((await loadConfig(home)).automation.setupState, 'pending-registration');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('one Codex heartbeat can register both required job-search tasks', () => {
  const db = openDatabase(':memory:'); migrate(db);
  const mail = upsertTask(db, {
    type: 'mail-sync', enabled: true, timezone: 'UTC', time: '20:00',
    accountId: 'host:candidate@example.test', notificationPolicy: 'actionable',
  });
  const deadline = upsertTask(db, {
    type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
  });
  const execution = { node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home: '/data', platform: 'darwin' };
  markTaskRegistration(db, mail.id, { driver: 'Codex', externalId: 'career-journal-daily', registeredAt: '2026-09-19T12:00:00.000Z', execution });
  markTaskRegistration(db, deadline.id, { driver: 'codex', externalId: 'career-journal-daily', registeredAt: '2026-09-19T12:01:00.000Z', execution });
  const registered = listTasks(db).filter((task) => ['mail-sync', 'deadline-review'].includes(task.type));
  assert.equal(registered.length, 2);
  for (const task of registered) {
    assert.equal(task.config.registration.externalId, 'career-journal-daily');
    assert.deepEqual(task.config.registration.sharedSchedules, [
      { taskId: 'career-journal-mail-sync', schedule: '20:00', timezone: 'UTC' },
      { taskId: 'career-journal-deadline-review', schedule: '20:15', timezone: 'UTC' },
    ]);
  }
  db.close();
});

test('shared scheduler identity remains restricted to the required Codex pair', () => {
  const db = openDatabase(':memory:'); migrate(db);
  const first = upsertTask(db, { type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable' });
  const second = upsertTask(db, { type: 'daily-consolidation', enabled: true, timezone: 'UTC', time: '22:00', notificationPolicy: 'actionable' });
  assert.throws(
    () => markTaskRegistration(db, second.id, { driver: 'cron', externalId: 'bad\nid' }),
    /unsupported characters/i,
  );
  markTaskRegistration(db, first.id, { driver: 'Codex', externalId: 'shared-id', registeredAt: '2026-09-19T12:00:00.000Z' });
  assert.throws(
    () => markTaskRegistration(db, second.id, { driver: 'codex', externalId: 'shared-id' }),
    /already registered.*deadline-review|shared.*required/i,
  );
  const cleared = clearTaskRegistration(db, first.id);
  assert.equal(cleared.config.registration, undefined);
  markTaskRegistration(db, second.id, { driver: 'codex', externalId: 'shared-id' });
  db.close();
});

test('public registration helper stores a current claim but only a verifier creates attestation', () => {
  const db = openDatabase(':memory:'); migrate(db);
  const task = upsertTask(db, {
    type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
  });
  const registered = markTaskRegistration(db, task.id, { driver: 'codex', externalId: 'deadline-host-job' });
  assert.equal(isCurrentTaskClaim(registered), true);
  assert.equal(isCurrentTaskRegistration(registered), false);
  const verified = verifyTaskRegistration(db, task.id, { method: 'trusted-host' });
  assert.equal(isCurrentTaskRegistration(verified), true);
  assert.equal(isCurrentTaskRegistration({ ...verified, schedule: '20:30' }), false);
  assert.equal(isCurrentTaskRegistration({ ...registered, config: {} }), false);
  db.close();
});

test('unchanged task setup preserves attestation while schedule timezone account and policy changes invalidate it', () => {
  const base = {
    type: 'mail-sync', enabled: true, timezone: 'UTC', time: '20:00', accountId: 'host:one@example.test', notificationPolicy: 'actionable',
  };
  for (const changed of [
    { time: '20:30' },
    { timezone: 'America/New_York' },
    { accountId: 'host:two@example.test' },
    { notificationPolicy: 'failures' },
  ]) {
    const db = openDatabase(':memory:'); migrate(db);
    const task = upsertTask(db, base);
    const registered = markTaskRegistration(db, task.id, { driver: 'codex', externalId: `automation-${Object.keys(changed)[0]}` });
    assert.equal(upsertTask(db, base).config.registration.bindingRevision, registered.config.registration.bindingRevision);
    assert.equal(upsertTask(db, { ...base, ...changed }).config.registration, undefined);
    db.close();
  }
});

test('only a successful run with the matching external id records external-run evidence', async () => {
  const db = openDatabase(':memory:'); migrate(db);
  const task = upsertTask(db, { type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable' });
  markTaskRegistration(db, task.id, { driver: 'codex', externalId: 'automation-1' });

  await runTask(db, task.id, { handler: async () => ({ cursor: 'manual', changed: 0 }) });
  assert.equal(listTasks(db)[0].config.registration.lastExternalRunAt, null);

  verifyTaskRegistration(db, task.id, { method: 'trusted-host' });

  let called = false;
  await assert.rejects(() => runTask(db, task.id, {
    externalId: 'wrong-id',
    handler: async () => { called = true; return { changed: 0 }; },
  }), /does not match/i);
  assert.equal(called, false);

  await runTask(db, task.id, { externalId: 'automation-1', handler: async () => ({ cursor: 'external', changed: 1 }) });
  const recorded = listTasks(db)[0].config.registration.lastExternalRunAt;
  assert.match(recorded, /^\d{4}-\d{2}-\d{2}T/);

  await assert.rejects(() => runTask(db, task.id, {
    externalId: 'automation-1',
    handler: async () => { throw new Error('host failed'); },
  }), /host failed/);
  assert.equal(listTasks(db)[0].config.registration.lastExternalRunAt, recorded);
  db.close();
});

test('unregister-external and uninstall clear attestation and persist pending setup state', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-auto-clear-external-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
      provisionAutomations: true,
    });
    const runtime = { root: process.cwd(), version: 'test' };
    await automationCommand({ subcommand: 'configure', options: {
      home, task: 'daily-consolidation', time: '22:00', timezone: 'UTC', enabled: true,
    } }, memoryIO(), runtime);
    await automationCommand({ subcommand: 'configure', options: {
      home, task: 'local-backup', time: '23:00', timezone: 'UTC', enabled: true,
    } }, memoryIO(), runtime);
    for (const task of ['mail-sync', 'deadline-review', 'daily-consolidation', 'local-backup']) {
      await automationCommand({ subcommand: 'register-external', options: {
        home, task, driver: 'codex', 'external-id': `automation-${task}`,
      } }, memoryIO(), runtime);
    }
    assert.equal((await loadConfig(home)).automation.setupState, 'pending-registration');

    await automationCommand({ subcommand: 'unregister-external', options: {
      home, task: 'deadline-review',
    } }, memoryIO(), runtime);
    assert.equal((await loadConfig(home)).automation.setupState, 'pending-registration');

    await automationCommand({ subcommand: 'register-external', options: {
      home, task: 'deadline-review', driver: 'codex', 'external-id': 'automation-deadline-review',
    } }, memoryIO(), runtime);
    const io = memoryIO();
    await automationCommand({ subcommand: 'uninstall', options: { home, task: 'deadline-review' } }, io, runtime);
    assert.equal(JSON.parse(io.stdout).localRegistrationCleared, true);
    assert.equal((await loadConfig(home)).automation.setupState, 'pending-registration');

    const context = await import('../../src/runtime/home.mjs').then(({ openHomeDatabase }) => openHomeDatabase(home));
    assert.equal(listTasks(context.db).find((item) => item.type === 'deadline-review').config.registration, undefined);
    context.db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('deadline review and daily consolidation use deterministic cursors and report no identical change', async () => {
  const db = openDatabase(':memory:'); migrate(db);
  const deadlineTask = { type: 'deadline-review', cursor: null };
  const firstDeadline = await runDeadlineReview(db, deadlineTask);
  assert.equal(firstDeadline.changed, 1);
  assert.match(firstDeadline.cursor, /^sha256:[a-f0-9]{64}$/);
  const unchangedDeadline = await runDeadlineReview(db, { ...deadlineTask, cursor: firstDeadline.cursor });
  assert.equal(unchangedDeadline.changed, 0);
  assert.equal(unchangedDeadline.cursor, firstDeadline.cursor);

  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-daily-hash-'));
  try {
    const dailyTask = { type: 'daily-consolidation', cursor: null };
    const firstDaily = await runDailyConsolidation(db, dailyTask, { home, now: '2026-09-19T12:00:00.000Z' });
    assert.equal(firstDaily.changed, 1);
    assert.match(firstDaily.cursor, /^sha256:[a-f0-9]{64}$/);
    const unchangedDaily = await runDailyConsolidation(db, { ...dailyTask, cursor: firstDaily.cursor }, { home, now: '2026-09-19T13:00:00.000Z' });
    assert.equal(unchangedDaily.changed, 0);
    assert.equal(unchangedDaily.cursor, firstDaily.cursor);
  } finally {
    await rm(home, { recursive: true, force: true });
    db.close();
  }
});
