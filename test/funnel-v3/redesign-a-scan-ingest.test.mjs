// Redesign 2026-11-05, lane A: collection writes only what can matter (A1), settled work is not reset by a
// sighting (A2), silent provider ceilings are flagged (A3), receipts carry timings (A4), and writers wait on
// short transactions (A5). Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { aliasesFor } from '../../src/funnel/identity.mjs';
import { freshDb, insertPosting, insertReview, reviewOf, seedApplication, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { record, PROFILE, SCREENING_POLICY, JUDGMENTS, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { ingestBatch, createIngestContext, DEFAULT_CERTAIN_DROP_CODES } from '../../src/funnel/ingest.mjs';
import { runScan } from '../../src/scan/run.mjs';
import { runReview } from '../../src/review/worker.mjs';
import { parseSimplify } from '../../src/scan/sources/simplify.mjs';
import { collectCareerOpsRaw, providerCeiling, PROVIDER_CEILINGS } from '../../src/integrations/careerops-scan-bridge.mjs';
import { BUSY_TIMEOUT_MS, openDatabase } from '../../src/storage/database.mjs';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { prune, retentionPolicy } from '../../src/retention/prune.mjs';

const PARTITION = 'greenhouse:examplecorp';
const LONG = (text) => `${text} `.repeat(12);
const NO_SIGNAL = Object.freeze({ title: 'Senior Data Engineer', description: LONG('Build pipelines for our platform.') });
const urlOf = (n) => `https://job-boards.greenhouse.io/examplecorp/jobs/${n}`;
const role = (n, overrides = {}) => record({ sourceId: String(n), url: urlOf(n), ...overrides });
const postingOf = (db, n) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(`url:${urlOf(n).replace('https://', '')}`)?.posting_id;
const FULL_TIME_OPEN = Object.freeze({ search: { jobType: 'full-time', countries: [] } });
const OPEN_POLICY = Object.freeze({ ...SCREENING_POLICY, userExcludedCompanies: [] });
const ingest = (db, records, { runId = 'scan-1', now = T0, profile = PROFILE, policy = SCREENING_POLICY, source = 'greenhouse', partition = PARTITION, context } = {}) =>
  ingestBatch(db, { runId, source, partition, records, now, policy, profile, context });
const rows = (db, table, where = '1=1', ...params) => db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...params).n;
const TABLES = ['postings', 'posting_aliases', 'posting_links', 'observations', 'observation_sightings', 'posting_partitions', 'reviews', 'review_log'];
const tableCounts = (db) => Object.fromEntries(TABLES.map((table) => [table, rows(db, table)]));

// A drop stored before count-only ingest: posting and every alias exist, the review is settled.
function settledDrop(db, n, rec, code) {
  ingest(db, [rec], { runId: `seed-${n}`, profile: FULL_TIME_OPEN, policy: OPEN_POLICY });
  const id = postingOf(db, n);
  db.prepare(`UPDATE reviews SET state='done', decision='dropped', code=?, lane=?, next_due=NULL WHERE posting_id=?`)
    .run(code, code === 'no_student_signal' ? code : 'new', id);
  return id;
}

// ===================================================================== A1 count-only

test('[A1] an unknown certain-drop record creates no rows at all and is counted per class', () => {
  const db = freshDb();
  const known = { locations: 'complete', arrangement: 'known', description: 'full', employment_type: 'absent' };
  const counts = ingest(db, [
    role(1, NO_SIGNAL),
    role(2, { company: 'Excluded Example Co' }),
    role(3, { locations: ['Berlin, Germany'], remote: false, completeness: known }),
  ]);
  assert.deepEqual(tableCounts(db), Object.fromEntries(TABLES.map((table) => [table, 0])), 'nothing is written');
  assert.deepEqual([counts.observed, counts.stored, counts.countedOnly, counts.quarantined], [3, 0, 3, 0]);
  assert.deepEqual(counts.countedOnlyBy, { no_student_signal: 1, company_excluded: 1, outside_countries: 1 });
  assert.deepEqual(counts.dropped, { no_student_signal: 1, company_excluded: 1, outside_countries: 1 }, 'drops are still reported');
  // Changed at integration: the default set is the classifier's CERTAIN_DROP_CODES, which adds company_small (C1).
  assert.deepEqual([...DEFAULT_CERTAIN_DROP_CODES].sort(), ['company_excluded', 'company_small', 'no_student_signal', 'outside_countries']);
});

test('[A1] a known settled-dropped posting gets no observation or sighting, but its last_seen and membership stay current', () => {
  const db = freshDb();
  const id = settledDrop(db, 1, role(1, NO_SIGNAL), 'no_student_signal');
  const before = { observations: rows(db, 'observations'), sightings: rows(db, 'observation_sightings'), review: reviewOf(db, id) };
  const counts = ingest(db, [role(1, { ...NO_SIGNAL, description: LONG('Rewritten senior platform role.') })], { runId: 'scan-2', now: at(3) });
  assert.deepEqual([counts.stored, counts.countedOnly], [0, 1]);
  assert.equal(rows(db, 'observations'), before.observations, 'no observation row');
  assert.equal(rows(db, 'observation_sightings'), before.sightings, 'no sighting row');
  assert.deepEqual(reviewOf(db, id), before.review, 'the settled review is untouched');
  assert.equal(db.prepare('SELECT last_seen FROM postings WHERE id=?').get(id).last_seen, at(3));
  assert.equal(db.prepare('SELECT last_seen FROM posting_partitions WHERE posting_id=? AND source=? AND partition=?').get(id, 'greenhouse', PARTITION).last_seen, at(3));
  // A new partition of the same posting joins its membership too.
  ingest(db, [role(1, NO_SIGNAL)], { runId: 'scan-3', now: at(4), partition: 'greenhouse:examplecorp-2' });
  assert.equal(db.prepare('SELECT last_seen FROM posting_partitions WHERE posting_id=? AND partition=?').get(id, 'greenhouse:examplecorp-2')?.last_seen, at(4));
});

test('[A1] a known drop takes the full path when anything could matter: another class, an unowned alias, an application, a user log, a manual row', () => {
  const db = freshDb();
  const otherClass = settledDrop(db, 1, role(1, NO_SIGNAL), 'outside_countries');
  const linked = settledDrop(db, 2, role(2, NO_SIGNAL), 'no_student_signal');
  const logged = settledDrop(db, 3, role(3, NO_SIGNAL), 'no_student_signal');
  const manual = settledDrop(db, 4, role(4, NO_SIGNAL), 'no_student_signal');
  const app = seedApplication(db, { company: 'Example Corp', role: 'Senior Data Engineer', jobUrl: urlOf(2) });
  db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, linked);
  db.prepare("INSERT INTO review_log (posting_id, at, stage, kind, payload_json) VALUES (?, ?, 'deliver', 'user', '{}')").run(logged, T0);
  db.prepare(`UPDATE reviews SET flags_json='["manual"]' WHERE posting_id=?`).run(manual);
  const counts = ingest(db, [1, 2, 3, 4].map((n) => role(n, NO_SIGNAL)), { runId: 'scan-2', now: at(1) });
  assert.deepEqual([counts.stored, counts.countedOnly], [4, 0]);
  for (const id of [otherClass, linked, logged, manual]) assert.equal(rows(db, 'observation_sightings', "posting_id=? AND run_id='scan-2'", id), 1, `${id}: full sighting`);
  // A new source alias for a known posting is identity work: full path.
  const fresh = ingest(db, [role(1, { ...NO_SIGNAL, source: 'lever', sourceId: 'lv-1' })], { runId: 'scan-3', now: at(2), source: 'lever', partition: 'lever:examplecorp' });
  assert.deepEqual([fresh.stored, fresh.countedOnly], [1, 0]);
});

