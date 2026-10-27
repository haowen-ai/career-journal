// Lane A — profile fields, schema 6 extras, data-home placement, redaction, identity binding, collection envelope,
// exclusions, source health (screening plan Tasks A1–A5). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, migrate, schemaMigrations } from '../../src/storage/database.mjs';
import { createApplication } from '../../src/commands/application.mjs';
import { parseGreenhouse, fetchAtsBoards, ATS_ENDPOINTS } from '../../src/scan/sources/ats-boards.mjs';
import { freshDb, load, insertPosting, seedApplication, T0, at } from '../../test-utils/funnel-v3.mjs';
import { record, SCREENING_POLICY, PROFILE } from '../../test-utils/funnel-v3-fixtures.mjs';
import { ATS_URLS, fixtureFetch } from '../../test-utils/scan-fixtures.mjs';

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireSchema6 = (lane) => {
  if (!schemaMigrations.some((item) => item.version === 6)) throw new Error(`NOT IMPLEMENTED [${lane}]: migration 006-funnel is not registered in schemaMigrations`);
};
const tempHome = (prefix) => mkdtemp(path.join(os.tmpdir(), prefix));
const setupHome = async (home) => (await import('../../src/commands/setup.mjs')).setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
const homeDb = (home) => path.join(home, '.career-journal', 'career-journal.db');
const postingFor = (db, alias) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(alias)?.posting_id;
const LONG = (text) => `${text} `.repeat(30);

// ===================================================================== A1

