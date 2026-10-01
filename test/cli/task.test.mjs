import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { runCli, HELP } from '../../src/cli/main.mjs';
import { createRuntime } from '../../src/runtime/create-runtime.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

const runtime = createRuntime({ root: process.cwd(), version: '0.1.0-alpha.1' });

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-cli-task-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

async function cli(args) {
  const io = memoryIO();
  const code = await runCli(args, io, runtime);
  return { code, io };
}

async function addApplication(home, company, role) {
  const { code, io } = await cli(['application', 'add', '--home', home, '--company', company, '--role', role, '--status', 'applied']);
  assert.equal(code, 0, io.stderr);
  return JSON.parse(io.stdout).id;
}

test('help lists the task command', () => {
  assert.match(HELP, /^ {2}task {10}Track assessment and interview steps with deadlines$/m);
});

test('task add derives a stable id, prints the stored task, and re-runs idempotently', async () => fixture(async (home) => {
  const id = await addApplication(home, 'Acme', 'Software Engineering Intern');
  const args = ['task', 'add', '--home', home, '--id', id, '--kind', 'assessment', '--title', 'HackerRank online assessment',
    '--platform', 'HackerRank', '--due-at', '2026-10-01T23:59:00-07:00', '--due-note', 'Deadline computed as received time + 7 days', '--source', 'email'];
  const first = await cli(args);
  assert.equal(first.code, 0, first.io.stderr);
  const task = JSON.parse(first.io.stdout);
  assert.match(task.id, /^[0-9a-f]{32}$/);
  assert.equal(task.applicationId, id);
  assert.equal(task.company, 'Acme');
  assert.equal(task.role, 'Software Engineering Intern');
  assert.equal(task.kind, 'assessment');
  assert.equal(task.platform, 'HackerRank');
  assert.equal(task.dueAt, '2026-10-01T23:59:00-07:00');
  assert.equal(task.dueNote, 'Deadline computed as received time + 7 days');
  assert.equal(task.status, 'open');
  assert.equal(task.note, '');
  assert.deepEqual(task.source, { kind: 'email' });
  assert.equal(task.createdAt, task.updatedAt);

  const replay = await cli(args);
  assert.equal(replay.code, 0, replay.io.stderr);
  assert.deepEqual(JSON.parse(replay.io.stdout), task);
  const list = await cli(['task', 'list', '--home', home, '--json']);
  assert.equal(JSON.parse(list.io.stdout).length, 1);
}));

test('task add upserts by explicit task id and keeps a completed status unless one is given', async () => fixture(async (home) => {
  const id = await addApplication(home, 'Acme', 'Data Intern');
  const created = await cli(['task', 'add', '--home', home, '--id', id, '--task-id', 'acme-video', '--kind', 'interview', '--title', 'Video interview', '--due-note', 'Email gives no deadline']);
  assert.equal(created.code, 0, created.io.stderr);
  const original = JSON.parse(created.io.stdout);
  assert.equal(original.id, 'acme-video');
  assert.equal(original.dueAt, null);
  assert.deepEqual(original.source, { kind: 'user' });

  assert.equal((await cli(['task', 'done', '--home', home, '--task-id', 'acme-video'])).code, 0);
  const updated = await cli(['task', 'add', '--home', home, '--id', id, '--task-id', 'acme-video', '--kind', 'interview', '--title', 'HireVue video interview', '--platform', 'HireVue', '--due-at', '2026-10-03T17:00:00Z']);
  assert.equal(updated.code, 0, updated.io.stderr);
  const record = JSON.parse(updated.io.stdout);
  assert.equal(record.title, 'HireVue video interview');
  assert.equal(record.platform, 'HireVue');
  assert.equal(record.dueAt, '2026-10-03T17:00:00Z');
  assert.equal(record.dueNote, 'Email gives no deadline');
  assert.equal(record.status, 'done');
  assert.equal(record.createdAt, original.createdAt);

  const reopened = await cli(['task', 'add', '--home', home, '--id', id, '--task-id', 'acme-video', '--kind', 'interview', '--title', 'HireVue video interview', '--status', 'open']);
  assert.equal(JSON.parse(reopened.io.stdout).status, 'open');
  const list = JSON.parse((await cli(['task', 'list', '--home', home, '--json'])).io.stdout);
  assert.deepEqual(list.map((item) => item.id), ['acme-video']);

  const other = await addApplication(home, 'Other', 'Intern');
  const conflict = await cli(['task', 'add', '--home', home, '--id', other, '--task-id', 'acme-video', '--kind', 'interview', '--title', 'Video interview']);
  assert.equal(conflict.code, 1);
  assert.match(conflict.io.stderr, /Task id conflict: acme-video belongs to application/);
}));

