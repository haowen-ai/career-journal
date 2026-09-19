import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import { configureEmailAccount } from '../../src/email/accounts.mjs';
import { fingerprintMessage, importEml } from '../../src/email/eml.mjs';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createApplication } from '../../src/commands/application.mjs';

const baseMessage = {
  messageId: '<ABC@example.test>', from: 'recruiting@example.test', subject: 'Interview invitation',
  sentAt: '2026-09-19T01:00:00.000Z', body: 'Choose a time for your interview',
};

test('prefers Message-ID and otherwise uses a stable content fingerprint', () => {
  assert.equal(fingerprintMessage(baseMessage), 'message-id:abc@example.test');
  const withoutId = { ...baseMessage, messageId: null };
  assert.equal(fingerprintMessage(withoutId), fingerprintMessage({ ...withoutId }));
  assert.notEqual(fingerprintMessage(withoutId), fingerprintMessage({ ...withoutId, subject: 'Different' }));
});

test('deduplicates EML, redacts auth links, and creates a pending event without final status', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-eml-'));
  const db = openDatabase(path.join(home, 'jobops.db')); migrate(db);
  configureEmailAccount(db, { provider: 'manual-eml', address: 'candidate@example.test' });
  db.prepare('INSERT INTO applications (id, company, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('acme-role', 'Acme', 'Analyst', 'applied', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');
  const eml = path.join(home, 'message.eml');
  await writeFile(eml, `From: recruiting@example.test\nTo: candidate@example.test\nSubject: Interview invitation\nDate: Fri, 19 Sep 2026 01:00:00 +0000\nMessage-ID: <ABC@example.test>\nContent-Type: text/plain; charset=utf-8\n\nPlease schedule your interview at https://example.test/login?token=secret-value\n`);
  try {
    const first = await importEml(db, eml, { accountId: 'manual-eml:candidate@example.test', applicationId: 'acme-role', recordedAt: '2026-09-19T02:00:00Z' });
    const second = await importEml(db, eml, { accountId: 'manual-eml:candidate@example.test', applicationId: 'acme-role', recordedAt: '2026-09-19T02:00:00Z' });
    assert.equal(first.created, true);
    assert.equal(first.classification, 'interview');
    assert.equal(second.created, false);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM application_events').get().count, 1);
    assert.equal(db.prepare('SELECT status FROM applications WHERE id = ?').get('acme-role').status, 'applied');
    const stored = JSON.stringify(db.prepare('SELECT source_json, note, status_after FROM application_events').get());
    assert.equal(stored.includes('secret-value'), false);
    assert.match(stored, /pending review/i);
  } finally { db.close(); await rm(home, { recursive: true, force: true }); }
});

test('same Message-ID with changed content is a conflict and decision plus event stay atomic', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-eml-conflict-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const context = await openHomeDatabase(home);
    configureEmailAccount(context.db, { provider: 'manual-eml', address: 'candidate@example.test' });
    createApplication(context.db, { company: 'Acme', role: 'Analyst' });
    const first = path.join(home, 'first.eml');
    const changed = path.join(home, 'changed.eml');
    await writeFile(first, 'Message-ID: <same@example.test>\nSubject: Interview invitation\n\nSchedule an interview');
    await writeFile(changed, 'Message-ID: <same@example.test>\nSubject: Application update\n\nUnfortunately we are not moving forward');
    await importEml(context.db, first, { accountId: 'manual-eml:candidate@example.test', applicationId: 'acme-analyst' });
    await assert.rejects(() => importEml(context.db, changed, { accountId: 'manual-eml:candidate@example.test', applicationId: 'acme-analyst' }), /Email identity conflict/);
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM decision_traces').get().count, 1);
    assert.equal(context.db.prepare('SELECT COUNT(*) count FROM application_events').get().count, 1);
    context.db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('ambiguous email uses the configured decision router and persists its engine', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-eml-router-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const context = await openHomeDatabase(home);
    configureEmailAccount(context.db, { provider: 'manual-eml', address: 'candidate@example.test' });
    const file = path.join(home, 'ambiguous.eml');
    await writeFile(file, 'Message-ID: <router@example.test>\nSubject: Update\n\nThere is an update');
    const result = await importEml(context.db, file, { accountId: 'manual-eml:candidate@example.test' }, {
      structuredLlm: async () => ({ classification: 'assessment', confidence: 0.9 }),
    });
    assert.equal(result.classification, 'assessment');
    assert.equal(context.db.prepare('SELECT engine FROM decision_traces').get().engine, 'structured-llm');
    context.db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('marketing email keeps its decision trace without creating an application event', async () => {
  const db = openDatabase(':memory:'); migrate(db);
  const message = path.join(os.tmpdir(), `career-journal-marketing-${process.pid}.eml`);
  try {
    configureEmailAccount(db, { provider: 'manual-eml', address: 'candidate@example.test' });
    createApplication(db, { company: 'Acme', role: 'Analyst' });
    await writeFile(message, 'Message-ID: <marketing@example.test>\nSubject: Acme Analyst newsletter\n\nRecommended jobs for you');
    const result = await importEml(db, message, {
      accountId: 'manual-eml:candidate@example.test', applicationId: 'acme-analyst', recordedAt: '2026-09-19T02:00:00Z',
    });
    assert.equal(result.classification, 'marketing');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM decision_traces').get().count, 1);
    assert.equal(db.prepare('SELECT application_id applicationId FROM decision_traces').get().applicationId, 'acme-analyst');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM application_events').get().count, 0);
  } finally { db.close(); await rm(message, { force: true }); }
});
