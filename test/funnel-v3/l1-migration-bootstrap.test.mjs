// Lane L1 — migration 006, writer fence, bootstrap of existing state (spec sections 2, 8; review-v3 §5.2, §5.4, plan 7.1 #6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate, schemaMigrations } from '../../src/storage/database.mjs';
import { freshDb, load, seedApplication, seedCheckerWithdrawal, reviewOf, applicationsCount, tempDb, T0 } from '../../test-utils/funnel-v3.mjs';
import { PROVENANCE } from '../../test-utils/funnel-v3-fixtures.mjs';

const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
const postingOf = (db, applicationId) => db.prepare('SELECT id FROM postings WHERE application_id = ?').get(applicationId)?.id;

test('[L1] migration 006 creates the funnel tables with run membership, fencing and attempt columns', () => {
  const db = freshDb();
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const name of ['postings', 'posting_aliases', 'posting_links', 'observations', 'observation_sightings', 'runs', 'run_sources', 'snapshots', 'reviews', 'review_log', 'attempts']) {
    assert.ok(tables.has(name), `table ${name}`);
  }
  for (const name of ['lease_owner', 'lease_generation', 'lease_until', 'dep_hashes_json', 'hold_owner', 'lane', 'lost_attempts', 'paid_attempts']) assert.ok(columns(db, 'reviews').has(name), `reviews.${name}`);
  for (const name of ['run_id', 'posting_id', 'observation_id', 'source', 'partition']) assert.ok(columns(db, 'observation_sightings').has(name), `observation_sightings.${name}`);
  for (const name of ['state', 'output_path', 'tier', 'transport_retries']) assert.ok(columns(db, 'attempts').has(name), `attempts.${name}`);
  assert.ok(columns(db, 'postings').has('merged_into'));
  assert.ok(columns(db, 'applications').has('skip_owner'));
  assert.deepEqual(migrate(db).applied, [], 'idempotent');
});

test('[L1] migration 006 marks every existing skip_reason as legacy-owned', () => {
  const db = openDatabase(':memory:');
  migrate(db, { migrations: schemaMigrations.filter((item) => item.version <= 5) });
  db.prepare(`INSERT INTO applications (id, company, role, status, skip_reason, created_at, updated_at) VALUES ('a1','Example Corp','Intern','lead','hidden for review','2026-10-01','2026-10-01')`).run();
  if (!schemaMigrations.some((item) => item.version === 6)) throw new Error('NOT IMPLEMENTED [L1]: migration 006-funnel is not registered in schemaMigrations');
  migrate(db);
  assert.equal(db.prepare("SELECT skip_owner FROM applications WHERE id='a1'").get().skip_owner, 'legacy');
});

test('[L1] a legacy scan writer is blocked after migration 006 (stale writer fence)', () => {
  const db = freshDb();
  assert.throws(() => db.prepare(`INSERT INTO applications (id, company, role, external_id, status, created_at, updated_at)
    VALUES ('legacy-1','Example Corp','Data Intern','simplify:abc-123','lead','2026-11-01','2026-11-01')`).run(), /legacy scan writer blocked/);
  db.prepare(`INSERT INTO applications (id, company, role, external_id, status, created_at, updated_at)
    VALUES ('new-1','Example Corp','Data Intern','posting:p-1','lead','2026-11-01','2026-11-01')`).run();
  db.prepare(`INSERT INTO applications (id, company, role, external_id, status, created_at, updated_at)
    VALUES ('manual-1','Example Corp','Data Intern','R12345','applied','2026-11-01','2026-11-01')`).run();
});

test('[L1] a database newer than this build is refused instead of opened for writing', async () => {
  const { assertSchemaNotNewer } = await load('L1', './src/storage/database.mjs', ['assertSchemaNotNewer']);
  const harness = await tempDb();
  try {
    harness.db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future', '2027-01-01')").run();
    assert.throws(() => assertSchemaNotNewer(harness.db), /schema 99 is newer than this CAREER JOURNAL/);
  } finally { await harness.cleanup(); }
});

