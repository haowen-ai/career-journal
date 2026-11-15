// Plan 2026-11-14 v2 (incremental nightly): the scan still enumerates every list, but a listing it has already
// seen (source + partition + native listing id) is skipped before classification. The first run after deploy is a
// baseline: it processes every row as before and records every id; skipping starts per list only after a scan that
// completed with that list read. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, T0, at } from '../../test-utils/funnel-v3.mjs';
import { record, PROFILE, SCREENING_POLICY } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runScan } from '../../src/scan/run.mjs';
import { listingKeyOf, nativeListingId } from '../../src/scan/listing-key.mjs';
import { parseCareerOpsRoles } from '../../src/scan/sources/careerops.mjs';
import { ingestBatch } from '../../src/funnel/ingest.mjs';

const A = 'greenhouse:alpha';
const B = 'greenhouse:beta';
const urlOf = (board, n) => `https://job-boards.greenhouse.io/${board}/jobs/${n}`;
const role = (board, partition, n, extra = {}) => record({ sourceId: String(n), url: urlOf(board, n), partition, company: `${board} Example Co`, ...extra });
const profile = { ...PROFILE, sources: { expected: ['atsBoards'], atsBoards: [{ ats: 'greenhouse', board: 'alpha' }, { ats: 'greenhouse', board: 'beta' }] } };
const ON = { enabled: true };
const scan = (db, runId, now, lists, { incremental = ON, collect } = {}) => runScan({ db, profile, runId, now, policy: SCREENING_POLICY, incremental,
  collect: collect ?? (async () => ({
    sources: lists.map(({ partition, records, status = 'ok' }) => ({ source: 'greenhouse', partition, status, count: records.length, rawCount: records.length })),
    batches: lists.filter((list) => (list.status ?? 'ok') !== 'error').map(({ partition, records }) => ({ source: 'greenhouse', partition, records, rawCount: records.length })),
  })) });
const sightings = (db, runId) => db.prepare('SELECT COUNT(*) n FROM observation_sightings WHERE run_id=?').get(runId).n;
const seenCount = (db, partition) => db.prepare('SELECT COUNT(*) n FROM seen_ids WHERE partition=?').get(partition).n;
const baselined = (db) => db.prepare('SELECT partition FROM seen_baselines ORDER BY partition').all().map((row) => row.partition);

test('the first run is a baseline: every row is processed as before and every listing id is recorded', async () => {
  const db = freshDb();
  const first = await scan(db, 'scan-1', T0, [{ partition: A, records: [1, 2, 3].map((n) => role('alpha', A, n)) }]);
  assert.equal(first.counts.skippedKnown, 0, 'nothing is skipped before a baseline exists');
  assert.equal(first.counts.new, 3);
  assert.equal(first.counts.stored + first.counts.countedOnly + first.counts.quarantined, 3);
  assert.equal(seenCount(db, A), 3);
  assert.deepEqual(baselined(db), [A], 'a completed run with the list read is its baseline');
  assert.equal(sightings(db, 'scan-1'), first.counts.stored);
});

test('after the baseline a known listing is skipped before classification; a new id is processed', async () => {
  const db = freshDb();
  await scan(db, 'scan-1', T0, [{ partition: A, records: [1, 2, 3].map((n) => role('alpha', A, n)) }]);
  const lastSeen = db.prepare('SELECT id,last_seen FROM postings ORDER BY id').all();
  const second = await scan(db, 'scan-2', at(1), [{ partition: A, records: [1, 2, 3, 4].map((n) => role('alpha', A, n)) }]);
  assert.equal(second.counts.raw, 4);
  assert.equal(second.counts.skippedKnown, 3);
  assert.equal(second.counts.new, 1);
  assert.equal(second.counts.newPostings, 1);
  // Conservation includes the skipped rows, per batch, per source and in the totals.
  assert.equal(second.counts.stored + second.counts.countedOnly + second.counts.quarantined + second.counts.skippedKnown, 4);
  const [batch] = second.ingest;
  assert.deepEqual([batch.fetched, batch.skippedKnown, batch.new], [4, 3, 1]);
  const source = second.sources.find((item) => item.partition === A);
  assert.deepEqual([source.fetched, source.skippedKnown, source.new], [4, 3, 1]);
  assert.equal(sightings(db, 'scan-2'), 1, 'known listings get no sighting');
  for (const row of lastSeen) assert.equal(db.prepare('SELECT last_seen FROM postings WHERE id=?').get(row.id).last_seen, row.last_seen, 'known listings are not touched');
  assert.equal(seenCount(db, A), 4);
});