test('task add fails clearly for a missing application and invalid input', async () => fixture(async (home) => {
  const missing = await cli(['task', 'add', '--home', home, '--id', 'no-such-app', '--kind', 'assessment', '--title', 'OA']);
  assert.equal(missing.code, 1);
  assert.match(missing.io.stderr, /Unknown application: no-such-app/);

  const id = await addApplication(home, 'Acme', 'Intern');
  const base = ['task', 'add', '--home', home, '--id', id, '--title', 'Coding test'];
  for (const [extra, pattern] of [
    [['--kind', 'quiz'], /Task kind must be one of: assessment, interview, other/],
    [['--kind', 'assessment', '--due-at', '2026-10-01'], /ISO 8601 timestamp with a UTC offset/],
    [['--kind', 'assessment', '--due-at', '2026-10-01T23:59:00'], /ISO 8601 timestamp with a UTC offset/],
    [['--kind', 'assessment', '--due-at', '2026-02-30T12:00:00Z'], /ISO 8601 timestamp with a UTC offset/],
    [['--kind', 'assessment', '--due-at', 'next friday'], /ISO 8601 timestamp with a UTC offset/],
    [['--kind', 'assessment', '--status', 'skipped'], /Task status must be open or done/],
  ]) {
    const result = await cli([...base, ...extra]);
    assert.equal(result.code, 1, extra.join(' '));
    assert.match(result.io.stderr, pattern);
  }
  assert.deepEqual(JSON.parse((await cli(['task', 'list', '--home', home, '--json'])).io.stdout), []);
  const usage = await cli(['task', 'remove', '--home', home]);
  assert.equal(usage.code, 1);
  assert.match(usage.io.stderr, /Usage: career-journal task add\|list\|done\|reopen/);
}));

test('task list sorts by the absolute deadline with no-deadline tasks last and filters by status', async () => fixture(async (home) => {
  const acme = await addApplication(home, 'Acme', 'Intern');
  const beta = await addApplication(home, 'Beta', 'Intern');
  const add = async (id, taskId, title, dueAt) => {
    const args = ['task', 'add', '--home', home, '--id', id, '--task-id', taskId, '--kind', 'assessment', '--title', title];
    const result = await cli(dueAt ? [...args, '--due-at', dueAt] : args);
    assert.equal(result.code, 0, result.io.stderr);
  };
  await add(acme, 'no-deadline', 'Portfolio review', null);
  await add(beta, 'pacific', 'Pacific deadline', '2026-10-01T09:00:00-07:00');
  await add(acme, 'utc', 'UTC deadline', '2026-10-01T12:00:00Z');
  await add(beta, 'earliest', 'Earliest deadline', '2026-09-30T08:00:00+08:00');

  const all = JSON.parse((await cli(['task', 'list', '--home', home, '--json'])).io.stdout);
  assert.deepEqual(all.map((item) => item.id), ['earliest', 'utc', 'pacific', 'no-deadline']);

  const done = await cli(['task', 'done', '--home', home, '--task-id', 'utc']);
  assert.equal(done.code, 0, done.io.stderr);
  assert.equal(JSON.parse(done.io.stdout).status, 'done');
  assert.deepEqual(JSON.parse((await cli(['task', 'list', '--home', home, '--json', '--status', 'open'])).io.stdout).map((item) => item.id), ['earliest', 'pacific', 'no-deadline']);
  assert.deepEqual(JSON.parse((await cli(['task', 'list', '--home', home, '--json', '--status', 'done'])).io.stdout).map((item) => item.id), ['utc']);

  const text = await cli(['task', 'list', '--home', home]);
  assert.equal(text.code, 0);
  const lines = text.io.stdout.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0].split('\t'), ['earliest', '2026-09-30T08:00:00+08:00', 'open', 'assessment', 'Beta', 'Intern', 'Earliest deadline']);
  assert.equal(lines[3].split('\t')[1], '-');

  const invalid = await cli(['task', 'list', '--home', home, '--status', 'pending']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.io.stderr, /Task status must be open or done/);
}));

test('task done and reopen toggle status and reject unknown task ids', async () => fixture(async (home) => {
  const id = await addApplication(home, 'Acme', 'Intern');
  await cli(['task', 'add', '--home', home, '--id', id, '--task-id', 'oa', '--kind', 'assessment', '--title', 'OA']);
  const done = await cli(['task', 'done', '--home', home, '--task-id', 'oa']);
  assert.equal(done.code, 0, done.io.stderr);
  assert.equal(JSON.parse(done.io.stdout).status, 'done');
  const again = await cli(['task', 'done', '--home', home, '--task-id', 'oa']);
  assert.deepEqual(JSON.parse(again.io.stdout), JSON.parse(done.io.stdout));
  const reopened = await cli(['task', 'reopen', '--home', home, '--task-id', 'oa']);
  assert.equal(reopened.code, 0, reopened.io.stderr);
  assert.equal(JSON.parse(reopened.io.stdout).status, 'open');

  const unknown = await cli(['task', 'done', '--home', home, '--task-id', 'missing']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.io.stderr, /Unknown task: missing/);
  const noId = await cli(['task', 'reopen', '--home', home]);
  assert.equal(noId.code, 1);
  assert.match(noId.io.stderr, /task-id is required/);
}));

test('task add stores an http(s) link, keeps it on re-add, and rejects other schemes', async () => fixture(async (home) => {
  const id = await addApplication(home, 'Acme', 'Data Science Intern');
  const base = ['task', 'add', '--home', home, '--id', id, '--task-id', 'acme-video', '--kind', 'interview', '--title', 'Video interview'];
  const added = await cli([...base, '--link', 'https://example.com/invite/abc']);
  assert.equal(added.code, 0, added.io.stderr);
  assert.equal(JSON.parse(added.io.stdout).link, 'https://example.com/invite/abc');
  const kept = await cli([...base, '--note', 'Camera on']);
  assert.equal(kept.code, 0, kept.io.stderr);
  assert.equal(JSON.parse(kept.io.stdout).link, 'https://example.com/invite/abc');
  const rejected = await cli([...base, '--link', 'javascript:alert(1)']);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.io.stderr, /task\.link must be an http or https URL/);
}));