test('[L1] bootstrap binds every application to a posting with exact aliases', async () => {
  const { bootstrapExisting } = await load('L1', './src/funnel/bootstrap.mjs', ['bootstrapExisting']);
  const db = freshDb();
  const submitted = seedApplication(db, { company: 'Example Corp', role: 'ML Intern', status: 'applied', externalId: 'R900519', appliedAt: '2026-09-29T00:00:00Z' });
  const linked = seedApplication(db, { company: 'Example Bank', role: 'AI Engineering Intern', status: 'applied', jobUrl: 'https://examplebank.wd12.myworkdayjobs.com/Ext/job/New-York-NY/AI-Engineering-Intern_R900109-1', appliedAt: '2026-09-29T00:00:00Z' });
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  for (const app of [submitted, linked]) {
    const postingId = postingOf(db, app.id);
    assert.ok(postingId, `posting for ${app.id}`);
    const review = reviewOf(db, postingId);
    assert.equal(review.state, 'done');
    assert.equal(review.decision, 'reused');
    assert.equal(review.code, 'already_submitted');
  }
  const aliases = db.prepare('SELECT alias FROM posting_aliases').all().map((row) => row.alias);
  assert.ok(aliases.includes('company_req:example:R900519'), aliases.join(', '));
  assert.ok(aliases.some((alias) => alias.startsWith('req:workday:examplebank:R900109-1')), aliases.join(', '));
  assert.ok(aliases.includes('url:examplebank.wd12.myworkdayjobs.com/Ext/job/New-York-NY/AI-Engineering-Intern_R900109-1'), 'URL alias keeps path case');
});

test('[L1] bootstrap re-queues automated withdrawals and held leads, preserves user declines, and holds unknown provenance', async () => {
  const { bootstrapExisting } = await load('L1', './src/funnel/bootstrap.mjs', ['bootstrapExisting']);
  const db = freshDb();
  const automated = seedCheckerWithdrawal(db, { company: 'Example Corp', role: 'Analytics Intern', jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/7000001', note: 'AUTO-CHECK low fit: gaps in forecasting' });
  const declined = seedCheckerWithdrawal(db, { company: 'Example Corp', role: 'Ops Intern', jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/7000002', note: 'USER declined: not interested' });
  const unknown = seedCheckerWithdrawal(db, { company: 'Example Corp', role: 'Finance Intern', jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/7000003', note: 'skip, see notes' });
  const heldAuto = seedApplication(db, { company: 'Example Labs', role: 'Data Intern', jobUrl: 'https://jobs.lever.co/examplelabs/2f1c7c1e-0000-4000-8000-000000000001', skipReason: 'AUTO-CHECK closed: fetch failed', skipOwner: 'legacy' });
  const heldOther = seedApplication(db, { company: 'Example Labs', role: 'BI Intern', jobUrl: 'https://jobs.lever.co/examplelabs/2f1c7c1e-0000-4000-8000-000000000002', skipReason: 'waiting on recruiter answer', skipOwner: 'legacy' });
  const visible = seedApplication(db, { company: 'Example Labs', role: 'ML Intern', jobUrl: 'https://jobs.lever.co/examplelabs/2f1c7c1e-0000-4000-8000-000000000003' });
  const before = applicationsCount(db);
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });

  const r = (app) => reviewOf(db, postingOf(db, app.id));
  assert.equal(r(automated).state, 'due');
  assert.equal(r(automated).lane, 'bootstrap');
  assert.equal(r(declined).decision, 'reused');
  assert.equal(r(declined).code, 'user_declined');
  assert.equal(r(unknown).state, 'held');
  assert.equal(r(unknown).code, 'provenance_unknown');
  assert.equal(r(unknown).hold_owner, 'user');
  assert.equal(r(heldAuto).state, 'due');
  assert.equal(db.prepare('SELECT skip_owner FROM applications WHERE id = ?').get(heldAuto.id).skip_owner, 'review');
  assert.equal(r(heldOther).state, 'held');
  assert.equal(db.prepare('SELECT skip_owner FROM applications WHERE id = ?').get(heldOther.id).skip_owner, 'legacy');
  assert.equal(r(visible).lane, 'refresh');
  assert.equal(applicationsCount(db), before, 'bootstrap never creates applications');
  const declinedRow = db.prepare('SELECT status, skip_reason FROM applications WHERE id = ?').get(declined.id);
  assert.deepEqual({ ...declinedRow }, { status: 'withdrawn', skip_reason: 'USER declined: not interested' }, 'manual queue_skipped record preserved');

  const snapshot = JSON.stringify(db.prepare('SELECT * FROM reviews ORDER BY posting_id').all());
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM reviews ORDER BY posting_id').all()), snapshot, 'second bootstrap is a no-op');
});
