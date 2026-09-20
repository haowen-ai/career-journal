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
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { listEmailAccounts } from '../../src/email/accounts.mjs';
import { listTasks, markTaskRegistration, upsertTask } from '../../src/automation/registry.mjs';
import { openDatabase, migrate, schemaMigrations } from '../../src/storage/database.mjs';

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

test('Agent-managed setup needs no separate model endpoint or key', async () => withHome(async (home) => {
  const result = await setup(home, {
    timezone: 'UTC',
    email: { mode: 'skip' },
    model: { provider: 'host-agent' },
    jev: { accessState: 'unavailable' },
  });
  assert.deepEqual(result.config.model, {
    provider: 'host-agent', baseUrl: null, model: null, secretRef: null, threshold: 0.8,
  });
}));

test('a host mailbox selects the current Agent automatically when no semantic provider is configured', async () => withHome(async (home) => {
  const result = await setup(home, {
    timezone: 'UTC',
    email: { mode: 'configure', provider: 'host', address: 'candidate@school.edu', settings: { connector: 'apple-mail' } },
  });
  assert.deepEqual(result.config.model, {
    provider: 'host-agent', baseUrl: null, model: null, secretRef: null, threshold: 0.8,
  });
  assert.equal(result.config.jev.accessState, 'unavailable');
}));

test('setup binds one mail-sync task to every selected job-search mailbox', async () => withHome(async (home) => {
  await setup(home, {
    timezone: 'UTC',
    email: { mode: 'configure', provider: 'host', address: 'personal@candidate.dev', settings: { connector: 'apple-mail' } },
  });
  await setup(home, {
    timezone: 'UTC',
    email: { mode: 'configure', provider: 'host', address: 'school@candidate.edu', settings: { connector: 'apple-mail' } },
    provisionAutomations: true,
    model: { provider: 'host-agent' },
  });
  const context = await openHomeDatabase(home);
  try {
    const mailTask = listTasks(context.db).find((task) => task.type === 'mail-sync');
    assert.equal(mailTask.accountId, 'host:personal@candidate.dev');
    assert.deepEqual(mailTask.config.accountIds, [
      'host:personal@candidate.dev',
      'host:school@candidate.edu',
    ]);
  } finally { context.db.close(); }
}));

test('rejects an invalid timezone', async () => withHome(async (home) => {
  await assert.rejects(() => setup(home, { timezone: 'Moon/Base' }), /Invalid IANA timezone/);
}));

test('CLI setup without timezone preserves an existing timezone', async () => withHome(async (home) => {
  await setup(home, {
    timezone: 'Asia/Tokyo',
    email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
  });
  await setupCommand({ options: { home, 'careerops-root': '/tmp/career-ops' } }, memoryIO());
  assert.equal((await loadConfig(home)).timezone, 'Asia/Tokyo');
}));

