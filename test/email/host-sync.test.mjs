import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { createApplication } from '../../src/commands/application.mjs';
import { emailCommand } from '../../src/commands/email.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { syncHostBatch, validateHostBatch } from '../../src/email/host-sync.mjs';
import { markTaskRegistration, verifyTaskRegistration } from '../../src/automation/registry.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { loadConfig } from '../../src/config/store.mjs';

const ACCOUNT_ID = 'host:candidate@example.test';
const EXTERNAL_TASK_ID = 'smoke-mail-sync';

function batch(overrides = {}) {
  return {
    accountId: ACCOUNT_ID,
    connector: 'gmail',
    readOnly: true,
    beforeCursor: null,
    afterCursor: 'gmail-history-101',
    runId: 'gmail-run-101',
    fetchedAt: '2026-09-19T01:30:00Z',
    externalTaskId: EXTERNAL_TASK_ID,
    messages: [{
      sourceId: 'gmail-message-1',
      from: 'recruiting@acme.example',
      to: 'candidate@example.test',
      subject: 'Acme Data Analyst interview invitation',
      sentAt: '2026-09-19T01:00:00Z',
      body: 'Please choose an interview time',
    }],
    ...overrides,
  };
}

async function createHostHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-host-sync-'));
  await setup(home, {
    timezone: 'UTC',
    email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
    provisionAutomations: true,
  });
  const context = await openHomeDatabase(home);
  markTaskRegistration(context.db, 'career-journal-mail-sync', {
    driver: 'test', externalId: EXTERNAL_TASK_ID,
  });
  verifyTaskRegistration(context.db, 'career-journal-mail-sync', {
    method: 'trusted-host', verifiedAt: '2026-09-19T00:00:00Z',
  });
  return { home, context };
}

test('host batches require a complete read-only execution envelope', () => {
  const valid = batch({ messages: [] });
  assert.equal(validateHostBatch(valid).beforeCursor, null);
  for (const field of ['accountId', 'connector', 'beforeCursor', 'afterCursor', 'runId', 'fetchedAt', 'externalTaskId']) {
    const invalid = { ...valid };
    delete invalid[field];
    assert.throws(() => validateHostBatch(invalid), new RegExp(field, 'i'));
  }
  assert.throws(() => validateHostBatch({ ...valid, readOnly: false }), /readOnly.*true/i);
  assert.throws(() => validateHostBatch({ ...valid, fetchedAt: 'not-a-date' }), /fetchedAt/i);
});