test('[A1] a certain-drop record that matches a submitted application takes the full path and is reused', () => {
  const db = freshDb();
  const app = seedApplication(db, { company: 'Example Corp', role: 'Senior Data Engineer', status: 'applied', jobUrl: urlOf(7), appliedAt: '2026-10-01T00:00:00Z' });
  const counts = ingest(db, [role(7, NO_SIGNAL)]);
  assert.deepEqual([counts.stored, counts.countedOnly, counts.reused], [1, 0, 1]);
  const review = reviewOf(db, postingOf(db, 7));
  assert.deepEqual([review.decision, review.code], ['reused', 'already_submitted']);
  assert.equal(JSON.parse(review.evidence_json)[0]?.applicationId ?? app.id, app.id);
});

test('[A1] an unlisted Simplify listing that matches nothing is counted; one that matches a posting takes the full path', () => {
  const db = freshDb();
  const listing = (id, overrides = {}) => ({ id, company_name: 'Synthetic Devices', title: 'Data Science Intern', url: `https://careers.synthetic.test/jobs/${id}`,
    locations: ['Chicago, IL'], terms: ['Summer 2027'], active: true, is_visible: true, ...overrides });
  const census = (listings, runId, now) => ingestBatch(db, { runId, source: 'simplify', partition: 'simplify:1', records: parseSimplify(listings, { partition: 'simplify:1' }), now, policy: SCREENING_POLICY, profile: PROFILE });
  const first = census([listing('s-1', { active: false }), listing('s-2')], 'scan-1', T0);
  assert.deepEqual([first.stored, first.countedOnly, first.countedOnlyBy], [1, 1, { unlisted: 1 }]);
  assert.equal(rows(db, 'posting_aliases', "alias='source:simplify:s-1'"), 0);
  const second = census([listing('s-2', { active: false })], 'scan-2', at(1));
  assert.deepEqual([second.stored, second.countedOnly], [1, 0], 'a known posting seen unlisted keeps today\'s path');
});

