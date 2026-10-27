// Lane C — retention, storage report, backups, ranking with company load, apply tab titles
// (screening plan Tasks C1, C2, C3). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { schemaMigrations } from '../../src/storage/database.mjs';
import { load, freshDb, insertPosting, insertReview, seedApplication, reviewOf, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SCREENING_POLICY, JUDGMENTS, writeReviewHome } from '../../test-utils/funnel-v3-fixtures.mjs';
import { readFixture } from '../../test-utils/scan-fixtures.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

const pruneModule = () => load('C1', './src/retention/prune.mjs', ['retentionPolicy', 'prune']);
const storageModule = () => load('C1', './src/retention/storage.mjs', ['measureStorage', 'rotateBackups']);
const receiptModule = () => load('B7', './src/review/receipt.mjs', ['writeReceipt']);
const tabModule = () => load('C3', './src/apply/tab-title.mjs', ['tabTitle', 'needsFromVerdict']);

// "Now" for retention tests. Ages are expressed in days before it.
const NOW = '2027-06-01T03:00:00.000Z';
const ago = (days, base = NOW) => new Date(Date.parse(base) - days * 86_400_000).toISOString();
const count = (db, table, where = '1=1', ...params) => db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...params).n;
const PERMANENT = ['applications', 'application_events', 'reviews', 'postings', 'posting_aliases'];
const permanentCounts = (db) => Object.fromEntries(PERMANENT.map((table) => [table, count(db, table)]));