test('health still reads the full list count: skipped rows raise no drop or zero alert', async () => {
  const db = freshDb();
  const records = Array.from({ length: 6 }, (_, i) => role('alpha', A, i + 1));
  await scan(db, 'scan-1', T0, [{ partition: A, records }]);
  await scan(db, 'scan-2', at(1), [{ partition: A, records }]);
  const third = await scan(db, 'scan-3', at(2), [{ partition: A, records }]);
  const source = third.sources.find((item) => item.partition === A);
  assert.equal(third.counts.skippedKnown, 6);
  assert.equal(source.count, 6, 'the list is still enumerated in full');
  assert.equal(source.alert, null);
  assert.ok(!third.alerts.some((item) => item.partition === A), JSON.stringify(third.alerts));
});

test('a baseline run that fails partway leaves skipping off; the ids it already wrote stay recorded', async () => {
  const db = freshDb();
  await assert.rejects(scan(db, 'scan-1', T0, [], { collect: async (_profile, { onBatch }) => {
    onBatch({ source: 'greenhouse', partition: A, records: [1, 2].map((n) => role('alpha', A, n)), rawCount: 2 });
    throw new Error('collector died');
  } }), /collector died/);
  assert.equal(seenCount(db, A), 2, 'the streamed batch recorded its ids');
  assert.deepEqual(baselined(db), [], 'no baseline from a run that did not finish');
  const next = await scan(db, 'scan-2', at(1), [{ partition: A, records: [1, 2].map((n) => role('alpha', A, n)) }]);
  assert.equal(next.counts.skippedKnown, 0, 'still the old flow: every row processed');
  assert.deepEqual(baselined(db), [A]);
});

test('a list that failed in the baseline run gets no baseline; others do', async () => {
  const db = freshDb();
  await scan(db, 'scan-1', T0, [{ partition: A, records: [role('alpha', A, 1)] }, { partition: B, records: [], status: 'error' }]);
  assert.deepEqual(baselined(db), [A]);
  const next = await scan(db, 'scan-2', at(1), [{ partition: A, records: [role('alpha', A, 1)] }, { partition: B, records: [role('beta', B, 1)] }]);
  assert.equal(next.counts.skippedKnown, 1, 'only the baselined list skips');
  assert.equal(next.counts.new, 1);
  assert.deepEqual(baselined(db), [A, B]);
});

test('with incremental turned off nothing is skipped, ids are still recorded', async () => {
  const db = freshDb();
  const records = [1, 2].map((n) => role('alpha', A, n));
  await scan(db, 'scan-1', T0, [{ partition: A, records }], { incremental: { enabled: false } });
  const second = await scan(db, 'scan-2', at(1), [{ partition: A, records }], { incremental: { enabled: false } });
  assert.equal(second.counts.skippedKnown, 0);
  assert.equal(seenCount(db, A), 2);
});

