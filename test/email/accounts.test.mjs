import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import { configureEmailAccount, listEmailAccounts } from '../../src/email/accounts.mjs';

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
  db.close();
});

