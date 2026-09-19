import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { configPath, loadConfig } from '../../src/config/store.mjs';
import { defaultConfig } from '../../src/config/defaults.mjs';
import { setupCommand } from '../../src/commands/setup.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-setup-'));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('does not invent an email account', async () => withHome(async (home) => {
  const result = await setup(home, { timezone: 'America/Chicago', email: { mode: 'skip' } });
  assert.deepEqual(result.config.email.accounts, []);
  assert.equal(result.config.email.setupState, 'skipped');
  assert.equal((await loadConfig(home)).timezone, 'America/Chicago');
}));

test('new workspaces use the CAREER JOURNAL data directory and database name', async () => withHome(async (home) => {
  const result = await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  assert.equal(configPath(home), path.join(home, '.career-journal', 'config.json'));
  await access(configPath(home));
  assert.equal(result.config.data.database, '.career-journal/career-journal.db');
  assert.equal(result.config.data.artifacts, '.career-journal/artifacts');
  assert.equal(result.config.careerOps.entrypoint, 'career-journal-adapter.mjs');
}));

test('existing .jobops workspaces remain readable for upgrades', async () => withHome(async (home) => {
  const legacyDirectory = path.join(home, '.jobops');
  await mkdir(legacyDirectory, { recursive: true });
  const legacy = defaultConfig('2026-09-19T00:00:00Z', 'UTC');
  legacy.data = { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' };
  legacy.careerOps.entrypoint = 'jobops-adapter.mjs';
  await writeFile(path.join(legacyDirectory, 'config.json'), `${JSON.stringify(legacy)}\n`);
  assert.equal(configPath(home), path.join(legacyDirectory, 'config.json'));
  assert.equal((await loadConfig(home)).data.database, '.jobops/jobops.db');
  await setup(home, { timezone: 'America/New_York' });
  assert.equal((await loadConfig(home)).timezone, 'America/New_York');
  await assert.rejects(() => access(path.join(home, '.career-journal', 'config.json')), { code: 'ENOENT' });
}));

test('an empty primary directory does not shadow an existing legacy config', async () => withHome(async (home) => {
  const primaryDirectory = path.join(home, '.career-journal');
  const legacyDirectory = path.join(home, '.jobops');
  await mkdir(primaryDirectory, { recursive: true });
  await mkdir(legacyDirectory, { recursive: true });
  const legacy = defaultConfig('2026-09-19T00:00:00Z', 'UTC');
  legacy.data = { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' };
  legacy.careerOps.entrypoint = 'jobops-adapter.mjs';
  await writeFile(path.join(legacyDirectory, 'config.json'), `${JSON.stringify(legacy)}\n`);

  assert.equal(configPath(home), path.join(legacyDirectory, 'config.json'));
  assert.equal((await loadConfig(home)).careerOps.entrypoint, 'jobops-adapter.mjs');
}));

test('two config files fail explicitly instead of silently choosing one workspace', async () => withHome(async (home) => {
  const primaryDirectory = path.join(home, '.career-journal');
  const legacyDirectory = path.join(home, '.jobops');
  await mkdir(primaryDirectory, { recursive: true });
  await mkdir(legacyDirectory, { recursive: true });
  const primary = defaultConfig('2026-09-19T01:00:00Z', 'America/Chicago');
  const legacy = defaultConfig('2026-09-19T00:00:00Z', 'UTC');
  legacy.data = { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' };
  legacy.careerOps.entrypoint = 'jobops-adapter.mjs';
  await writeFile(path.join(primaryDirectory, 'config.json'), `${JSON.stringify(primary)}\n`);
  await writeFile(path.join(legacyDirectory, 'config.json'), `${JSON.stringify(legacy)}\n`);

  await assert.rejects(() => loadConfig(home), /both|conflict|multiple/i);
}));

test('stores only an explicit email adapter without credentials', async () => withHome(async (home) => {
  const result = await setup(home, {
    timezone: 'UTC',
    email: { mode: 'configure', provider: 'manual-eml', address: 'candidate@example.test' },
  });
  assert.deepEqual(result.config.email.accounts, [{
    id: 'manual-eml:candidate@example.test', provider: 'manual-eml', address: 'candidate@example.test', readOnly: true,
  }]);
  assert.equal(JSON.stringify(result.config).includes('token'), false);
}));

test('a second setup preserves existing provider and account choices', async () => withHome(async (home) => {
  await setup(home, {
    timezone: 'UTC',
    email: { mode: 'configure', provider: 'manual-eml', address: 'candidate@example.test' },
    model: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
  });
  const second = await setup(home, { timezone: 'America/New_York' });
  assert.equal(second.config.timezone, 'America/New_York');
  assert.equal(second.config.email.accounts.length, 1);
  assert.equal(second.config.model.provider, 'openai-compatible');
}));

test('rejects an invalid timezone', async () => withHome(async (home) => {
  await assert.rejects(() => setup(home, { timezone: 'Moon/Base' }), /Invalid IANA timezone/);
}));

test('CLI setup without timezone preserves an existing timezone', async () => withHome(async (home) => {
  await setup(home, { timezone: 'Asia/Tokyo', email: { mode: 'skip' } });
  await setupCommand({ options: { home, 'careerops-root': '/tmp/career-ops' } }, memoryIO());
  assert.equal((await loadConfig(home)).timezone, 'Asia/Tokyo');
}));

test('first CLI setup without timezone uses the computer IANA timezone', async () => withHome(async (home) => {
  await setupCommand({ options: { home, 'skip-email': true } }, memoryIO());
  assert.equal((await loadConfig(home)).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
}));

test('programmatic setup also defaults to the computer IANA timezone', async () => withHome(async (home) => {
  const configured = await setup(home, { email: { mode: 'skip' } });
  assert.equal(configured.config.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
}));

test('stores explicit personal material-rule files without replacing built-in defaults', async () => withHome(async (home) => {
  const rules = path.join(home, 'resume-rules.md');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(rules, '# Personal rules\n'));
  const configured = await setup(home, { timezone: 'UTC', materialRules: [rules] });
  assert.deepEqual(configured.config.materials.ruleFiles, [rules]);
  const untouched = await setup(path.join(home, 'other'), { timezone: 'UTC' });
  assert.deepEqual(untouched.config.materials.ruleFiles, []);
}));
