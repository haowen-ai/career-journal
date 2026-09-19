import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';

function waitForDashboardUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`dashboard URL not reported\n${output}`)), 5_000);
    const consume = (chunk) => {
      output += chunk;
      const match = output.match(/Job Search Ops dashboard: (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('exit', (code) => {
      if (code !== null && !/Job Search Ops dashboard:/.test(output)) {
        clearTimeout(timeout);
        reject(new Error(`dashboard exited with ${code}\n${output}`));
      }
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

test('default start reports a friendly localhost URL that serves the dashboard', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-start-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const child = spawn(process.execPath, ['bin/jobops.mjs', 'start', '--home', home, '--port', '0'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const dashboardUrl = await waitForDashboardUrl(child);
    assert.match(dashboardUrl, /^http:\/\/job-search-ops\.localhost:\d+$/);
    const health = await fetch(`${dashboardUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, schemaVersion: 1 });
  } finally {
    await stopChild(child);
    await rm(home, { recursive: true, force: true });
  }
});

test('explicit IPv6 loopback start reports a valid bracketed URL', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-start-ipv6-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const child = spawn(process.execPath, ['bin/jobops.mjs', 'start', '--home', home, '--host', '::1', '--port', '0'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const dashboardUrl = await waitForDashboardUrl(child);
    assert.match(dashboardUrl, /^http:\/\/\[::1\]:\d+$/);
    assert.equal((await fetch(`${dashboardUrl}/api/health`)).status, 200);
  } finally {
    await stopChild(child);
    await rm(home, { recursive: true, force: true });
  }
});
