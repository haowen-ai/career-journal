import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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
  try { await run(baseUrl, context.db); }
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
  const dashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
  assert.equal(dashboard.applications.length, 1);
  assert.equal(dashboard.applications[0].id, created.id);
  assert.equal(dashboard.applications[0].events.length, 1);
  assert.equal(dashboard.applications[0].events[0].sourceKind, 'api');
  assert.equal('source' in dashboard.applications[0].events[0], false);
  assert.deepEqual(dashboard.applications[0].artifacts, []);
}));

test('dashboard sorts material activity and normalizes CLI user sources', async () => withServer(async (baseUrl, db) => {
  const older = await (await fetch(`${baseUrl}/api/applications`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'Older', role: 'Analyst' }),
  })).json();
  const material = await (await fetch(`${baseUrl}/api/applications`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'Material', role: 'Engineer' }),
  })).json();
  db.prepare('UPDATE applications SET updated_at = ? WHERE id IN (?, ?)').run('2026-01-01T00:00:00Z', older.id, material.id);
  db.prepare(`INSERT INTO artifacts
    (id, application_id, kind, lifecycle, file_name, storage_path, sha256, submitted_at, recorded_at, verification, metadata_json)
    VALUES (?, ?, 'resume', 'submitted', 'resume.pdf', '/private/resume.pdf', ?, ?, ?, 'passed', '{}')`)
    .run('artifact-latest', material.id, 'a'.repeat(64), '2026-01-02T00:00:00Z', '2026-09-19T03:00:00Z');
  db.prepare(`INSERT INTO application_events
    (id, application_id, event_type, occurred_at, observed_at, recorded_at, title, note, source_json, status_after, content_hash)
    VALUES (?, ?, 'application_update', NULL, ?, ?, 'Manual update', '', ?, NULL, ?)`)
    .run('event-user', older.id, '2026-09-19T01:00:00Z', '2026-09-19T02:00:00Z', JSON.stringify({ kind: 'user' }), 'b'.repeat(64));

  const dashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
  assert.deepEqual(dashboard.applications.map((application) => application.id), [material.id, older.id]);
  assert.equal(dashboard.applications[1].events[0].sourceKind, 'manual');
  assert.equal('storagePath' in dashboard.applications[0].artifacts[0], false);
}));

test('rejects invalid JSON and oversized request bodies', async () => withServer(async (baseUrl) => {
  const invalid = await fetch(`${baseUrl}/api/applications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'Invalid JSON body');
  const oversized = await fetch(`${baseUrl}/api/applications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'A'.repeat(1_100_000), role: 'Analyst' }) });
  assert.equal(oversized.status, 413);
}));

test('rejects cross-origin, invalid-host, and non-JSON mutation requests', async () => withServer(async (baseUrl) => {
  const body = JSON.stringify({ company: 'Cross Origin', role: 'Attacker' });
  const crossOrigin = await fetch(`${baseUrl}/api/applications`, {
    method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'text/plain' }, body,
  });
  assert.equal(crossOrigin.status, 403);
  const target = new URL(`${baseUrl}/api/applications`);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { host: 'untrusted.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject); request.end(body);
  });
  assert.equal(wrongHostStatus, 403);
  const nonJson = await fetch(`${baseUrl}/api/applications`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
  assert.equal(nonJson.status, 415);
  assert.equal((await (await fetch(`${baseUrl}/api/applications`)).json()).length, 0);
}));

test('accepts the friendly localhost Host and matching Origin hostname', async () => withServer(async (baseUrl) => {
  const target = new URL(`${baseUrl}/api/applications`);
  const body = JSON.stringify({ company: 'Friendly Host', role: 'Local User' });
  const result = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        host: `career-journal.localhost:${target.port}`,
        origin: `http://career-journal.localhost:${target.port}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end(body);
  });
  assert.equal(result, 201);
}));
