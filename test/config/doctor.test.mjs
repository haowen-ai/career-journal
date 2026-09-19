import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { setup } from '../../src/commands/setup.mjs';
import { doctor } from '../../src/commands/doctor.mjs';
import { defaultConfig } from '../../src/config/defaults.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { listTasks, markTaskRegistration, runTask, verifyTaskRegistration } from '../../src/automation/registry.mjs';
import { syncHostBatch } from '../../src/email/host-sync.mjs';
import { syncImapEmailAccount } from '../../src/email/imap-sync.mjs';
import { openDatabase, migrate, schemaMigrations } from '../../src/storage/database.mjs';
import { verifyImapEmailAccount } from '../../src/email/accounts.mjs';

class DoctorImapSocket extends Duplex {
  constructor() {
    super();
    queueMicrotask(() => this.push('* OK ready\r\n'));
  }
  _read() {}
  _write(chunk, _encoding, callback) {
    const command = chunk.toString('utf8').trim();
    const tag = command.split(' ', 1)[0];
    if (/ CAPABILITY /.test(` ${command} `)) this.push(`* CAPABILITY IMAP4rev1\r\n${tag} OK capability\r\n`);
    else if (/ LOGIN /.test(` ${command} `)) this.push(`${tag} OK authenticated\r\n`);
    else if (/ EXAMINE /.test(` ${command} `)) this.push(`* 0 EXISTS\r\n* OK [UIDVALIDITY 9] valid\r\n* OK [UIDNEXT 1] next\r\n${tag} OK read-only\r\n`);
    else if (/ UID SEARCH /.test(` ${command} `)) this.push(`* SEARCH\r\n${tag} OK search\r\n`);
    else if (/ LOGOUT$/.test(command)) this.push(`* BYE done\r\n${tag} OK logout\r\n`);
    callback();
  }
}

