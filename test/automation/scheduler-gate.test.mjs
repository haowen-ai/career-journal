import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { doctor } from '../../src/commands/doctor.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import {
  listTasks,
  markTaskRegistration,
  runTask,
  upsertTask,
  verifyTaskRegistration,
  automationSetupState,
} from '../../src/automation/registry.mjs';
import { syncHostBatch } from '../../src/email/host-sync.mjs';
import { codexCommandLineForTask, probeTaskRegistration } from '../../src/automation/probe.mjs';
import { installNativeScheduler } from '../../src/automation/native-scheduler.mjs';
import { automationCommand } from '../../src/commands/automation.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { renderScheduler } from '../../src/automation/platform.mjs';

function launchdPrint({
  node = '/opt/node/bin/node',
  cli = '/repo/bin/career-journal.mjs',
  home,
  taskId = 'career-journal-deadline-review',
  externalId = 'io.career-journal.deadline-review',
  timezone = 'UTC',
  hour = 20,
  minute = 15,
  extraTrigger = false,
}) {
  const lines = [
    `program = ${node}`,
    'arguments = {',
    `  ${node}`,
    `  ${cli}`,
    '  automation',
    '  run',
    '  --id',
    `  ${taskId}`,
    '  --home',
    `  ${home}`,
    '  --external-id',
    `  ${externalId}`,
    '}',
    'environment = {',
    `  TZ => ${timezone}`,
    '}',
    'event triggers = {',
    '  calendar => {',
    '    keepalive = 0',
    `    service = ${externalId}`,
    '    stream = com.apple.launchd.calendarinterval',
    '    monitor = com.apple.UserEventAgent-Aqua',
    '    descriptor = {',
    `      "Minute" => ${minute}`,
    `      "Hour" => ${hour}`,
    '    }',
    '  }',
  ];
  if (extraTrigger) {
    lines.push(
      '  extra => {',
      '    keepalive = 0',
      `    service = ${externalId}`,
      '    stream = com.apple.launchd.other-trigger',
      '    monitor = com.apple.UserEventAgent-Aqua',
      '  }',
    );
  }
  lines.push('}');
  return lines.join('\n');
}

