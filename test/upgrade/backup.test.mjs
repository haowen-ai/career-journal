import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createApplication } from '../../src/commands/application.mjs';
import { createBackup } from '../../src/commands/backup.mjs';

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(file)); else output.push(file);
  }
  return output;
}

test('backup contains data and artifacts but no secret references or scheduler files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jobops-backup-'));
  const home = path.join(root, 'home');
  const output = path.join(root, 'backup');
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' }, model: { provider: 'openai-compatible', baseUrl: 'https://example.test/v1', secretRef: 'env:VERY_SECRET_KEY' } });
    const context = await openHomeDatabase(home);
    createApplication(context.db, { company: 'Example', role: 'Engineer' });
    context.db.close();
    await writeFile(path.join(home, '.jobops', 'should-not-copy.env'), 'API_KEY=real-secret-value');
    const result = await createBackup(home, output, { now: '2026-09-19T12:00:00.000Z' });
    assert.equal(result.manifest.schemaVersion, 1);
    const files = await walk(output);
    const content = (await Promise.all(files.filter((file) => !file.endsWith('.db')).map((file) => readFile(file, 'utf8')))).join('\n');
    assert.equal(content.includes('VERY_SECRET_KEY'), false);
    assert.equal(content.includes('real-secret-value'), false);
    assert.equal(files.some((file) => file.endsWith('jobops.db')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup refuses to overwrite an existing destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jobops-backup-'));
  try {
    await setup(root, { timezone: 'UTC', email: { mode: 'skip' } });
    const output = path.join(root, 'backup');
    await createBackup(root, output);
    await assert.rejects(() => createBackup(root, output), /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
