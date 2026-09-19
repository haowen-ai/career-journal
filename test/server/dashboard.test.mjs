import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createServer } from '../../src/server/app.mjs';

test('serves dashboard labels and rejects path traversal', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-dashboard-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const context = await openHomeDatabase(home);
  const server = createServer({ db: context.db, config: context.config, webRoot: path.resolve('web') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.match(html, /Job Search Ops/);
    assert.match(html, /Draft/);
    assert.match(html, /Submitted/);
    assert.equal((await fetch(`${baseUrl}/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/missing.js`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    context.db.close();
    await rm(home, { recursive: true, force: true });
  }
});