test('a public external-id claim stays unverified and cannot be used as scheduler-run evidence', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-scheduler-claim-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
      provisionAutomations: true,
    });
    const context = await openHomeDatabase(home);
    const claimed = markTaskRegistration(context.db, 'career-journal-deadline-review', {
      driver: 'launchd', externalId: 'io.career-journal.deadline-review',
    });

    assert.equal(claimed.config.registration.status, 'pending-verification');
    assert.equal(claimed.config.registration.verified, false);
    await assert.rejects(
      () => runTask(context.db, claimed.id, {
        externalId: claimed.config.registration.externalId,
        handler: async () => ({ changed: 0, cursor: null }),
      }),
      /verified scheduler registration/i,
    );
    context.db.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('doctor rejects recorded runs when the live scheduler probe cannot find the jobs', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-scheduler-probe-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
      provisionAutomations: true,
    });
    const context = await openHomeDatabase(home);
    const now = Date.now();
    const registeredAt = new Date(now - 2 * 60 * 1000).toISOString();
    const fetchedAt = new Date(now - 60 * 1000).toISOString();
    for (const task of listTasks(context.db)) {
      markTaskRegistration(context.db, task.id, {
        driver: 'codex', externalId: `external-${task.type}`, registeredAt,
      });
      verifyTaskRegistration(context.db, task.id, {
        method: 'trusted-host', verifiedAt: registeredAt,
      });
    }
    await syncHostBatch(context.db, 'host:candidate@example.test', {
      accountId: 'host:candidate@example.test',
      connector: 'gmail',
      readOnly: true,
      beforeCursor: null,
      afterCursor: 'initial-probe',
      runId: 'initial-probe-run',
      fetchedAt,
      externalTaskId: 'external-mail-sync',
      messages: [],
    }, {}, fetchedAt);
    for (const task of listTasks(context.db).filter((item) => item.type !== 'mail-sync')) {
      const current = listTasks(context.db).find((item) => item.id === task.id);
      context.db.prepare('UPDATE automations SET last_success_at = ?, config_json = ? WHERE id = ?').run(
        fetchedAt,
        JSON.stringify({
          ...current.config,
          registration: { ...current.config.registration, lastExternalRunAt: fetchedAt },
        }),
        task.id,
      );
    }
    context.db.close();

    const report = await doctor(home, {
      now: new Date(now).toISOString(),
      nodeVersion: '24.19.0',
      storage: async () => ({ ok: true }),
      careerOps: async () => ({ ok: false, detail: 'optional' }),
      schedulerProbe: async () => ({ ok: false, detail: 'job not found' }),
    });
    assert.equal(report.checks.find((item) => item.id === 'automation').severity, 'fail');
    assert.match(report.checks.find((item) => item.id === 'automation').detail, /scheduler probe/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('native scheduler probe checks the installed command instead of trusting an external id', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-scheduler-native-probe-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' }, provisionAutomations: false });
    const context = await openHomeDatabase(home);
    const configured = upsertTask(context.db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(context.db, configured.id, {
      driver: 'launchd', externalId: 'io.career-journal.deadline-review',
      execution: { node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home },
    });
    const found = await probeTaskRegistration(claim, {
      platform: 'darwin', uid: 501, systemTimezone: 'UTC',
      definitionContent: renderScheduler(claim, {
        node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home,
      }, 'darwin').content,
      execFile: async (command, args) => {
        assert.equal(command, 'launchctl');
        assert.deepEqual(args, ['print', 'gui/501/io.career-journal.deadline-review']);
        return { stdout: launchdPrint({ home }) };
      },
    });
    assert.equal(found.ok, true);
    assert.match(found.evidenceDigest, /^sha256:[a-f0-9]{64}$/);

    const extraTriggerDefinition = renderScheduler(claim, {
      node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home,
    }, 'darwin').content.replace(
      '<key>RunAtLoad</key><false/>',
      '<key>RunAtLoad</key><false/><key>KeepAlive</key><true/>',
    );
    const extraTrigger = await probeTaskRegistration(claim, {
      platform: 'darwin', uid: 501, systemTimezone: 'UTC',
      definitionContent: extraTriggerDefinition,
      execFile: async () => ({ stdout: launchdPrint({ home }) }),
    });
    assert.equal(extraTrigger.ok, false);
    assert.match(extraTrigger.detail, /does not match/i);

    const staleLoadedSchedule = await probeTaskRegistration(claim, {
      platform: 'darwin', uid: 501, systemTimezone: 'UTC',
      definitionContent: renderScheduler(claim, {
        node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home,
      }, 'darwin').content,
      execFile: async () => ({ stdout: launchdPrint({ home, minute: 30 }) }),
    });
    assert.equal(staleLoadedSchedule.ok, false);

    const staleLoadedTimezone = await probeTaskRegistration(claim, {
      platform: 'darwin', uid: 501, systemTimezone: 'UTC',
      definitionContent: renderScheduler(claim, {
        node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home,
      }, 'darwin').content,
      execFile: async () => ({ stdout: launchdPrint({ home, timezone: 'America/Chicago' }) }),
    });
    assert.equal(staleLoadedTimezone.ok, false);

    const additionalLoadedTrigger = await probeTaskRegistration(claim, {
      platform: 'darwin', uid: 501, systemTimezone: 'UTC',
      definitionContent: renderScheduler(claim, {
        node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home,
      }, 'darwin').content,
      execFile: async () => ({ stdout: launchdPrint({ home, extraTrigger: true }) }),
    });
    assert.equal(additionalLoadedTrigger.ok, false);

    const mismatched = await probeTaskRegistration(claim, {
      platform: 'darwin', uid: 501, systemTimezone: 'UTC',
      definitionContent: renderScheduler(claim, {
        node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home,
      }, 'darwin').content,
      execFile: async () => ({ stdout: 'unrelated command' }),
    });
    assert.equal(mismatched.ok, false);
    assert.match(mismatched.detail, /does not match/i);
    context.db.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Codex scheduler probe requires an ACTIVE heartbeat with matching command schedule and timezone', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-codex-probe-'));
  const codexHome = path.join(home, 'codex-home');
  try {
    await setup(home, { timezone: 'America/Chicago', email: { mode: 'skip' }, provisionAutomations: false });
    const context = await openHomeDatabase(home);
    const configured = upsertTask(context.db, {
      type: 'deadline-review', enabled: true, timezone: 'America/Chicago', time: '20:15', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(context.db, configured.id, {
      driver: 'codex', externalId: 'automation-deadline-review',
      execution: {
        node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home, platform: 'darwin',
      },
    });
    const exactCommand = codexCommandLineForTask(claim);
    const directory = path.join(codexHome, 'automations', 'automation-deadline-review');
    const fs = await import('node:fs/promises');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'automation.toml'), [
        'version = 1',
        'id = "automation-deadline-review"',
        'kind = "heartbeat"',
        'name = "CAREER JOURNAL deadline review"',
        `prompt = ${JSON.stringify(`Run this exact command in America/Chicago:\n${exactCommand}`)}`,
        'status = "ACTIVE"',
        'rrule = "FREQ=DAILY;BYHOUR=20;BYMINUTE=15;BYSECOND=0"',
        'target_thread_id = "01a0a64b-06b5-79a1-97fd-1cb60a1f21c7"',
      ].join('\n'));

    const verified = await probeTaskRegistration(claim, { codexHome });
    assert.equal(verified.ok, true);
    assert.match(verified.evidenceDigest, /^sha256:[a-f0-9]{64}$/);

    await fs.writeFile(path.join(directory, 'automation.toml'), [
      'id = "automation-deadline-review"',
      'kind = "heartbeat"',
      `prompt = ${JSON.stringify(`Run this exact command in America/Chicago:\n${exactCommand}`)}`,
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY;BYHOUR=20;BYMINUTE=15;BYSECOND=0"',
    ].join('\n'));
    const missingRequiredMetadata = await probeTaskRegistration(claim, { codexHome });
    assert.equal(missingRequiredMetadata.ok, false);
    assert.match(missingRequiredMetadata.detail, /version|target.thread/i);

    await fs.writeFile(path.join(directory, 'automation.toml'), [
      'version = 1',
      'id = "automation-deadline-review"',
      'kind = "cron"',
      `prompt = ${JSON.stringify(`Run this exact command in America/Chicago:\n${exactCommand}`)}`,
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY;BYHOUR=20;BYMINUTE=15;BYSECOND=0"',
      'target_thread_id = "01a0a64b-06b5-79a1-97fd-1cb60a1f21c7"',
    ].join('\n'));
    const unsupportedCron = await probeTaskRegistration(claim, { codexHome });
    assert.equal(unsupportedCron.ok, false);
    assert.match(unsupportedCron.detail, /heartbeat/i);

    await fs.writeFile(path.join(directory, 'automation.toml'), [
      'version = 1',
      'id = "automation-deadline-review"',
      'kind = "heartbeat"',
      `prompt = ${JSON.stringify('Run /usr/bin/echo career-journal automation run --id career-journal-deadline-review --external-id automation-deadline-review in America/Chicago')}`,
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY;BYHOUR=20;BYMINUTE=15;BYSECOND=0"',
      'target_thread_id = "01a0a64b-06b5-79a1-97fd-1cb60a1f21c7"',
    ].join('\n'));
    const echoWrapper = await probeTaskRegistration(claim, { codexHome });
    assert.equal(echoWrapper.ok, false);
    assert.match(echoWrapper.detail, /exact registered CAREER JOURNAL command/i);

    await fs.writeFile(path.join(directory, 'automation.toml'), [
      'version = 1',
      'id = "automation-deadline-review"',
      'kind = "heartbeat"',
      'prompt = "unrelated"',
      'status = "PAUSED"',
      'rrule = "FREQ=DAILY;BYHOUR=20;BYMINUTE=15;BYSECOND=0"',
      'target_thread_id = "01a0a64b-06b5-79a1-97fd-1cb60a1f21c7"',
    ].join('\n'));
    const inactive = await probeTaskRegistration(claim, { codexHome });
    assert.equal(inactive.ok, false);
    assert.match(inactive.detail, /ACTIVE/i);

    await fs.writeFile(path.join(directory, 'automation.toml'), [
      'version = 1',
      'id = "automation-deadline-review"',
      'kind = "heartbeat"',
      `prompt = ${JSON.stringify(`Run this exact command in America/Chicago:\n${exactCommand}`)}`,
      'status = "ACTIVE"',
      'this is not valid TOML',
      'status = "PAUSED"',
      'rrule = "FREQ=DAILY;BYHOUR=20;BYMINUTE=15;BYSECOND=0"',
      'target_thread_id = "01a0a64b-06b5-79a1-97fd-1cb60a1f21c7"',
    ].join('\n'));
    const malformed = await probeTaskRegistration(claim, { codexHome });
    assert.equal(malformed.ok, false);
    assert.match(malformed.detail, /TOML|malformed|duplicate/i);
    context.db.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Codex scheduler probe requires an exact indefinite daily recurrence', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-codex-rrule-'));
  const codexHome = path.join(home, 'codex-home');
  try {
    await setup(home, { timezone: 'America/Chicago', email: { mode: 'skip' }, provisionAutomations: false });
    const context = await openHomeDatabase(home);
    const configured = upsertTask(context.db, {
      type: 'deadline-review', enabled: true, timezone: 'America/Chicago', time: '20:00', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(context.db, configured.id, {
      driver: 'codex', externalId: 'automation-exact-daily',
      execution: {
        node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home, platform: 'darwin',
      },
    });
    const exactCommand = codexCommandLineForTask(claim);
    const directory = path.join(codexHome, 'automations', 'automation-exact-daily');
    const fs = await import('node:fs/promises');
    await fs.mkdir(directory, { recursive: true });
    const writeAutomation = (rrule) => fs.writeFile(path.join(directory, 'automation.toml'), [
      'version = 1',
      'id = "automation-exact-daily"',
      'kind = "heartbeat"',
      `prompt = ${JSON.stringify(`Run this exact command in America/Chicago:\n${exactCommand}`)}`,
      'status = "ACTIVE"',
      `rrule = ${JSON.stringify(rrule)}`,
      'target_thread_id = "01a0a64b-06b5-79a1-97fd-1cb60a1f21c7"',
    ].join('\n'));

    for (const rrule of [
      'FREQ=DAILY;BYHOUR=20;BYMINUTE=0;BYSECOND=0',
      'FREQ=DAILY;INTERVAL=1;BYHOUR=20;BYMINUTE=0',
    ]) {
      await writeAutomation(rrule);
      const verified = await probeTaskRegistration(claim, { codexHome });
      assert.equal(verified.ok, true, `${rrule} should be accepted`);
    }

    for (const rrule of [
      'FREQ=DAILY;INTERVAL=2;BYHOUR=20,22;BYMINUTE=0;COUNT=1',
      'FREQ=DAILY;BYHOUR=20,22;BYMINUTE=0',
      'FREQ=DAILY;BYHOUR=20;BYMINUTE=0,15',
      'FREQ=DAILY;BYHOUR=20;BYMINUTE=0;UNTIL=20261231T235959Z',
      'FREQ=DAILY;BYHOUR=20;BYMINUTE=0;BYSECOND=1',
      'FREQ=DAILY;BYHOUR=20;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR',
      'FREQ=DAILY;BYHOUR=20;BYHOUR=20;BYMINUTE=0',
    ]) {
      await writeAutomation(rrule);
      const rejected = await probeTaskRegistration(claim, { codexHome });
      assert.equal(rejected.ok, false, `${rrule} should be rejected`);
      assert.match(rejected.detail, /schedule does not match/i);
    }
    context.db.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('cron and Windows probes require the bound task command in the scheduler output', async () => {
  const db = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const value = openDatabase(':memory:');
    migrate(value);
    return value;
  });
  try {
    const configured = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const cronClaim = markTaskRegistration(db, configured.id, {
      driver: 'cron', externalId: 'career-journal-deadline-review',
      execution: { node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home: '/data' },
    });
    const cron = await probeTaskRegistration(cronClaim, {
      platform: 'linux',
      execFile: async () => ({ stdout: [
        '# BEGIN CAREER JOURNAL career-journal-deadline-review',
        'CRON_TZ=UTC',
        "15 20 * * * '/opt/node/bin/node' '/repo/bin/career-journal.mjs' 'automation' 'run' '--id' 'career-journal-deadline-review' '--home' '/data' '--external-id' 'career-journal-deadline-review'",
        '# END CAREER JOURNAL career-journal-deadline-review',
      ].join('\n') }),
    });
    assert.equal(cron.ok, true);
    const commented = await probeTaskRegistration(cronClaim, {
      platform: 'linux',
      execFile: async () => ({ stdout: "# 15 20 * * * career-journal automation run --id career-journal-deadline-review --external-id career-journal-deadline-review" }),
    });
    assert.equal(commented.ok, false);
    const noOpWrapper = await probeTaskRegistration(cronClaim, {
      platform: 'linux',
      execFile: async () => ({ stdout: [
        '# BEGIN CAREER JOURNAL career-journal-deadline-review',
        'CRON_TZ=UTC',
        '15 20 * * * /usr/bin/echo automation run --id wrong --external-id wrong career-journal-deadline-review career-journal-deadline-review',
        '# END CAREER JOURNAL career-journal-deadline-review',
      ].join('\n') }),
    });
    assert.equal(noOpWrapper.ok, false);
    const wrongTime = await probeTaskRegistration(cronClaim, {
      platform: 'linux',
      execFile: async () => ({ stdout: [
        '# BEGIN CAREER JOURNAL career-journal-deadline-review',
        'CRON_TZ=UTC',
        "16 20 * * * '/opt/node/bin/node' '/repo/bin/career-journal.mjs' 'automation' 'run' '--id' 'career-journal-deadline-review' '--home' '/data' '--external-id' 'career-journal-deadline-review'",
        '# END CAREER JOURNAL career-journal-deadline-review',
      ].join('\n') }),
    });
    assert.equal(wrongTime.ok, false);
    const overriddenTimezone = await probeTaskRegistration(cronClaim, {
      platform: 'linux',
      execFile: async () => ({ stdout: [
        '# BEGIN CAREER JOURNAL career-journal-deadline-review',
        'CRON_TZ=UTC',
        'CRON_TZ=America/New_York',
        "15 20 * * * '/opt/node/bin/node' '/repo/bin/career-journal.mjs' 'automation' 'run' '--id' 'career-journal-deadline-review' '--home' '/data' '--external-id' 'career-journal-deadline-review'",
        '# END CAREER JOURNAL career-journal-deadline-review',
      ].join('\n') }),
    });
    assert.equal(overriddenTimezone.ok, false);

    const windowsClaim = markTaskRegistration(db, configured.id, {
      driver: 'schtasks', externalId: 'CareerJournal-deadline-review',
      execution: {
        node: 'C:\\Program Files\\node.exe',
        cli: 'C:\\Career Journal\\bin\\career-journal.mjs',
        home: 'C:\\Career Journal',
      },
    });
    const windows = await probeTaskRegistration(windowsClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T20:15:00Z',
      execFile: async (command, args) => {
        assert.equal(command, 'schtasks.exe');
        assert.deepEqual(args, ['/Query', '/TN', 'CareerJournal-deadline-review', '/XML']);
        return { stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-19T20:15:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' };
      },
    });
    assert.equal(windows.ok, true);

    const rootExecution = {
      node: 'C:\\Program Files\\node.exe',
      cli: 'C:\\Career Journal\\bin\\career-journal.mjs',
      home: 'C:\\',
    };
    const rootClaim = markTaskRegistration(db, configured.id, {
      driver: 'schtasks', externalId: 'CareerJournal-deadline-review', execution: rootExecution,
    });
    const canonicalRoot = await probeTaskRegistration(rootClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T20:15:00Z',
      execFile: async () => ({ stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-19T20:15:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\\\" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' }),
    });
    assert.equal(canonicalRoot.ok, true);
    const brokenRoot = await probeTaskRegistration(rootClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T20:15:00Z',
      execFile: async () => ({ stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-19T20:15:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' }),
    });
    assert.equal(brokenRoot.ok, false);

    const localBoundaryWithoutSeconds = await probeTaskRegistration(windowsClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T20:15:00Z',
      execFile: async () => ({ stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-19T20:15</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' }),
    });
    assert.equal(localBoundaryWithoutSeconds.ok, true);

    const utcBoundary = await probeTaskRegistration(windowsClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T20:15:00Z',
      execFile: async () => ({ stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-19T20:15:00Z</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' }),
    });
    assert.equal(utcBoundary.ok, false);

    const futureStart = await probeTaskRegistration(windowsClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T20:15:00Z',
      execFile: async () => ({ stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2099-09-19T20:15:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' }),
    });
    assert.equal(futureStart.ok, false);

    const sameDayFirstRun = await probeTaskRegistration(windowsClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T10:00:00Z',
      execFile: async () => ({ stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-19T20:15:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' }),
    });
    assert.equal(sameDayFirstRun.ok, true);

    const nextDayFirstRun = await probeTaskRegistration(windowsClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T22:00:00Z',
      execFile: async () => ({ stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-20T20:15:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' }),
    });
    assert.equal(nextDayFirstRun.ok, true);

    const beyondDailyWindow = await probeTaskRegistration(windowsClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T10:00:00Z',
      execFile: async () => ({ stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-20T20:15:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' }),
    });
    assert.equal(beyondDailyWindow.ok, false);

    const randomizedStart = await probeTaskRegistration(windowsClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T20:15:00Z',
      execFile: async () => ({ stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-19T20:15:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay><RandomDelay>PT12H</RandomDelay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' }),
    });
    assert.equal(randomizedStart.ok, false);
    const unknownTriggerSemantics = await probeTaskRegistration(windowsClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T20:15:00Z',
      execFile: async () => ({ stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-19T20:15:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay><Delay>PT1H</Delay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' }),
    });
    assert.equal(unknownTriggerSemantics.ok, false);

    const multipleActionsAndEndedTrigger = await probeTaskRegistration(windowsClaim, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-19T20:15:00Z',
      execFile: async () => ({ stdout: [
        '<Task><Triggers><CalendarTrigger>',
        '<StartBoundary>2026-09-19T20:15:00</StartBoundary>',
        '<EndBoundary>2026-09-20T20:15:00</EndBoundary>',
        '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
        '</CalendarTrigger></Triggers><Actions>',
        '<Exec><Command>C:\\Program Files\\node.exe</Command>',
        '<Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec>',
        '<Exec><Command>C:\\malware.exe</Command><Arguments>--persist</Arguments></Exec>',
        '</Actions></Task>',
      ].join('') }),
    });
    assert.equal(multipleActionsAndEndedTrigger.ok, false);
  } finally {
    db.close();
  }
});

test('native install loads and probes launchd before returning verified evidence', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-scheduler-native-install-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' }, provisionAutomations: false });
    const context = await openHomeDatabase(home);
    const configured = upsertTask(context.db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(context.db, configured.id, {
      driver: 'launchd', externalId: 'io.career-journal.deadline-review',
      execution: { node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home },
    });
    const files = new Map();
    const calls = [];
    const result = await installNativeScheduler(claim, {
      node: '/opt/node/bin/node',
      cli: '/repo/bin/career-journal.mjs',
      home,
    }, {
      platform: 'darwin', uid: 501, osHome: '/Users/candidate', systemTimezone: 'UTC',
      fs: {
        mkdir: async () => {},
        readFile: async (file) => {
          if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return files.get(file);
        },
        writeFile: async (file, content) => { files.set(file, content); },
        rm: async (file) => { files.delete(file); },
      },
      execFile: async (command, args) => {
        calls.push([command, args]);
        if (args[0] === 'print') {
          return { stdout: launchdPrint({ home }) };
        }
        if (args[0] === 'bootout') throw new Error('not loaded');
        return { stdout: '' };
      },
    });
    assert.equal(result.installed, true);
    assert.equal(result.probe.ok, true);
    assert.equal(files.has('/Users/candidate/Library/LaunchAgents/io.career-journal.deadline-review.plist'), true);
    assert.equal(calls.some(([, args]) => args[0] === 'bootstrap'), true);
    assert.equal(calls.some(([, args]) => args[0] === 'print'), true);
    context.db.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('failed launchd replacement restores and reloads the previous definition', async () => {
  const db = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const value = openDatabase(':memory:'); migrate(value); return value;
  });
  try {
    const configured = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(db, configured.id, {
      driver: 'launchd', externalId: 'io.career-journal.deadline-review',
    });
    const destination = '/Users/candidate/Library/LaunchAgents/io.career-journal.deadline-review.plist';
    const files = new Map([[destination, 'previous definition']]);
    let bootstrapCalls = 0;
    await assert.rejects(() => installNativeScheduler(claim, {
      node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home: '/data',
    }, {
      platform: 'darwin', uid: 501, osHome: '/Users/candidate',
      fs: {
        mkdir: async () => {},
        readFile: async (file) => files.get(file),
        writeFile: async (file, content) => { files.set(file, content); },
        rm: async (file) => { files.delete(file); },
      },
      execFile: async (_command, args) => {
        if (args[0] === 'bootstrap') {
          bootstrapCalls += 1;
          if (bootstrapCalls === 1) throw new Error('new definition rejected');
        }
        return { stdout: '' };
      },
    }), /installation failed/i);
    assert.equal(files.get(destination), 'previous definition');
    assert.equal(bootstrapCalls, 2);
  } finally { db.close(); }
});

test('failed launchd rollback is surfaced instead of being silently ignored', async () => {
  const db = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const value = openDatabase(':memory:'); migrate(value); return value;
  });
  try {
    const configured = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(db, configured.id, {
      driver: 'launchd', externalId: 'io.career-journal.deadline-review',
    });
    const destination = '/Users/candidate/Library/LaunchAgents/io.career-journal.deadline-review.plist';
    const files = new Map([[destination, 'previous definition']]);
    await assert.rejects(() => installNativeScheduler(claim, {
      node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home: '/data',
    }, {
      platform: 'darwin', uid: 501, osHome: '/Users/candidate',
      fs: {
        mkdir: async () => {}, readFile: async (file) => files.get(file),
        writeFile: async (file, content) => { files.set(file, content); },
        rm: async (file) => { files.delete(file); },
      },
      execFile: async (_command, args) => {
        if (args[0] === 'bootstrap') throw new Error(args[2]?.includes('LaunchAgents') ? 'bootstrap rejected' : 'unexpected');
        return { stdout: '' };
      },
    }), /rollback failed.*bootstrap rejected/i);
    assert.equal(files.get(destination), 'previous definition');
  } finally { db.close(); }
});

test('Windows install never overwrites an existing mismatched task', async () => {
  const db = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const value = openDatabase(':memory:'); migrate(value); return value;
  });
  try {
    const configured = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(db, configured.id, {
      driver: 'schtasks', externalId: 'CareerJournal-deadline-review',
    });
    const calls = [];
    await assert.rejects(() => installNativeScheduler(claim, {
      node: 'C:\\Program Files\\node.exe', cli: 'C:\\Career Journal\\bin\\career-journal.mjs', home: 'C:\\Career Journal',
    }, {
      platform: 'win32',
      fs: {
        mkdir: async () => {}, readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
        writeFile: async () => {}, rm: async () => {},
      },
      execFile: async (_command, args) => {
        calls.push(args);
        if (args[0] === '/Query') return { stdout: '<Command>unrelated.exe</Command>' };
        return { stdout: '' };
      },
    }), /already exists.*does not match/i);
    assert.equal(calls.some((args) => args[0] === '/Create'), false);
    assert.equal(calls.some((args) => args[0] === '/Delete'), false);
  } finally { db.close(); }
});

test('Windows install fails closed when the existing-task query is ambiguous', async () => {
  const db = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const value = openDatabase(':memory:'); migrate(value); return value;
  });
  try {
    const execution = {
      node: 'C:\\Program Files\\node.exe', cli: 'C:\\Career Journal\\bin\\career-journal.mjs',
      home: 'C:\\Career Journal', platform: 'win32',
    };
    const configured = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(db, configured.id, {
      driver: 'schtasks', externalId: 'CareerJournal-deadline-review', execution,
    });
    const calls = [];
    await assert.rejects(() => installNativeScheduler(claim, execution, {
      platform: 'win32',
      fs: {
        mkdir: async () => {}, writeFile: async () => {}, rm: async () => {},
        readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      },
      execFile: async (_command, args) => {
        calls.push(args);
        throw new Error('ERROR: Access is denied.');
      },
    }), /cannot safely determine|query.*failed|access is denied/i);
    assert.equal(calls.some((args) => args[0] === '/Create'), false);
    assert.equal(calls.some((args) => args[0] === '/Delete'), false);
  } finally { db.close(); }
});

test('Windows install proceeds only after a clear task-not-found query', async () => {
  const db = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const value = openDatabase(':memory:'); migrate(value); return value;
  });
  try {
    const execution = {
      node: 'C:\\Program Files\\node.exe', cli: 'C:\\Career Journal\\bin\\career-journal.mjs',
      home: 'C:\\Career Journal', platform: 'win32',
    };
    const configured = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(db, configured.id, {
      driver: 'schtasks', externalId: 'CareerJournal-deadline-review', execution,
    });
    let queries = 0;
    const calls = [];
    const result = await installNativeScheduler(claim, execution, {
      platform: 'win32', systemTimezone: 'UTC', now: '2026-09-20T00:00:00Z',
      fs: {
        mkdir: async () => {}, writeFile: async () => {}, rm: async () => {},
        readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      },
      execFile: async (_command, args) => {
        calls.push(args);
        if (args[0] === '/Query') {
          queries += 1;
          if (queries === 1) throw new Error('ERROR: The system cannot find the file specified.');
          return { stdout: '<Task><Triggers><CalendarTrigger><StartBoundary>2026-09-19T20:15:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\node.exe</Command><Arguments>"C:\\Career Journal\\bin\\career-journal.mjs" automation run --id career-journal-deadline-review --home "C:\\Career Journal" --external-id CareerJournal-deadline-review</Arguments></Exec></Actions></Task>' };
        }
        return { stdout: '' };
      },
    });
    assert.equal(result.installed, true);
    assert.equal(calls.some((args) => args[0] === '/Create'), true);
    assert.equal(calls.find((args) => args[0] === '/Create').includes('/F'), false);
    assert.equal(calls.some((args) => args[0] === '/Delete'), false);
  } finally { db.close(); }
});

test('Windows install does not delete a task that appears before create', async () => {
  const db = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const value = openDatabase(':memory:'); migrate(value); return value;
  });
  try {
    const execution = {
      node: 'C:\\Program Files\\node.exe', cli: 'C:\\Career Journal\\bin\\career-journal.mjs',
      home: 'C:\\Career Journal', platform: 'win32',
    };
    const configured = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(db, configured.id, {
      driver: 'schtasks', externalId: 'CareerJournal-deadline-review', execution,
    });
    const calls = [];
    await assert.rejects(() => installNativeScheduler(claim, execution, {
      platform: 'win32',
      fs: {
        mkdir: async () => {}, writeFile: async () => {}, rm: async () => {},
        readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      },
      execFile: async (_command, args) => {
        calls.push(args);
        if (args[0] === '/Query') throw new Error('ERROR: The system cannot find the file specified.');
        if (args[0] === '/Create') throw new Error('ERROR: The task already exists.');
        return { stdout: '' };
      },
    }), /task already exists/i);
    assert.equal(calls.some((args) => args[0] === '/Create'), true);
    assert.equal(calls.some((args) => args[0] === '/Delete'), false);
  } finally { db.close(); }
});

