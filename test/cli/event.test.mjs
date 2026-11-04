import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { runCli } from '../../src/cli/main.mjs';
import { createRuntime } from '../../src/runtime/create-runtime.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

const runtime = createRuntime({ root: process.cwd(), version: '0.1.0-alpha.1' });

async function cli(args) {
  const io = memoryIO();
  const code = await runCli(args, io, runtime);
  return { code, io };
}

async function withdrawnApplication(home, owner) {
  const added = await cli(['application', 'add', '--home', home, '--company', 'Acme', '--role', 'Analyst Intern', '--status', 'lead']);
  assert.equal(added.code, 0, added.io.stderr);
  const { id } = JSON.parse(added.io.stdout);
  const context = await openHomeDatabase(home);
  try { context.db.prepare("UPDATE applications SET status='withdrawn', skip_reason='duplicate', skip_owner=? WHERE id=?").run(owner, id); }
  finally { context.db.close(); }
  return id;
}

async function status(home, id) {
  const shown = await cli(['application', 'show', '--home', home, '--id', id]);
  return JSON.parse(shown.io.stdout).status;
}

test('event add reopens a review withdrawal with a submitted event and needs the explicit flag for a user withdrawal', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-cli-event-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  try {
    const review = await withdrawnApplication(home, 'review');
    const reopened = await cli(['event', 'add', '--home', home, '--id', review, '--type', 'submitted', '--title', 'Submitted', '--status-after', 'applied']);
    assert.equal(reopened.code, 0, reopened.io.stderr);
    assert.equal(await status(home, review), 'applied');

    const user = await withdrawnApplication(home, 'user');
    const base = ['event', 'add', '--home', home, '--id', user, '--type', 'submitted', '--title', 'Submitted', '--status-after', 'applied'];
    const blocked = await cli(base);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.io.stderr, /Invalid status transition: withdrawn -> applied/);
    assert.equal(await status(home, user), 'withdrawn');
    const forced = await cli([...base, '--reopen-user-withdrawal']);
    assert.equal(forced.code, 0, forced.io.stderr);
    assert.equal(await status(home, user), 'applied');
  } finally { await rm(home, { recursive: true, force: true }); }
});
