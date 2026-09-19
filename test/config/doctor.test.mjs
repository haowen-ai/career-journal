import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { doctor } from '../../src/commands/doctor.mjs';

test('reports configured core and optional capability warnings', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-doctor-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' }, jev: { accessState: 'waitlisted' } });
    const report = await doctor(home, {
      nodeVersion: '24.19.0',
      storage: async () => ({ ok: true, detail: 'writable' }),
      careerOps: async () => ({ ok: false, detail: 'not installed' }),
    });
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((item) => item.id === 'storage').severity, 'pass');
    assert.equal(report.checks.find((item) => item.id === 'careerops').severity, 'warn');
    assert.equal(report.checks.find((item) => item.id === 'jev').detail, 'waitlisted');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('fails health when Node is below version 24', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-doctor-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const report = await doctor(home, { nodeVersion: '22.9.0', storage: async () => ({ ok: true }) });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((item) => item.id === 'node').severity, 'fail');
  } finally { await rm(home, { recursive: true, force: true }); }
});

