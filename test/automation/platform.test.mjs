import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSchedulerRegistration, renderScheduler } from '../../src/automation/platform.mjs';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import { markTaskRegistration, upsertTask } from '../../src/automation/registry.mjs';
import { parseWindowsCommandLine, quoteWindowsArgument } from '../../src/automation/windows-argv.mjs';

const runtime = { node: '/opt/node/bin/node', cli: '/Users/example/Career Journal/bin/career-journal.mjs', home: '/Users/example/Career Journal' };

function commandLineToArgvWQuote(value) {
  if (value && !/[\t "]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of String(value)) {
    if (character === '\\') {
      backslashes += 1;
    } else if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      quoted += '\\'.repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

function configuredTask(platform, legacy = false) {
  const db = openDatabase(':memory:');
  migrate(db);
  let task;
  if (legacy) {
    db.prepare(`INSERT INTO automations
      (id, task_type, enabled, timezone, schedule, notification_policy, config_json)
      VALUES ('jobops-deadline-review', 'deadline-review', 1, 'America/Chicago', '20:15', 'actionable', '{}')`).run();
    task = db.prepare('SELECT * FROM automations WHERE id = ?').get('jobops-deadline-review');
    task = {
      id: task.id, type: task.task_type, enabled: true, timezone: task.timezone,
      schedule: task.schedule, accountId: null, notificationPolicy: task.notification_policy,
      cursor: null, config: {},
    };
  } else {
    task = upsertTask(db, {
      type: 'deadline-review', enabled: true, timezone: 'America/Chicago', time: '20:15', notificationPolicy: 'actionable',
    });
  }
  const claimed = markTaskRegistration(db, task.id, nativeSchedulerRegistration(task, platform));
  db.close();
  return claimed;
}

test('renders a launchd plist with stable label and escaped arguments', () => {
  const task = configuredTask('darwin');
  const artifact = renderScheduler(task, runtime, 'darwin');
  assert.equal(artifact.kind, 'launchd');
  assert.match(artifact.content, /io\.career-journal\.deadline-review/);
  assert.match(artifact.content, /<integer>20<\/integer>/);
  assert.match(artifact.content, /<integer>15<\/integer>/);
  assert.match(artifact.content, /\/Users\/example\/Career Journal/);
  assert.match(artifact.content, /<string>--external-id<\/string><string>io\.career-journal\.deadline-review<\/string>/);
});

test('renders cron and Windows scheduler definitions without shell interpolation', () => {
  const cron = renderScheduler(configuredTask('linux'), runtime, 'linux');
  assert.match(cron.content, /CRON_TZ=America\/Chicago\n15 20 \* \* \*/);
  assert.match(cron.content, /'\/Users\/example\/Career Journal\/bin\/career-journal\.mjs'/);
  assert.match(cron.content, /'--external-id' 'career-journal-deadline-review'/);
  const windows = renderScheduler(configuredTask('win32'), { ...runtime, node: 'C:\\Program Files\\node.exe', cli: 'C:\\Career Journal\\bin\\career-journal.mjs', home: 'C:\\Career Journal' }, 'win32');
  assert.equal(windows.kind, 'schtasks');
  assert.equal(windows.command.includes('/F'), false);
  assert.match(windows.command.join(' '), /career-journal-deadline-review/);
  assert.match(windows.command.join(' '), /20:15/);
  assert.match(windows.command.join(' '), /--external-id CareerJournal-deadline-review/);
});

test('Windows scheduler action uses CommandLineToArgvW-compatible quoting for every argument', () => {
  const task = configuredTask('win32');
  const cases = [
    { node: 'C:\\node.exe', cli: 'C:\\career-journal.mjs', home: 'C:\\data' },
    { node: 'C:\\Program Files\\node.exe', cli: 'C:\\Career Journal\\bin\\career-journal.mjs', home: 'C:\\Career Journal' },
    { node: 'C:\\node.exe', cli: 'C:\\career-journal.mjs', home: 'C:\\' },
    { node: 'C:\\node.exe', cli: 'C:\\career-journal.mjs', home: 'C:\\quoted"segment\\' },
  ];
  for (const windowsRuntime of cases) {
    const artifact = renderScheduler(task, windowsRuntime, 'win32');
    const action = artifact.command[artifact.command.indexOf('/TR') + 1];
    const expected = [
      windowsRuntime.node, windowsRuntime.cli, 'automation', 'run', '--id', task.id,
      '--home', windowsRuntime.home, '--external-id', task.config.registration.externalId,
    ].map(commandLineToArgvWQuote).join(' ');
    assert.equal(action, expected);
  }
});

test('Windows argument quoting and probing parser round-trip ordinary and escaped values', () => {
  for (const value of [
    'plain',
    'C:\\data',
    'C:\\Career Journal',
    'C:\\',
    'C:\\quoted"segment\\',
  ]) {
    assert.deepEqual(parseWindowsCommandLine(quoteWindowsArgument(value)), [value]);
  }
});

test('regenerated legacy tasks keep their stored ID and platform registration name', () => {
  const legacyTask = configuredTask('darwin', true);
  const launchd = renderScheduler(legacyTask, runtime, 'darwin');
  assert.equal(launchd.fileName, 'io.job-search-ops.deadline-review.plist');
  assert.match(launchd.content, /<string>jobops-deadline-review<\/string>/);

  const windows = renderScheduler(configuredTask('win32', true), {
    ...runtime,
    node: 'C:\\Program Files\\node.exe',
    cli: 'C:\\Career Journal\\bin\\career-journal.mjs',
    home: 'C:\\Career Journal',
  }, 'win32');
  assert.match(windows.command.join(' '), /JobSearchOps-deadline-review/);
  assert.match(windows.command.join(' '), /jobops-deadline-review/);
  assert.match(windows.command.join(' '), /--external-id JobSearchOps-deadline-review/);
});

test('scheduler rendering requires a current native scheduler claim', () => {
  const task = configuredTask('darwin');
  assert.throws(
    () => renderScheduler({ ...task, config: {} }, runtime, 'darwin'),
    /register-external/i,
  );
  assert.throws(
    () => renderScheduler({ ...task, schedule: '20:30' }, runtime, 'darwin'),
    /register-external/i,
  );
});

test('scheduler rendering rejects runtime paths containing control-line injection', () => {
  const task = configuredTask('linux');
  assert.throws(
    () => renderScheduler(task, { ...runtime, home: '/safe\n* * * * * attacker' }, 'linux'),
    /unsupported scheduler path/i,
  );
  assert.throws(
    () => renderScheduler(task, { ...runtime, cli: '/safe\rcareer-journal.mjs' }, 'linux'),
    /unsupported scheduler path/i,
  );
});
