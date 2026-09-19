import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import { configureEmailAccount, disconnectEmailAccount, listEmailAccounts } from '../../src/email/accounts.mjs';
import { listTasks, markTaskRegistration, upsertTask } from '../../src/automation/registry.mjs';

test('stores only explicitly configured read-only accounts', () => {
  const db = openDatabase(':memory:'); migrate(db);
  assert.deepEqual(listEmailAccounts(db), []);
  const account = configureEmailAccount(db, { provider: 'manual-eml', address: 'candidate@example.test', secretRef: null });
  assert.equal(account.id, 'manual-eml:candidate@example.test');
  assert.equal(account.readOnly, true);
  assert.equal(listEmailAccounts(db).length, 1);
  assert.equal(JSON.stringify(account).includes('password'), false);
  db.close();
});

test('rejects writable email configuration and inline secrets', () => {
  const db = openDatabase(':memory:'); migrate(db);
  assert.throws(() => configureEmailAccount(db, { provider: 'imap', address: 'candidate@example.test', readOnly: false }), /read-only/);
  assert.throws(() => configureEmailAccount(db, { provider: 'imap', address: 'candidate@example.test', secret: 'plaintext' }), /inline secrets/);
  assert.throws(() => configureEmailAccount(db, {
    provider: 'host', address: 'candidate@example.test', secretRef: 'env:HOST_TOKEN',
  }), /must not store a secretRef/i);
  assert.throws(() => configureEmailAccount(db, {
    provider: 'manual-eml', address: 'candidate@example.test', secretRef: 'literal-token',
  }), /env:VARIABLE/);
  assert.throws(() => configureEmailAccount(db, { provider: 'host', address: 'candidate@example.test' }), /connector/);
  assert.throws(() => configureEmailAccount(db, {
    provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail', extra: 'not-allowed' },
  }), /only stores the connector name/i);
  db.close();
});

test('non-host secret references stay internal and must use an environment variable', () => {
  const db = openDatabase(':memory:'); migrate(db);
  try {
    const account = configureEmailAccount(db, {
      provider: 'manual-eml', address: 'candidate@example.test', secretRef: 'env:MAIL_IMPORT_KEY',
    });
    assert.equal(Object.hasOwn(account, 'secretRef'), false);
    assert.equal(Object.hasOwn(listEmailAccounts(db)[0], 'secretRef'), false);
    assert.equal(db.prepare('SELECT secret_ref secretRef FROM email_accounts').get().secretRef, 'env:MAIL_IMPORT_KEY');
  } finally { db.close(); }
});

test('changing a host connector requires a new successful sync probe', () => {
  const db = openDatabase(':memory:'); migrate(db);
  configureEmailAccount(db, { provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } });
  const task = upsertTask(db, {
    type: 'mail-sync', enabled: true, timezone: 'UTC', time: '20:00',
    accountId: 'host:candidate@example.test', notificationPolicy: 'actionable', cursor: 'cursor-1',
  });
  markTaskRegistration(db, task.id, { driver: 'codex', externalId: 'mail-sync-job' });
  db.prepare(`UPDATE email_accounts SET cursor = 'cursor-1', revision = 4, last_run_id = 'run-1',
    last_batch_hash = 'abc', last_fetched_at = '2026-09-19T00:00:00Z', last_success_at = '2026-09-19T00:00:00Z'
    WHERE id = 'host:candidate@example.test'`).run();

  configureEmailAccount(db, { provider: 'host', address: 'candidate@example.test', settings: { connector: 'outlook' } });
  const account = listEmailAccounts(db)[0];
  assert.deepEqual(account.settings, { connector: 'outlook' });
  assert.equal(account.cursor, null);
  assert.equal(account.revision, 5);
  assert.equal(account.lastRunId, null);
  assert.equal(account.lastBatchHash, null);
  assert.equal(account.lastFetchedAt, null);
  assert.equal(account.lastSuccessAt, null);
  const resetTask = listTasks(db)[0];
  assert.equal(resetTask.cursor, null);
  assert.equal(resetTask.config.registration, undefined);
  db.close();
});

test('disconnecting a host mailbox clears linked mail registration and execution health', () => {
  const db = openDatabase(':memory:'); migrate(db);
  const account = configureEmailAccount(db, {
    provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' },
  });
  const task = upsertTask(db, {
    type: 'mail-sync', enabled: true, timezone: 'UTC', time: '20:00', accountId: account.id, notificationPolicy: 'actionable',
  });
  markTaskRegistration(db, task.id, { driver: 'codex', externalId: 'mail-job' });
  db.prepare('UPDATE automations SET last_success_at = ? WHERE id = ?').run('2026-09-19T01:00:00Z', task.id);

  assert.equal(disconnectEmailAccount(db, account.id), true);
  const stored = db.prepare('SELECT last_success_at lastSuccessAt, config_json configJson FROM automations WHERE id = ?').get(task.id);
  assert.equal(stored.lastSuccessAt, null);
  assert.equal(JSON.parse(stored.configJson).registration, undefined);
  assert.deepEqual(listEmailAccounts(db), []);
  db.close();
});