test('Greenhouse postings that share one requisition are two listings: the second is new', async () => {
  const db = freshDb();
  await scan(db, 'scan-1', T0, [{ partition: A, records: [role('alpha', A, 11, { requisitionId: 'R-77' })] }]);
  const second = await scan(db, 'scan-2', at(1), [{ partition: A, records: [role('alpha', A, 11, { requisitionId: 'R-77' }), role('alpha', A, 12, { requisitionId: 'R-77', title: 'Data Science Intern, Summer 2027 (NYC)' })] }]);
  assert.equal(second.counts.skippedKnown, 1);
  assert.equal(second.counts.new, 1, 'a shared requisition does not hide the other posting');
});

test('the same listing id in two partitions is two keys; a known id in its own partition is skipped', async () => {
  const db = freshDb();
  await scan(db, 'scan-1', T0, [{ partition: A, records: [role('alpha', A, 5)] }, { partition: B, records: [] }]);
  const second = await scan(db, 'scan-2', at(1), [{ partition: A, records: [role('alpha', A, 5)] }, { partition: B, records: [role('alpha', B, 5)] }]);
  assert.equal(second.counts.skippedKnown, 1);
  assert.equal(second.counts.new, 1);
});

test('the scan hands the collector the known listing ids of baselined CareerOps lists only', async () => {
  const db = freshDb();
  const CO = 'workday:Acme';
  const COB = 'workday:Beta';
  const careerOpsProfile = { ...PROFILE, sources: { expected: [], atsBoards: [], careerOps: true } };
  const coRole = (partition, token) => ({ ...record({ source: 'careerops', partition, sourceId: `https://acme.wd5.myworkdayjobs.com/x/job/Chicago/Intern_${token}`, url: `https://acme.wd5.myworkdayjobs.com/x/job/Chicago/Intern_${token}` }), listingId: token });
  let seenKnown = 'unset';
  const run = (runId, now, lists) => runScan({ db, profile: careerOpsProfile, runId, now, policy: SCREENING_POLICY, incremental: ON,
    collect: async (_profile, { knownListings }) => {
      seenKnown = knownListings;
      return { sources: lists.map(({ partition, records, status = 'ok' }) => ({ source: 'careerops', partition, status, count: records.length, rawCount: records.length })),
        batches: lists.filter((list) => (list.status ?? 'ok') !== 'error').map(({ partition, records }) => ({ source: 'careerops', partition, records, rawCount: records.length })) };
    } });
  await run('scan-1', T0, [{ partition: CO, records: [coRole(CO, 'R100'), coRole(CO, 'R101')] }, { partition: COB, records: [], status: 'error' }]);
  assert.equal(seenKnown, null, 'nothing is known before a baseline');
  await run('scan-2', at(1), [{ partition: CO, records: [coRole(CO, 'R100')] }]);
  assert.deepEqual(Object.keys(seenKnown), [CO]);
  assert.deepEqual([...seenKnown[CO]].sort(), ['R100', 'R101']);
});

test('the listing id travels with the record but never changes its stored content or hash', () => {
  const db = freshDb();
  const plain = role('alpha', A, 1);
  const first = ingestBatch(db, { runId: 'scan-1', source: 'greenhouse', partition: A, records: [plain], now: T0, policy: SCREENING_POLICY, profile: PROFILE });
  assert.equal(first.stored, 1);
  ingestBatch(db, { runId: 'scan-2', source: 'greenhouse', partition: A, records: [{ ...plain, listingId: '1' }], now: at(1), policy: SCREENING_POLICY, profile: PROFILE });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM observations').get().n, 1, 'same content: no new observation');
  assert.ok(!db.prepare('SELECT fields_json FROM observations').get().fields_json.includes('listingId'));
});