test('[A1] an eligible lead keeps full sightings, even from a record without a student signal, and still closes after two censuses without it', async () => {
  const db = freshDb();
  const profile = { ...PROFILE, sources: { expected: ['atsBoards'], atsBoards: [{ ats: 'greenhouse', board: 'examplecorp' }] } };
  const noise = (k) => Array.from({ length: 3 }, (_, i) => role(500 + i, { ...NO_SIGNAL, title: `Staff Engineer ${k}-${i}` }));
  const scan = (runId, now, records) => runScan({ db, profile, runId, now, policy: SCREENING_POLICY,
    collect: async () => ({ sources: [{ source: 'greenhouse', partition: PARTITION, status: 'ok', count: records.length, rawCount: records.length }],
      batches: [{ source: 'greenhouse', partition: PARTITION, records, rawCount: records.length }] }) });
  const first = await scan('scan-1', T0, [role(1), ...noise(1)]);
  const lead = postingOf(db, 1);
  const app = seedApplication(db, { company: 'Example Corp', role: 'Data Science Intern, Summer 2027', jobUrl: urlOf(1) });
  db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, lead);
  db.prepare("UPDATE reviews SET state='done', decision='eligible', code=NULL, next_due=NULL WHERE posting_id=?").run(lead);
  const source = first.sources.find((item) => item.partition === PARTITION);
  assert.deepEqual([source.count, source.fetched, source.stored, source.countedOnly, source.quarantined], [4, 4, 1, 3, 0], 'fetched = stored + countedOnly + quarantined');
  assert.equal(rows(db, 'observation_sightings', "posting_id=? AND run_id='scan-1'", lead), 1);
  // The same requisition read without its student signal: the lead is open, so it is sighted in full.
  await scan('scan-2', at(1), [role(1, NO_SIGNAL), ...noise(2)]);
  assert.equal(rows(db, 'observation_sightings', "posting_id=? AND run_id='scan-2'", lead), 1, 'an open lead is sighted in full');
  assert.notEqual(reviewOf(db, lead).decision, 'dropped');
  await scan('scan-3', at(2), noise(3));
  await scan('scan-4', at(3), noise(4));
  db.prepare("UPDATE reviews SET state='due', stage='fetch', next_due=? WHERE posting_id=?").run(at(4), lead);
  const judges = { primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) }), escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }) };
  await runReview({ db, runId: 'review-1', owner: 'worker-a', now: at(4), budget: 10, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fakeFetcher({ [urlOf(1)]: { ok: false, httpStatus: 404, error: 'not found' } }), judges, inputs: () => reviewInputs(), hooks: {} });
  assert.equal(db.prepare('SELECT availability FROM postings WHERE id=?').get(lead).availability, 'closed_verified', 'absent from two healthy censuses: closed');
});

