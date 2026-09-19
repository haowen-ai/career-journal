import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createApplication } from '../../src/commands/application.mjs';
import { createBackup } from '../../src/commands/backup.mjs';
import { defaultConfig } from '../../src/config/defaults.mjs';

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

test('backup contains data and artifacts, preserves safe references, and excludes secret values and scheduler files', async () => {
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

test('backup preserves a legacy workspace, provider references, artifacts, and jobops automation IDs', async () => {
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
    assert.equal(await readFile(path.join(output, 'artifacts', 'example-engineer', 'resume.txt'), 'utf8'), 'artifact');
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