test('native listing id: provider identity first, then listingId, externalId, id, canonical URL', () => {
  assert.equal(nativeListingId({ listingIdentity: { posting_id: '42' }, externalId: '9', url: 'https://x.example/a' }), '42');
  assert.equal(nativeListingId({ listingId: 'R167982-1', id: 'https://acme.wd5.myworkdayjobs.com/x/job/A_R167982-1', url: 'https://acme.wd5.myworkdayjobs.com/x/job/A_R167982-1' }), 'R167982-1');
  assert.equal(nativeListingId({ externalId: 77, url: 'https://x.example/a' }), '77');
  assert.equal(nativeListingId({ id: 'abc', url: 'https://x.example/a' }), 'abc');
  assert.equal(nativeListingId({ url: 'https://www.x.example/a/?utm_source=z' }), 'x.example/a');
  assert.equal(nativeListingId({}), null);
  // Simplify keeps its own row id; a board record its source id.
  assert.equal(listingKeyOf({ source: 'simplify', sourceId: 'abc-123', url: 'https://x.example/a' }), 'abc-123');
  assert.equal(listingKeyOf({ source: 'greenhouse', sourceId: '9', url: 'https://x.example/a' }), '9');
});

test('a Workday posting read by two keyword searches carries one listing id through parseCareerOpsRoles', () => {
  const url = 'https://acme.wd5.myworkdayjobs.com/acmecareers/job/USA---Chicago-IL/Finance-Intern_R5555';
  const [one, two] = parseCareerOpsRoles({ roles: [
    { id: url, url, company: 'Acme', title: 'Finance Intern', partition: 'workday:Acme', listingId: 'R5555' },
    { id: url, url, company: 'Acme', title: 'Finance Intern', partition: 'workday:Acme', listingId: 'R5555' },
  ] });
  assert.equal(one.listingId, 'R5555');
  assert.equal(listingKeyOf(one), listingKeyOf(two));
  const [gh] = parseCareerOpsRoles({ roles: [{ id: 'https://job-boards.greenhouse.io/a/jobs/1', url: 'https://job-boards.greenhouse.io/a/jobs/1', company: 'A', title: 'Intern', listingIdentity: { ats_provider: 'greenhouse', board_slug: 'a', posting_id: '1' }, externalId: '1' }] });
  assert.equal(gh.listingId, '1');
});

// ---- v3.1 step 8': early stop for Oracle Cloud and Taleo, with list watermarks ----
const CO_PROFILE = { ...PROFILE, sources: { expected: ['careerops'], atsBoards: [], careerOps: true } };
const ORC = 'oraclecloud:Acme';
const TAL = 'taleo:Bank';
const coRow = (partition, n) => record({ source: 'careerops', partition, sourceId: `https://acme.example.test/job/${n}`, url: `https://acme.example.test/job/${n}` });
const coScan = (db, runId, now, lists, { fail, seenArgs = [] } = {}) => runScan({ db, profile: CO_PROFILE, runId, now, policy: SCREENING_POLICY, incremental: ON,
  collect: async (_profile, args) => {
    seenArgs.push(args);
    if (fail) throw new Error('collector died');
    return { careerOpsPartitions: lists.map((list) => list.partition),
      sources: lists.map(({ partition, records, status = 'ok', collection, truncated = false }) => ({ source: 'careerops', partition, status, count: records.length, rawCount: records.length, truncated,
        ...(collection ? { collection, collectionMode: collection === 'early_stopped' ? 'early_stopped' : 'full' } : {}) })),
      batches: lists.filter((list) => (list.status ?? 'ok') !== 'error').map(({ partition, records }) => ({ source: 'careerops', partition, records, rawCount: records.length })) };
  } });
const watermarks = (db) => Object.fromEntries(db.prepare('SELECT partition,completed_at FROM list_watermarks').all().map((row) => [row.partition, row.completed_at]));

