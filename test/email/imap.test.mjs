import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import {
  configureEmailAccount,
  isLiveVerifiedEmailAccount,
  listEmailAccounts,
  verifyImapEmailAccount,
} from '../../src/email/accounts.mjs';
import { fetchImapMailbox, probeImapConnection } from '../../src/email/imap.mjs';
import { syncHostBatch } from '../../src/email/host-sync.mjs';
import { listTasks, markTaskRegistration, upsertTask, verifyTaskRegistration } from '../../src/automation/registry.mjs';
import { syncImapEmailAccount } from '../../src/email/imap-sync.mjs';
import { setup, setupCommand } from '../../src/commands/setup.mjs';
import { emailCommand } from '../../src/commands/email.mjs';
import { doctor } from '../../src/commands/doctor.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { loadConfig } from '../../src/config/store.mjs';

class FakeImapSocket extends Duplex {
  constructor({ rejectLogin = false, messages = {} } = {}) {
    super();
    this.rejectLogin = rejectLogin;
    this.messages = messages;
    this.commands = [];
    queueMicrotask(() => this.push('* OK fake-imap ready\r\n'));
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    const command = chunk.toString('utf8').trim();
    this.commands.push(command);
    const tag = command.split(' ', 1)[0];
    if (/ CAPABILITY /.test(` ${command} `)) this.push(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK capability\r\n`);
    else if (/ LOGIN /.test(` ${command} `)) this.push(`${tag} ${this.rejectLogin ? 'NO invalid credentials' : 'OK authenticated'}\r\n`);
    else if (/ EXAMINE /.test(` ${command} `)) {
      const highest = Math.max(0, ...Object.keys(this.messages).map(Number));
      this.push(`* ${Object.keys(this.messages).length} EXISTS\r\n* OK [UIDVALIDITY 77] valid\r\n* OK [UIDNEXT ${highest + 1}] next\r\n${tag} OK read-only\r\n`);
    }
    else if (/ UID SEARCH /.test(` ${command} `)) this.push(`* SEARCH ${Object.keys(this.messages).join(' ')}\r\n${tag} OK search\r\n`);
    else if (/ UID FETCH /.test(` ${command} `)) {
      const uid = /UID FETCH (\d+)/.exec(command)?.[1];
      const raw = this.messages[uid];
      if (!raw) this.push(`${tag} NO missing\r\n`);
      else this.push(`* 1 FETCH (UID ${uid} BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n${tag} OK fetch\r\n`);
    }
    else if (/ LOGOUT$/.test(command)) this.push(`* BYE done\r\n${tag} OK logout\r\n`);
    callback();
  }
}

test('IMAPS probe authenticates and opens the mailbox read-only without returning credentials', async () => {
  const socket = new FakeImapSocket();
  const result = await probeImapConnection({
    host: 'imap.school.edu',
    port: 993,
    username: 'student@school.edu',
    mailbox: 'INBOX',
    secretRef: 'env:CAREER_JOURNAL_IMAP_PASSWORD',
  }, {
    env: { CAREER_JOURNAL_IMAP_PASSWORD: 'app-password' },
    openTransport: async () => socket,
    now: '2026-09-19T12:00:00.000Z',
  });

  assert.deepEqual(result, {
    method: 'imap-tls',
    server: 'imap.school.edu',
    port: 993,
    username: 'student@school.edu',
    mailbox: 'INBOX',
    verifiedAt: '2026-09-19T12:00:00.000Z',
  });
  assert.match(socket.commands.join('\n'), /LOGIN "student@school\.edu" "app-password"/);
  assert.match(socket.commands.join('\n'), /EXAMINE "INBOX"/);
  assert.equal(JSON.stringify(result).includes('app-password'), false);
});

test('IMAPS probe requires an environment-backed credential and rejects failed login', async () => {
  await assert.rejects(() => probeImapConnection({
    host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX', secretRef: 'env:IMAP_PASSWORD',
  }, { env: {}, openTransport: async () => new FakeImapSocket() }), /IMAP_PASSWORD.*not set/i);

  await assert.rejects(() => probeImapConnection({
    host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX', secretRef: 'env:IMAP_PASSWORD',
  }, { env: { IMAP_PASSWORD: 'wrong-secret' }, openTransport: async () => new FakeImapSocket({ rejectLogin: true }) }), /authentication failed/i);
});

test('IMAPS fetch reads messages with BODY.PEEK and advances a UIDVALIDITY cursor', async () => {
  const raw = 'Message-ID: <real-42@school.edu>\r\nFrom: recruiter@company.com\r\nTo: student@school.edu\r\nSubject: Interview invitation\r\nDate: Sat, 19 Sep 2026 11:30:00 +0000\r\n\r\nPlease choose an interview time';
  const socket = new FakeImapSocket({ messages: { 42: raw } });
  const result = await fetchImapMailbox({
    host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX', secretRef: 'env:IMAP_PASSWORD',
  }, { beforeCursor: null }, {
    env: { IMAP_PASSWORD: 'app-password' }, openTransport: async () => socket, now: '2026-09-19T12:00:00.000Z',
  });

  assert.equal(result.beforeCursor, null);
  assert.equal(result.afterCursor, 'imap-uid:77:42');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, '<real-42@school.edu>');
  assert.equal(result.messages[0].subject, 'Interview invitation');
  assert.match(result.messages[0].body, /choose an interview time/i);
  assert.ok(socket.commands.some((command) => /UID SEARCH SINCE/.test(command)));
  assert.ok(socket.commands.some((command) => /UID FETCH 42 \(UID BODY\.PEEK\[\]\)/.test(command)));
});

test('IMAPS fetch pages oldest-first without advancing past unfetched UIDs', async () => {
  const raw = 'From: recruiter@company.com\r\nTo: student@school.edu\r\nSubject: Update\r\n\r\nApplication update';
  const messages = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [String(index + 1), raw]));
  const first = await fetchImapMailbox({
    host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX', secretRef: 'env:IMAP_PASSWORD',
  }, { beforeCursor: null }, {
    env: { IMAP_PASSWORD: 'app-password' }, openTransport: async () => new FakeImapSocket({ messages }), now: '2026-09-19T12:00:00.000Z',
  });
  assert.equal(first.messages.length, 200);
  assert.equal(first.afterCursor, 'imap-uid:77:200');

  const second = await fetchImapMailbox({
    host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX', secretRef: 'env:IMAP_PASSWORD',
  }, { beforeCursor: first.afterCursor }, {
    env: { IMAP_PASSWORD: 'app-password' }, openTransport: async () => new FakeImapSocket({ messages }), now: '2026-09-19T12:05:00.000Z',
  });
  assert.equal(second.messages.length, 1);
  assert.equal(second.afterCursor, 'imap-uid:77:201');
});

test('only a live IMAPS probe records mailbox verification provenance', async () => {
  const db = openDatabase(':memory:'); migrate(db);
  try {
    const account = configureEmailAccount(db, {
      provider: 'imap',
      address: 'student@school.edu',
      secretRef: 'env:IMAP_PASSWORD',
      settings: { host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX' },
    });
    assert.equal(isLiveVerifiedEmailAccount(account, '2026-09-19T12:30:00.000Z'), false);

    await verifyImapEmailAccount(db, account.id, {
      env: { IMAP_PASSWORD: 'app-password' },
      openTransport: async () => new FakeImapSocket(),
      now: '2026-09-19T12:00:00.000Z',
    });
    const verified = listEmailAccounts(db)[0];
    assert.equal(isLiveVerifiedEmailAccount(verified, '2026-09-19T12:30:00.000Z'), true);
    assert.deepEqual(verified.settings.verification, {
      method: 'imap-tls',
      address: 'student@school.edu',
      server: 'imap.school.edu',
      port: 993,
      mailbox: 'INBOX',
      verifiedAt: '2026-09-19T12:00:00.000Z',
    });
    assert.equal(JSON.stringify(verified).includes('app-password'), false);
    assert.equal(Object.hasOwn(verified, 'secretRef'), false);
  } finally { db.close(); }
});

test('changing IMAP connection settings clears prior live verification', async () => {
  const db = openDatabase(':memory:'); migrate(db);
  try {
    const input = {
      provider: 'imap', address: 'student@school.edu', secretRef: 'env:IMAP_PASSWORD',
      settings: { host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX' },
    };
    const account = configureEmailAccount(db, input);
    await verifyImapEmailAccount(db, account.id, {
      env: { IMAP_PASSWORD: 'app-password' }, openTransport: async () => new FakeImapSocket(), now: '2026-09-19T12:00:00.000Z',
    });
    configureEmailAccount(db, { ...input, settings: { ...input.settings, host: 'imap2.school.edu' } });
    const changed = listEmailAccounts(db)[0];
    assert.equal(changed.settings.verification, undefined);
    assert.equal(isLiveVerifiedEmailAccount(changed, '2026-09-19T12:30:00.000Z'), false);
  } finally { db.close(); }
});

test('caller-authored host batches cannot advance an IMAP account, even after live verification', async () => {
  const db = openDatabase(':memory:'); migrate(db);
  try {
    const account = configureEmailAccount(db, {
      provider: 'imap', address: 'student@school.edu', secretRef: 'env:IMAP_PASSWORD',
      settings: { host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX' },
    });
    const task = upsertTask(db, {
      type: 'mail-sync', enabled: true, timezone: 'UTC', time: '20:00', accountId: account.id, notificationPolicy: 'actionable',
    });
    markTaskRegistration(db, task.id, { driver: 'test', externalId: 'imap-mail-sync', registeredAt: '2026-09-19T11:00:00.000Z' });
    verifyTaskRegistration(db, task.id, { method: 'trusted-host', verifiedAt: '2026-09-19T11:01:00.000Z' });
    const payload = {
      accountId: account.id,
      connector: 'imap',
      readOnly: true,
      beforeCursor: null,
      afterCursor: 'uid-77:42',
      runId: 'imap-run-42',
      fetchedAt: '2026-09-19T12:05:00.000Z',
      externalTaskId: 'imap-mail-sync',
      messages: [],
    };
    await assert.rejects(() => syncHostBatch(db, account.id, payload, {}, '2026-09-19T12:05:00.000Z'), /host-managed.*account/i);

    await verifyImapEmailAccount(db, account.id, {
      env: { IMAP_PASSWORD: 'app-password' }, openTransport: async () => new FakeImapSocket(), now: '2026-09-19T12:00:00.000Z',
    });
    await assert.rejects(() => syncHostBatch(db, account.id, payload, {}, '2026-09-19T12:05:00.000Z'), /host-managed.*account/i);

    const stored = listEmailAccounts(db)[0];
    assert.equal(stored.cursor, null);
    assert.equal(stored.lastFetchedAt, null);
    assert.equal(stored.lastSuccessAt, null);
    const storedTask = db.prepare('SELECT cursor, last_success_at lastSuccessAt, config_json configJson FROM automations WHERE id = ?').get(task.id);
    assert.equal(storedTask.cursor, null);
    assert.equal(storedTask.lastSuccessAt, null);
    assert.equal(JSON.parse(storedTask.configJson).registration.lastExternalRunAt, null);
  } finally { db.close(); }
});

test('direct IMAPS sync proves the mailbox, fetches read-only, imports, and advances the registered task', async () => {
  const db = openDatabase(':memory:'); migrate(db);
  try {
    const account = configureEmailAccount(db, {
      provider: 'imap', address: 'student@school.edu', secretRef: 'env:IMAP_PASSWORD',
      settings: { host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX' },
    });
    const task = upsertTask(db, {
      type: 'mail-sync', enabled: true, timezone: 'UTC', time: '20:00', accountId: account.id, notificationPolicy: 'actionable',
    });
    markTaskRegistration(db, task.id, { driver: 'test', externalId: 'imap-live-job', registeredAt: '2026-09-19T11:00:00.000Z' });
    verifyTaskRegistration(db, task.id, { method: 'trusted-host', verifiedAt: '2026-09-19T11:01:00.000Z' });
    const raw = 'Message-ID: <real-42@school.edu>\r\nFrom: recruiter@company.com\r\nTo: student@school.edu\r\nSubject: Application update\r\nDate: Sat, 19 Sep 2026 11:30:00 +0000\r\n\r\nWe have an update';
    const result = await syncImapEmailAccount(db, account.id, {
      externalTaskId: 'imap-live-job',
      env: { IMAP_PASSWORD: 'app-password' },
      openTransport: async () => new FakeImapSocket({ messages: { 42: raw } }),
      now: '2026-09-19T12:00:00.000Z',
    });

    assert.equal(result.examined, 1);
    assert.equal(result.created, 1);
    const stored = listEmailAccounts(db)[0];
    assert.equal(stored.cursor, 'imap-uid:77:42');
    assert.equal(stored.lastFetchedAt, '2026-09-19T12:00:00.000Z');
    assert.equal(stored.settings.verification.method, 'imap-tls');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM decision_traces').get().count, 1);
  } finally { db.close(); }
});

test('switching mailboxes clears old task health so the new IMAPS account starts from a null cursor', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-imap-switch-'));
  try {
    const firstAddress = 'first@school.edu';
    await setup(home, {
      timezone: 'UTC',
      email: {
        mode: 'configure', provider: 'imap', address: firstAddress, secretRef: 'env:IMAP_PASSWORD',
        settings: { host: 'imap.school.edu', port: 993, username: firstAddress, mailbox: 'INBOX' },
      },
      provisionAutomations: true,
    });
    let context = await openHomeDatabase(home);
    let task = listTasks(context.db).find((item) => item.type === 'mail-sync');
    markTaskRegistration(context.db, task.id, { driver: 'test', externalId: 'first-mail-job', registeredAt: '2026-09-19T10:00:00.000Z' });
    verifyTaskRegistration(context.db, task.id, { method: 'trusted-host', verifiedAt: '2026-09-19T10:01:00.000Z' });
    await syncImapEmailAccount(context.db, `imap:${firstAddress}`, {
      externalTaskId: 'first-mail-job',
      env: { IMAP_PASSWORD: 'app-password' },
      openTransport: async () => new FakeImapSocket({ messages: {
        42: 'From: recruiter@company.com\r\nTo: first@school.edu\r\nSubject: First account\r\n\r\nUpdate',
      } }),
      now: '2026-09-19T11:00:00.000Z',
    });
    task = listTasks(context.db).find((item) => item.type === 'mail-sync');
    assert.equal(task.cursor, 'imap-uid:77:42');
    assert.equal(task.lastSuccessAt, '2026-09-19T11:00:00.000Z');
    context.db.close();

    const secondAddress = 'second@school.edu';
    const setupIo = memoryIO();
    await setupCommand({ options: {
      home,
      'email-provider': 'imap',
      'email-address': secondAddress,
      'imap-host': 'imap.school.edu',
      'imap-user': secondAddress,
      'secret-ref': 'env:IMAP_PASSWORD',
    } }, setupIo);
    assert.match(setupIo.stdout, /Email: pending-verification/);
    assert.equal((await loadConfig(home)).email.setupState, 'pending-verification');
    assert.equal((await doctor(home)).ok, false);
    await emailCommand({ subcommand: 'configure', options: {
      home,
      provider: 'imap',
      address: secondAddress,
      'imap-host': 'imap.school.edu',
      'imap-user': secondAddress,
      'secret-ref': 'env:IMAP_PASSWORD',
    } }, memoryIO());
    assert.equal((await loadConfig(home)).email.setupState, 'pending-verification');
    context = await openHomeDatabase(home);
    try {
      task = listTasks(context.db).find((item) => item.type === 'mail-sync');
      assert.equal(task.accountId, `imap:${secondAddress}`);
      assert.equal(task.cursor, null);
      assert.equal(task.lastAttemptAt, null);
      assert.equal(task.lastSuccessAt, null);
      assert.equal(task.error, null);
      assert.equal(task.config.registration, undefined);

      markTaskRegistration(context.db, task.id, { driver: 'test', externalId: 'second-mail-job', registeredAt: '2026-09-19T12:00:00.000Z' });
      verifyTaskRegistration(context.db, task.id, { method: 'trusted-host', verifiedAt: '2026-09-19T12:01:00.000Z' });
      const result = await syncImapEmailAccount(context.db, `imap:${secondAddress}`, {
        externalTaskId: 'second-mail-job',
        env: { IMAP_PASSWORD: 'app-password' },
        openTransport: async () => new FakeImapSocket(),
        now: '2026-09-19T13:00:00.000Z',
      });
      assert.equal(result.beforeCursor, null);
      assert.equal(result.afterCursor, 'imap-uid:77:0');
    } finally { context.db.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('email sync-imap CLI completes the live mailbox path and persists verified setup state', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-imap-cli-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: {
        mode: 'configure', provider: 'imap', address: 'student@school.edu', secretRef: 'env:IMAP_PASSWORD',
        settings: { host: 'imap.school.edu', port: 993, username: 'student@school.edu', mailbox: 'INBOX' },
      },
      provisionAutomations: true,
    });
    const context = await openHomeDatabase(home);
    const task = context.db.prepare("SELECT id FROM automations WHERE task_type = 'mail-sync'").get();
    markTaskRegistration(context.db, task.id, { driver: 'test', externalId: 'imap-cli-job', registeredAt: '2026-09-19T11:00:00.000Z' });
    verifyTaskRegistration(context.db, task.id, { method: 'trusted-host', verifiedAt: '2026-09-19T11:01:00.000Z' });
    context.db.close();

    const callerBatch = path.join(home, 'caller-imap-batch.json');
    await writeFile(callerBatch, JSON.stringify({
      accountId: 'imap:student@school.edu', connector: 'imap', readOnly: true,
      beforeCursor: null, afterCursor: 'imap-uid:77:0', runId: 'caller-authored',
      fetchedAt: '2026-09-19T12:00:00.000Z', externalTaskId: 'imap-cli-job', messages: [],
    }));
    for (const dryRun of [false, true]) {
      await assert.rejects(() => emailCommand({ subcommand: 'sync-host', options: {
        home, account: 'imap:student@school.edu', file: callerBatch, 'dry-run': dryRun,
      } }, memoryIO()), /host-managed.*account/i);
    }

    const io = memoryIO();
    await emailCommand({ subcommand: 'sync-imap', options: {
      home, account: 'imap:student@school.edu', 'external-task-id': 'imap-cli-job',
    } }, io, { emailCapabilities: {
      env: { IMAP_PASSWORD: 'app-password' }, openTransport: async () => new FakeImapSocket(), now: '2026-09-19T12:00:00.000Z',
    } });
    assert.equal(JSON.parse(io.stdout).examined, 0);
    assert.equal((await loadConfig(home)).email.setupState, 'verified');
    const afterSync = await openHomeDatabase(home);
    try {
      const storedTask = listTasks(afterSync.db).find((item) => item.type === 'mail-sync');
      assert.equal(storedTask.config.registration.lastExternalRunAt, null);
    } finally { afterSync.db.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});
