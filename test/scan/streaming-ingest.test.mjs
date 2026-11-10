// Component F (user 2026-11-09): runScan writes a batch the collector hands over through onBatch at once,
// during collection, with the same counts and receipt as writing it after collection. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshDb, T0 } from '../../test-utils/funnel-v3.mjs';
import { record, PROFILE, SCREENING_POLICY } from '../../test-utils/funnel-v3-fixtures.mjs';
import { collectRoles, runScan } from '../../src/scan/run.mjs';

const A = 'greenhouse:alpha';
const B = 'greenhouse:beta';
const urlOf = (board, n) => `https://job-boards.greenhouse.io/${board}/jobs/${n}`;
const recordsOf = (board, partition, ns) => ns.map((n) => record({ sourceId: `${board}-${n}`, url: urlOf(board, n), partition, company: `${board} Example Co` }));
const sourceOf = (partition, count) => ({ source: 'greenhouse', partition, status: 'ok', count, rawCount: count });
const batchOf = (partition, records, rawCount = records.length) => ({ source: 'greenhouse', partition, records, rawCount });
const profile = { ...PROFILE, sources: { expected: ['atsBoards'], atsBoards: [{ ats: 'greenhouse', board: 'alpha' }, { ats: 'greenhouse', board: 'beta' }] } };
const postings = (db) => db.prepare('SELECT COUNT(*) n FROM postings').get().n;
const runRow = (db, runId) => db.prepare('SELECT status FROM runs WHERE run_id=?').get(runId);
// Ingest timings differ between runs; everything else must match.
const withoutTimes = (receipt) => ({
  counts: receipt.counts,
  status: receipt.status,
  ingest: receipt.ingest.map(({ elapsedMs, ...rest }) => rest),
  sources: receipt.sources.map(({ ingestElapsedMs, ...rest }) => rest),
});

test('a batch delivered through onBatch is written during collection; counts and receipt equal the non-streaming scan', async () => {
  const alpha = recordsOf('alpha', A, [1, 2, 3]);
  const beta = recordsOf('beta', B, [1, 2]);
  const sources = [sourceOf(A, 3), sourceOf(B, 2)];

  const streamingDb = freshDb();
  const order = [];
  const streaming = await runScan({ db: streamingDb, profile, runId: 'scan-stream', now: T0, policy: SCREENING_POLICY,
    collect: async (_profile, { onBatch }) => {
      assert.equal(typeof onBatch, 'function');
      onBatch(batchOf(A, alpha));
      order.push(['alpha written during collection', postings(streamingDb)]);
      return { sources, batches: [batchOf(B, beta)] };
    } });
  assert.ok(order[0][1] > 0, 'the streamed batch is in the database before collection returns');

  const plainDb = freshDb();
  const plain = await runScan({ db: plainDb, profile, runId: 'scan-plain', now: T0, policy: SCREENING_POLICY,
    collect: async () => ({ sources, batches: [batchOf(A, alpha), batchOf(B, beta)] }) });

  assert.deepEqual(withoutTimes(streaming), withoutTimes(plain));
  assert.deepEqual(streaming.ingest.map((item) => item.partition), [A, B], 'streamed batch first, returned batches after');
  assert.equal(postings(streamingDb), postings(plainDb));
  const alphaSource = streaming.sources.find((item) => item.partition === A);
  assert.equal(alphaSource.fetched, 3, 'the streamed batch is merged into its source row');
  assert.equal(alphaSource.stored + alphaSource.countedOnly + alphaSource.quarantined, 3);
  assert.equal(runRow(streamingDb, 'scan-stream').status, streaming.status);
});

test('a second streamed batch is written before collection returns', async () => {
  const db = freshDb();
  const seen = [];
  await runScan({ db, profile, runId: 'scan-1', now: T0, policy: SCREENING_POLICY,
    collect: async (_profile, { onBatch }) => {
      onBatch(batchOf(A, recordsOf('alpha', A, [1])));
      seen.push(postings(db));
      await new Promise((resolve) => setTimeout(resolve, 5));
      onBatch(batchOf(B, recordsOf('beta', B, [1])));
      seen.push(postings(db));
      return { sources: [sourceOf(A, 1), sourceOf(B, 1)], batches: [] };
    } });
  assert.ok(seen[1] > seen[0] && seen[0] > 0, `each batch is written when it arrives: ${seen}`);
});

