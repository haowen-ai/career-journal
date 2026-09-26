import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { listTasks, markTaskRegistration } from '../../src/automation/registry.mjs';
import { hostCommandLineForTask, probeTaskRegistration } from '../../src/automation/probe.mjs';
import { automationCommand } from '../../src/commands/automation.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

const TASK_ID = 'career-journal-daily';

async function claudeFixture(prefix) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  await setup(home, {
    timezone: 'America/Chicago',
    email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'apple-mail' } },
    provisionAutomations: true,
  });
  const claudeHome = path.join(home, 'claude-home');
  const claudeAppSupport = path.join(home, 'claude-app');
  const skillFile = path.join(claudeHome, 'scheduled-tasks', TASK_ID, 'SKILL.md');
  await mkdir(path.dirname(skillFile), { recursive: true });
  const writeSkill = (prompt, name = TASK_ID) => writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: CAREER JOURNAL daily checks\n---\n\n${prompt}\n`,
  );
  const writeStore = async (records, { account = 'account-a', organization = 'org-a', mtime } = {}) => {
    const file = path.join(claudeAppSupport, 'claude-code-sessions', account, organization, 'scheduled-tasks.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ scheduledTasks: records }));
    if (mtime) await utimes(file, mtime, mtime);
  };
  const record = (overrides = {}) => ({
    id: TASK_ID, cronExpression: '0,15 20 * * *', enabled: true, filePath: skillFile, ...overrides,
  });
  const probeOptions = { claudeHome, claudeAppSupport, systemTimezone: 'America/Chicago', platform: 'darwin' };
  return { home, claudeHome, claudeAppSupport, skillFile, writeSkill, writeStore, record, probeOptions };
}

function bindBothTasks(db, home, externalId = TASK_ID) {
  for (const task of listTasks(db).filter((item) => ['mail-sync', 'deadline-review'].includes(item.type))) {
    markTaskRegistration(db, task.id, {
      driver: 'claude-code', externalId,
      execution: { node: '/opt/node/bin/node', cli: '/repo/bin/career-journal.mjs', home, platform: 'darwin' },
    });
  }
  return listTasks(db).filter((item) => ['mail-sync', 'deadline-review'].includes(item.type));
}

test('one Claude Code scheduled task verifies the two required commands and schedules', async () => {
  const fixture = await claudeFixture('career-journal-claude-shared-');
  try {
    const context = await openHomeDatabase(fixture.home);
    const tasks = bindBothTasks(context.db, fixture.home);
    const commands = tasks.map(hostCommandLineForTask);
    assert.ok(commands.every(Boolean));
    await fixture.writeSkill(`Local time zone America/Chicago. Before 20:15 run mail-sync, otherwise deadline-review.\n${commands.join('\n')}`);
    await fixture.writeStore([fixture.record()]);
    for (const task of tasks) {
      const result = await probeTaskRegistration(task, fixture.probeOptions);
      assert.equal(result.ok, true, result.detail);
      assert.match(result.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
    }

    await fixture.writeSkill(`America/Chicago\n${commands[0]}`);
    assert.equal((await probeTaskRegistration(tasks[1], fixture.probeOptions)).ok, false);

    await fixture.writeSkill(`America/Chicago\n${commands.join('\n')}`);
    await fixture.writeStore([fixture.record({ cronExpression: '0,15,30 20 * * *' })]);
    for (const task of tasks) assert.equal((await probeTaskRegistration(task, fixture.probeOptions)).ok, false);
    context.db.close();
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test('Claude Code probe rejects disabled, one-time, mismatched, and unbound tasks', async () => {
  const fixture = await claudeFixture('career-journal-claude-reject-');
  try {
    const context = await openHomeDatabase(fixture.home);
    const tasks = bindBothTasks(context.db, fixture.home);
    const prompt = `America/Chicago\n${tasks.map(hostCommandLineForTask).join('\n')}`;
    const probe = () => probeTaskRegistration(tasks[0], fixture.probeOptions);

    await fixture.writeSkill(prompt);
    const missing = await probe();
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /no schedule record/);

    const cases = [
      [{ enabled: false }, /must be enabled/],
      [{ fireAt: '2026-10-01T20:00:00-05:00' }, /cron does not match/],
      [{ cronExpression: '0,15 20 * * 1-5' }, /cron does not match/],
      [{ cronExpression: '*/15 20 * * *' }, /cron does not match/],
      [{ filePath: path.join(fixture.claudeHome, 'scheduled-tasks', 'other', 'SKILL.md') }, /different SKILL\.md/],
    ];
    for (const [overrides, expected] of cases) {
      await fixture.writeStore([fixture.record(overrides)]);
      const result = await probe();
      assert.equal(result.ok, false, JSON.stringify(overrides));
      assert.match(result.detail, expected);
    }

    await fixture.writeStore([fixture.record()]);
    assert.equal((await probe()).ok, true);
    assert.equal((await probeTaskRegistration(tasks[0], { ...fixture.probeOptions, systemTimezone: 'UTC' })).ok, false);

    await fixture.writeSkill(prompt, 'another-task');
    assert.match((await probe()).detail, /name does not match/);

    await fixture.writeSkill(`Run in America/Chicago:\necho ${hostCommandLineForTask(tasks[0])}`);
    assert.match((await probe()).detail, /exact registered CAREER JOURNAL command/);
    context.db.close();
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test('Claude Code probe trusts the most recently written desktop schedule store', async () => {
  const fixture = await claudeFixture('career-journal-claude-stores-');
  try {
    const context = await openHomeDatabase(fixture.home);
    const tasks = bindBothTasks(context.db, fixture.home);
    await fixture.writeSkill(`America/Chicago\n${tasks.map(hostCommandLineForTask).join('\n')}`);
    const older = new Date('2026-09-20T12:00:00Z');
    const newer = new Date('2026-09-26T12:00:00Z');

    await fixture.writeStore([fixture.record()], { account: 'old-account', mtime: older });
    await fixture.writeStore([fixture.record({ enabled: false })], { account: 'current-account', mtime: newer });
    assert.equal((await probeTaskRegistration(tasks[0], fixture.probeOptions)).ok, false);

    await fixture.writeStore([fixture.record({ enabled: false })], { account: 'old-account', mtime: older });
    await fixture.writeStore([fixture.record()], { account: 'current-account', mtime: newer });
    assert.equal((await probeTaskRegistration(tasks[0], fixture.probeOptions)).ok, true);

    await mkdir(path.join(fixture.claudeAppSupport, 'claude-code-sessions', 'broken', 'org'), { recursive: true });
    await writeFile(path.join(fixture.claudeAppSupport, 'claude-code-sessions', 'broken', 'org', 'scheduled-tasks.json'), '{not json');
    assert.equal((await probeTaskRegistration(tasks[0], fixture.probeOptions)).ok, true);
    context.db.close();
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test('register-external prints the Claude Code command and verify promotes it as a trusted host', async () => {
  const fixture = await claudeFixture('career-journal-claude-command-');
  try {
    const commands = [];
    for (const type of ['mail-sync', 'deadline-review']) {
      const io = memoryIO();
      await automationCommand({ subcommand: 'register-external', options: {
        home: fixture.home, task: type, driver: 'claude-code', 'external-id': TASK_ID,
      } }, io, { root: '/repo', version: 'test' });
      const output = JSON.parse(io.stdout);
      assert.equal(output.codexCommandLine, undefined);
      assert.equal(output.claudeCodeCommandLine, hostCommandLineForTask(output));
      commands.push(output.claudeCodeCommandLine);
    }
    await fixture.writeSkill(`America/Chicago\n${commands.join('\n')}`);
    await fixture.writeStore([fixture.record()]);

    for (const type of ['mail-sync', 'deadline-review']) {
      await automationCommand({ subcommand: 'verify', options: { home: fixture.home, task: type } }, memoryIO(), {
        root: '/repo', version: 'test',
        claudeHome: fixture.claudeHome,
        claudeAppSupport: fixture.claudeAppSupport,
        systemTimezone: 'America/Chicago',
        platform: 'darwin',
      });
    }
    const context = await openHomeDatabase(fixture.home);
    for (const task of listTasks(context.db).filter((item) => ['mail-sync', 'deadline-review'].includes(item.type))) {
      assert.equal(task.config.registration.driver, 'claude-code');
      assert.equal(task.config.registration.verified, true);
      assert.equal(task.config.registration.verifier.method, 'trusted-host');
      assert.deepEqual(task.config.registration.sharedSchedules.map((item) => item.schedule), ['20:00', '20:15']);
    }
    context.db.close();
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});
