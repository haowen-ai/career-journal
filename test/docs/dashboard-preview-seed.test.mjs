import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { seedDashboardPreview } from '../../scripts/seed-dashboard-preview.mjs';

test('dashboard preview seed is synthetic, recognizable, and contains no applicant identity', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'career-journal-preview-test-parent-'));
  const home = path.join(os.tmpdir(), `career-journal-preview-${path.basename(parent)}`);
  try {
    await seedDashboardPreview(home);
    await assert.rejects(() => access(`${home}-source-artifacts`));
    const context = await openHomeDatabase(home);
    const applications = context.db.prepare('SELECT company, role, external_id externalId, job_url jobUrl FROM applications ORDER BY company').all();
    const events = context.db.prepare('SELECT title, note, source_json sourceJson FROM application_events ORDER BY id').all();
    const artifacts = context.db.prepare('SELECT file_name fileName, storage_path storagePath, metadata_json metadataJson FROM artifacts ORDER BY id').all();
    context.db.close();

    assert.equal(applications.length, 7);
    assert.deepEqual(applications.map(({ company }) => company), [
      'Amazon · Demo',
      'Apple · Demo',
      'Google · Demo',
      'Meta · Demo',
      'Microsoft · Demo',
      'NVIDIA · Demo',
      'Tesla · Demo',
    ]);
    for (const item of applications) {
      assert.match(item.externalId, /^DEMO-/);
      assert.equal(item.jobUrl, null);
    }
    for (const event of events) {
      assert.match(event.note, /^\[合成演示\]/);
      assert.match(event.sourceJson, /synthetic-big-company-demo/);
    }
    const artifactContents = [];
    for (const artifact of artifacts) {
      assert.match(artifact.fileName, /demo-resume\.pdf$/);
      assert.match(artifact.metadataJson, /synthetic-big-company-demo/);
      const content = await readFile(artifact.storagePath, 'utf8');
      assert.match(content, /Synthetic CAREER JOURNAL demo artifact/);
      artifactContents.push(content);
    }

    const serialized = JSON.stringify({ applications, events, artifacts, artifactContents });
    assert.doesNotMatch(serialized, /@[A-Za-z0-9.-]+|linkedin\.com|github\.com\/haowenchen|224[- )]?420/i);
    assert.match(await readFile(path.join(home, '.career-journal', 'config.json'), 'utf8'), /"setupState": "skipped"/);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('dashboard preview seed refuses to replace a non-preview directory', async () => {
  await assert.rejects(() => seedDashboardPreview(path.join(os.tmpdir(), 'career-journal-user-data')), /Preview homes must be/);
});
