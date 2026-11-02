import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeCareerOpsProcess } from '../../src/integrations/careerops-process.mjs';
import { runCareerOpsScan } from '../../src/integrations/careerops.mjs';
import { scanCareerOps, scanCareerOpsRaw } from '../../src/integrations/careerops-scan-bridge.mjs';
import { collectRoles } from '../../src/scan/run.mjs';

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'career-journal-scan-timeout-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'career-ops', version: '1.32.0' }));
    await writeFile(path.join(root, 'portals.yml'), 'tracked_companies: []\n');
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const timeoutMs of [undefined, null]) {
  test(`CareerOps process with ${timeoutMs} timeout starts no timer and returns delayed output`, async (t) => {
    const timer = t.mock.method(globalThis, 'setTimeout');
    const result = await executeCareerOpsProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.stdout.write("completed"), 40)'],
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    assert.equal(timer.mock.callCount(), 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'completed');
  });
}

test('CareerOps process still enforces an explicit timeout', async () => {
  await assert.rejects(executeCareerOpsProcess({
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 50,
  }), { code: 'PROCESS_TIMEOUT', message: 'CareerOps request timed out after 50ms' });
});

test('CareerOps process without a timeout still enforces the byte limit', async () => {
  await assert.rejects(executeCareerOpsProcess({
    command: process.execPath, args: ['-e', 'process.stdout.write("too large")'], maxBytes: 2,
  }), { code: 'PROCESS_TOO_LARGE' });
});

test('runCareerOpsScan passes undefined without scanTimeoutMs and preserves an explicit limit', async () => withRoot(async (root) => {
  for (const scanTimeoutMs of [undefined, 4321]) {
    let invocation;
    await runCareerOpsScan({ root, ...(scanTimeoutMs === undefined ? {} : { scanTimeoutMs }) }, {
      execute: async (options) => {
        invocation = options;
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, roles: [] }) };
      },
    });
    assert.equal(invocation.timeoutMs, scanTimeoutMs);
  }
}));

test('both CareerOps scan bridges default to no timeout and preserve an explicit limit', async () => withRoot(async (root) => {
  for (const scan of [scanCareerOps, scanCareerOpsRaw]) {
    for (const timeoutMs of [undefined, 4321]) {
      let invocation;
      await scan(root, { env: {}, ...(timeoutMs === undefined ? {} : { timeoutMs }),
        execute: async (command, args, options) => {
          invocation = options;
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, roles: [], added_urls: [] }), stderr: '' };
        },
      });
      assert.equal(invocation.timeoutMs, timeoutMs);
    }
  }
}));

test('collectRoles leaves CareerOps uncapped without a deadline and uses remaining time with a deadline', async () => withRoot(async (root) => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const remaining = 86_400_000;
  const deadlineAt = new Date(now + remaining).toISOString();
  const profile = { sources: { atsBoards: [], careerOps: true, simplify: { enabled: false } } };
  for (const scenario of [
    { expected: undefined },
    { scanTimeoutMs: 4321, expected: 4321 },
    { deadlineAt, expected: remaining },
    { deadlineAt, scanTimeoutMs: 4321, expected: 4321 },
    { deadlineAt, scanTimeoutMs: remaining * 2, expected: remaining },
  ]) {
    let invocation;
    const careerOpsConfig = { root, ...(scenario.scanTimeoutMs === undefined ? {} : { scanTimeoutMs: scenario.scanTimeoutMs }) };
    const result = await collectRoles(profile, {
      careerOpsConfig, deadlineAt: scenario.deadlineAt, clock: () => now,
      careerOpsDependencies: { execute: async (options) => {
        invocation = options;
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, roles: [], partitions: [{ partition: 'all', status: 'ok' }] }) };
      } },
    });
    assert.equal(result.sources.find((source) => source.source === 'careerops').status, 'ok');
    assert.equal(invocation.timeoutMs, scenario.expected);
    assert.equal(careerOpsConfig.scanTimeoutMs, scenario.scanTimeoutMs, 'caller config stays unchanged');
  }
}));