test('a list read complete or early-stopped advances its watermark to the run start; page_failed, ceiling and errors do not', async () => {
  const db = freshDb();
  await coScan(db, 'scan-1', T0, [
    { partition: ORC, records: [coRow(ORC, 1)], collection: 'complete' },
    { partition: TAL, records: [coRow(TAL, 1)], collection: 'page_failed', status: 'partial', truncated: true },
    { partition: 'oraclecloud:Capped', records: [coRow('oraclecloud:Capped', 1)], collection: 'ceiling', status: 'partial', truncated: true },
    { partition: 'oraclecloud:Down', records: [], status: 'error' },
    { partition: 'workday:NoStatus', records: [coRow('workday:NoStatus', 1)] },
  ]);
  assert.deepEqual(watermarks(db), { [ORC]: T0 });
  await coScan(db, 'scan-2', at(1), [{ partition: ORC, records: [coRow(ORC, 2)], collection: 'early_stopped' }]);
  assert.deepEqual(watermarks(db), { [ORC]: at(1) });
});

test('a run that dies keeps the old watermark', async () => {
  const db = freshDb();
  await coScan(db, 'scan-1', T0, [{ partition: ORC, records: [coRow(ORC, 1)], collection: 'complete' }]);
  await assert.rejects(coScan(db, 'scan-2', at(1), [], { fail: true }));
  assert.deepEqual(watermarks(db), { [ORC]: T0 });
});

test('the collector gets the watermarks of baselined lists only', async () => {
  const db = freshDb();
  const seenArgs = [];
  await coScan(db, 'scan-1', T0, [{ partition: ORC, records: [coRow(ORC, 1)], collection: 'complete' }], { seenArgs });
  assert.equal(seenArgs[0].watermarks, null);
  await coScan(db, 'scan-2', at(1), [{ partition: ORC, records: [coRow(ORC, 1)], collection: 'complete' }], { seenArgs });
  assert.deepEqual(seenArgs[1].watermarks, { [ORC]: T0 });
});

test('an early-stopped list is not compared with the count baseline and never feeds it', async () => {
  const db = freshDb();
  const rows = (n) => Array.from({ length: n }, (_, i) => coRow(ORC, i + 1));
  await coScan(db, 'scan-1', T0, [{ partition: ORC, records: rows(20), collection: 'complete' }]);
  await coScan(db, 'scan-2', at(1), [{ partition: ORC, records: rows(20), collection: 'complete' }]);
  const stopped = await coScan(db, 'scan-3', at(2), [{ partition: ORC, records: rows(2), collection: 'early_stopped' }]);
  const source = stopped.sources.find((item) => item.partition === ORC);
  assert.equal(source.alert, null, 'two rows of an early-stopped read are not a drop');
  assert.equal(db.prepare("SELECT collection_mode FROM run_sources WHERE run_id='scan-3' AND partition=?").get(ORC).collection_mode, 'early_stopped');
  await coScan(db, 'scan-4', at(3), [{ partition: ORC, records: rows(2), collection: 'early_stopped' }]);
  const full = await coScan(db, 'scan-5', at(4), [{ partition: ORC, records: rows(20), collection: 'complete' }]);
  assert.equal(full.sources.find((item) => item.partition === ORC).baseline, 20, 'the baseline median reads full reads only');
});

// ---- plan v5: Apple whole-board early stop. An unverified read (the board's total changed while paging) is partial and
// never moves the watermark; complete and early_stopped do. ----
test('an Apple list: complete sets the watermark, unverified keeps it, early_stopped moves it', async () => {
  const db = freshDb();
  const APPLE = 'apple:Apple';
  await coScan(db, 'scan-1', T0, [{ partition: APPLE, records: [coRow(APPLE, 1)], collection: 'complete' }]);
  assert.deepEqual(watermarks(db), { [APPLE]: T0 });
  await coScan(db, 'scan-2', at(1), [{ partition: APPLE, records: [coRow(APPLE, 2)], collection: 'unverified', status: 'partial', truncated: true }]);
  assert.deepEqual(watermarks(db), { [APPLE]: T0 }, 'a board whose total changed mid-read proves nothing');
  await coScan(db, 'scan-3', at(2), [{ partition: APPLE, records: [coRow(APPLE, 3)], collection: 'early_stopped' }]);
  assert.deepEqual(watermarks(db), { [APPLE]: at(2) });
});