test('checks storage in the selected primary workspace without creating legacy state', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-doctor-storage-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const report = await doctor(home, {
      nodeVersion: '24.19.0',
      careerOps: async () => ({ ok: false, detail: 'not installed' }),
    });
    assert.equal(report.checks.find((item) => item.id === 'storage').severity, 'pass');
    await access(path.join(home, '.career-journal'));
    await assert.rejects(() => access(path.join(home, '.jobops')), { code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('checks storage in an existing legacy workspace without creating primary state', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-doctor-legacy-'));
  try {
    const legacyDirectory = path.join(home, '.jobops');
    await mkdir(legacyDirectory, { recursive: true });
    const config = defaultConfig('2026-09-19T00:00:00Z', 'UTC');
    config.data = { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' };
    config.careerOps.entrypoint = 'jobops-adapter.mjs';
    await writeFile(path.join(legacyDirectory, 'config.json'), `${JSON.stringify(config)}\n`);
    const report = await doctor(home, {
      nodeVersion: '24.19.0',
      careerOps: async () => ({ ok: false, detail: 'not installed' }),
    });
    assert.equal(report.checks.find((item) => item.id === 'storage').severity, 'pass');
    await assert.rejects(() => access(path.join(home, '.career-journal')), { code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('reports configured core and optional capability warnings', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-doctor-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' }, jev: { accessState: 'waitlisted' } });
    const report = await doctor(home, {
      nodeVersion: '24.19.0',
      storage: async () => ({ ok: true, detail: 'writable' }),
      careerOps: async () => ({ ok: false, detail: 'not installed' }),
    });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((item) => item.id === 'storage').severity, 'pass');
    assert.equal(report.checks.find((item) => item.id === 'careerops').severity, 'warn');
    assert.equal(report.checks.find((item) => item.id === 'email').severity, 'fail');
    assert.equal(report.checks.find((item) => item.id === 'automation').severity, 'fail');
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
    const result = await setup(home, { timezone: 'UTC', email: { mode: 'skip' }, model: { provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'model', secretRef: 'env:MISSING_MODEL_KEY' }, jev: { accessState: 'enabled', secretRef: 'env:MISSING_JEV_KEY' } });
    result.config.email = { setupState: 'configured', accounts: [{ id: 'unknown:a@example.test', provider: 'unknown', address: 'a@example.test', readOnly: true }] };
    result.config.jev.secretRef = 'env:MISSING_JEV_KEY';
    const { saveConfig } = await import('../../src/config/store.mjs');
    await saveConfig(home, result.config);
    const report = await doctor(home, { nodeVersion: '24.19.0', storage: async () => ({ ok: true, detail: 'writable' }), env: {} });
    assert.equal(report.checks.find((item) => item.id === 'model').severity, 'warn');
    assert.match(report.checks.find((item) => item.id === 'model').detail, /MISSING_MODEL_KEY/);
    assert.equal(report.checks.find((item) => item.id === 'jev').severity, 'warn');
    assert.equal(report.checks.find((item) => item.id === 'email').severity, 'fail');
    assert.equal(JSON.stringify(report).includes('secret-value'), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('host connector JSON remains self-attested and cannot make onboarding healthy', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-doctor-onboarding-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
      provisionAutomations: true,
    });
    const incomplete = await doctor(home, { nodeVersion: '24.19.0', storage: async () => ({ ok: true }), careerOps: async () => ({ ok: false, detail: 'optional' }) });
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.checks.find((item) => item.id === 'email').severity, 'fail');
    assert.equal(incomplete.checks.find((item) => item.id === 'automation').severity, 'fail');

    const context = await openHomeDatabase(home);
    const clock = Date.now();
    const registeredAt = new Date(clock - 2 * 60 * 1000).toISOString();
    const fetchedAt = new Date(clock - 60 * 1000).toISOString();
    for (const task of ['mail-sync', 'deadline-review', 'daily-consolidation', 'local-backup']) {
      markTaskRegistration(context.db, `career-journal-${task}`, {
        driver: 'codex', externalId: `external-${task}`, registeredAt,
      });
      verifyTaskRegistration(context.db, `career-journal-${task}`, {
        method: 'trusted-host', verifiedAt: registeredAt,
      });
    }
    const registeredOnly = await doctor(home, {
      now: new Date(clock).toISOString(), nodeVersion: '24.19.0', storage: async () => ({ ok: true }), careerOps: async () => ({ ok: false, detail: 'optional' }),
      schedulerProbe: async () => ({ ok: true, detail: 'trusted host verifier' }),
    });
    assert.equal(registeredOnly.ok, false);
    assert.match(registeredOnly.checks.find((item) => item.id === 'automation').detail, /observe one matching successful run/i);

    await syncHostBatch(context.db, 'host:candidate@example.test', {
      accountId: 'host:candidate@example.test',
      connector: 'gmail',
      readOnly: true,
      beforeCursor: null,
      afterCursor: 'initial-probe',
      runId: 'initial-probe-run',
      fetchedAt,
      externalTaskId: 'external-mail-sync',
      messages: [],
    }, {}, fetchedAt);
    for (const task of listTasks(context.db).filter((item) => item.type !== 'mail-sync')) {
      await runTask(context.db, task.id, {
        externalId: `external-${task.type}`,
        handler: async () => ({ changed: 0, cursor: task.cursor }),
      });
    }
    context.db.close();
    const complete = await doctor(home, {
      now: new Date().toISOString(), nodeVersion: '24.19.0', storage: async () => ({ ok: true }), careerOps: async () => ({ ok: false, detail: 'optional' }),
      schedulerProbe: async () => ({ ok: true, detail: 'trusted host verifier' }),
    });
    assert.equal(complete.ok, false);
    assert.equal(complete.checks.find((item) => item.id === 'email').severity, 'fail');
    assert.match(complete.checks.find((item) => item.id === 'email').detail, /self-attested|cannot prove/i);
    assert.equal(complete.checks.find((item) => item.id === 'automation').severity, 'fail');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('doctor passes mailbox health only after fresh live IMAPS verification and sync', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-doctor-imap-'));
  try {
    const now = new Date();
    const registeredAt = new Date(now.getTime() - 3 * 60 * 1000).toISOString();
    const verifiedAt = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
    const fetchedAt = new Date(now.getTime() - 60 * 1000).toISOString();
    await setup(home, {
      timezone: 'UTC',
      email: {
        mode: 'configure', provider: 'imap', address: 'candidate@school.edu', secretRef: 'env:IMAP_PASSWORD',
        settings: { host: 'imap.school.edu', port: 993, username: 'candidate@school.edu', mailbox: 'INBOX' },
      },
      provisionAutomations: true,
    });
    const context = await openHomeDatabase(home);
    for (const task of listTasks(context.db)) {
      markTaskRegistration(context.db, task.id, { driver: 'codex', externalId: `external-${task.type}`, registeredAt });
      verifyTaskRegistration(context.db, task.id, { method: 'trusted-host', verifiedAt });
    }
    await verifyImapEmailAccount(context.db, 'imap:candidate@school.edu', {
      env: { IMAP_PASSWORD: 'app-password' }, openTransport: async () => new DoctorImapSocket(), now: fetchedAt,
    });
    await assert.rejects(() => syncHostBatch(context.db, 'imap:candidate@school.edu', {
      accountId: 'imap:candidate@school.edu', connector: 'imap', readOnly: true,
      beforeCursor: null, afterCursor: 'imap-uid:9:0', runId: 'imap-live-run', fetchedAt,
      externalTaskId: 'external-mail-sync', messages: [],
    }, {}, fetchedAt), /host-managed.*account/i);

    const callerBatchReport = await doctor(home, {
      now: now.toISOString(), nodeVersion: '24.19.0', storage: async () => ({ ok: true }),
      careerOps: async () => ({ ok: false, detail: 'optional' }),
      schedulerProbe: async () => ({ ok: true, detail: 'trusted host verifier' }),
    });
    assert.equal(callerBatchReport.checks.find((item) => item.id === 'email').severity, 'fail');
    assert.equal(callerBatchReport.checks.find((item) => item.id === 'automation').severity, 'fail');

    await syncImapEmailAccount(context.db, 'imap:candidate@school.edu', {
      externalTaskId: 'external-mail-sync', env: { IMAP_PASSWORD: 'app-password' },
      openTransport: async () => new DoctorImapSocket(), now: fetchedAt,
    });
    for (const task of listTasks(context.db).filter((item) => item.type !== 'mail-sync')) {
      await runTask(context.db, task.id, {
        externalId: `external-${task.type}`,
        handler: async () => ({ changed: 0, cursor: task.cursor }),
      });
    }
    context.db.close();

    const directSyncReport = await doctor(home, {
      now: now.toISOString(), nodeVersion: '24.19.0', storage: async () => ({ ok: true }),
      careerOps: async () => ({ ok: false, detail: 'optional' }),
      schedulerProbe: async () => ({ ok: true, detail: 'trusted host verifier' }),
    });
    assert.equal(directSyncReport.checks.find((item) => item.id === 'email').severity, 'pass');
    assert.equal(directSyncReport.checks.find((item) => item.id === 'automation').severity, 'fail');

    const afterDirectSync = await openHomeDatabase(home);
    const mailTask = listTasks(afterDirectSync.db).find((item) => item.type === 'mail-sync');
    await runTask(afterDirectSync.db, mailTask.id, {
      externalId: 'external-mail-sync',
      handler: async () => ({ changed: 0, cursor: mailTask.cursor }),
    });
    afterDirectSync.db.close();

    const report = await doctor(home, {
      now: now.toISOString(), nodeVersion: '24.19.0', storage: async () => ({ ok: true }),
      careerOps: async () => ({ ok: false, detail: 'optional' }),
      schedulerProbe: async () => ({ ok: true, detail: 'trusted host verifier' }),
    });
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((item) => item.id === 'email').severity, 'pass');
    assert.match(report.checks.find((item) => item.id === 'email').detail, /live-verified.*IMAPS/i);
    assert.equal(report.checks.find((item) => item.id === 'automation').severity, 'pass');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('daily mailbox and scheduler evidence becomes unhealthy after 36 hours', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-doctor-stale-'));
  try {
    await setup(home, {
      timezone: 'UTC',
      email: { mode: 'configure', provider: 'host', address: 'candidate@example.test', settings: { connector: 'gmail' } },
      provisionAutomations: true,
    });
    const context = await openHomeDatabase(home);
    const registeredAt = '2026-09-17T08:00:00.000Z';
    const staleRun = '2026-09-17T09:00:00.000Z';
    for (const task of listTasks(context.db)) {
      markTaskRegistration(context.db, task.id, { driver: 'codex', externalId: `external-${task.type}`, registeredAt });
      verifyTaskRegistration(context.db, task.id, { method: 'trusted-host', verifiedAt: registeredAt });
      const current = listTasks(context.db).find((item) => item.id === task.id);
      context.db.prepare('UPDATE automations SET last_success_at = ?, config_json = ? WHERE id = ?').run(
        staleRun,
        JSON.stringify({ ...current.config, registration: { ...current.config.registration, lastExternalRunAt: staleRun } }),
        task.id,
      );
    }
    context.db.prepare(`UPDATE email_accounts SET last_success_at = ?, last_fetched_at = ?, error = NULL
      WHERE id = 'host:candidate@example.test'`).run(staleRun, staleRun);
    context.db.close();

    const report = await doctor(home, {
      now: '2026-09-19T00:00:00.000Z', nodeVersion: '24.19.0', storage: async () => ({ ok: true }), careerOps: async () => ({ ok: false, detail: 'optional' }),
    });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((item) => item.id === 'email').severity, 'fail');
    assert.equal(report.checks.find((item) => item.id === 'automation').severity, 'fail');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('manual EML remains an import fallback and does not satisfy daily mailbox health', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-doctor-manual-email-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'configure', provider: 'manual-eml', address: 'candidate@example.test' } });
    const report = await doctor(home, { nodeVersion: '24.19.0', storage: async () => ({ ok: true }), careerOps: async () => ({ ok: false, detail: 'optional' }) });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((item) => item.id === 'email').severity, 'fail');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('doctor reports pending migrations without mutating an alpha.5 database', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-doctor-migration-'));
  try {
    const legacyDirectory = path.join(home, '.jobops');
    await mkdir(legacyDirectory, { recursive: true });
    const config = defaultConfig('2026-09-19T00:00:00Z', 'UTC');
    config.data = { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' };
    await writeFile(path.join(legacyDirectory, 'config.json'), `${JSON.stringify(config)}\n`);
    const database = path.join(legacyDirectory, 'jobops.db');
    const seed = openDatabase(database);
    migrate(seed, { migrations: [schemaMigrations[0]] });
    seed.close();

    const report = await doctor(home, {
      nodeVersion: '24.19.0', storage: async () => ({ ok: true }), careerOps: async () => ({ ok: false, detail: 'optional' }),
    });
    assert.equal(report.ok, false);
    assert.match(report.checks.find((item) => item.id === 'migration').detail, /pending versions 2/);

    const inspect = openDatabase(database);
    assert.deepEqual(inspect.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version), [1]);
    assert.equal(inspect.prepare('PRAGMA table_info(email_accounts)').all().some((column) => column.name === 'config_json'), false);
    inspect.close();
    await assert.rejects(() => openHomeDatabase(home), /migrations pending/i);
  } finally { await rm(home, { recursive: true, force: true }); }
});
