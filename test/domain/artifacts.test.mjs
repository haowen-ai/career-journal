import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import { archiveArtifact } from '../../src/domain/artifacts.mjs';

test('keeps drafts separate and requires explicit submitted confirmation', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-artifact-'));
  const db = openDatabase(path.join(home, 'jobops.db'));
  migrate(db);
  db.prepare('INSERT INTO applications (id, company, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('acme-role', 'Acme', 'Analyst', 'prepared', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');
  const source = path.join(home, 'resume.pdf');
  await writeFile(source, '%PDF-1.4\nfixture');
  try {
    const draft = await archiveArtifact(db, { applicationId: 'acme-role', kind: 'resume', lifecycle: 'draft', filePath: source, storageRoot: path.join(home, 'artifacts') });
    assert.equal(draft.lifecycle, 'draft');
    assert.equal(path.basename(draft.storagePath), 'resume.pdf');
    await assert.rejects(() => archiveArtifact(db, { applicationId: 'acme-role', kind: 'resume', lifecycle: 'submitted', filePath: source, storageRoot: path.join(home, 'artifacts') }), /explicit confirmation/);
    const submitted = await archiveArtifact(db, { applicationId: 'acme-role', kind: 'resume', lifecycle: 'submitted', submittedConfirmed: true, filePath: source, storageRoot: path.join(home, 'artifacts') });
    assert.equal(submitted.lifecycle, 'submitted');
    assert.notEqual(submitted.id, draft.id);
    assert.equal(await readFile(submitted.storagePath, 'utf8'), '%PDF-1.4\nfixture');
    const replay = await archiveArtifact(db, { applicationId: 'acme-role', kind: 'resume', lifecycle: 'submitted', submittedConfirmed: true, filePath: source, storageRoot: path.join(home, 'artifacts') });
    assert.equal(replay.id, submitted.id);
    await writeFile(source, '%PDF-1.4\nsecond version');
    const secondDraft = await archiveArtifact(db, { applicationId: 'acme-role', kind: 'resume', lifecycle: 'draft', filePath: source, storageRoot: path.join(home, 'artifacts') });
    assert.equal(path.basename(secondDraft.storagePath), 'resume (2).pdf');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM artifacts').get().count, 3);
  } finally { db.close(); await rm(home, { recursive: true, force: true }); }
});