test('host mailbox sync validates its envelope, imports once, and records replay metadata', async () => {
  const { home, context } = await createHostHome();
  try {
    createApplication(context.db, { company: 'Acme', role: 'Data Analyst', status: 'applied' }, '2026-09-19T00:00:00Z');
    context.db.close();
    const file = path.join(home, 'batch.json');
    await writeFile(file, JSON.stringify(batch()));

    const firstIo = memoryIO();
    await emailCommand({ subcommand: 'sync-host', options: { home, account: ACCOUNT_ID, file } }, firstIo);
    assert.equal(JSON.parse(firstIo.stdout).created, 1);
    const secondIo = memoryIO();
    await emailCommand({ subcommand: 'sync-host', options: { home, account: ACCOUNT_ID, file } }, secondIo);
    assert.equal(JSON.parse(secondIo.stdout).replayed, true);
    assert.equal((await loadConfig(home)).email.setupState, 'host-attested');

    const inspect = await openHomeDatabase(home);
    try {
      assert.equal(inspect.db.prepare('SELECT COUNT(*) count FROM decision_traces').get().count, 1);
      assert.equal(inspect.db.prepare('SELECT COUNT(*) count FROM application_events WHERE event_type = ?').get('email_candidate').count, 1);
      assert.equal(inspect.db.prepare('SELECT status FROM applications WHERE id = ?').get('acme-data-analyst').status, 'applied');
      const account = inspect.db.prepare(`SELECT cursor, revision, last_run_id lastRunId,
        last_batch_hash lastBatchHash, last_fetched_at lastFetchedAt FROM email_accounts WHERE id = ?`).get(ACCOUNT_ID);
      assert.equal(account.cursor, 'gmail-history-101');
      assert.equal(account.revision, 1);
      assert.equal(account.lastRunId, 'gmail-run-101');
      assert.match(account.lastBatchHash, /^[a-f0-9]{64}$/);
      assert.equal(account.lastFetchedAt, '2026-09-19T01:30:00.000Z');
      const task = inspect.db.prepare('SELECT cursor, config_json configJson FROM automations WHERE task_type = ?').get('mail-sync');
      assert.equal(task.cursor, 'gmail-history-101');
      assert.equal(JSON.parse(task.configJson).registration.lastExternalRunAt, null);
    } finally { inspect.db.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('host sync rejects account, connector, scheduler, stale cursor, and out-of-order batches before import', async () => {
  const { home, context } = await createHostHome();
  try {
    createApplication(context.db, { company: 'Acme', role: 'Data Analyst' });
    const initial = validateHostBatch(batch());
    await assert.rejects(() => syncHostBatch(context.db, 'host:other@example.test', initial), /account.*match/i);
    await assert.rejects(() => syncHostBatch(context.db, ACCOUNT_ID, validateHostBatch(batch({ connector: 'outlook' }))), /connector.*match/i);
    await assert.rejects(() => syncHostBatch(context.db, ACCOUNT_ID, validateHostBatch(batch({ externalTaskId: 'wrong-task' }))), /external.*task/i);
    context.db.prepare("UPDATE automations SET schedule = '20:05' WHERE task_type = 'mail-sync'").run();
    await assert.rejects(() => syncHostBatch(context.db, ACCOUNT_ID, initial), /attestation.*not current/i);
    context.db.prepare("UPDATE automations SET schedule = '20:00' WHERE task_type = 'mail-sync'").run();
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM decision_traces').get().count, 0);

    await syncHostBatch(context.db, ACCOUNT_ID, initial, {}, '2026-09-19T01:31:00Z');
    const stale = validateHostBatch(batch({
      runId: 'gmail-run-102', beforeCursor: null, afterCursor: 'gmail-history-102',
      fetchedAt: '2026-09-19T01:40:00Z', messages: [{ ...batch().messages[0], sourceId: 'gmail-message-2' }],
    }));
    await assert.rejects(() => syncHostBatch(context.db, ACCOUNT_ID, stale), /stale.*cursor/i);
    const outOfOrder = validateHostBatch(batch({
      runId: 'gmail-run-103', beforeCursor: 'gmail-history-101', afterCursor: 'gmail-history-103',
      fetchedAt: '2026-09-19T01:29:59Z', messages: [],
    }));
    await assert.rejects(() => syncHostBatch(context.db, ACCOUNT_ID, outOfOrder), /out.of.order/i);
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM decision_traces').get().count, 1);
    assert.equal(context.db.prepare('SELECT revision FROM email_accounts WHERE id = ?').get(ACCOUNT_ID).revision, 1);
  } finally { context.db.close(); await rm(home, { recursive: true, force: true }); }
});

test('exact replay is a no-op while a changed replay is a conflict', async () => {
  const { home, context } = await createHostHome();
  try {
    createApplication(context.db, { company: 'Acme', role: 'Data Analyst' });
    const original = validateHostBatch(batch());
    const first = await syncHostBatch(context.db, ACCOUNT_ID, original, {}, '2026-09-19T01:31:00Z');
    assert.equal(first.created, 1);
    const replay = await syncHostBatch(context.db, ACCOUNT_ID, original, {}, '2026-09-19T01:32:00Z');
    assert.equal(replay.replayed, true);
    assert.equal(replay.created, 0);
    assert.equal(context.db.prepare('SELECT revision FROM email_accounts WHERE id = ?').get(ACCOUNT_ID).revision, 1);
    assert.equal(JSON.parse(context.db.prepare("SELECT config_json configJson FROM automations WHERE task_type = 'mail-sync'").get().configJson)
      .registration.lastExternalRunAt, null);

    const changed = validateHostBatch(batch({ messages: [{ ...batch().messages[0], body: 'Changed after a successful run' }] }));
    await assert.rejects(() => syncHostBatch(context.db, ACCOUNT_ID, changed), /replay.*conflict/i);
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM decision_traces').get().count, 1);
  } finally { context.db.close(); await rm(home, { recursive: true, force: true }); }
});

test('a Jev outage falls back to the structured LLM and commits the host batch atomically', async () => {
  const { home, context } = await createHostHome();
  try {
    createApplication(context.db, { company: 'Acme', role: 'Data Analyst', status: 'applied' }, '2026-09-19T00:00:00Z');
    context.db.prepare('UPDATE email_accounts SET cursor = ? WHERE id = ?').run('gmail-history-100', ACCOUNT_ID);
    context.db.prepare("UPDATE automations SET cursor = ? WHERE task_type = 'mail-sync'").run('gmail-history-100');
    const retryBatch = validateHostBatch(batch({
      beforeCursor: 'gmail-history-100',
      afterCursor: 'gmail-history-102',
      runId: 'gmail-run-102',
      fetchedAt: '2026-09-19T02:00:00Z',
      messages: [
        { ...batch().messages[0], sourceId: 'gmail-message-101' },
        {
          sourceId: 'gmail-message-102',
          from: 'recruiting@acme.example',
          to: 'candidate@example.test',
          subject: 'Acme Data Analyst update',
          sentAt: '2026-09-19T01:30:00Z',
          body: 'We have news about your candidacy',
        },
      ],
    }));

    const result = await syncHostBatch(context.db, ACCOUNT_ID, retryBatch, {
      jev: { accessState: 'enabled', mode: 'active', threshold: 0.8, decide: async () => { throw new Error('temporary Jev outage'); } },
      structuredLlm: async () => ({ classification: 'assessment', confidence: 0.91 }),
    }, '2026-09-19T02:01:00Z');
    assert.equal(result.created, 2);
    assert.deepEqual(context.db.prepare('SELECT engine FROM decision_traces ORDER BY id').all().map((row) => row.engine).sort(), ['rules', 'structured-llm']);
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM application_events').get().count, 2);
    const committed = context.db.prepare(`SELECT cursor, revision, last_run_id lastRunId, last_batch_hash lastBatchHash,
      last_fetched_at lastFetchedAt FROM email_accounts WHERE id = ?`).get(ACCOUNT_ID);
    assert.equal(committed.cursor, 'gmail-history-102');
    assert.equal(committed.revision, 1);
    assert.equal(committed.lastRunId, 'gmail-run-102');
    assert.match(committed.lastBatchHash, /^[a-f0-9]{64}$/);
    assert.equal(committed.lastFetchedAt, '2026-09-19T02:00:00.000Z');
    assert.equal(context.db.prepare("SELECT cursor FROM automations WHERE task_type = 'mail-sync'").get().cursor, 'gmail-history-102');
  } finally { context.db.close(); await rm(home, { recursive: true, force: true }); }
});

test('competing same-cursor batches commit only the winner evidence and cursor', async () => {
  const { home, context } = await createHostHome();
  try {
    let entered = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const classify = async () => {
      entered += 1;
      if (entered === 2) release();
      await barrier;
      return { classification: 'assessment', confidence: 0.9 };
    };
    const left = validateHostBatch(batch({
      runId: 'race-left', afterCursor: 'race-left-cursor', fetchedAt: '2026-09-19T02:00:00Z',
      messages: [{ ...batch().messages[0], sourceId: 'race-left-message', subject: 'Update', body: 'There is an update' }],
    }));
    const right = validateHostBatch(batch({
      runId: 'race-right', afterCursor: 'race-right-cursor', fetchedAt: '2026-09-19T02:00:01Z',
      messages: [{ ...batch().messages[0], sourceId: 'race-right-message', subject: 'Update', body: 'There is another update' }],
    }));

    const results = await Promise.allSettled([
      syncHostBatch(context.db, ACCOUNT_ID, left, { jev: { accessState: 'enabled', mode: 'active', threshold: 0.8, decide: classify } }, '2026-09-19T02:01:00Z'),
      syncHostBatch(context.db, ACCOUNT_ID, right, { jev: { accessState: 'enabled', mode: 'active', threshold: 0.8, decide: classify } }, '2026-09-19T02:01:01Z'),
    ]);
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
    assert.match(results.find((item) => item.status === 'rejected').reason.message, /stale.*cursor|changed during processing/i);
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM decision_traces').get().count, 1);
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM application_events').get().count, 0);
    const cursor = context.db.prepare('SELECT cursor FROM email_accounts WHERE id = ?').get(ACCOUNT_ID).cursor;
    assert.ok(['race-left-cursor', 'race-right-cursor'].includes(cursor));
  } finally { context.db.close(); await rm(home, { recursive: true, force: true }); }
});

test('automatic matching requires an external ID or both company and role', async () => {
  const { home, context } = await createHostHome();
  try {
    createApplication(context.db, { company: 'Acme', role: 'Data Analyst', externalId: 'REQ-123' });
    createApplication(context.db, { company: 'Beta', role: 'Product Analyst' });
    createApplication(context.db, { company: 'Gamma', role: 'Research Scientist' });
    await syncHostBatch(context.db, ACCOUNT_ID, validateHostBatch(batch({ messages: [
      { ...batch().messages[0], sourceId: 'role-only', subject: 'Research Scientist interview invitation' },
      { ...batch().messages[0], sourceId: 'external-id', subject: 'REQ-123 interview invitation' },
      { ...batch().messages[0], sourceId: 'company-role', subject: 'Beta Product Analyst interview invitation' },
      { ...batch().messages[0], sourceId: 'marketing', subject: 'Beta Product Analyst newsletter', body: 'Recommended jobs' },
    ] })), {}, '2026-09-19T01:31:00Z');

    const traces = context.db.prepare('SELECT application_id applicationId, decision_json decisionJson FROM decision_traces').all()
      .map((row) => ({ applicationId: row.applicationId, decision: JSON.parse(row.decisionJson) }));
    assert.equal(traces.find((row) => row.decision.subject.startsWith('Research Scientist')).applicationId, null);
    assert.equal(traces.find((row) => row.decision.subject.startsWith('REQ-123')).applicationId, 'acme-data-analyst-req-123');
    assert.equal(traces.find((row) => row.decision.subject.startsWith('Beta Product Analyst interview')).applicationId, 'beta-product-analyst');
    assert.equal(traces.find((row) => row.decision.classification === 'marketing').applicationId, 'beta-product-analyst');
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM application_events').get().count, 2);
  } finally { context.db.close(); await rm(home, { recursive: true, force: true }); }
});