// A file-backed data home (outside the checkout) at schema 6.
async function withHome(run) {
  if (!schemaMigrations.some((item) => item.version === 6)) throw new Error('NOT IMPLEMENTED [L1]: migration 006-funnel is not registered in schemaMigrations');
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-retention-'));
  let context;
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    context = await openHomeDatabase(home);
    await run({ home, db: context.db, dataDir: path.join(home, '.career-journal') });
  } finally {
    try { context?.db.close(); } catch { /* closed */ }
    await rm(home, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ raw seeders (SPEC §2 + schema 006)

function seedRun(db, { runId, kind = 'scan', at: when, status = 'ok', parentRunId = null }) {
  db.prepare(`INSERT INTO runs (run_id, kind, owner, started_at, heartbeat_at, finished_at, status, receipt_json, parent_run_id)
    VALUES (?, ?, 'test', ?, ?, ?, ?, '{}', ?)`).run(runId, kind, when, when, when, status, parentRunId);
}

function seedRunSource(db, { runId, partition = 'greenhouse:examplecorp', count: n = 10 }) {
  db.prepare(`INSERT INTO run_sources (run_id, source, partition, status, count, errors, truncated, expected, detail, baseline, alert, raw_count, quarantined)
    VALUES (?, 'greenhouse', ?, 'ok', ?, 0, 0, 1, '', NULL, NULL, ?, 0)`).run(runId, partition, n, n);
}

function seedObservation(db, { id, postingId, at: when, runId, hash = id, partition = 'greenhouse:examplecorp' }) {
  db.prepare(`INSERT INTO observations (id, posting_id, source, source_id, partition, first_run_id, observed_at, fields_json, completeness_json, listed, content_hash)
    VALUES (?, ?, 'greenhouse', ?, ?, ?, ?, '{}', '{}', 1, ?)`).run(id, postingId, postingId, partition, runId, when, hash);
}

function seedSighting(db, { runId, postingId, observationId, at: when, partition = 'greenhouse:examplecorp' }) {
  db.prepare(`INSERT INTO observation_sightings (run_id, posting_id, observation_id, source, partition, seen_at)
    VALUES (?, ?, ?, 'greenhouse', ?, ?)`).run(runId, postingId, observationId, partition, when);
}

function seedSnapshot(db, { id, postingId, at: when, text = `Snapshot ${id}. `.repeat(40) }) {
  db.prepare(`INSERT INTO snapshots (id, posting_id, content_hash, fetched_at, final_url, http_status, method, identity_ok, identity_reason, fields_json, sections_json, text, text_pruned_at)
    VALUES (?, ?, ?, ?, ?, 200, 'ats_api', 1, NULL, '{"title":"x"}', '[{"kind":"required","start":0,"end":5}]', ?, NULL)`)
    .run(id, postingId, `hash-${id}`, when, `https://job-boards.greenhouse.io/examplecorp/jobs/${postingId}`, text);
}

function seedLog(db, { postingId, at: when, kind, attemptId = null }) {
  db.prepare('INSERT INTO review_log (posting_id, at, stage, kind, attempt_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(postingId, when, kind === 'delivery' ? 'deliver' : 'judge', kind, attemptId, JSON.stringify({ synthetic: true }));
}

function seedAttempt(db, { id, postingId, runId = 'review-x', at: when, state = 'responded', outputPath = null }) {
  db.prepare(`INSERT INTO attempts (id, run_id, posting_id, stage, runner, model, tier, state, dispatched_at, finished_at, output_path, usage_json, transport_retries, error)
    VALUES (?, ?, ?, 'judge', 'fake', 'fake-primary', 'primary', ?, ?, ?, ?, '{}', 0, NULL)`)
    .run(id, runId, postingId, state, when, state === 'dispatched' ? null : when, outputPath);
}

function seedSample(db, { partition = 'greenhouse:examplecorp', at: when }) {
  db.prepare('INSERT INTO source_samples (partition, sampled_at, board_count, census_count, status) VALUES (?, ?, 10, 10, ?)').run(partition, when, 'ok');
}

// A lead with a posting, a done review and one event: permanent user history.
function seedLead(db, { id, company = 'Example Corp', decision = 'eligible', code = null, now = ago(200) }) {
  const app = seedApplication(db, { company, role: `Data Intern ${id}`, now });
  insertPosting(db, { id, company, applicationId: app.id, firstSeen: now });
  insertReview(db, { postingId: id, state: 'done', stage: 'deliver', decision, code, firstSeen: now, nextDue: now });
  db.prepare(`INSERT INTO application_events (id, application_id, event_type, observed_at, recorded_at, title, note, source_json, status_after, content_hash)
    VALUES (?, ?, 'review_delivered', ?, ?, 'Delivered', '', '{"actor":"review-worker"}', NULL, ?)`).run(`ev-${id}`, app.id, now, now, `h-${id}`);
  return app;
}

async function setMtime(file, iso) {
  const time = new Date(iso);
  await utimes(file, time, time);
}

async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

// ------------------------------------------------------------------------------- C1

test('[C] prune follows the inventory and never touches permanent records or active files', async () => {
  const { retentionPolicy, prune } = await pruneModule();
  await withHome(async ({ db, dataDir }) => {
    seedLead(db, { id: 'p-keep' });
    for (const [runId, days] of [['scan-old', 200], ['scan-mid', 100], ['scan-new', 1]]) { seedRun(db, { runId, at: ago(days) }); seedRunSource(db, { runId }); }
    // observations: first and latest per (posting, source, partition) stay; a middle one goes once unreferenced.
    seedObservation(db, { id: 'o-first', postingId: 'p-keep', at: ago(200), runId: 'scan-old' });
    seedObservation(db, { id: 'o-mid', postingId: 'p-keep', at: ago(100), runId: 'scan-mid' });
    seedObservation(db, { id: 'o-latest', postingId: 'p-keep', at: ago(1), runId: 'scan-new' });
    seedSighting(db, { runId: 'scan-mid', postingId: 'p-keep', observationId: 'o-mid', at: ago(100) });
    seedSighting(db, { runId: 'scan-new', postingId: 'p-keep', observationId: 'o-latest', at: ago(1) });
    seedSample(db, { at: ago(200) });
    seedSample(db, { at: ago(3) });
    seedSnapshot(db, { id: 's-old', postingId: 'p-keep', at: ago(100) });
    seedSnapshot(db, { id: 's-latest', postingId: 'p-keep', at: ago(2) });
    seedLog(db, { postingId: 'p-keep', at: ago(20), kind: 'llm_raw' });
    seedLog(db, { postingId: 'p-keep', at: ago(1), kind: 'llm_raw' });
    seedLog(db, { postingId: 'p-keep', at: ago(200), kind: 'outcome' });
    seedLog(db, { postingId: 'p-keep', at: ago(200), kind: 'delivery' });
    seedLog(db, { postingId: 'p-keep', at: ago(200), kind: 'user' });
    const attemptDir = path.join(dataDir, 'attempts');
    await mkdir(attemptDir, { recursive: true });
    const recentOutput = path.join(attemptDir, 'a-recent.json');
    await writeFile(recentOutput, JSON.stringify(JUDGMENTS.eligible));
    await setMtime(recentOutput, ago(2));
    seedAttempt(db, { id: 'a-old', postingId: 'p-keep', at: ago(100) });
    seedAttempt(db, { id: 'a-recent', postingId: 'p-keep', at: ago(2), outputPath: recentOutput });
    seedAttempt(db, { id: 'a-inflight', postingId: 'p-keep', at: ago(0.1), state: 'dispatched', outputPath: path.join(attemptDir, 'a-inflight.json') });
    const before = permanentCounts(db);
    const review = { ...reviewOf(db, 'p-keep') };

    const result = await prune(db, path.dirname(dataDir), { now: NOW, policy: retentionPolicy(REVIEW_POLICY), dryRun: false });

    assert.ok(Object.values(result.removed).some((category) => category.rows > 0), JSON.stringify(result.removed));
    assert.deepEqual(permanentCounts(db), before, 'permanent user history is never pruned');
    assert.deepEqual({ ...reviewOf(db, 'p-keep') }, review, 'review decision and evidence unchanged');
    const ids = (table, column = 'id') => db.prepare(`SELECT ${column} v FROM ${table} ORDER BY ${column}`).all().map((row) => row.v);
    assert.deepEqual(ids('observations'), ['o-first', 'o-latest'], 'first and latest observation kept; unreferenced middle removed');
    assert.deepEqual(ids('observation_sightings', 'run_id'), ['scan-new'], 'sightings older than 45 days removed');
    assert.deepEqual(ids('runs', 'run_id'), ['scan-new'], 'runs older than 90 days removed');
    assert.deepEqual(ids('run_sources', 'run_id'), ['scan-new'], 'run_sources older than 90 days removed');
    assert.equal(count(db, 'source_samples'), 1, 'samples older than 180 days removed');
    assert.deepEqual(ids('snapshots'), ['s-latest'], 'non-latest, uncited snapshot older than 30 days removed');
    assert.equal(count(db, 'snapshots', "id = 's-latest' AND text IS NOT NULL"), 1, 'the current snapshot of an unsubmitted lead keeps its text');
    assert.equal(count(db, 'review_log', "kind = 'llm_raw'"), 1, 'llm_raw older than 14 days removed');
    assert.equal(count(db, 'review_log', "kind = 'outcome'"), 0, 'outcome rows older than 180 days removed');
    assert.equal(count(db, 'review_log', "kind IN ('delivery','user')"), 2, 'user/delivery review_log is permanent');
    assert.deepEqual(ids('attempts'), ['a-inflight', 'a-recent'], 'terminal attempts older than 90 days removed; dispatched rows never pruned');
    assert.equal(db.prepare("SELECT state FROM attempts WHERE id = 'a-inflight'").get().state, 'dispatched', 'a fresh in-flight attempt is not recovered');
    assert.ok(existsSync(recentOutput), 'a recent attempt output file is kept');
  });
});

test('[C] a not-eligible snapshot loses its payload after 60 days but keeps its row and reason', async () => {
  const { retentionPolicy, prune } = await pruneModule();
  await withHome(async ({ home, db }) => {
    for (const [id, days] of [['p-neg-old', 70], ['p-neg-new', 30]]) {
      insertPosting(db, { id, firstSeen: ago(days) });
      insertReview(db, { postingId: id, state: 'done', stage: 'deliver', decision: 'not_eligible', code: 'requirement_conflict', firstSeen: ago(days), nextDue: ago(days) });
      db.prepare('UPDATE reviews SET updated_at = ? WHERE posting_id = ?').run(ago(days), id);
      seedSnapshot(db, { id: `s-${id}`, postingId: id, at: ago(days) });
    }
    await prune(db, home, { now: NOW, policy: retentionPolicy(REVIEW_POLICY), dryRun: false });
    const old = db.prepare("SELECT text, fields_json, sections_json, text_pruned_at FROM snapshots WHERE id = 's-p-neg-old'").get();
    assert.ok(old, 'the snapshot row is kept');
    assert.equal(old.text, null);
    assert.equal(old.fields_json, '{}');
    assert.equal(old.sections_json, '[]');
    assert.ok(old.text_pruned_at, 'text_pruned_at is set');
    assert.deepEqual([reviewOf(db, 'p-neg-old').decision, reviewOf(db, 'p-neg-old').code], ['not_eligible', 'requirement_conflict']);
    const fresh = db.prepare("SELECT text, text_pruned_at FROM snapshots WHERE id = 's-p-neg-new'").get();
    assert.ok(fresh.text, 'a 30-day-old not-eligible snapshot keeps its text');
    assert.equal(fresh.text_pruned_at, null);
  });
});

test('[C] byte caps evict the oldest prunable files first', async () => {
  const { retentionPolicy, prune } = await pruneModule();
  await withHome(async ({ home, db, dataDir }) => {
    insertPosting(db, { id: 'p-cap' });
    insertReview(db, { postingId: 'p-cap', state: 'done', stage: 'deliver', decision: 'eligible' });
    const attemptDir = path.join(dataDir, 'attempts');
    await mkdir(attemptDir, { recursive: true });
    const files = {};
    // Three 80 MB (sparse) responded outputs, all inside the 14-day age window: only the 200 MB cap applies.
    for (const days of [3, 2, 1]) {
      const file = path.join(attemptDir, `a-${days}d.json`);
      await writeFile(file, '');
      await truncate(file, 80 * 1024 * 1024);
      await setMtime(file, ago(days));
      seedAttempt(db, { id: `a-${days}d`, postingId: 'p-cap', at: ago(days), outputPath: file });
      files[days] = file;
    }
    assert.equal((await stat(files[3])).size, 80 * 1024 * 1024);
    await prune(db, home, { now: NOW, policy: retentionPolicy(REVIEW_POLICY), dryRun: false });
    assert.equal(existsSync(files[3]), false, 'the oldest output file is evicted first');
    assert.ok(existsSync(files[2]) && existsSync(files[1]), 'newer files stay once the total is under the cap');
  });
});

test('[C] stale leases and dispatched attempts are recovered before pruning', async () => {
  const { retentionPolicy, prune } = await pruneModule();
  await withHome(async ({ home, db, dataDir }) => {
    insertPosting(db, { id: 'p-lease' });
    insertReview(db, { postingId: 'p-lease', stage: 'judge' });
    db.prepare("UPDATE reviews SET state = 'leased', lease_owner = 'dead-worker', lease_generation = 1, lease_until = ? WHERE posting_id = 'p-lease'").run(ago(2 / 24));
    const attemptDir = path.join(dataDir, 'attempts');
    await mkdir(attemptDir, { recursive: true });
    const adoptedOutput = path.join(attemptDir, 'a-adopt.json');
    await writeFile(adoptedOutput, JSON.stringify(JUDGMENTS.eligible));
    seedAttempt(db, { id: 'a-lost', postingId: 'p-lease', at: ago(2), state: 'dispatched', outputPath: path.join(attemptDir, 'a-lost.json') });
    seedAttempt(db, { id: 'a-adopt', postingId: 'p-lease', at: ago(2), state: 'dispatched', outputPath: adoptedOutput });
    await prune(db, home, { now: NOW, policy: retentionPolicy(REVIEW_POLICY), dryRun: false });
    assert.equal(reviewOf(db, 'p-lease').state, 'due', 'an expired lease returns the item to due');
    const state = (id) => db.prepare('SELECT state FROM attempts WHERE id = ?').get(id)?.state;
    assert.equal(state('a-lost'), 'lost', 'a dispatched attempt older than a day without output is lost');
    assert.equal(state('a-adopt'), 'adopted', 'a dispatched attempt with a parseable output is adopted');
  });
});

test('[C] prune never removes the receipt being read', async () => {
  const { retentionPolicy, prune } = await pruneModule();
  const { writeReceipt } = await receiptModule();
  await withHome(async ({ home, db, dataDir }) => {
    const runsDir = path.join(dataDir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const receipts = [
      { run_id: 'review-stale', kind: 'review', days: 60 },
      { run_id: 'review-protected', kind: 'review', days: 60 },
      { run_id: 'daily-old', kind: 'daily', days: 120 },
    ];
    for (const item of receipts) {
      await writeReceipt(home, { schema: 1, run_id: item.run_id, run_date: ago(item.days).slice(0, 10), kind: item.kind, status: 'ok', started: ago(item.days), finished: ago(item.days) });
    }
    for (const file of await readdir(runsDir)) await setMtime(path.join(runsDir, file), ago(file.startsWith('daily-old') || file === 'latest.json' ? 120 : 60));
    const has = async (runId) => (await readdir(runsDir)).some((file) => file.startsWith(runId));
    assert.ok(await has('review-stale') && await has('review-protected') && await has('daily-old'));

    await prune(db, home, { now: NOW, policy: retentionPolicy(REVIEW_POLICY), dryRun: false, protectRunIds: ['review-protected'] });
    assert.equal(await has('review-stale'), false, 'a stage receipt older than 30 days is removed');
    assert.ok(await has('review-protected'), 'a protected receipt is kept');
    assert.ok(await has('daily-old'), 'the daily receipt latest.json points to is kept even past 90 days');
    assert.ok(existsSync(path.join(runsDir, 'latest.json')), 'the latest pointer is kept');
  });
});

test('[C] prune rotates weekly backups and a restore returns profile, rules and the selected resume byte-for-byte', async () => {
  const { retentionPolicy, prune } = await pruneModule();
  const { rotateBackups } = await storageModule();
  await withHome(async ({ home, db, dataDir }) => {
    const resume = path.join(home, 'synthetic-resume.pdf');
    await writeFile(resume, '%PDF-1.4 synthetic resume for tests\n');
    const profile = await readFixture('profile.json');
    profile.materials.resumePath = resume;
    await mkdir(path.join(dataDir, 'profile'), { recursive: true });
    await writeFile(path.join(dataDir, 'profile', 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
    await writeReviewHome(home);
    const policy = retentionPolicy(REVIEW_POLICY);

    await prune(db, home, { now: NOW, policy, dryRun: false });
    assert.equal((await rotateBackups(home, { now: at(1, NOW), policy })).created, null, 'prune already made this week\'s backup');

    let created = null;
    const removed = [];
    for (const week of [1, 2, 3, 4]) {
      const result = await rotateBackups(home, { now: at(week * 7, NOW), policy });
      assert.ok(result.created, `week ${week} creates a backup`);
      created = result.created;
      removed.push(...result.removed);
    }
    const entries = (await readdir(path.dirname(created))).filter((name) => !name.startsWith('.'));
    assert.equal(entries.length, 4, `four weekly backups are kept: ${entries.join(', ')}`);
    assert.equal(removed.length, 1, 'the fifth weekly backup removed the oldest');

    const copies = await walk(created);
    const originals = {
      'profile.json': path.join(dataDir, 'profile', 'profile.json'),
      'screening-rules.md': path.join(dataDir, 'profile', 'screening-rules.md'),
      'fit-rules.md': path.join(dataDir, 'profile', 'fit-rules.md'),
      'synthetic-resume.pdf': resume,
    };
    for (const [name, original] of Object.entries(originals)) {
      const copy = copies.find((file) => path.basename(file) === name);
      assert.ok(copy, `the backup contains ${name}`);
      assert.deepEqual(await readFile(copy), await readFile(original), `${name} restores byte-for-byte`);
    }
  });
});

test('[C] operational rows and bytes plateau across retention windows for a fixed set of postings with daily changes', async () => {
  const { retentionPolicy, prune } = await pruneModule();
  const { measureStorage } = await storageModule();
  await withHome(async ({ home, db, dataDir }) => {
    const start = '2027-01-01T03:00:00.000Z';
    const workRoot = path.join(home, 'work');
    const attemptDir = path.join(dataDir, 'attempts');
    const runsDir = path.join(dataDir, 'runs');
    await mkdir(workRoot, { recursive: true });
    await mkdir(attemptDir, { recursive: true });
    await mkdir(runsDir, { recursive: true });
    const policy = retentionPolicy({ ...REVIEW_POLICY, retention: { workPaths: [workRoot] } });
    const postings = Array.from({ length: 50 }, (_, index) => `p-${String(index).padStart(3, '0')}`);
    for (const id of postings) seedLead(db, { id, now: start });
    const permanent = permanentCounts(db);
    const tables = ['observations', 'observation_sightings', 'runs', 'run_sources', 'source_samples', 'snapshots', 'attempts', 'review_log'];
    const sample = async (now) => ({
      rows: Object.fromEntries(tables.map((table) => [table, count(db, table)])),
      bytes: (await measureStorage(home, db)).operational,
      now,
    });
    const snapshotsAt = {};
    for (let day = 0; day < 270; day += 1) {
      const now = at(day, start);
      const date = now.slice(0, 10);
      const scanId = `scan-${date}`;
      const reviewId = `review-${date}`;
      seedRun(db, { runId: scanId, at: now });
      seedRun(db, { runId: reviewId, kind: 'review', at: now });
      seedRunSource(db, { runId: scanId });
      db.exec('BEGIN');
      for (const id of postings) {
        seedObservation(db, { id: `o-${id}-${day}`, postingId: id, at: now, runId: scanId, hash: `h-${id}-${day}` });
        seedSighting(db, { runId: scanId, postingId: id, observationId: `o-${id}-${day}`, at: now });
      }
      for (let k = 0; k < 10; k += 1) seedSnapshot(db, { id: `s-${day}-${k}`, postingId: postings[(day * 10 + k) % 50], at: now, text: `Day ${day} posting text. `.repeat(50) });
      for (let k = 0; k < 5; k += 1) {
        const id = `a-${day}-${k}`;
        const output = path.join(attemptDir, `${id}.json`);
        seedAttempt(db, { id, postingId: postings[(day * 5 + k) % 50], runId: reviewId, at: now, outputPath: output });
        seedLog(db, { postingId: postings[(day * 5 + k) % 50], at: now, kind: 'llm_raw', attemptId: id });
        seedLog(db, { postingId: postings[(day * 5 + k) % 50], at: now, kind: 'outcome', attemptId: id });
      }
      if (day % 7 === 0) seedSample(db, { at: now });
      db.exec('COMMIT');
      for (let k = 0; k < 5; k += 1) {
        const output = path.join(attemptDir, `a-${day}-${k}.json`);
        await writeFile(output, JSON.stringify({ ...JUDGMENTS.eligible, day, k }));
        await setMtime(output, now);
      }
      for (const runId of [scanId, reviewId]) {
        const file = path.join(runsDir, `${runId}.json`);
        await writeFile(file, JSON.stringify({ schema: 1, run_id: runId, run_date: date, kind: runId.split('-')[0], status: 'ok', started: now, finished: now }));
        await setMtime(file, now);
      }
      const workDir = path.join(workRoot, date);
      await mkdir(workDir, { recursive: true });
      await writeFile(path.join(workDir, 'evidence.txt'), `Synthetic evidence for ${date}. `.repeat(120));
      await setMtime(path.join(workDir, 'evidence.txt'), now);
      await setMtime(workDir, now);
      await prune(db, home, { now, policy, dryRun: false });
      if (day === 180 || day === 269) snapshotsAt[day] = await sample(now);
    }
    const near = (actual, expected) => Math.abs(actual - expected) <= Math.max(0.05 * expected, 65_536);
    const nearRows = (actual, expected) => Math.abs(actual - expected) <= Math.max(0.05 * expected, 1);
    for (const table of tables) {
      assert.ok(nearRows(snapshotsAt[269].rows[table], snapshotsAt[180].rows[table]), `${table}: ${snapshotsAt[180].rows[table]} rows at day 180 vs ${snapshotsAt[269].rows[table]} at day 270`);
    }
    for (const [key, value] of Object.entries(snapshotsAt[180].bytes)) {
      assert.ok(near(snapshotsAt[269].bytes[key], value), `${key}: ${value} bytes at day 180 vs ${snapshotsAt[269].bytes[key]} at day 270`);
    }
    const caps = { attempts: 200 * 1024 * 1024, runs: 50 * 1024 * 1024, work: 200 * 1024 * 1024 };
    for (const [key, cap] of Object.entries(caps)) assert.ok(snapshotsAt[269].bytes[key] <= cap, `${key} under its cap`);
    assert.deepEqual(permanentCounts(db), permanent, 'permanent records unchanged');
    assert.equal(count(db, 'reviews', "state = 'done' AND decision = 'eligible'"), 50, 'current evidence unchanged');
  });
});

test('[C] prune is a dry run unless --apply', async () => {
  const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
  const { runCli } = await import('../../src/cli/main.mjs');
  const runtime = createRuntime({ root: process.cwd(), version: 'test' });
  if (!runtime.commands.has('prune')) throw new Error('NOT IMPLEMENTED [C1]: `prune` command is not registered in create-runtime.mjs');
  await withHome(async ({ home, db }) => {
    const real = Date.now();
    const old = new Date(real - 100 * 86_400_000).toISOString();
    seedLead(db, { id: 'p-cli', now: old });
    seedRun(db, { runId: 'scan-cli-old', at: old });
    seedObservation(db, { id: 'o-cli', postingId: 'p-cli', at: old, runId: 'scan-cli-old' });
    for (const runId of ['scan-cli-old', 'scan-cli-old-2']) seedSighting(db, { runId, postingId: 'p-cli', observationId: 'o-cli', at: old });
    const before = count(db, 'observation_sightings');
    db.close();

    const io = memoryIO();
    assert.equal(await runCli(['prune', '--home', home, '--json'], io, runtime), 0, io.stderr);
    const plan = JSON.parse(io.stdout);
    assert.ok(Object.values(plan.removed).some((category) => category.rows > 0), 'the dry run reports what it would remove');
    let context = await openHomeDatabase(home);
    try { assert.equal(count(context.db, 'observation_sightings'), before, 'a dry run changes no rows'); } finally { context.db.close(); }

    const applied = memoryIO();
    assert.equal(await runCli(['prune', '--home', home, '--apply', '--json'], applied, runtime), 0, applied.stderr);
    context = await openHomeDatabase(home);
    try { assert.equal(count(context.db, 'observation_sightings'), 0, '--apply removes the old sightings'); } finally { context.db.close(); }
  });
});

// ------------------------------------------------------------------------------- C3

test('[C] tabTitle picks the first remaining action in priority order', async () => {
  const { tabTitle, needsFromVerdict } = await tabModule();
  const company = 'Example Corp';
  assert.equal(tabTitle({ company, needs: {} }), '✅ Ready to submit Example Corp');
  assert.equal(tabTitle({ company, needs: { essay: true, signIn: true } }), '🔑 Sign in Example Corp');
  assert.equal(tabTitle({ company, needs: { essay: true, createAccount: true, signIn: true } }), '🆕 Create account Example Corp');
  assert.equal(tabTitle({ company, needs: { click: true, assessment: true, documents: true } }), '📎 Transcript/references Example Corp');
  assert.equal(tabTitle({ company, needs: { click: true, assessment: true } }), '🧪 Assessment link Example Corp');
  assert.equal(tabTitle({ company, needs: { verify: true, question: true } }), '🤖 Verify Example Corp');
  assert.equal(tabTitle({ company, needs: { question: true, essay: true } }), '❓ Question Example Corp');
  assert.equal(tabTitle({ company, needs: { click: true } }), '👆 Click Example Corp');
  assert.equal(tabTitle({ company, needs: { essay: true } }), '✍️ Essay Example Corp');
  const zh = [
    [{ createAccount: true }, '🆕 先注册'], [{ signIn: true }, '🔑 先登录'], [{ verify: true }, '🤖 人机验证'], [{ question: true }, '❓ 有问题'],
    [{ essay: true }, '✍️ 要写作文'], [{ documents: true }, '📎 要成绩单/推荐人'], [{ assessment: true }, '🧪 测评链接'], [{ click: true }, '👆 要你点'], [{}, '✅ 待提交'],
  ];
  for (const [needs, label] of zh) assert.equal(tabTitle({ company, needs, language: 'zh' }), `${label} ${company}`);
  assert.deepEqual(needsFromVerdict({ essay: true, documents: false, assessment: true, quotes: { essay: 'Write an essay.', documents: null, assessment: 'Take the test.' } }), { essay: true, documents: false, assessment: true });
  assert.deepEqual(needsFromVerdict(undefined), { essay: false, documents: false, assessment: false });
});

// ------------------------------------------------------------------------------- C2

test('[C] an equal-fit company with more active applications ranks lower', async () => {
  const { listQueue, compareQueueItems } = await load('C2', './src/commands/queue.mjs', ['listQueue', 'compareQueueItems']);
  const db = freshDb();
  const busy = seedApplication(db, { company: 'Busy Co', role: 'Data Intern', fit: 'high' });
  const quiet = seedApplication(db, { company: 'Quiet Co', role: 'Data Intern', fit: 'high' });
  seedApplication(db, { company: 'Busy Co', role: 'Analytics Intern', status: 'applied', appliedAt: '2026-10-01T00:00:00Z' });
  seedApplication(db, { company: 'Busy Co', role: 'ML Intern', status: 'prepared' });
  const queue = listQueue(db);
  assert.deepEqual(queue.map((row) => row.id), [quiet.id, busy.id], 'fewer active applications at the same company first');
  assert.deepEqual(queue.map((row) => row.companyLoad), [0, 2]);
  assert.ok(compareQueueItems({ fit: 'high', companyLoad: 0, id: 'z' }, { fit: 'high', companyLoad: 2, id: 'a' }) < 0);
  assert.ok(compareQueueItems({ fit: 'low', companyLoad: 0, id: 'a' }, { fit: 'high', companyLoad: 5, id: 'z' }) > 0, 'fit still comes first');
});

test('[C] verdict needs round-trip into the queue tab hint', async () => {
  const { listQueue } = await load('C2', './src/commands/queue.mjs', ['listQueue']);
  const { deliver } = await load('B5', './src/review/deliver.mjs', ['deliver']);
  const { claimItem } = await load('B3', './src/review/lease.mjs', ['claimItem']);
  const db = freshDb();
  insertPosting(db, { id: 'p-tab', company: 'Example Corp' });
  insertReview(db, { postingId: 'p-tab', stage: 'deliver' });
  const verdict = {
    decision: 'eligible', code: null, escalate: false, factsUsed: [], evidence: [],
    fit: { level: 'high', note: 'SQL and Python match' },
    deadline: { kind: 'none', date: null, time: null, tz: null, precision: null, quote: null },
    program: null,
    location: { offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' }], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' },
    needs: { essay: true, documents: false, assessment: false, quotes: { essay: 'All applicants submit a short written essay.', documents: null, assessment: null } },
  };
  const fence = claimItem(db, 'p-tab', { owner: 'worker-a', now: at(0) });
  const result = deliver(db, { postingId: 'p-tab', verdict, fence, now: at(0), policy: SCREENING_POLICY });
  const row = listQueue(db).find((item) => item.id === result.applicationId);
  assert.ok(row, 'the delivered lead is in the queue');
  assert.equal(row.tabHint, '✍️ Essay Example Corp');
});
