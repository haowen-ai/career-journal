import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { loadConfig } from '../../src/config/store.mjs';

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-setup-'));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('does not invent an email account', async () => withHome(async (home) => {
  const result = await setup(home, { timezone: 'America/Chicago', email: { mode: 'skip' } });
  assert.deepEqual(result.config.email.accounts, []);
  assert.equal(result.config.email.setupState, 'skipped');
  assert.equal((await loadConfig(home)).timezone, 'America/Chicago');
}));

test('stores only an explicit email adapter without credentials', async () => withHome(async (home) => {
  const result = await setup(home, {
    timezone: 'UTC',
    email: { mode: 'configure', provider: 'manual-eml', address: 'candidate@example.test' },
  });
  assert.deepEqual(result.config.email.accounts, [{
    id: 'manual-eml:candidate@example.test', provider: 'manual-eml', address: 'candidate@example.test', readOnly: true,
  }]);
  assert.equal(JSON.stringify(result.config).includes('token'), false);
}));

test('a second setup preserves existing provider and account choices', async () => withHome(async (home) => {
  await setup(home, {
    timezone: 'UTC',
    email: { mode: 'configure', provider: 'manual-eml', address: 'candidate@example.test' },
    model: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
  });
  const second = await setup(home, { timezone: 'America/New_York' });
  assert.equal(second.config.timezone, 'America/New_York');
  assert.equal(second.config.email.accounts.length, 1);
  assert.equal(second.config.model.provider, 'openai-compatible');
}));

test('rejects an invalid timezone', async () => withHome(async (home) => {
  await assert.rejects(() => setup(home, { timezone: 'Moon/Base' }), /Invalid IANA timezone/);
}));