test('Windows install surfaces a failed cleanup after create or verification failure', async () => {
  const db = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const value = openDatabase(':memory:'); migrate(value); return value;
  });
  try {
    const execution = {
      node: 'C:\\Program Files\\node.exe', cli: 'C:\\Career Journal\\bin\\career-journal.mjs',
      home: 'C:\\Career Journal', platform: 'win32',
    };
    const configured = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const claim = markTaskRegistration(db, configured.id, {
      driver: 'schtasks', externalId: 'CareerJournal-deadline-review', execution,
    });
    let queries = 0;
    await assert.rejects(() => installNativeScheduler(claim, execution, {
      platform: 'win32',
      fs: {
        mkdir: async () => {}, writeFile: async () => {}, rm: async () => {},
        readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      },
      execFile: async (_command, args) => {
        if (args[0] === '/Query') {
          queries += 1;
          if (queries === 1) throw new Error('ERROR: The system cannot find the file specified.');
          return { stdout: '<Task><Actions><Exec><Command>wrong.exe</Command></Exec></Actions></Task>' };
        }
        if (args[0] === '/Delete') throw new Error('ERROR: Access is denied during cleanup.');
        return { stdout: '' };
      },
    }), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.message, /rollback failed.*access is denied during cleanup/i);
      return true;
    });
  } finally { db.close(); }
});