test('[A1/A4] the scan receipt conserves every fetched record per source and times each ingest batch', async () => {
  const db = freshDb();
  const profile = { ...PROFILE, sources: { expected: ['atsBoards'], atsBoards: [{ ats: 'greenhouse', board: 'examplecorp' }] } };
  const records = [role(1), role(2, NO_SIGNAL), { ...role(3), url: 'not-a-url' }];
  const receipt = await runScan({ db, profile, runId: 'scan-1', now: T0, policy: SCREENING_POLICY,
    collect: async () => ({ sources: [{ source: 'greenhouse', partition: PARTITION, status: 'ok', count: 3, rawCount: 3, elapsedMs: 12 }],
      batches: [{ source: 'greenhouse', partition: PARTITION, records, rawCount: 3 }] }) });
  assert.deepEqual([receipt.counts.raw, receipt.counts.stored, receipt.counts.countedOnly, receipt.counts.quarantined], [3, 1, 1, 1]);
  const [batch] = receipt.ingest;
  assert.deepEqual([batch.fetched, batch.stored, batch.countedOnly, batch.quarantined], [3, 1, 1, 1]);
  assert.ok(Number.isInteger(batch.elapsedMs) && batch.elapsedMs >= 0);
  const source = receipt.sources.find((item) => item.partition === PARTITION);
  assert.equal(source.elapsedMs, 12, 'partition fetch time is carried into the receipt');
  assert.equal(source.count, 3, 'health reads the fetched census, not stored rows');
});

// ===================================================================== A2 decide once at ingest

test('[A2] a content change resets open work only; settled not_eligible and unclear stay; a delisted posting listed again is relisted', () => {
  const db = freshDb();
  ingest(db, [1, 2, 3, 4, 5].map((n) => role(n)));
  const [notEligible, unclear, held, closed, closedStillListed] = [1, 2, 3, 4, 5].map((n) => postingOf(db, n));
  const settle = db.prepare("UPDATE reviews SET state=?, decision=?, code=?, hold_owner=?, next_due=NULL WHERE posting_id=?");
  settle.run('done', 'not_eligible', 'requirement_conflict', null, notEligible);
  settle.run('done', 'unclear', 'missing_fact', null, unclear);
  settle.run('held', 'unclear', 'browser_review', 'system', held);
  settle.run('done', 'not_eligible', 'closed_verified', null, closed);
  settle.run('done', 'not_eligible', 'closed_verified', null, closedStillListed);
  db.prepare("UPDATE postings SET listed=0, availability='closed_verified' WHERE id=?").run(closed);
  ingest(db, [1, 2, 3, 4, 5].map((n) => role(n, { description: LONG('Rewritten summer 2027 internship.') })), { runId: 'scan-2', now: at(1) });
  assert.deepEqual([reviewOf(db, notEligible).state, reviewOf(db, notEligible).decision], ['done', 'not_eligible']);
  assert.deepEqual([reviewOf(db, unclear).state, reviewOf(db, unclear).decision], ['done', 'unclear']);
  assert.equal(reviewOf(db, held).state, 'due', 'a system hold is open work');
  assert.equal(reviewOf(db, closed).state, 'due', 'relisted after delisting');
  assert.ok(JSON.parse(reviewOf(db, closed).flags_json).includes('authorization:relist'));
  const log = db.prepare("SELECT payload_json FROM review_log WHERE posting_id=? AND kind='outcome'").all(closed).map((row) => JSON.parse(row.payload_json));
  assert.deepEqual(log.map((item) => [item.action, item.authorization]), [['relisted', 'relist']]);
  assert.deepEqual([reviewOf(db, closedStillListed).state, reviewOf(db, closedStillListed).code], ['done', 'closed_verified'], 'never left the board: not a relist');
});

// ===================================================================== A3 provider ceilings