test('a conservation violation in a streamed batch still fails the scan', async () => {
  const db = freshDb();
  await assert.rejects(runScan({ db, profile, runId: 'scan-1', now: T0, policy: SCREENING_POLICY,
    collect: async (_profile, { onBatch }) => {
      onBatch(batchOf(A, recordsOf('alpha', A, [1, 2]), 3));
      return { sources: [sourceOf(A, 3)], batches: [] };
    } }), /Collector conservation violation: greenhouse:alpha/);
  assert.equal(runRow(db, 'scan-1').status, 'failed');
});

test('a streamed partition missing from the final source list fails the scan', async () => {
  const db = freshDb();
  await assert.rejects(runScan({ db, profile, runId: 'scan-1', now: T0, policy: SCREENING_POLICY,
    collect: async (_profile, { onBatch }) => {
      onBatch(batchOf(A, recordsOf('alpha', A, [1])));
      return { sources: [sourceOf(B, 1)], batches: [batchOf(B, recordsOf('beta', B, [1]))] };
    } }), /Collector omitted partition status: greenhouse:alpha/);
  assert.equal(runRow(db, 'scan-1').status, 'failed');
});

// The whole chain with real processes: a fake CareerOps root whose slow entry only finishes after the
// two fast ones were written to the database.
async function fakeRoot(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cj-streaming-scan-root-'));
  const files = {
    'package.json': JSON.stringify({ name: 'career-ops', version: '0.0.0-synthetic', private: true }),
    'portals.yml': JSON.stringify({ tracked_companies: entries }),
    'node_modules/js-yaml/package.json': JSON.stringify({ name: 'js-yaml', version: '0.0.0-synthetic', main: 'index.js' }),
    'node_modules/js-yaml/index.js': 'module.exports = { load: (text) => JSON.parse(text) };\n',
    'providers/_registry.mjs': `const fake = (await import(new URL('./fakeboard.mjs', import.meta.url))).default;
export async function loadProviders() { return new Map([['fakeboard', fake]]); }
export function resolveProvider() { return { provider: fake }; }
`,
    'providers/_http.mjs': 'export function makeHttpCtx() { return {}; }\n',
    'providers/fakeboard.mjs': `import { existsSync } from 'node:fs';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export default {
  id: 'fakeboard',
  async fetch(entry) {
    let state = 'plain';
    if (entry.wait_for) { state = 'gave-up'; for (let i = 0; i < 400; i += 1) { if (existsSync(entry.wait_for)) { state = 'released'; break; } await sleep(25); } }
    return [1, 2].map((n) => ({ id: entry.name + '-' + n, title: 'Data Science Intern, Summer 2027 ' + state, company: entry.name + ' Example Co',
      url: entry.careers_url + '/' + n, location: 'Chicago, IL', description: 'We are hiring a summer 2027 intern to analyse data. '.repeat(20) }));
  },
};
`,
    'plugins/_engine.mjs': 'export async function mergeProviderPlugins(providers) { return providers; }\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

test('runScan writes each CareerOps entry while the slow one is still being fetched', async () => {
  const release = path.join(os.tmpdir(), `cj-streaming-scan-release-${process.pid}-${Date.now()}`);
  const entry = (name, extra = {}) => ({ name, careers_url: `https://${name.toLowerCase()}.example.test/jobs`, ...extra });
  const root = await fakeRoot([entry('Slow', { wait_for: release }), entry('Fast'), entry('Quick')]);
  const env = process.env.CAREER_OPS_PORTALS;
  delete process.env.CAREER_OPS_PORTALS;
  try {
    const db = freshDb();
    const scanProfile = { ...PROFILE, sources: { careerOps: true, atsBoards: [], simplify: { enabled: false, url: null }, expected: [] } };
    const writtenBeforeRelease = [];
    const receipt = await runScan({ db, profile: scanProfile, runId: 'scan-co', now: T0, policy: SCREENING_POLICY,
      careerOpsConfig: { root, scanConcurrency: 3 },
      collect: (collectProfile, options) => collectRoles(collectProfile, { ...options, onBatch: (batch) => {
        options.onBatch(batch);
        writtenBeforeRelease.push([batch.partition, postings(db)]);
        if (writtenBeforeRelease.length === 2) writeFileSync(release, 'go');
      } }) });
    assert.deepEqual(writtenBeforeRelease.slice(0, 2).map(([partition]) => partition).sort(), ['fakeboard:Fast', 'fakeboard:Quick']);
    assert.ok(writtenBeforeRelease[1][1] > 0, 'rows of the fast entries are in the database before the slow one ends');
    assert.equal(receipt.counts.raw, 6);
    assert.deepEqual(receipt.ingest.map((item) => item.partition).slice(-1), ['fakeboard:Slow']);
    const slow = receipt.sources.find((item) => item.partition === 'fakeboard:Slow');
    assert.equal(slow.fetched, 2);
    const titles = db.prepare("SELECT title FROM postings WHERE title LIKE '%released%' OR title LIKE '%gave-up%'").all().map((row) => row.title);
    assert.equal(titles.length, 2);
    assert.ok(titles.every((title) => title.includes('released')), `the slow fetch ran while the others were written: ${titles}`);
    assert.ok(receipt.sources.filter((item) => item.source === 'careerops').every((item) => item.status === 'ok'), JSON.stringify(receipt.sources));
  } finally {
    if (env !== undefined) process.env.CAREER_OPS_PORTALS = env;
    await rm(root, { recursive: true, force: true }); await rm(release, { force: true });
  }
});

test('a CareerOps step that times out after streaming keeps the stored entries and makes the run partial', async () => {
  // The release file is never written: the slow entry is still running when the step times out.
  const never = path.join(os.tmpdir(), `cj-streaming-never-${process.pid}-${Date.now()}`);
  const entry = (name, extra = {}) => ({ name, careers_url: `https://${name.toLowerCase()}.example.test/jobs`, ...extra });
  const root = await fakeRoot([entry('Fast'), entry('Slow', { wait_for: never })]);
  const env = process.env.CAREER_OPS_PORTALS;
  delete process.env.CAREER_OPS_PORTALS;
  const scan = (db, expected, runId) => runScan({ db, runId, now: T0, policy: SCREENING_POLICY,
    profile: { ...PROFILE, sources: { careerOps: true, atsBoards: [], simplify: { enabled: false, url: null }, expected } },
    careerOpsConfig: { root, scanConcurrency: 2, scanTimeoutMs: 1_500 } });
  try {
    // First scan, no saved inventory, CareerOps not even listed as expected.
    const first = freshDb();
    const receipt = await scan(first, [], 'scan-first');
    assert.equal(receipt.counts.raw, 2, 'the finished entry was stored');
    assert.equal(postings(first), 2);
    assert.equal(receipt.sources.find((item) => item.partition === 'fakeboard:Fast').status, 'ok');
    assert.equal(receipt.sources.find((item) => item.source === 'careerops' && item.partition === 'all').status, 'error');
    assert.ok(receipt.alerts.some((item) => item.source === 'careerops' && item.partition === 'all' && item.alert === 'error'), JSON.stringify(receipt.alerts));
    assert.equal(receipt.status, 'partial');
    assert.equal(runRow(first, 'scan-first').status, 'partial');

    // Saved inventory known from an earlier scan: the entry never reached shows as not reported.
    const known = freshDb();
    for (const partition of ['fakeboard:Fast', 'fakeboard:Slow']) {
      known.prepare('INSERT INTO expected_partitions (source,partition,first_expected,last_expected,retired_at) VALUES (?,?,?,?,NULL)').run('careerops', partition, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    }
    const second = await scan(known, ['careerops'], 'scan-known');
    const slow = second.sources.find((item) => item.partition === 'fakeboard:Slow');
    assert.equal(slow.status, 'stale');
    assert.ok(['missing', 'never_reported'].includes(slow.alert), JSON.stringify(slow));
    assert.ok(second.alerts.some((item) => item.partition === 'fakeboard:Slow'));
    assert.ok(second.alerts.some((item) => item.source === 'careerops' && item.partition === 'all' && item.alert === 'error'));
    assert.equal(second.counts.raw, 2);
    assert.equal(second.status, 'partial');
    assert.equal(known.prepare("SELECT COUNT(*) n FROM expected_partitions WHERE source='careerops' AND partition='all'").get().n, 0, 'the step failure is not registered as a configured partition');
  } finally {
    if (env !== undefined) process.env.CAREER_OPS_PORTALS = env;
    await rm(root, { recursive: true, force: true });
  }
});
