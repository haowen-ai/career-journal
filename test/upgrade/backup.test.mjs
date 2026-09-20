import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createApplication } from '../../src/commands/application.mjs';
import { createBackup } from '../../src/commands/backup.mjs';
import { archiveArtifact } from '../../src/domain/artifacts.mjs';
import { defaultConfig } from '../../src/config/defaults.mjs';
import { loadConfig, saveConfig } from '../../src/config/store.mjs';

async function createLegacyHome(home, { model, jev } = {}) {
  const directory = path.join(home, '.jobops');
  await mkdir(directory, { recursive: true });
  const config = defaultConfig('2026-09-19T00:00:00Z', 'UTC');
  config.data = { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' };
  config.email.setupState = 'skipped';
  config.careerOps.entrypoint = 'jobops-adapter.mjs';
  if (model) config.model = { ...config.model, ...model };
  if (jev) config.jev = { ...config.jev, ...jev };
  await writeFile(path.join(directory, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(file)); else output.push(file);
  }
  return output;
}

test('backup contains data and an artifact index, preserves safe references, and excludes secret values and scheduler files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'career-journal-backup-'));
  const home = path.join(root, 'home');
  const output = path.join(root, 'backup');
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' }, model: { provider: 'openai-compatible', baseUrl: 'https://example.test/v1', secretRef: 'env:VERY_SECRET_KEY' } });
    const context = await openHomeDatabase(home);
    createApplication(context.db, { company: 'Example', role: 'Engineer' });
    context.db.close();
    await writeFile(path.join(home, '.career-journal', 'should-not-copy.env'), 'API_KEY=real-secret-value');
    const result = await createBackup(home, output, { now: '2026-09-19T12:00:00.000Z' });
    assert.equal(result.manifest.schemaVersion, 1);
    const files = await walk(output);
    const content = (await Promise.all(files.filter((file) => !file.endsWith('.db')).map((file) => readFile(file, 'utf8')))).join('\n');
    assert.equal(content.includes('env:VERY_SECRET_KEY'), true);
    assert.equal(content.includes('real-secret-value'), false);
    assert.equal(files.some((file) => file.endsWith('career-journal.db')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup config omits credential-like literal fields while preserving environment references', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'career-journal-backup-credentials-'));
  const home = path.join(root, 'home');
  const output = path.join(root, 'backup');
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const config = await loadConfig(home);
    config.integration = {
      ['pass' + 'word']: 'literal-password',
      ['access' + 'Token']: 'literal-access-token',
      ['refresh_' + 'token']: 'literal-refresh-token',
      ['api_' + 'key']: 'literal-api-key',
      authorization: 'Bearer literal-authorization',
      cookie: 'session=literal-cookie',
      clientSecret: 'literal-client-secret',
      credential: 'literal-credential',
      secretRef: 'literal-secret-reference',
      safeSecretRef: 'env:SAFE_REFERENCE',
      keychainSecretRef: 'keychain:career-journal-typesafe:local-user',
      label: 'safe-value',
    };
    await saveConfig(home, config);

    await createBackup(home, output);

    const backupConfig = JSON.parse(await readFile(path.join(output, 'config.json'), 'utf8'));
    const serialized = JSON.stringify(backupConfig);
    for (const literal of [
      'literal-password', 'literal-access-token', 'literal-refresh-token', 'literal-api-key',
      'literal-authorization', 'literal-cookie', 'literal-client-secret', 'literal-credential',
      'literal-secret-reference',
    ]) assert.equal(serialized.includes(literal), false, `backup leaked ${literal}`);
    assert.equal(backupConfig.integration.safeSecretRef, 'env:SAFE_REFERENCE');
    assert.equal(backupConfig.integration.keychainSecretRef, 'keychain:career-journal-typesafe:local-user');
    assert.equal(backupConfig.integration.label, 'safe-value');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup writes artifact metadata index without copying artifact payloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'career-journal-backup-artifact-index-'));
  const home = path.join(root, 'home');
  const output = path.join(root, 'backup');
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const context = await openHomeDatabase(home);
    const application = createApplication(context.db, { company: 'Example', role: 'Engineer' }, '2026-09-19T10:00:00.000Z');
    const source = path.join(root, 'credentials.env');
    await writeFile(source, 'API_TOKEN=FAKE_TEST_SECRET_123456789\n');
    await archiveArtifact(context.db, {
      applicationId: application.id,
      kind: 'resume',
      lifecycle: 'draft',
      filePath: source,
      storageRoot: context.artifactRoot,
      verification: 'pending',
      recordedAt: '2026-09-19T10:05:00.000Z',
    });
    context.db.close();

    const result = await createBackup(home, output, { now: '2026-09-19T12:00:00.000Z' });

    const files = await walk(output);
    assert.equal(files.some((file) => path.relative(output, file).startsWith(`artifacts${path.sep}`)), false);
    const textContent = (await Promise.all(files
      .filter((file) => !file.endsWith('.db'))
      .map((file) => readFile(file, 'utf8')))).join('\n');
    assert.equal(textContent.includes('FAKE_TEST_SECRET_123456789'), false);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'artifacts-index.json'), 'utf8')), [{
      id: '43ae73e9ac3d80f23c91e48f0bf6b789',
      applicationId: 'example-engineer',
      kind: 'resume',
      lifecycle: 'draft',
      fileName: 'credentials.env',
      sha256: '768217692d9e36777f306a593621fd0b5955da5977da5fdb7d6f82e6a1ff4285',
      submittedAt: null,
      recordedAt: '2026-09-19T10:05:00.000Z',
      verification: 'pending',
    }]);
    assert.equal(result.manifest.exclusions.includes('artifact payloads'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup clears scheduler attestation and external run health only in the copied database', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'career-journal-backup-attestation-'));
  const home = path.join(root, 'home');
  const output = path.join(root, 'backup');
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const context = await openHomeDatabase(home);
    context.db.prepare(`INSERT INTO automations
      (id, task_type, enabled, timezone, schedule, notification_policy, cursor,
       last_attempt_at, last_success_at, error, config_json)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'career-journal-local-backup', 'local-backup', 'UTC', '23:00', 'failures', 'durable-cursor',
        '2026-09-19T22:59:00.000Z', '2026-09-19T23:00:00.000Z', 'old host error',
        JSON.stringify({
          output: 'local',
          registration: {
            status: 'host-attested',
            verified: true,
            driver: 'codex',
            externalId: 'external-backup-task',
            registeredAt: '2026-09-19T20:00:00.000Z',
            bindingRevision: 'binding-revision',
            lastExternalRunAt: '2026-09-19T23:00:00.000Z',
          },
        }),
      );
    const sourceBefore = context.db.prepare('SELECT * FROM automations WHERE id = ?').get('career-journal-local-backup');
    context.db.close();
    const config = await loadConfig(home);
    config.automation.setupState = 'registered';
    await saveConfig(home, config);

    await createBackup(home, output);

    const { openDatabase } = await import('../../src/storage/database.mjs');
    const backupDb = openDatabase(path.join(output, 'career-journal.db'));
    const copied = backupDb.prepare('SELECT * FROM automations WHERE id = ?').get('career-journal-local-backup');
    backupDb.close();
    const copiedConfig = JSON.parse(copied.config_json);
    assert.equal(copiedConfig.registration, undefined);
    assert.equal(JSON.stringify(copiedConfig).includes('lastExternalRunAt'), false);
    assert.equal(copied.last_attempt_at, null);
    assert.equal(copied.last_success_at, null);
    assert.equal(copied.error, null);
    assert.equal(copied.cursor, 'durable-cursor');
    assert.equal(JSON.parse(await readFile(path.join(output, 'config.json'), 'utf8')).automation.setupState, 'pending-registration');

    const source = await openHomeDatabase(home);
    assert.deepEqual(source.db.prepare('SELECT * FROM automations WHERE id = ?').get('career-journal-local-backup'), sourceBefore);
    source.db.close();
    assert.equal((await loadConfig(home)).automation.setupState, 'registered');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup clears mailbox execution and verification health only in the copied state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'career-journal-backup-email-health-'));
  const home = path.join(root, 'home');
  const output = path.join(root, 'backup');
  try {
    await setup(home, {
      timezone: 'UTC',
      email: {
        mode: 'configure',
        provider: 'host',
        address: 'candidate@example.test',
        settings: { connector: 'gmail' },
      },
      provisionAutomations: true,
    });
    const context = await openHomeDatabase(home);
    const accountId = 'host:candidate@example.test';
    const verifiedSettings = JSON.stringify({
      connector: 'gmail',
      verification: { method: 'trusted-host', verifiedAt: '2026-09-19T20:00:00.000Z' },
    });
    context.db.prepare(`UPDATE email_accounts SET cursor = ?, revision = 7,
      last_run_id = ?, last_batch_hash = ?, last_fetched_at = ?,
      last_attempt_at = ?, last_success_at = ?, error = ?, config_json = ? WHERE id = ?`)
      .run(
        'gmail-history-300', 'mail-run-300', 'batch-hash-300', '2026-09-19T20:00:00.000Z',
        '2026-09-19T20:00:01.000Z', '2026-09-19T20:00:02.000Z', 'old error',
        verifiedSettings, accountId,
      );
    context.db.prepare("UPDATE automations SET cursor = 'gmail-history-300' WHERE task_type = 'mail-sync'").run();
    const sourceAccount = context.db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId);
    const sourceMailTask = context.db.prepare("SELECT * FROM automations WHERE task_type = 'mail-sync'").get();
    context.db.close();
    const config = await loadConfig(home);
    config.email.setupState = 'verified';
    await saveConfig(home, config);

    await createBackup(home, output);

    const { openDatabase } = await import('../../src/storage/database.mjs');
    const backupDb = openDatabase(path.join(output, 'career-journal.db'));
    const copiedAccount = backupDb.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId);
    const copiedMailTask = backupDb.prepare("SELECT * FROM automations WHERE task_type = 'mail-sync'").get();
    backupDb.close();
    assert.equal(copiedAccount.cursor, null);
    assert.equal(copiedAccount.revision, 0);
    assert.equal(copiedAccount.last_run_id, null);
    assert.equal(copiedAccount.last_batch_hash, null);
    assert.equal(copiedAccount.last_fetched_at, null);
    assert.equal(copiedAccount.last_attempt_at, null);
    assert.equal(copiedAccount.last_success_at, null);
    assert.equal(copiedAccount.error, null);
    assert.deepEqual(JSON.parse(copiedAccount.config_json), { connector: 'gmail' });
    assert.equal(copiedMailTask.cursor, null);
    assert.equal(JSON.parse(await readFile(path.join(output, 'config.json'), 'utf8')).email.setupState, 'pending-verification');

    const source = await openHomeDatabase(home);
    assert.deepEqual(source.db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId), sourceAccount);
    assert.deepEqual(source.db.prepare("SELECT * FROM automations WHERE task_type = 'mail-sync'").get(), sourceMailTask);
    source.db.close();
    assert.equal((await loadConfig(home)).email.setupState, 'verified');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup preserves a legacy workspace, provider references, artifact index, and jobops automation IDs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'career-journal-backup-legacy-'));
  const home = path.join(root, 'home');
  const output = path.join(root, 'backup');
  try {
    await createLegacyHome(home, {
      model: { provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'test-model', secretRef: 'env:MODEL_KEY' },
      jev: { accessState: 'enabled', secretRef: 'env:JEV_KEY', mode: 'shadow' },
    });
    const context = await openHomeDatabase(home);
    createApplication(context.db, { company: 'Example', role: 'Engineer' });
    const artifactDir = path.join(home, '.jobops', 'artifacts', 'example-engineer');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, 'resume.txt'), 'artifact');
    context.db.prepare("INSERT INTO automations (id, task_type, enabled, timezone, schedule, notification_policy, config_json) VALUES ('jobops-local-backup','local-backup',1,'UTC','23:00','actionable','{}')").run();
    context.db.close();
    await createBackup(home, output);
    const backupConfig = JSON.parse(await readFile(path.join(output, 'config.json'), 'utf8'));
    assert.equal(backupConfig.model.secretRef, 'env:MODEL_KEY');
    assert.equal(backupConfig.jev.secretRef, 'env:JEV_KEY');
    const { openDatabase } = await import('../../src/storage/database.mjs');
    const backupDb = openDatabase(path.join(output, 'jobops.db'));
    assert.equal(backupDb.prepare('SELECT company FROM applications').get().company, 'Example');
    assert.equal(backupDb.prepare('SELECT id FROM automations').get().id, 'jobops-local-backup');
    backupDb.close();
    await assert.rejects(() => readFile(path.join(output, 'artifacts', 'example-engineer', 'resume.txt'), 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'artifacts-index.json'), 'utf8')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup refuses to overwrite an existing destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'career-journal-backup-'));
  try {
    await setup(root, { timezone: 'UTC', email: { mode: 'skip' } });
    const output = path.join(root, 'backup');
    await createBackup(root, output);
    await assert.rejects(() => createBackup(root, output), /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