test('cron install fails closed on malformed owned markers without replacing the crontab', async () => {
  const db = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const value = openDatabase(':memory:'); migrate(value); return value;
  });
  try {
    const configured = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const execution = { node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home: '/data' };
    const claim = markTaskRegistration(db, configured.id, {
      driver: 'cron', externalId: 'career-journal-deadline-review', execution,
    });
    const calls = [];
    const malformed = [
      '0 1 * * * /usr/bin/unrelated',
      '# BEGIN CAREER JOURNAL career-journal-deadline-review',
      '5 2 * * * /usr/bin/old-career-journal',
      '30 3 * * * /usr/bin/must-survive',
    ].join('\n');
    await assert.rejects(() => installNativeScheduler(claim, execution, {
      platform: 'linux',
      fs: { mkdir: async () => {}, writeFile: async () => {}, rm: async () => {}, readFile: async () => '' },
      execFile: async (_command, args) => {
        calls.push(args);
        if (args[0] === '-l') return { stdout: malformed };
        throw new Error('crontab must not be replaced');
      },
    }), /malformed or duplicate.*marker/i);
    assert.deepEqual(calls, [['-l']]);
  } finally { db.close(); }
});

test('cron rollback failure is surfaced instead of being silently ignored', async () => {
  const db = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const value = openDatabase(':memory:'); migrate(value); return value;
  });
  try {
    const configured = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'UTC', time: '20:15', notificationPolicy: 'actionable',
    });
    const execution = { node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home: '/data' };
    const claim = markTaskRegistration(db, configured.id, {
      driver: 'cron', externalId: 'career-journal-deadline-review', execution,
    });
    await assert.rejects(() => installNativeScheduler(claim, execution, {
      platform: 'linux',
      fs: { mkdir: async () => {}, writeFile: async () => {}, rm: async () => {}, readFile: async () => '' },
      execFile: async (_command, args) => {
        if (args[0] === '-l') return { stdout: '0 1 * * * /usr/bin/unrelated\n' };
        if (String(args[0]).endsWith('.active-crontab')) throw new Error('new crontab rejected');
        if (String(args[0]).endsWith('.rollback-crontab')) throw new Error('rollback crontab rejected');
        return { stdout: '' };
      },
    }), /rollback failed.*rollback crontab rejected/i);
  } finally { db.close(); }
});