test('[A3] a CareerOps partition that returns exactly a known provider ceiling is flagged cap', async () => {
  const jobs = (n) => Array.from({ length: n }, (_, i) => ({ id: `j-${i}`, title: `Role ${i}`, url: `https://example.test/jobs/${i}` }));
  assert.deepEqual(PROVIDER_CEILINGS, { successfactors: 1000, oraclecloud: 5000, smartrecruiters: 5000 });
  assert.equal(providerCeiling('workday', { max_pages: 1500 }), 30000);
  assert.equal(providerCeiling('radancy', {}), 2000);
  assert.equal(providerCeiling('radancy', { max_jobs: 5000 }), 5000);
  assert.equal(providerCeiling('greenhouse', {}), null);
  // A raised limit moves the ceiling, so `cap` stays truthful after the entry is configured.
  assert.equal(providerCeiling('successfactors', { max_jobs: 5000 }), 5000);
  assert.equal(providerCeiling('oraclecloud', { max_pages: 150 }), 30000);
  assert.equal(providerCeiling('smartrecruiters', { max_pages: 1000 }), 100000);
  assert.equal(providerCeiling('smartrecruiters', {}), 5000);
  assert.equal(providerCeiling('jibeapply', {}), 500);
  assert.equal(providerCeiling('jibeapply', { max_pages: 300 }), 3000);
  assert.equal(providerCeiling('jibeapply', { max_pages: 100000 }), 50000);
  const jibe = await collectCareerOpsRaw({
    portals: { tracked_companies: [{ name: 'Jibe Default' }, { name: 'Jibe Raised', max_pages: 300 }] },
    providers: {}, makeHttpCtx: async () => ({}), sleep: async () => {},
    resolveProvider: async () => ({ provider: { id: 'jibeapply', fetch: async () => jobs(500) } }),
  });
  assert.deepEqual(jibe.partitions.map((item) => item.capDetected), [true, false], 'JibeApply stopping at 50 pages x 10 is a cap');
  const raised = await collectCareerOpsRaw({
    portals: { tracked_companies: [{ name: 'SF Raised', max_jobs: 5000 }, { name: 'SF Raised Full', max_jobs: 1200 }] },
    providers: {}, makeHttpCtx: async () => ({}), sleep: async () => {},
    resolveProvider: async () => ({ provider: { id: 'successfactors', fetch: async () => jobs(1200) } }),
  });
  assert.deepEqual(raised.partitions.map((item) => item.capDetected), [false, true], 'capped only at the effective ceiling');
  const sizes = { 'SF Exact': ['successfactors', 1000], 'SF Under': ['successfactors', 998], 'Oracle Exact': ['oraclecloud', 5000], 'SR Exact': ['smartrecruiters', 5000], 'GH Big': ['greenhouse', 5000] };
  const result = await collectCareerOpsRaw({
    portals: { tracked_companies: Object.keys(sizes).map((name) => ({ name })) },
    providers: {}, makeHttpCtx: async () => ({}), sleep: async () => {},
    resolveProvider: async (entry) => ({ provider: { id: sizes[entry.name][0], fetch: async () => jobs(sizes[entry.name][1]) } }),
  });
  const byName = Object.fromEntries(result.partitions.map((item) => [item.partition.split(':')[1], item]));
  for (const name of ['SF Exact', 'Oracle Exact', 'SR Exact']) assert.deepEqual([byName[name].capDetected, byName[name].status], [true, 'partial'], name);
  for (const name of ['SF Under', 'GH Big']) assert.deepEqual([byName[name].capDetected, byName[name].status], [false, 'ok'], name);
  assert.equal(byName['SF Exact'].ceiling, 1000);
  for (const item of result.partitions) assert.ok(Number.isInteger(item.elapsedMs) && item.elapsedMs >= 0, `${item.partition}: elapsedMs`);
});

test('[A4] partition elapsedMs covers retries', async () => {
  let calls = 0;
  const result = await collectCareerOpsRaw({
    portals: { tracked_companies: [{ name: 'Flaky Co' }] }, providers: {}, makeHttpCtx: async () => ({}),
    retryDelaysMs: [30], sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    resolveProvider: async () => ({ provider: { id: 'greenhouse', fetch: async () => { calls += 1; if (calls === 1) throw new Error('fetch failed'); return []; } } }),
  });
  assert.equal(result.partitions[0].attempts, 2);
  assert.ok(result.partitions[0].elapsedMs >= 25, `retry delay counted: ${result.partitions[0].elapsedMs}`);
});

// ===================================================================== A5 locks

