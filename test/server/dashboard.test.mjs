import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createServer } from '../../src/server/app.mjs';

test('serves the bilingual career-journal dashboard shell and rejects path traversal', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-dashboard-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const context = await openHomeDatabase(home);
  const server = createServer({ db: context.db, config: context.config, artifactRoot: context.artifactRoot, webRoot: path.resolve('web') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.match(html, /CAREER JOURNAL/);
    assert.match(html, /data-testid="language-toggle"/);
    assert.match(html, /data-testid="stat-applied"/);
    assert.match(html, /data-testid="stat-waiting"/);
    assert.match(html, /data-testid="stat-interview"/);
    assert.match(html, /data-testid="stat-closed"/);
    assert.match(html, /data-testid="stat-preparing"/);
    assert.match(html, /data-testid="filter-all"/);
    assert.match(html, /data-testid="search-input"/);
    assert.match(html, /data-testid="application-card"/);
    assert.match(html, /data-testid="application-details"/);
    assert.match(html, /data-testid="timeline"/);
    assert.match(html, /data-testid="materials"/);
    assert.equal((await fetch(`${baseUrl}/dashboard-model.js`)).status, 200);
    const icon = await fetch(`${baseUrl}/icons/search.svg`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
    assert.doesNotMatch(html, /PrivateCandidate|PrivateEmployer|private@example\.com/);
    assert.equal((await fetch(`${baseUrl}/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/missing.js`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    context.db.close();
    await rm(home, { recursive: true, force: true });
  }
});
