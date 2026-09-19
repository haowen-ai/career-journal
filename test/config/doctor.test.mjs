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
    assert.match(report.checks.find((item) => item.id === 'jev').detail, /waitlisted/);
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

test('reports configured versus usable provider, Jev, and email capabilities without exposing secrets', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-doctor-capabilities-'));
  try {
    const result = await setup(home, { timezone: 'UTC', email: { mode: 'skip' }, model: { provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'model', secretRef: 'env:MISSING_MODEL_KEY' }, jev: { accessState: 'enabled' } });
    result.config.email = { setupState: 'configured', accounts: [{ id: 'unknown:a@example.test', provider: 'unknown', address: 'a@example.test', readOnly: true }] };
    result.config.jev.secretRef = 'env:MISSING_JEV_KEY';
    const { saveConfig } = await import('../../src/config/store.mjs');
    await saveConfig(home, result.config);
    const report = await doctor(home, { nodeVersion: '24.19.0', storage: async () => ({ ok: true, detail: 'writable' }), env: {} });
    assert.equal(report.checks.find((item) => item.id === 'model').severity, 'warn');
    assert.match(report.checks.find((item) => item.id === 'model').detail, /MISSING_MODEL_KEY/);
    assert.equal(report.checks.find((item) => item.id === 'jev').severity, 'warn');
    assert.equal(report.checks.find((item) => item.id === 'email').severity, 'warn');
    assert.equal(JSON.stringify(report).includes('secret-value'), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
