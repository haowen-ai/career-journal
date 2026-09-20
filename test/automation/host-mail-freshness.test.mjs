import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { automationCommand } from '../../src/commands/automation.mjs';
import { recordTrustedHostVerification } from '../../src/email/accounts.mjs';
import { markTaskRegistration, verifyTaskRegistration } from '../../src/automation/registry.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

const ACCOUNT_ID = 'host:candidate@example.test';
const EXTERNAL_ID = 'career-journal-daily';

async function createHostHome({ minutesSinceSync }) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-host-freshness-'));
  await setup(home, {
    timezone: 'UTC',
    email: {
      mode: 'configure',
      provider: 'host',
      address: 'candidate@example.test',
      settings: { connector: 'apple-mail' },
    },
    provisionAutomations: true,
  });
  const context = await openHomeDatabase(home);
  const now = Date.now();
  const verifiedAt = new Date(now - 60_000).toISOString();
  const syncedAt = new Date(now - minutesSinceSync * 60_000).toISOString();
  recordTrustedHostVerification(context.db, ACCOUNT_ID, {
    method: 'trusted-host',
    connector: 'apple-mail',
    address: 'candidate@example.test',
    externalId: 'apple-mail:candidate@example.test',
    verifiedAt,
  });
  markTaskRegistration(context.db, 'career-journal-mail-sync', {
    driver: 'codex',
    externalId: EXTERNAL_ID,
  });
  verifyTaskRegistration(context.db, 'career-journal-mail-sync', {
    method: 'trusted-host',
    verifiedAt,
  });
  context.db.prepare(`UPDATE email_accounts SET last_attempt_at = ?, last_success_at = ?,
    last_fetched_at = ?, error = NULL WHERE id = ?`).run(syncedAt, syncedAt, syncedAt, ACCOUNT_ID);
  context.db.close();
  return home;
}

test('host mail automation rejects an earlier sync instead of reporting a fresh daily check', async () => {
  const home = await createHostHome({ minutesSinceSync: 31 });
  try {
    await assert.rejects(
      () => automationCommand({
        subcommand: 'run',
        options: { home, id: 'career-journal-mail-sync', 'external-id': EXTERNAL_ID },
      }, memoryIO(), {}),
      /fresh host sync.*before.*automation run/i,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('host mail automation accepts a host sync performed immediately before the run', async () => {
  const home = await createHostHome({ minutesSinceSync: 5 });
  try {
    const io = memoryIO();
    const exitCode = await automationCommand({
      subcommand: 'run',
      options: { home, id: 'career-journal-mail-sync', 'external-id': EXTERNAL_ID },
    }, io, {});
    assert.equal(exitCode, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