test('[A5] connections wait 120 s for a writer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cj-busy-'));
  try {
    const db = openDatabase(path.join(dir, 'x.db'));
    assert.equal(BUSY_TIMEOUT_MS, 120_000);
    assert.equal(Number(db.prepare('PRAGMA busy_timeout').get().timeout), 120_000);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('[A5] a run-wide ingest context is built once and kept current across batches', () => {
  const db = freshDb();
  const context = createIngestContext(db, { policy: SCREENING_POLICY });
  ingest(db, [role(1, { title: 'Data Science Intern - Team A' })], { context });
  // A second batch of the same run sees the first batch's posting as a maybe_same candidate.
  ingest(db, [role(2, { title: 'Data Science Intern - Team B' }), role(3, { source: 'lever', sourceId: 'lv-3', partition: 'lever:examplecorp', title: 'Data Science Intern - Team C' })], { context, partition: 'lever:examplecorp', source: 'lever' });
  assert.ok(rows(db, 'posting_links', "kind='maybe_same'") >= 1, 'links across batches of one run');
  // The cached sighting index learns this run's sightings: a no-signal record from another partition does not drop the student role.
  const id = postingOf(db, 1);
  ingest(db, [role(1, { ...NO_SIGNAL, source: 'careerops', sourceId: 'co-1' })], { context, source: 'careerops', partition: 'all' });
  assert.equal(reviewOf(db, id).state, 'due', 'another partition\'s current student record keeps it open');
});

test('[A5] prune recovers lost attempts in their own short transactions, not inside its writer transaction', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-prune-recovery-'));
  let context;
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    context = await openHomeDatabase(home);
    const { db } = context;
    insertPosting(db, { id: 'p-lost' });
    insertReview(db, { postingId: 'p-lost', stage: 'judge', state: 'leased' });
    db.prepare(`INSERT INTO attempts (id, run_id, posting_id, stage, runner, model, tier, state, dispatched_at, finished_at, output_path, usage_json, transport_retries, error)
      VALUES ('a-lost', 'review-gone', 'p-lost', 'judge', 'fake', 'fake-primary', 'primary', 'dispatched', ?, NULL, NULL, '{}', 0, NULL)`).run(at(-10));
    const statements = [];
    const exec = db.exec.bind(db);
    db.exec = (sql) => { statements.push(String(sql)); return exec(sql); };
    try { await prune(db, home, { now: T0, policy: retentionPolicy({}), dryRun: false }); } finally { db.exec = exec; }
    assert.equal(db.prepare("SELECT state FROM attempts WHERE id='a-lost'").get().state, 'lost', 'fixture: the attempt was recovered');
    const savepoint = statements.findIndex((sql) => sql.includes('SAVEPOINT retention_prune'));
    const nested = statements.slice(savepoint).filter((sql) => sql.includes('SAVEPOINT review_atomic'));
    assert.deepEqual(nested, [], 'no recovery inside the prune transaction');
    assert.ok(statements.slice(0, savepoint).some((sql) => sql.includes('BEGIN IMMEDIATE')), 'recovery committed on its own before');
  } finally {
    try { context?.db.close(); } catch { /* closed */ }
    await rm(home, { recursive: true, force: true });
  }
});

test('[A5] prune keeps the snapshot payload byte cap exact without re-summing the table per snapshot', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-prune-bytes-'));
  let context;
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    context = await openHomeDatabase(home);
    const { db } = context;
    for (let i = 0; i < 6; i += 1) {
      insertPosting(db, { id: `p-${i}` });
      for (const [suffix, when] of [['old', at(-20)], ['new', at(-1)]]) {
        db.prepare(`INSERT INTO snapshots (id, posting_id, content_hash, fetched_at, final_url, http_status, method, identity_ok, identity_reason, fields_json, sections_json, text, text_pruned_at)
          VALUES (?, ?, ?, ?, 'https://example.test', 200, 'ats_api', 1, NULL, '{"title":"x"}', '[]', ?, NULL)`).run(`s-${i}-${suffix}`, `p-${i}`, `h-${i}-${suffix}`, when, 'x'.repeat(10_000));
      }
    }
    const { tableBytes } = await import('../../src/retention/storage.mjs');
    const total = tableBytes(db, 'snapshots');
    const maxBytes = total - 25_000; // three old payloads must go
    const result = await prune(db, home, { now: T0, policy: retentionPolicy({ retention: { snapshotsMaxBytes: maxBytes } }), dryRun: false });
    assert.equal(rows(db, 'snapshots', 'text_pruned_at IS NOT NULL'), 3);
    assert.equal(result.removed.snapshot_payloads.bytes, total - tableBytes(db, 'snapshots'), 'freed bytes are exact');
    assert.ok(tableBytes(db, 'snapshots') <= maxBytes);
  } finally {
    try { context?.db.close(); } catch { /* closed */ }
    await rm(home, { recursive: true, force: true });
  }
});

