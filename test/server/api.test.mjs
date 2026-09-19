import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createServer } from '../../src/server/app.mjs';

async function withServer(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-server-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const context = await openHomeDatabase(home);
  const server = createServer({ db: context.db, config: context.config, webRoot: path.resolve('web') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { await run(baseUrl); }
  finally { await new Promise((resolve) => server.close(resolve)); context.db.close(); await rm(home, { recursive: true, force: true }); }
}

test('health, create, list, detail, and idempotent event routes work', async () => withServer(async (baseUrl) => {
  assert.deepEqual(await (await fetch(`${baseUrl}/api/health`)).json(), { ok: true, schemaVersion: 1 });
  const created = await (await fetch(`${baseUrl}/api/applications`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'Acme', role: 'Analyst' }),
  })).json();
  assert.equal(created.company, 'Acme');
  const list = await (await fetch(`${baseUrl}/api/applications`)).json();
  assert.equal(list.length, 1);
  const detail = await (await fetch(`${baseUrl}/api/applications/${created.id}`)).json();
  assert.equal(detail.role, 'Analyst');
  const event = { id: 'evt-api-1', type: 'application_update', title: 'Received', occurredAt: null, observedAt: '2026-09-19T01:00:00Z', recordedAt: '2026-09-19T02:00:00Z', source: { kind: 'api' } };
  const first = await (await fetch(`${baseUrl}/api/applications/${created.id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) })).json();
  const second = await (await fetch(`${baseUrl}/api/applications/${created.id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) })).json();
  assert.equal(first.created, true);
  assert.equal(second.created, false);
}));

test('rejects invalid JSON and oversized request bodies', async () => withServer(async (baseUrl) => {
  const invalid = await fetch(`${baseUrl}/api/applications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'Invalid JSON body');
  const oversized = await fetch(`${baseUrl}/api/applications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'A'.repeat(1_100_000), role: 'Analyst' }) });
  assert.equal(oversized.status, 413);
}));