test('[A] migrate apply backs up an existing database before 006', async () => {
  requireSchema6('A1');
  const { migrateHome } = await import('../../src/commands/migrate.mjs');
  const home = await tempHome('cj-a-migrate-');
  try {
    await setupHome(home);
    for (const suffix of ['', '-wal', '-shm']) await rm(`${homeDb(home)}${suffix}`, { force: true });
    const v5 = openDatabase(homeDb(home));
    migrate(v5, { migrations: schemaMigrations.filter((item) => item.version <= 5) });
    v5.prepare(`INSERT INTO applications (id, company, role, status, created_at, updated_at) VALUES ('kept','Example Corp','Intern','applied','2026-09-01','2026-09-01')`).run();
    v5.close();

    const first = await migrateHome(home, {});
    assert.equal(first.dryRun, false);
    assert.deepEqual(first.applied, [6]);
    assert.equal(typeof first.backup, 'string', 'a backup is taken before migration 006 is applied');
    assert.ok(existsSync(path.join(first.backup, 'manifest.json')), 'the backup directory carries a manifest');
    const second = await migrateHome(home, {});
    assert.deepEqual(second.applied, []);
    assert.equal(second.backup, null, 'nothing pending, no backup');
    const db = openDatabase(homeDb(home));
    try { assert.equal(db.prepare("SELECT status FROM applications WHERE id = 'kept'").get().status, 'applied'); } finally { db.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('[A] schema 6 accepts prune runs, parent links, partition sightings and empty/stale/retired partitions', () => {
  const db = freshDb();
  const insertRun = (runId, kind, parent = null) => db.prepare(`INSERT INTO runs (run_id, kind, owner, started_at, heartbeat_at, finished_at, status, receipt_json, parent_run_id)
    VALUES (?, ?, 'test', ?, ?, ?, 'ok', '{}', ?)`).run(runId, kind, T0, T0, T0, parent);
  insertRun('daily-1', 'daily');
  for (const kind of ['scan', 'review', 'prune']) insertRun(`daily-1:${kind}`, kind, 'daily-1');
  assert.throws(() => insertRun('bogus-1', 'bogus'), /CHECK constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM runs WHERE parent_run_id = 'daily-1'").get().n, 3);

  insertPosting(db, { id: 'p-1' });
  db.prepare(`INSERT INTO observations (id, posting_id, source, source_id, partition, first_run_id, observed_at, fields_json, completeness_json, listed, content_hash)
    VALUES ('o-1', 'p-1', 'simplify', 's-1', 'simplify:1', 'daily-1:scan', ?, '{}', '{}', 1, 'h1')`).run(T0);
  for (const partition of ['simplify:1', 'simplify:2']) {
    db.prepare(`INSERT INTO observation_sightings (run_id, posting_id, observation_id, source, partition, seen_at) VALUES ('daily-1:scan', 'p-1', 'o-1', 'simplify', ?, ?)`).run(partition, T0);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM observation_sightings').get().n, 2, 'the sighting key includes the partition');

  for (const [partition, status, alert] of [['greenhouse:a', 'empty', 'zero'], ['greenhouse:b', 'stale', 'missing'], ['greenhouse:c', 'retired', 'removed_from_config']]) {
    db.prepare(`INSERT INTO run_sources (run_id, source, partition, status, count, errors, truncated, expected, detail, baseline, alert, raw_count, quarantined)
      VALUES ('daily-1:scan', 'greenhouse', ?, ?, 0, 0, 0, 1, '', 10, ?, 0, 0)`).run(partition, status, alert);
  }
  assert.throws(() => db.prepare(`INSERT INTO run_sources (run_id, source, partition, status, count, errors, truncated, expected, detail)
    VALUES ('daily-1:scan', 'greenhouse', 'greenhouse:d', 'weird', 0, 0, 0, 1, '')`).run(), /CHECK constraint failed/);

  db.prepare(`INSERT INTO expected_partitions (source, partition, first_expected, last_expected, retired_at) VALUES ('greenhouse', 'greenhouse:a', ?, ?, NULL)`).run(T0, T0);
  db.prepare(`INSERT INTO source_samples (partition, sampled_at, board_count, census_count, status) VALUES ('greenhouse:a', ?, 10, 8, 'sample_mismatch')`).run(T0);
  db.prepare(`INSERT INTO cooldowns (key, until, reason) VALUES ('judge:primary', ?, 'quota')`).run(at(0.25));
  db.prepare(`INSERT INTO snapshots (id, posting_id, content_hash, fetched_at, final_url, http_status, method, identity_ok, identity_reason, fields_json, sections_json, text, text_pruned_at)
    VALUES ('s-1', 'p-1', 'h', ?, 'https://example.com/x', 200, 'ats_api', 1, NULL, '{}', '[]', NULL, ?)`).run(T0, T0);

  const app = seedApplication(db, { company: 'Example Corp', role: 'Data Intern' });
  db.prepare("UPDATE applications SET deadline_at = '2027-01-15', deadline_precision = 'date', deadline_source = 'review', posting_end_at = '2027-02-01' WHERE id = ?").run(app.id);
  assert.throws(() => db.prepare("UPDATE applications SET deadline_precision = 'week' WHERE id = ?").run(app.id), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE applications SET deadline_source = 'guess' WHERE id = ?").run(app.id), /CHECK constraint failed/);
});

test('[A] home connections wait on a busy database', async () => {
  requireSchema6('A1');
  const { openHomeDatabase } = await import('../../src/runtime/home.mjs');
  const home = await tempHome('cj-a-busy-');
  let context;
  let child;
  try {
    await setupHome(home);
    context = await openHomeDatabase(home);
    assert.ok(Number(context.db.prepare('PRAGMA busy_timeout').get().timeout) >= 5000, 'busy_timeout ≥ 5000 ms');
    assert.equal(Math.max(...context.db.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version))), 6);
    // Another connection (the dashboard) holds the write lock for 300 ms; the worker must wait, not fail with SQLITE_BUSY.
    const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);`;
    child = spawn(process.execPath, ['-e', script, context.databasePath], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
    });
    const started = Date.now();
    context.db.prepare(`INSERT INTO runs (run_id, kind, owner, started_at, heartbeat_at, finished_at, status, receipt_json) VALUES ('busy-1', 'review', 'worker', ?, ?, NULL, 'running', '{}')`).run(T0, T0);
    assert.ok(Date.now() - started >= 100, 'the write waited for the other connection');
    assert.equal(context.db.prepare("SELECT COUNT(*) n FROM runs WHERE run_id = 'busy-1'").get().n, 1);
  } finally {
    child?.kill();
    try { context?.db.close(); } catch { /* closed */ }
    await rm(home, { recursive: true, force: true });
  }
});

test('[A] loadScanProfile keeps search.countries and sources.expected', async () => {
  const { loadScanProfile } = await import('../../src/scan/profile-input.mjs');
  const directory = await tempHome('cj-a-profile-');
  try {
    const withFields = path.join(directory, 'with.json');
    await writeFile(withFields, JSON.stringify({ schemaVersion: 1, search: { jobType: 'internship', countries: ['US', 'CA'] }, sources: { atsBoards: [], expected: ['careerops', 'simplify'] } }));
    const loaded = await loadScanProfile(directory, { path: withFields });
    assert.deepEqual(loaded.search.countries, ['US', 'CA']);
    assert.deepEqual(loaded.sources.expected, ['careerops', 'simplify']);
    const without = path.join(directory, 'without.json');
    await writeFile(without, JSON.stringify({ schemaVersion: 1, search: { jobType: 'internship' }, sources: { atsBoards: [] } }));
    const old = await loadScanProfile(directory, { path: without });
    assert.deepEqual(old.search.countries, []);
    assert.deepEqual(old.sources.expected, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ===================================================================== A7

test('[A] setup refuses a data home inside the code checkout', async () => {
  const inside = await mkdtemp(path.join(CHECKOUT, '.cj-home-inside-'));
  try {
    await assert.rejects(setupHome(inside), /checkout/i);
    assert.equal(existsSync(path.join(inside, '.career-journal')), false, 'nothing is created');
  } finally { await rm(inside, { recursive: true, force: true }); }
});

test('[A] openHomeDatabase refuses a home inside the checkout', async () => {
  const { openHomeDatabase, assertHomeOutsideCheckout } = await load('A7', './src/runtime/home.mjs', ['openHomeDatabase', 'assertHomeOutsideCheckout']);
  const outside = await tempHome('cj-a-outside-');
  const inside = await mkdtemp(path.join(CHECKOUT, '.cj-home-inside-'));
  try {
    assert.throws(() => assertHomeOutsideCheckout(path.join(CHECKOUT, 'data-home'), CHECKOUT), /checkout/i);
    assert.doesNotThrow(() => assertHomeOutsideCheckout(outside, CHECKOUT));
    await setupHome(outside);
    await cp(path.join(outside, '.career-journal'), path.join(inside, '.career-journal'), { recursive: true });
    await assert.rejects(openHomeDatabase(inside), /checkout/i);
  } finally {
    await rm(inside, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('[A] redact removes emails, phones and home paths but keeps example domains', async () => {
  const { redact } = await load('A7', './src/runtime/redact.mjs', ['redact']);
  assert.equal(redact('personal@candidate.dev 312-555-0100 /Users/candidate/x jo@example.com'), '<email> <phone> <home>/x jo@example.com');
});

// ===================================================================== A2

const identityModule = () => load('A2', './src/funnel/identity.mjs', ['canonicalUrl', 'providerRequisition', 'aliasesFor', 'resolvePosting', 'bindApplication', 'duplicateGroups']);

test('[A] a manual application recorded after bootstrap is bound and later scan records reuse it', async () => {
  const { resolvePosting } = await identityModule();
  const db = freshDb();
  const url = 'https://examplebank.wd1.myworkdayjobs.com/Ext/job/Chicago-IL/Data-Intern_R900333';
  const manual = createApplication(db, { company: 'Example Bank', role: 'Data Intern', jobUrl: url, status: 'applied', appliedAt: at(-1) }, at(-1));
  const bound = db.prepare('SELECT id FROM postings WHERE application_id = ?').get(manual.id);
  assert.ok(bound, 'createApplication binds the application to a posting in the same transaction');
  const aggregator = record({ source: 'simplify', sourceId: 's-333', partition: 'simplify:1', company: 'Example Bank', title: 'Data Analytics Intern',
    url: 'https://examplebank.wd1.myworkdayjobs.com/Ext/job/Chicago-IL/data-analytics-intern_R900333?source=Simplify' });
  db.exec('BEGIN IMMEDIATE');
  let resolved;
  try { resolved = resolvePosting(db, aggregator, { now: T0 }); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  assert.equal(resolved.postingId, bound.id, 'the scan record resolves to the manually recorded posting');
  assert.equal(resolved.created, false);
});

test('[A] a scan record matching a manually recorded application is reused at scan', async () => {
  const { ingestBatch } = await load('A4', './src/funnel/ingest.mjs', ['ingestBatch']);
  const db = freshDb();
  createApplication(db, { company: 'Example Bank', role: 'Data Intern', jobUrl: 'https://examplebank.wd1.myworkdayjobs.com/Ext/job/Chicago-IL/Data-Intern_R900334', status: 'applied', appliedAt: at(-1) }, at(-1));
  const counts = ingestBatch(db, { runId: 'scan-1', source: 'simplify', partition: 'simplify:1', now: T0, policy: SCREENING_POLICY, profile: PROFILE, records: [
    record({ source: 'simplify', sourceId: 's-334', partition: 'simplify:1', company: 'Example Bank', title: 'Data Intern', url: 'https://examplebank.wd1.myworkdayjobs.com/Ext/job/Chicago-IL/Data-Intern_R900334' }),
  ] });
  assert.equal(counts.reused, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state IN ('due','leased')").get().n, 0, 'no new review is due');
});

test('[A] duplicateGroups finds an old bare-id application and a new posting application for the same requisition', async () => {
  const { duplicateGroups } = await identityModule();
  const db = freshDb();
  db.prepare(`INSERT INTO applications (id, company, role, external_id, status, applied_at, created_at, updated_at)
    VALUES ('old-app', 'Acme', 'Data Intern', 'R900321', 'applied', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO applications (id, company, role, external_id, job_url, status, created_at, updated_at)
    VALUES ('new-app', 'Acme', 'Data Intern', 'posting:p-new', 'https://acme.wd5.myworkdayjobs.com/ext/job/Chicago-IL/Data-Intern_R900321', 'lead', ?, ?)`).run(T0, T0);
  insertPosting(db, { id: 'p-old', company: 'Acme', url: 'https://acme.example.com/legacy/R900321', applicationId: 'old-app', aliases: [['company_req:acme:R900321', 'company_req']] });
  insertPosting(db, { id: 'p-new', company: 'Acme', url: 'https://acme.wd5.myworkdayjobs.com/ext/job/Chicago-IL/Data-Intern_R900321', applicationId: 'new-app', aliases: [['req:workday:acme:R900321', 'req']] });
  const groups = duplicateGroups(db, { since: '2026-10-15T00:00:00.000Z' });
  assert.equal(groups.length, 1, JSON.stringify(groups));
  assert.deepEqual([...groups[0].applicationIds].sort(), ['new-app', 'old-app']);
  assert.deepEqual([...groups[0].postingIds].sort(), ['p-new', 'p-old']);
  assert.equal(groups[0].historical, false, 'one application is newer than the cutover');
  assert.equal(duplicateGroups(db, { since: '2026-12-01T00:00:00.000Z' })[0].historical, true, 'both predate the cutover');
});

test('[A] a Workday URL requisition with a -N suffix and the same requisition without it are one posting', async () => {
  const { resolvePosting, aliasesFor } = await identityModule();
  const db = freshDb();
  const url = 'https://examplebank.wd1.myworkdayjobs.com/Ext/job/Chicago-IL/Data-Intern_R900777-1';
  const board = record({ source: 'careerops', sourceId: url, partition: 'workday:Example Bank', company: 'Example Bank', title: 'Data Intern', url });
  // The detail API reports jobReqId without the URL's "-1" suffix; an aggregator carries only that field.
  const detail = record({ source: 'simplify', sourceId: 's-777', partition: 'simplify:1', company: 'Example Bank', title: 'Data Intern', url: 'https://careers.example.com/examplebank/data-intern-777', requisitionId: 'R900777' });
  const prefixed = record({ source: 'simplify', sourceId: 's-778', partition: 'simplify:1', company: 'Example Bank', title: 'Data Intern', url: 'https://careers.example.com/examplebank/data-intern-778', requisitionId: 'Req-900778' });
  const prefixedUrl = record({ source: 'careerops', sourceId: 'w-778', partition: 'workday:Example Bank', company: 'Example Bank', title: 'Data Intern', url: 'https://examplebank.wd1.myworkdayjobs.com/Ext/job/Chicago-IL/Data-Intern_Req-900778-1' });
  assert.ok(aliasesFor(board).some((item) => item.kind === 'company_req'), 'the Workday URL yields a company requisition alias');
  db.exec('BEGIN IMMEDIATE');
  try {
    const first = resolvePosting(db, board, { now: T0 });
    const second = resolvePosting(db, detail, { now: T0 });
    assert.equal(second.postingId, first.postingId, 'R900777-1 (URL) and R900777 (field) are the same requisition');
    const third = resolvePosting(db, prefixed, { now: T0 });
    const fourth = resolvePosting(db, prefixedUrl, { now: T0 });
    assert.equal(fourth.postingId, third.postingId, 'Req-900778-1 (URL) and Req-900778 (field) are the same requisition');
    assert.notEqual(third.postingId, first.postingId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM postings').get().n, 2);
});

test('[A] an iCIMS-style tracking parameter does not create a second posting', async () => {
  const { canonicalUrl, resolvePosting } = await identityModule();
  const plain = 'https://careers-examplecorp.icims.com/jobs/90055/data-intern/job';
  const tagged = `${plain}?icims=1`;
  assert.equal(canonicalUrl(tagged), canonicalUrl(plain));
  const db = freshDb();
  const app = createApplication(db, { company: 'Example Corp', role: 'Data Intern', jobUrl: tagged, status: 'applied', appliedAt: at(-1) }, at(-1));
  db.exec('BEGIN IMMEDIATE');
  let resolved;
  try { resolved = resolvePosting(db, record({ source: 'careerops', sourceId: plain, partition: 'icims:Example Corp', title: 'Data Intern', url: plain }), { now: T0 }); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  assert.equal(resolved.created, false);
  assert.equal(resolved.postingId, db.prepare('SELECT id FROM postings WHERE application_id = ?').get(app.id)?.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM postings').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM applications').get().n, 1);
});

// ===================================================================== A3

function fakeWorkday(jobsByEntry, { stderr = {} } = {}) {
  const providers = new Map([['workday', { id: 'workday', async fetch(entry) {
    for (const line of stderr[entry.name] ?? []) console.error(line);
    return jobsByEntry[entry.name] ?? [];
  } }]]);
  return { providers, resolveProvider: (entry, map) => ({ provider: map.get('workday') }), makeHttpCtx: () => ({}) };
}
const workdayJobs = (count, company = 'Bigco') => Array.from({ length: count }, (_, index) => ({
  title: `Role ${index + 1}`, company, url: `https://bigco.wd1.myworkdayjobs.com/ext/job/X/Role-${index + 1}_R90${String(index).padStart(4, '0')}`,
}));

test('[A] a Workday cap reported only on stderr makes the partition partial', async () => {
  const { collectCareerOpsRaw } = await load('A3', './src/integrations/careerops-scan-bridge.mjs', ['collectCareerOpsRaw']);
  const result = await collectCareerOpsRaw({
    portals: { tracked_companies: [{ name: 'Bigco', careers_url: 'https://bigco.wd1.myworkdayjobs.com/ext' }, { name: 'Smallco', careers_url: 'https://smallco.wd1.myworkdayjobs.com/ext' }] },
    ...fakeWorkday({ Bigco: workdayJobs(40), Smallco: workdayJobs(3, 'Smallco') }, { stderr: { Bigco: ['⚠️  workday: Bigco truncated at max_pages=2 (40 of 900 jobs)'] } }),
  });
  const byName = Object.fromEntries(result.partitions.map((item) => [item.partition.split(':').at(-1), item]));
  assert.equal(byName.Bigco.capDetected, true);
  assert.equal(byName.Bigco.status, 'partial');
  assert.equal(byName.Bigco.rawCount, 40);
  assert.equal(byName.Smallco.capDetected, false, 'the stderr line is attributed to its own entry only');
  assert.equal(byName.Smallco.status, 'ok');
});

test('[A] a Workday board whose reported total exceeds the cap, or whose page count reaches the cap, is partial', async () => {
  const { collectCareerOpsRaw } = await load('A3', './src/integrations/careerops-scan-bridge.mjs', ['collectCareerOpsRaw']);
  // The total-count signal: the board reports far more jobs (2001) than the capped fetch returned.
  const viaTotal = await collectCareerOpsRaw({
    portals: { tracked_companies: [{ name: 'Bigco', careers_url: 'https://bigco.wd1.myworkdayjobs.com/ext' }] },
    ...fakeWorkday({ Bigco: workdayJobs(2000) }, { stderr: { Bigco: ['⚠️  workday: Bigco truncated at max_pages=100 (2000 of 2001 jobs)'] } }),
  });
  assert.deepEqual([viaTotal.partitions[0].capDetected, viaTotal.partitions[0].status], [true, 'partial']);
  // The length signal: jobs.length ≥ maxPages(entry) × 20 with no stderr line and no workdayTruncated tag.
  const viaLength = await collectCareerOpsRaw({
    portals: { tracked_companies: [{ name: 'Bigco', careers_url: 'https://bigco.wd1.myworkdayjobs.com/ext', max_pages: 2 }] },
    ...fakeWorkday({ Bigco: workdayJobs(40) }),
  });
  assert.deepEqual([viaLength.partitions[0].capDetected, viaLength.partitions[0].status], [true, 'partial']);
});

test('[A] a malformed board row is emitted as invalid, not skipped', async () => {
  const board = { jobs: [
    { id: 9000901, title: 'Data Intern', absolute_url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9000901', location: { name: 'Chicago, IL' }, content: '' },
    { id: 9000902, title: 'Analytics Intern', location: { name: 'Chicago, IL' }, content: '' },
  ] };
  const parsed = parseGreenhouse(board, { ats: 'greenhouse', board: 'examplecorp' });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].invalid ?? null, null);
  assert.equal(typeof parsed[1].invalid, 'string');
  const collected = await fetchAtsBoards([{ ats: 'greenhouse', board: 'examplecorp' }], fixtureFetch({ [ATS_URLS.greenhouse]: board }));
  assert.ok(Array.isArray(collected.batches), 'collector envelope with batches');
  assert.equal(collected.batches[0].rawCount, 2);
  assert.equal(collected.batches[0].records.length, 2);
});

// ===================================================================== A4

test('[A] parser-emitted invalid rows are quarantined and conserved end to end', async () => {
  const { ingestBatch } = await load('A4', './src/funnel/ingest.mjs', ['ingestBatch']);
  const db = freshDb();
  const records = parseGreenhouse({ jobs: [
    { id: 9000911, title: 'Data Intern, Summer 2027', absolute_url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9000911', location: { name: 'Chicago, IL' }, content: '' },
    { id: 9000912, title: 'Analytics Intern, Summer 2027', absolute_url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9000912', location: { name: 'Seattle, WA' }, content: '' },
    { id: 9000913, title: 'Broken row without a link', location: { name: 'Chicago, IL' }, content: '' },
  ] }, { ats: 'greenhouse', board: 'examplecorp' });
  assert.equal(records.length, 3);
  const counts = ingestBatch(db, { runId: 'scan-1', source: 'greenhouse', partition: 'greenhouse:examplecorp', records, now: T0, policy: SCREENING_POLICY, profile: PROFILE });
  assert.equal(counts.observed, records.length, 'raw = observed');
  assert.equal(counts.quarantined, 1);
  assert.equal(counts.reused + Object.values(counts.dropped).reduce((sum, n) => sum + n, 0) + counts.review + counts.quarantined, counts.observed);
});

// ===================================================================== A5

const scanModules = async () => ({
  ...(await load('A5', './src/scan/run.mjs', ['runScan'])),
  ...(await load('A5', './src/funnel/health.mjs', ['buildExpectedManifest', 'assessSourceHealth', 'sampleOfficialBoards'])),
});
const boardsProfile = (boards, { expected = ['atsBoards'] } = {}) => ({
  search: { jobType: 'internship', countries: ['US'], exclusions: [] },
  sources: { atsBoards: boards.map(([ats, board]) => ({ ats, board })), careerOps: false, simplify: { enabled: false, url: null }, expected },
});
const part = (partition, { status = 'ok', count = 10, truncated = false, capDetected = false, detail } = {}) => ({
  source: partition.split(':')[0], partition, status, count, rawCount: count, truncated, capDetected, ...(detail ? { detail } : {}),
});
const batchFor = (partition, count) => ({
  source: partition.split(':')[0], partition, rawCount: count,
  records: Array.from({ length: count }, (_, index) => record({ source: partition.split(':')[0], partition, sourceId: `${partition}-${index}`, url: `https://job-boards.greenhouse.io/${partition.split(':')[1]}/jobs/${9100000 + index}` })),
});
async function scanOnce(db, profile, { day, runId = `scan-${day}`, parts, deadlineAt }) {
  const { runScan } = await scanModules();
  const sources = parts.map((item) => part(item[0], item[1]));
  const batches = sources.filter((item) => item.count > 0 && ['ok', 'partial'].includes(item.status)).map((item) => batchFor(item.partition, item.count));
  return runScan({ db, profile, runId, now: at(day), deadlineAt, policy: SCREENING_POLICY, collect: async () => ({ sources, batches }) });
}
const health = (summary, partition) => summary.sources.find((item) => item.partition === partition);

test('[A] the expected manifest names one partition per configured board', async () => {
  const { buildExpectedManifest } = await scanModules();
  const manifest = buildExpectedManifest(boardsProfile([['greenhouse', 'alpha'], ['lever', 'beta']], { expected: ['atsBoards', 'careerops'] }), { careerOpsPartitions: ['workday:Acme'] });
  const keys = manifest.map((item) => `${item.source}|${item.partition}`).sort();
  assert.deepEqual(keys, ['careerops|workday:Acme', 'greenhouse|greenhouse:alpha', 'lever|lever:beta']);
  assert.deepEqual(buildExpectedManifest(boardsProfile([['greenhouse', 'alpha']], { expected: [] })), [], 'nothing is expected unless the profile says so');
});

test('[A] partition health distinguishes empty, partial, disabled, stale and error', async () => {
  const db = freshDb();
  const names = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta'];
  const profile = boardsProfile(names.map((name) => ['greenhouse', name]));
  for (let day = 0; day < 4; day += 1) await scanOnce(db, profile, { day, parts: names.map((name) => [`greenhouse:${name}`, { count: 10 }]) });
  const summary = await scanOnce(db, profile, { day: 4, parts: [
    ['greenhouse:alpha', { count: 0 }],
    ['greenhouse:beta', { status: 'partial', count: 6, truncated: true, capDetected: true }],
    ['greenhouse:gamma', { status: 'disabled', count: 0, detail: 'board turned off' }],
    // delta is expected but not reported this run
    ['greenhouse:eps', { status: 'error', count: 0, detail: 'HTTP 503' }],
    ['greenhouse:zeta', { count: 3 }],
  ] });
  const view = (name) => { const item = health(summary, `greenhouse:${name}`); return item && [item.status, item.alert]; };
  assert.deepEqual(view('alpha'), ['empty', 'zero']);
  assert.deepEqual(view('beta'), ['partial', 'cap']);
  assert.deepEqual(view('gamma'), ['disabled', 'disabled']);
  assert.deepEqual(view('delta'), ['stale', 'missing']);
  assert.deepEqual(view('eps'), ['error', 'error']);
  assert.deepEqual(view('zeta'), ['ok', 'drop'], 'count < 0.5 × baseline');
  assert.equal(health(summary, 'greenhouse:zeta').baseline, 10);
  assert.equal(summary.status, 'partial');
});

test('[A] a partition empty from its first census alerts once cold start ends', async () => {
  const db = freshDb();
  const profile = boardsProfile([['greenhouse', 'fresh']]);
  const runs = [];
  for (const day of [0, 1, 2]) runs.push(await scanOnce(db, profile, { day, parts: [['greenhouse:fresh', { count: 0 }]] }));
  assert.equal(health(runs[0], 'greenhouse:fresh').alert, null, 'first empty census is cold start');
  assert.equal(health(runs[0], 'greenhouse:fresh').coldStart, true);
  assert.equal(health(runs[1], 'greenhouse:fresh').alert, null);
  assert.equal(health(runs[2], 'greenhouse:fresh').alert, 'zero', 'the third attempted census ends cold start even though none was non-empty');
  assert.equal(health(runs[2], 'greenhouse:fresh').status, 'empty');

  const old = freshDb();
  old.prepare('INSERT INTO expected_partitions (source, partition, first_expected, last_expected, retired_at) VALUES (?, ?, ?, ?, NULL)').run('greenhouse', 'greenhouse:aged', at(-8), at(-8));
  const summary = await scanOnce(old, boardsProfile([['greenhouse', 'aged']]), { day: 0, parts: [['greenhouse:aged', { count: 0 }]] });
  assert.equal(health(summary, 'greenhouse:aged').alert, 'zero', 'first expected 8 days ago: one census is enough to alert');
  assert.equal(health(summary, 'greenhouse:aged').coldStart, false);
});

test('[A] an expected partition that never reported is alerted', async () => {
  const db = freshDb();
  const profile = boardsProfile([['greenhouse', 'seen'], ['greenhouse', 'silent']]);
  const summary = await scanOnce(db, profile, { day: 0, parts: [['greenhouse:seen', { count: 4 }]] });
  assert.deepEqual([health(summary, 'greenhouse:silent')?.status, health(summary, 'greenhouse:silent')?.alert], ['stale', 'never_reported']);
  assert.equal(summary.status, 'partial');
  const row = db.prepare("SELECT status, alert FROM run_sources WHERE run_id = 'scan-0' AND partition = 'greenhouse:silent'").get();
  assert.deepEqual({ ...row }, { status: 'stale', alert: 'never_reported' }, 'the receipt row is persisted');
});

test('[A] removing an employer from the configuration is reported once, then retired', async () => {
  const db = freshDb();
  await scanOnce(db, boardsProfile([['greenhouse', 'keep'], ['greenhouse', 'gone']]), { day: 0, parts: [['greenhouse:keep', {}], ['greenhouse:gone', {}]] });
  const reduced = boardsProfile([['greenhouse', 'keep']]);
  const second = await scanOnce(db, reduced, { day: 1, parts: [['greenhouse:keep', {}]] });
  assert.deepEqual([health(second, 'greenhouse:gone')?.status, health(second, 'greenhouse:gone')?.alert], ['retired', 'removed_from_config']);
  const third = await scanOnce(db, reduced, { day: 2, parts: [['greenhouse:keep', {}]] });
  assert.ok(!health(third, 'greenhouse:gone')?.alert, 'reported once');
  assert.equal(third.status, 'ok');
  assert.ok(db.prepare("SELECT retired_at FROM expected_partitions WHERE partition = 'greenhouse:gone'").get()?.retired_at);
});

test('[A] a capped partition stays partial even when another source also lists its roles', async () => {
  const { runScan } = await scanModules();
  const db = freshDb();
  const url = 'https://bigco.wd1.myworkdayjobs.com/ext/job/X/Data-Intern_R900801';
  const profile = { search: { jobType: 'internship', countries: ['US'], exclusions: [] }, sources: { atsBoards: [], careerOps: true, simplify: { enabled: true, url: 'https://example.com/simplify/listings.json' }, expected: ['careerops'] } };
  const summary = await runScan({ db, profile, runId: 'scan-cap', now: T0, policy: SCREENING_POLICY, collect: async () => ({
    sources: [
      { source: 'careerops', partition: 'workday:Bigco', status: 'partial', count: 1, rawCount: 1, truncated: true, capDetected: true },
      { source: 'simplify', partition: 'simplify:1', status: 'ok', count: 1, rawCount: 1, truncated: false },
    ],
    batches: [
      { source: 'careerops', partition: 'workday:Bigco', rawCount: 1, records: [record({ source: 'careerops', sourceId: url, partition: 'workday:Bigco', company: 'Bigco', url })] },
      { source: 'simplify', partition: 'simplify:1', rawCount: 1, records: [record({ source: 'simplify', sourceId: 's-801', partition: 'simplify:1', company: 'Bigco', url })] },
    ],
  }) });
  assert.deepEqual([health(summary, 'workday:Bigco')?.status, health(summary, 'workday:Bigco')?.alert], ['partial', 'cap']);
  assert.equal(summary.status, 'partial');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM postings').get().n, 1);
});

test('[A] an official-board sample flags a census below the board count', async () => {
  const { sampleOfficialBoards } = await scanModules();
  const db = freshDb();
  db.prepare(`INSERT INTO runs (run_id, kind, owner, started_at, heartbeat_at, finished_at, status, receipt_json) VALUES ('scan-0', 'scan', 'test', ?, ?, ?, 'ok', '{}')`).run(T0, T0, T0);
  for (const [partition, count] of [['greenhouse:alpha', 8], ['greenhouse:beta', 10]]) {
    db.prepare(`INSERT INTO run_sources (run_id, source, partition, status, count, errors, truncated, expected, detail, baseline, alert, raw_count, quarantined)
      VALUES ('scan-0', 'greenhouse', ?, 'ok', ?, 0, 0, 1, '', NULL, NULL, ?, 0)`).run(partition, count, count);
  }
  const board = (name, n) => ({ jobs: Array.from({ length: n }, (_, index) => ({ id: 9200000 + index, title: `Role ${index}`, absolute_url: `https://job-boards.greenhouse.io/${name}/jobs/${9200000 + index}`, location: { name: 'Chicago, IL' }, content: '' })) });
  const fetchImpl = fixtureFetch({ [ATS_ENDPOINTS.greenhouse('alpha')]: board('alpha', 10), [ATS_ENDPOINTS.greenhouse('beta')]: board('beta', 10) });
  const samples = await sampleOfficialBoards(db, { now: at(0.1), fetchImpl, partitions: [
    { source: 'greenhouse', partition: 'greenhouse:alpha', ats: 'greenhouse', board: 'alpha' },
    { source: 'greenhouse', partition: 'greenhouse:beta', ats: 'greenhouse', board: 'beta' },
  ] });
  const byPartition = Object.fromEntries(samples.map((item) => [item.partition, item]));
  assert.deepEqual([byPartition['greenhouse:alpha'].boardCount, byPartition['greenhouse:alpha'].censusCount, byPartition['greenhouse:alpha'].status], [10, 8, 'sample_mismatch']);
  assert.equal(byPartition['greenhouse:beta'].status, 'ok');
  assert.equal(db.prepare("SELECT status FROM source_samples WHERE partition = 'greenhouse:alpha'").get()?.status, 'sample_mismatch');
});

test('[A] scan stops starting partitions after the daily deadline', async () => {
  const { runScan } = await scanModules();
  const db = freshDb();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); throw new Error('no fetch may start after the deadline'); };
  const summary = await runScan({ db, profile: boardsProfile([['greenhouse', 'alpha'], ['lever', 'beta']]), runId: 'scan-late', now: T0,
    deadlineAt: '2026-01-01T00:00:00.000Z', policy: SCREENING_POLICY, fetchImpl });
  assert.deepEqual(calls, [], 'no partition is started once the deadline has passed');
  for (const partition of ['greenhouse:alpha', 'lever:beta']) assert.equal(health(summary, partition)?.status, 'stale', partition);
  assert.equal(summary.status, 'partial');
});
