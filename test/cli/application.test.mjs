import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { runCli } from '../../src/cli/main.mjs';
import { createRuntime } from '../../src/runtime/create-runtime.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-cli-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('tracks two roles at one company independently', async () => fixture(async (home) => {
  const runtime = createRuntime({ root: process.cwd(), version: '0.1.0-alpha.1' });
  for (const [role, externalId] of [['Analyst', 'A-1'], ['Engineer', 'E-2']]) {
    const io = memoryIO();
    assert.equal(await runCli(['application', 'add', '--home', home, '--company', 'Acme', '--role', role, '--external-id', externalId], io, runtime), 0);
  }
  const io = memoryIO();
  assert.equal(await runCli(['application', 'list', '--home', home, '--json'], io, runtime), 0);
  const records = JSON.parse(io.stdout);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((item) => item.role), ['Analyst', 'Engineer']);
  assert.notEqual(records[0].id, records[1].id);
}));

test('event replay is a no-op and a conflicting event fails', async () => fixture(async (home) => {
  const runtime = createRuntime({ root: process.cwd(), version: '0.1.0-alpha.1' });
  const add = memoryIO();
  await runCli(['application', 'add', '--home', home, '--company', 'Acme', '--role', 'Analyst', '--external-id', 'A-1'], add, runtime);
  const id = JSON.parse(add.stdout).id;
  const args = ['event', 'record', '--home', home, '--id', id, '--event-id', 'evt-1', '--type', 'application_update', '--title', 'Received', '--observed-at', '2026-09-19T01:00:00Z', '--recorded-at', '2026-09-19T02:00:00Z'];
  const first = memoryIO();
  assert.equal(await runCli(args, first, runtime), 0);
  const replay = memoryIO();
  assert.equal(await runCli(args, replay, runtime), 0);
  assert.equal(JSON.parse(replay.stdout).created, false);
  const conflict = memoryIO();
  assert.equal(await runCli([...args, '--note', 'different'], conflict, runtime), 1);
  assert.match(conflict.stderr, /Event id conflict/);
}));

test('submitted artifacts require the submitted flag', async () => fixture(async (home) => {
  const runtime = createRuntime({ root: process.cwd(), version: '0.1.0-alpha.1' });
  const add = memoryIO();
  await runCli(['application', 'add', '--home', home, '--company', 'Acme', '--role', 'Analyst'], add, runtime);
  const id = JSON.parse(add.stdout).id;
  const pdf = path.join(home, 'resume.pdf');
  await writeFile(pdf, '%PDF-1.4\nfixture');
  const denied = memoryIO();
  assert.equal(await runCli(['artifact', 'add', '--home', home, '--id', id, '--kind', 'resume', '--lifecycle', 'submitted', '--file', pdf], denied, runtime), 1);
  const accepted = memoryIO();
  assert.equal(await runCli(['artifact', 'add', '--home', home, '--id', id, '--kind', 'resume', '--lifecycle', 'submitted', '--file', pdf, '--submitted'], accepted, runtime), 0);
  assert.equal(JSON.parse(accepted.stdout).lifecycle, 'submitted');
}));