test('first CLI setup without timezone uses the computer IANA timezone', async () => withHome(async (home) => {
  await setupCommand({ options: { home, 'email-provider': 'host', 'email-address': 'candidate@school.edu', 'email-connector': 'gmail' } }, memoryIO());
  assert.equal((await loadConfig(home)).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
}));

test('first CLI setup requires an explicit email account', async () => withHome(async (home) => {
  await assert.rejects(() => setupCommand({ options: { home } }, memoryIO()), /email account is required/i);
  await assert.rejects(() => access(configPath(home)), { code: 'ENOENT' });
}));

test('public setup rejects reserved example addresses that cannot identify a real mailbox', async () => withHome(async (home) => {
  await assert.rejects(() => setupCommand({ options: {
    home,
    'email-provider': 'host',
    'email-address': 'candidate@example.test',
    'email-connector': 'gmail',
  } }, memoryIO()), /reserved.*example|real mailbox/i);
  await assert.rejects(() => access(configPath(home)), { code: 'ENOENT' });
}));

test('public setup supports a generic IMAPS account with an environment-only credential reference', async () => withHome(async (home) => {
  await setupCommand({ options: {
    home,
    timezone: 'America/Los_Angeles',
    'email-provider': 'imap',
    'email-address': 'candidate@school.edu',
    'imap-host': 'imap.school.edu',
    'imap-user': 'candidate@school.edu',
    'secret-ref': 'env:CAREER_JOURNAL_IMAP_PASSWORD',
  } }, memoryIO());
  const context = await openHomeDatabase(home);
  try {
    const account = listEmailAccounts(context.db)[0];
    assert.equal(account.id, 'imap:candidate@school.edu');
    assert.deepEqual(account.settings, {
      host: 'imap.school.edu', port: 993, username: 'candidate@school.edu', mailbox: 'INBOX',
    });
    assert.equal(context.db.prepare('SELECT secret_ref secretRef FROM email_accounts').get().secretRef, 'env:CAREER_JOURNAL_IMAP_PASSWORD');
    assert.equal(listTasks(context.db).find((task) => task.type === 'mail-sync').accountId, account.id);
    assert.equal((await loadConfig(home)).email.setupState, 'pending-verification');
  } finally { context.db.close(); }
}));

test('public IMAPS setup requires connection settings and an env credential reference', async () => withHome(async (home) => {
  await assert.rejects(() => setupCommand({ options: {
    home,
    'email-provider': 'imap',
    'email-address': 'candidate@school.edu',
    'imap-host': 'imap.school.edu',
    'imap-user': 'candidate@school.edu',
  } }, memoryIO()), /secret-ref.*env:VARIABLE/i);
  await assert.rejects(() => access(configPath(home)), { code: 'ENOENT' });
}));

test('CLI setup rejects fallback-only email and requires a concrete host connector', async () => withHome(async (home) => {
  await assert.rejects(() => setupCommand({ options: {
    home,
    'email-provider': 'manual-eml',
    'email-address': 'candidate@school.edu',
  } }, memoryIO()), /host-managed/i);
  await assert.rejects(() => setupCommand({ options: {
    home,
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
  } }, memoryIO()), /email-connector/i);
  await assert.rejects(() => setupCommand({ options: {
    home,
    demo: true,
    'skip-email': true,
  } }, memoryIO()), /email account is required/i);
  await assert.rejects(() => access(configPath(home)), { code: 'ENOENT' });
}));

test('CLI setup refuses to present a legacy workspace without email as configured', async () => withHome(async (home) => {
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  await assert.rejects(() => setupCommand({ options: { home } }, memoryIO()), /email account is required/i);
}));

test('setup requires an explicit migration instead of mutating an old database', async () => withHome(async (home) => {
  const legacyDirectory = path.join(home, '.jobops');
  await mkdir(legacyDirectory, { recursive: true });
  const legacy = defaultConfig('2026-09-19T00:00:00Z', 'UTC');
  legacy.data = { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' };
  await writeFile(path.join(legacyDirectory, 'config.json'), `${JSON.stringify(legacy)}\n`);
  const database = path.join(legacyDirectory, 'jobops.db');
  const seed = openDatabase(database);
  migrate(seed, { migrations: [schemaMigrations[0]] });
  seed.close();

  await assert.rejects(() => setupCommand({ options: {
    home,
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'gmail',
  } }, memoryIO()), /migrations pending/i);

  const inspect = openDatabase(database);
  assert.deepEqual(inspect.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version), [1]);
  inspect.close();
}));

test('first CLI setup provisions only the two job-search automations', async () => withHome(async (home) => {
  const io = memoryIO();
  await setupCommand({ options: {
    home,
    timezone: 'America/New_York',
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'outlook',
  } }, io);
  assert.match(io.stdout, /register each returned ID/i);
  assert.match(io.stdout, /automation verify/i);
  assert.match(io.stdout, /trigger each verified job once/i);
  const context = await openHomeDatabase(home);
  try {
    const accounts = listEmailAccounts(context.db);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, 'host:candidate@school.edu');
    assert.deepEqual(accounts[0].settings, { connector: 'outlook' });
    const tasks = listTasks(context.db);
    assert.deepEqual(tasks.map((task) => task.type), ['deadline-review', 'mail-sync']);
    assert.equal(tasks.find((task) => task.type === 'mail-sync').accountId, accounts[0].id);
    assert.equal(tasks.find((task) => task.type === 'mail-sync').schedule, '20:00');
    assert.equal(tasks.find((task) => task.type === 'deadline-review').schedule, '20:15');
    const config = await loadConfig(home);
    assert.equal(config.email.setupState, 'pending-verification');
    assert.equal(config.automation.setupState, 'pending-registration');
    assert.equal(config.model.provider, 'host-agent');
    assert.equal(config.model.baseUrl, null);
    assert.equal(config.model.secretRef, null);
  } finally { context.db.close(); }
}));

test('rerunning setup preserves custom schedules, policies, disabled state, and current registrations', async () => withHome(async (home) => {
  await setupCommand({ options: {
    home,
    timezone: 'America/New_York',
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'gmail',
  } }, memoryIO());
  let context = await openHomeDatabase(home);
  const current = listTasks(context.db).find((task) => task.type === 'deadline-review');
  upsertTask(context.db, {
    type: current.type,
    enabled: false,
    timezone: current.timezone,
    time: '07:45',
    accountId: current.accountId,
    notificationPolicy: 'failures',
    config: current.config,
  });
  markTaskRegistration(context.db, current.id, { driver: 'codex', externalId: 'deadline-custom' });
  const before = listTasks(context.db).find((task) => task.type === 'deadline-review');
  context.db.close();

  await setupCommand({ options: { home } }, memoryIO());
  context = await openHomeDatabase(home);
  try {
    const after = listTasks(context.db).find((task) => task.type === 'deadline-review');
    assert.equal(after.schedule, '07:45');
    assert.equal(after.timezone, 'America/New_York');
    assert.equal(after.notificationPolicy, 'failures');
    assert.equal(after.enabled, false);
    assert.equal(after.config.registration.externalId, 'deadline-custom');
    assert.equal(after.config.registration.bindingRevision, before.config.registration.bindingRevision);
  } finally { context.db.close(); }
}));