// ===================================================================== A5 measurement

test('[A5] a 20,000-record census over 50,000 postings: report the longest single write transaction', { timeout: 300_000 }, () => {
  const db = freshDb();
  const POSTINGS = 50_000;
  const seenAt = at(-5);
  const insertPostingRow = db.prepare(`INSERT INTO postings (id, company, title, canonical_url, first_seen, last_seen, listed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  const insertAlias = db.prepare("INSERT INTO posting_aliases (alias, posting_id, kind, created_at) VALUES (?, ?, ?, ?)");
  const insertReviewRow = db.prepare(`INSERT INTO reviews (posting_id, stage, state, decision, code, lane, flags_json, next_due, evidence_json, dep_hashes_json, deadline_json, first_seen, updated_at)
    VALUES (?, 'fetch', ?, ?, ?, ?, '[]', NULL, '{}', '{}', '{}', ?, ?)`);
  const company = (i) => `Synthetic Co ${String(i % 400).padStart(3, '0')}`;
  const board = (i) => `syntheticco${String(i % 400).padStart(3, '0')}`;
  const url = (i) => `https://job-boards.greenhouse.io/${board(i)}/jobs/${7_000_000 + i}`;
  const titleOf = (i) => (i % 10 === 0 ? `Data Science Intern ${i}` : `Senior Platform Engineer ${i}`);
  const toRecord = (i) => record({ source: 'greenhouse', sourceId: String(7_000_000 + i), url: url(i), company: company(i),
    title: i >= POSTINGS && i % 20 === 0 ? `Data Science Intern ${i}` : titleOf(i), description: '', partition: 'p' });
  db.exec('BEGIN');
  for (let i = 0; i < POSTINGS; i += 1) {
    const id = `seed-${i}`;
    insertPostingRow.run(id, company(i), titleOf(i), url(i).slice(8), seenAt, seenAt, seenAt, seenAt);
    for (const { alias, kind } of aliasesFor(toRecord(i))) insertAlias.run(alias, id, kind, seenAt);
    const student = i % 10 === 0;
    insertReviewRow.run(id, student ? 'due' : 'done', student ? null : 'dropped', student ? null : 'no_student_signal', student ? 'new' : 'no_student_signal', seenAt, seenAt);
  }
  db.exec('COMMIT');
  // Tonight: 10,000 re-sightings (half of them open student roles) and 10,000 new records (a tenth students), in partitions of 2,000 and one of 5,000.
  const records = [];
  for (let i = 0; i < 10_000; i += 1) records.push(i * 5);
  for (let i = 0; i < 10_000; i += 1) records.push(POSTINGS + i);
  const partitions = [];
  for (let start = 0; start < 15_000; start += 2_000) partitions.push(records.slice(start, Math.min(start + 2_000, 15_000)));
  partitions.push(records.slice(15_000));
  const context = createIngestContext(db, { policy: SCREENING_POLICY });
  const durations = [];
  let stored = 0; let countedOnly = 0;
  const started = performance.now();
  partitions.forEach((items, index) => {
    const counts = ingest(db, items.map(toRecord), { runId: 'scan-big', now: T0, partition: `greenhouse:part-${index}`, context });
    durations.push(counts.elapsedMs);
    stored += counts.stored; countedOnly += counts.countedOnly;
  });
  const total = Math.round(performance.now() - started);
  const longest = Math.max(...durations);
  console.log(`[A5 measurement] ${records.length} records over ${POSTINGS} postings in ${partitions.length} batches: longest write transaction ${longest} ms (batch sizes ${partitions.map((p) => p.length).join('/')}), total ${total} ms; stored ${stored}, counted only ${countedOnly}`);
  assert.equal(stored + countedOnly, records.length);
  // Counted only: 5,000 re-sighted settled drops and 9,000 new no-signal records; stored: 5,000 open students and 1,000 new ones.
  assert.deepEqual([countedOnly, stored], [14_000, 6_000]);
  assert.equal(rows(db, 'postings'), POSTINGS + 1_000, 'only the new student roles are added');
});
