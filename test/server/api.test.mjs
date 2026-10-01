import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createServer } from '../../src/server/app.mjs';
import { archiveArtifact } from '../../src/domain/artifacts.mjs';
import { getTask, upsertTask } from '../../src/domain/tasks.mjs';

async function withServer(run, serverOptions = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-server-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const context = await openHomeDatabase(home);
  const server = createServer({ db: context.db, config: context.config, artifactRoot: context.artifactRoot, webRoot: path.resolve('web'), ...serverOptions });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { await run(baseUrl, context.db, context); }
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
  assert.deepEqual(dashboard.applications[0].tasks, []);
}));

test('opens and reveals an archived material by id without exposing its storage path', async () => {
  let revealedPath = null;
  await withServer(async (baseUrl, db, context) => {
    const application = await (await fetch(`${baseUrl}/api/applications`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'Acme', role: 'Engineer' }),
    })).json();
    const source = path.join(context.root, 'resume.pdf');
    await writeFile(source, '%PDF-1.4\nlocal artifact\n');
    const artifact = await archiveArtifact(db, {
      applicationId: application.id,
      kind: 'resume',
      lifecycle: 'draft',
      filePath: source,
      storageRoot: context.artifactRoot,
    });
    const response = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/file`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('content-disposition'), /inline/);
    assert.equal(await response.text(), '%PDF-1.4\nlocal artifact\n');
    const reveal = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/reveal`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(reveal.status, 200);
    assert.deepEqual(await reveal.json(), { ok: true });
    assert.equal(revealedPath, await realpath(artifact.storagePath));
    const dashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
    assert.equal('storagePath' in dashboard.applications[0].artifacts[0], false);
    assert.equal((await fetch(`${baseUrl}/api/artifacts/missing/file`)).status, 404);
  }, { revealFile: async (filePath) => { revealedPath = filePath; } });
});

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

function rawRequest(baseUrl, pathname, { method = 'POST', headers = {}, body = '' } = {}) {
  const target = new URL(`${baseUrl}${pathname}`);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function seedTasks(baseUrl, db) {
  const application = await (await fetch(`${baseUrl}/api/applications`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'Acme', role: 'SWE Intern' }),
  })).json();
  const later = upsertTask(db, { id: 'task-later', applicationId: application.id, kind: 'interview', title: 'Video interview', platform: 'HireVue', link: 'https://example.com/invite/abc', dueAt: '2026-10-03T17:00:00Z', dueNote: 'Deadline computed as received time + 7 days', source: { kind: 'email', messageId: 'private-message-id' } }, '2026-09-20T00:00:00Z');
  const none = upsertTask(db, { id: 'task-none', applicationId: application.id, kind: 'other', title: 'Portfolio upload', dueNote: 'Email gives no deadline' }, '2026-09-20T00:00:00Z');
  const soon = upsertTask(db, { id: 'task-soon', applicationId: application.id, kind: 'assessment', title: 'Coding test', platform: 'CodeSignal', dueAt: '2026-10-01T09:00:00-07:00', note: 'Use Python' }, '2026-09-20T00:00:00Z');
  return { application, later, none, soon };
}

test('dashboard includes each application task in camelCase deadline order without private source data', async () => withServer(async (baseUrl, db) => {
  const { application } = await seedTasks(baseUrl, db);
  const dashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
  const [item] = dashboard.applications;
  assert.equal(item.id, application.id);
  assert.deepEqual(item.tasks.map((task) => task.id), ['task-soon', 'task-later', 'task-none']);
  assert.deepEqual(item.tasks[1], {
    id: 'task-later', kind: 'interview', title: 'Video interview', platform: 'HireVue', link: 'https://example.com/invite/abc', dueAt: '2026-10-03T17:00:00Z',
    dueNote: 'Deadline computed as received time + 7 days', status: 'open', note: '', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
  });
  assert.equal(item.tasks[2].dueAt, null);
  assert.equal(item.tasks[2].platform, null);
  assert.equal(item.tasks[2].link, null);
  assert.doesNotMatch(JSON.stringify(dashboard), /private-message-id|source_json|applicationId/);
  const detail = await (await fetch(`${baseUrl}/api/applications/${application.id}`)).json();
  assert.deepEqual(detail.tasks.map((task) => task.id), ['task-soon', 'task-later', 'task-none']);
}));

test('task status route marks a task done and reopens it', async () => withServer(async (baseUrl, db) => {
  await seedTasks(baseUrl, db);
  const done = await fetch(`${baseUrl}/api/tasks/task-soon/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(done.status, 200);
  const body = await done.json();
  assert.equal(body.ok, true);
  assert.equal(body.task.id, 'task-soon');
  assert.equal(body.task.status, 'done');
  assert.deepEqual(Object.keys(body.task), ['id', 'kind', 'title', 'platform', 'link', 'dueAt', 'dueNote', 'status', 'note', 'createdAt', 'updatedAt']);
  assert.equal(getTask(db, 'task-soon').status, 'done');
  const dashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
  assert.equal(dashboard.applications[0].tasks.find((task) => task.id === 'task-soon').status, 'done');

  const reopened = await fetch(`${baseUrl}/api/tasks/task-soon/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'open' }),
  });
  assert.equal(reopened.status, 200);
  assert.equal((await reopened.json()).task.status, 'open');
  assert.equal(getTask(db, 'task-soon').status, 'open');
}));

test('task status route rejects cross-origin, invalid-host, non-JSON, malformed, unknown, and non-POST requests', async () => withServer(async (baseUrl, db) => {
  await seedTasks(baseUrl, db);
  const before = getTask(db, 'task-later');
  const body = JSON.stringify({ status: 'done' });
  const pathname = '/api/tasks/task-later/status';
  const port = new URL(baseUrl).port;

  const crossOrigin = await rawRequest(baseUrl, pathname, { headers: { host: `127.0.0.1:${port}`, origin: 'https://untrusted.example', 'content-type': 'application/json' }, body });
  assert.deepEqual(crossOrigin, { status: 403, body: { error: 'Loopback Host and Origin required' } });
  const wrongHost = await rawRequest(baseUrl, pathname, { headers: { host: 'untrusted.example', 'content-type': 'application/json' }, body });
  assert.deepEqual(wrongHost, { status: 403, body: { error: 'Loopback Host and Origin required' } });
  const nonJson = await rawRequest(baseUrl, pathname, { headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' }, body });
  assert.deepEqual(nonJson, { status: 415, body: { error: 'Mutating API requests require application/json' } });
  const invalidJson = await fetch(`${baseUrl}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { error: 'Invalid JSON body' });
  for (const payload of [{ status: 'archived' }, {}, null, ['done']]) {
    const invalidStatus = await fetch(`${baseUrl}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(invalidStatus.status, 400, JSON.stringify(payload));
    assert.deepEqual(await invalidStatus.json(), { error: 'Task status must be open or done' });
  }
  const unknown = await fetch(`${baseUrl}/api/tasks/missing/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'Task not found' });
  const getRequest = await fetch(`${baseUrl}${pathname}`);
  assert.equal(getRequest.status, 404);
  assert.deepEqual(await getRequest.json(), { error: 'Not found' });
  const putRequest = await fetch(`${baseUrl}${pathname}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
  assert.equal(putRequest.status, 404);
  assert.deepEqual(getTask(db, 'task-later'), before);
}));