test('an explicit setup time override changes only that task and invalidates its registration', async () => withHome(async (home) => {
  await setupCommand({ options: {
    home,
    timezone: 'UTC',
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'gmail',
  } }, memoryIO());
  let context = await openHomeDatabase(home);
  for (const task of listTasks(context.db)) {
    markTaskRegistration(context.db, task.id, { driver: 'codex', externalId: `external-${task.type}` });
  }
  context.db.close();

  await setupCommand({ options: { home, 'deadline-review-time': '06:30' } }, memoryIO());
  context = await openHomeDatabase(home);
  try {
    const tasks = listTasks(context.db);
    const deadline = tasks.find((task) => task.type === 'deadline-review');
    assert.equal(deadline.schedule, '06:30');
    assert.equal(deadline.config.registration, undefined);
    for (const task of tasks.filter((item) => item.type !== 'deadline-review')) {
      assert.equal(task.config.registration.externalId, `external-${task.type}`);
    }
  } finally { context.db.close(); }
}));

test('setup includes every configured host mailbox in the daily selection', async () => withHome(async (home) => {
  await setup(home, {
    timezone: 'UTC',
    email: { mode: 'configure', provider: 'host', address: 'first@example.test', settings: { connector: 'gmail' } },
  });
  await setup(home, {
    email: { mode: 'configure', provider: 'host', address: 'second@example.test', settings: { connector: 'outlook' } },
  });
  await setupCommand({ options: { home } }, memoryIO());
  const context = await openHomeDatabase(home);
  try {
    const mailTask = listTasks(context.db).find((task) => task.type === 'mail-sync');
    assert.deepEqual(mailTask.config.accountIds, ['host:first@example.test', 'host:second@example.test']);
  } finally { context.db.close(); }
}));

test('host-managed setup rejects credential references because the connector owns authentication', async () => withHome(async (home) => {
  await assert.rejects(() => setupCommand({ options: {
    home,
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'gmail',
    'secret-ref': 'plaintext-or-env',
  } }, memoryIO()), /secret-ref is not accepted/i);
  await assert.rejects(() => access(configPath(home)), { code: 'ENOENT' });
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

test('CLI host setup enables Jev and keeps the current Agent as its credential-free fallback', async () => withHome(async (home) => {
  await setupCommand({ options: {
    home,
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'gmail',
    'jev-secret-ref': 'env:TYPESAFE_API_KEY',
  } }, memoryIO());
  const config = await loadConfig(home);
  assert.deepEqual(config.jev, {
    accessState: 'enabled',
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    secretRef: 'env:TYPESAFE_API_KEY',
    mode: 'active',
    threshold: 0.8,
  });
  assert.equal(config.model.provider, 'host-agent');
  assert.equal(config.model.secretRef, null);
}));

test('CLI host setup accepts a macOS Keychain Jev secret reference', async () => withHome(async (home) => {
  await setupCommand({ options: {
    home,
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'apple-mail',
    'jev-secret-ref': 'keychain:career-journal-typesafe:local-user',
  } }, memoryIO());
  const config = await loadConfig(home);
  assert.equal(config.jev.secretRef, 'keychain:career-journal-typesafe:local-user');
  assert.equal(config.jev.accessState, 'enabled');
}));

test('CLI setup rejects a literal Jev key', async () => withHome(async (home) => {
  await assert.rejects(() => setupCommand({ options: {
    home,
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'gmail',
    'jev-secret-ref': 'secret-value',
  } }, memoryIO()), /jev-secret-ref.*env:VARIABLE/i);
}));

test('CLI setup refuses a Jev endpoint outside the TypeSafe API origin', async () => withHome(async (home) => {
  await assert.rejects(() => setupCommand({ options: {
    home,
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'gmail',
    'jev-secret-ref': 'env:TYPESAFE_API_KEY',
    'jev-base-url': 'https://attacker.example/v1/systemone',
  } }, memoryIO()), /api\.typesafe\.ai/);
}));

test('CLI setup configures an OpenAI-compatible LLM fallback when Jev is unavailable', async () => withHome(async (home) => {
  await setupCommand({ options: {
    home,
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'gmail',
    'model-provider': 'openai-compatible',
    'model-base-url': 'https://model.example/v1',
    'model-name': 'decision-model',
    'model-secret-ref': 'env:MODEL_API_KEY',
    'model-threshold': '0.85',
  } }, memoryIO());
  const config = await loadConfig(home);
  assert.deepEqual(config.model, {
    provider: 'openai-compatible',
    baseUrl: 'https://model.example/v1',
    model: 'decision-model',
    secretRef: 'env:MODEL_API_KEY',
    threshold: 0.85,
  });
  assert.equal(config.jev.accessState, 'unavailable');
}));

test('CLI setup rejects literal LLM credentials', async () => withHome(async (home) => {
  await assert.rejects(() => setupCommand({ options: {
    home,
    'email-provider': 'host',
    'email-address': 'candidate@school.edu',
    'email-connector': 'gmail',
    'model-provider': 'openai-compatible',
    'model-base-url': 'https://model.example/v1',
    'model-name': 'decision-model',
    'model-secret-ref': 'secret-value',
  } }, memoryIO()), /model-secret-ref.*env:VARIABLE/i);
}));