test('automation install creates a native claim and verifies it only after install probe success', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-scheduler-command-install-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
      provisionAutomations: true,
    });
    const io = memoryIO();
    await automationCommand({ subcommand: 'install', options: { home, task: 'deadline-review' } }, io, {
      root: '/repo', version: 'test', platform: 'darwin',
      scheduler: {
        install: async (task) => ({
          installed: true,
          kind: 'launchd',
          path: '/Users/candidate/Library/LaunchAgents/io.career-journal.deadline-review.plist',
          probe: {
            ok: true,
            detail: `launchd job ${task.config.registration.externalId} is installed`,
            evidenceDigest: `sha256:${'a'.repeat(64)}`,
          },
        }),
      },
    });
    const installed = JSON.parse(io.stdout);
    assert.equal(installed.installed, true);

    const context = await openHomeDatabase(home);
    const task = listTasks(context.db).find((item) => item.type === 'deadline-review');
    assert.equal(task.config.registration.driver, 'launchd');
    assert.equal(task.config.registration.externalId, 'io.career-journal.deadline-review');
    assert.equal(task.config.registration.status, 'verified');
    assert.equal(task.config.registration.verified, true);
    assert.equal(task.config.registration.verifier.method, 'native-probe');
    assert.equal(task.config.registration.lastExternalRunAt, null);
    context.db.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('failed native install restores the previous verified scheduler binding', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-install-state-rollback-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
      provisionAutomations: true,
    });
    const registerIo = memoryIO();
    await automationCommand({ subcommand: 'register-external', options: {
      home, task: 'deadline-review', driver: 'codex', 'external-id': 'automation-deadline-review',
    } }, registerIo, { root: '/repo', version: 'test' });
    const registrationOutput = JSON.parse(registerIo.stdout);
    assert.equal(registrationOutput.codexCommandLine, codexCommandLineForTask(registrationOutput));
    await automationCommand({ subcommand: 'verify', options: { home, task: 'deadline-review' } }, memoryIO(), {
      root: '/repo', version: 'test',
      scheduler: { probe: async () => ({ ok: true, detail: 'trusted', evidenceDigest: `sha256:${'c'.repeat(64)}` }) },
    });

    await assert.rejects(() => automationCommand({ subcommand: 'install', options: {
      home, task: 'deadline-review',
    } }, memoryIO(), {
      root: '/repo', version: 'test', platform: 'darwin',
      scheduler: { install: async () => { throw new Error('OS scheduler unavailable'); } },
    }), /OS scheduler unavailable/);

    const context = await openHomeDatabase(home);
    const task = listTasks(context.db).find((item) => item.type === 'deadline-review');
    assert.equal(task.config.registration.driver, 'codex');
    assert.equal(task.config.registration.externalId, 'automation-deadline-review');
    assert.equal(task.config.registration.verified, true);
    context.db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('automation setup stays pending until every verified scheduler has one matching run', async () => {
  const context = await import('../../src/storage/database.mjs').then(({ openDatabase, migrate }) => {
    const db = openDatabase(':memory:');
    migrate(db);
    return db;
  });
  try {
    const schedule = {
      'mail-sync': '20:00',
      'deadline-review': '20:15',
      'daily-consolidation': '22:00',
      'local-backup': '23:00',
    };
    for (const [type, time] of Object.entries(schedule)) {
      const task = upsertTask(context, {
        type, enabled: true, timezone: 'UTC', time,
        accountId: type === 'mail-sync' ? 'host:candidate@example.test' : null,
        notificationPolicy: 'actionable',
      });
      markTaskRegistration(context, task.id, { driver: 'codex', externalId: `host-${type}` });
      verifyTaskRegistration(context, task.id, { method: 'trusted-host' });
    }
    assert.equal(automationSetupState(listTasks(context)), 'pending-registration');
    for (const task of listTasks(context)) {
      await runTask(context, task.id, {
        externalId: task.config.registration.externalId,
        handler: async () => ({ changed: 0, cursor: task.cursor }),
      });
    }
    assert.equal(automationSetupState(listTasks(context)), 'registered');
  } finally {
    context.close();
  }
});

test('automation verify promotes a real Codex heartbeat claim without trusting register-external alone', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-codex-command-'));
  const codexHome = path.join(home, 'codex-home');
  try {
    await setup(home, {
      timezone: 'America/Chicago',
      email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
      provisionAutomations: true,
    });
    await automationCommand({ subcommand: 'register-external', options: {
      home, task: 'deadline-review', driver: 'codex', 'external-id': 'automation-deadline-review',
    } }, memoryIO(), { root: '/repo', version: 'test' });
    let context = await openHomeDatabase(home);
    const claimed = listTasks(context.db).find((task) => task.type === 'deadline-review');
    assert.equal(claimed.config.registration.verified, false);
    const exactCommand = codexCommandLineForTask(claimed);
    assert.ok(exactCommand);
    context.db.close();

    const directory = path.join(codexHome, 'automations', 'automation-deadline-review');
    const fs = await import('node:fs/promises');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'automation.toml'), [
      'version = 1',
      'id = "automation-deadline-review"',
      'kind = "heartbeat"',
      `prompt = ${JSON.stringify(`Run this exact command in America/Chicago:\n${exactCommand}`)}`,
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY;BYHOUR=20;BYMINUTE=15;BYSECOND=0"',
      'target_thread_id = "01a0a64b-06b5-79a1-97fd-1cb60a1f21c7"',
    ].join('\n'));

    await automationCommand({ subcommand: 'verify', options: { home, task: 'deadline-review' } }, memoryIO(), {
      root: '/repo', version: 'test', codexHome,
    });
    context = await openHomeDatabase(home);
    const verified = listTasks(context.db).find((task) => task.type === 'deadline-review');
    assert.equal(verified.config.registration.verified, true);
    assert.equal(verified.config.registration.verifier.method, 'trusted-host');
    assert.equal(verified.config.registration.lastExternalRunAt, null);
    context.db.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('native mail-sync install is refused until a secure scheduler credential provider exists', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-imap-scheduler-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: {
        mode: 'configure', provider: 'imap', address: 'student@school.edu', secretRef: 'env:IMAP_PASSWORD',
        settings: { host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX' },
      },
      provisionAutomations: true,
    });
    const runtime = {
      root: '/repo', version: 'test', platform: 'darwin',
      scheduler: {
        install: async () => ({
          installed: true,
          kind: 'launchd',
          path: '/Users/candidate/Library/LaunchAgents/io.career-journal.mail-sync.plist',
          probe: { ok: true, detail: 'installed', evidenceDigest: `sha256:${'b'.repeat(64)}` },
        }),
      },
    };
    await assert.rejects(
      () => automationCommand({ subcommand: 'install', options: { home, task: 'mail-sync' } }, memoryIO(), runtime),
      /secure scheduler credential provider/i,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
