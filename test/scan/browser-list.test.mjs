import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { runCli } from '../../src/cli/main.mjs';
import { createRuntime } from '../../src/runtime/create-runtime.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { loadScanProfile } from '../../src/scan/profile-input.mjs';
import { runScan } from '../../src/scan/run.mjs';
import { collectCareerOpsRaw } from '../../src/integrations/careerops-scan-bridge.mjs';
import { parseCareerOpsRaw } from '../../src/scan/sources/careerops.mjs';

import { assessSourceHealth } from '../../src/funnel/health.mjs';
import { BROWSER_LIST_DETAIL, PARTIAL_LIST_NOTE, attachBrowserList, failedLists } from '../../src/scan/browser-list.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { readFixture } from '../../test-utils/scan-fixtures.mjs';

const WALLED = 'demo:Walled Co';
const HEALTHY = 'demo:Healthy Co';
const job = (i) => ({ id: `h-${i}`, source: 'careerops', sourceId: `h-${i}`, partition: HEALTHY, company: 'Healthy Co', title: `Data Science Intern ${i}`,
  url: `https://healthy.example.test/jobs/${i}`, locations: ['Chicago, IL'], description: 'Summer 2027 internship for students.', listed: true, completeness: {} });

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-browser-list-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const file = path.join(home, '.career-journal', 'profile', 'profile.json');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(await readFixture('profile.json'), null, 2), { mode: 0o600 });
    await run(home);
  } finally { await rm(home, { recursive: true, force: true }); }
}

// A scan in which one company list failed and another was read.
async function scanWithFailure(home, { runId = 'scan-night-1', now = '2026-11-08T03:00:00.000Z', sources } = {}) {
  const { db } = await openHomeDatabase(home);
  try {
    return await runScan({ db, profile: await loadScanProfile(home), runId, now, collect: async () => ({
      sources: sources ?? [
        { source: 'careerops', partition: WALLED, status: 'error', count: 0, rawCount: 0, truncated: false, detail: 'HTTP 403 Forbidden', company: 'Walled Co', careersUrl: 'https://careers.walled.example.test/search' },
        { source: 'careerops', partition: HEALTHY, status: 'ok', count: 2, rawCount: 2, truncated: false },
      ],
      batches: sources ? [] : [{ source: 'careerops', partition: HEALTHY, records: [job(1), job(2)], rawCount: 2 }],
      careerOpsPartitions: (sources ?? [{ partition: WALLED }, { partition: HEALTHY }]).map((item) => item.partition).filter((name) => name !== 'all'),
    }) });
  } finally { db.close(); }
}

async function cli(args, now) {
  const runtime = { ...createRuntime({ root: process.cwd(), version: 'test' }), ...(now ? { now: () => now } : {}) };
  const io = memoryIO();
  const code = await runCli(args, io, runtime);
  return { code, stdout: io.stdout, stderr: io.stderr };
}
const json = async (args, now) => { const result = await cli([...args, '--json'], now); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); };
const rowsFile = async (home, rows, name = 'rows.json') => { const file = path.join(home, name); await writeFile(file, JSON.stringify(rows)); return file; };
const ROWS = [
  { title: 'Data Analytics Intern - Summer 2027', url: 'https://careers.walled.example.test/job/101', location: 'Chicago, IL' },
  { title: 'Strategy Intern - Summer 2027', url: 'https://careers.walled.example.test/job/102', location: 'New York, NY' },
  { title: 'Strategy Intern - Summer 2027', url: 'https://careers.walled.example.test/job/102', location: 'New York, NY' },
];

test('a failed entry reports its company and careers page; a fetched entry does not', async () => {
  const provider = { id: 'demo', fetch: async (entry) => { if (entry.name === 'Walled Co') throw Object.assign(new Error('HTTP 403 Forbidden'), { status: 403 }); return []; } };
  const result = await collectCareerOpsRaw({ portals: { tracked_companies: [
    { name: 'Walled Co', careers_url: 'https://careers.walled.example.test/search' }, { name: 'Healthy Co', careers_url: 'https://healthy.example.test/jobs' }] },
  providers: { demo: provider }, resolveProvider: async () => ({ provider, id: 'demo' }), makeHttpCtx: async () => ({}), sleep: async () => {} });
  assert.equal(result.partitions[0].company, 'Walled Co');
  assert.equal(result.partitions[0].careersUrl, 'https://careers.walled.example.test/search');
  assert.equal('careersUrl' in result.partitions[1], false);
  const [source] = parseCareerOpsRaw({ ok: true, roles: [], ...result }).sources;
  assert.equal(source.careersUrl, 'https://careers.walled.example.test/search', 'the address reaches the scan receipt');
});

test('failed-lists names the lists of the latest scan that could not be fetched, with their careers page', async () => fixture(async (home) => {
  assert.deepEqual(await json(['scan', 'failed-lists', '--home', home]), { scanRunId: null, scanRunning: false, wholeScanFailed: false, lists: [] });
  await scanWithFailure(home);
  const state = await json(['scan', 'failed-lists', '--home', home]);
  assert.equal(state.scanRunId, 'scan-night-1');
  assert.equal(state.wholeScanFailed, false);
  assert.deepEqual(state.lists, [{ partition: WALLED, company: 'Walled Co', careersUrl: 'https://careers.walled.example.test/search', error: 'HTTP 403 Forbidden' }]);
}));

test('attach ingests the rows read in a browser as a partial list, once, and the list leaves the queue', async () => fixture(async (home) => {
  await scanWithFailure(home);
  const file = await rowsFile(home, ROWS);
  const summary = await json(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', file], '2026-11-08T04:00:00.000Z');
  assert.equal(summary.browserList, true);
  assert.equal(summary.status, 'partial');
  assert.deepEqual([summary.sources[0].partition, summary.sources[0].status, summary.sources[0].count, summary.sources[0].detail], [WALLED, 'partial', 2, BROWSER_LIST_DETAIL]);
  assert.equal(summary.counts.raw, 2, 'the repeated link is one row');
  assert.equal(summary.counts.stored + summary.counts.countedOnly + summary.counts.quarantined, 2);
  const { db } = await openHomeDatabase(home);
  try {
    const stored = db.prepare("SELECT fields_json FROM observations WHERE source='careerops' AND partition=? ORDER BY rowid").all(WALLED).map((row) => JSON.parse(row.fields_json));
    assert.deepEqual(stored.map((role) => [role.company, role.title, role.url]), [
      ['Walled Co', 'Data Analytics Intern - Summer 2027', 'https://careers.walled.example.test/job/101'],
      ['Walled Co', 'Strategy Intern - Summer 2027', 'https://careers.walled.example.test/job/102']]);
    const row = db.prepare('SELECT status,count,truncated,errors,detail FROM run_sources WHERE run_id=? AND partition=?').get(summary.runId, WALLED);
    assert.deepEqual({ ...row }, { status: 'partial', count: 2, truncated: 0, errors: 0, detail: BROWSER_LIST_DETAIL });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM runs WHERE status='running'").get().n, 0);
  } finally { db.close(); }
  assert.deepEqual((await json(['scan', 'failed-lists', '--home', home])).lists, []);
  const again = await cli(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', file]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /not a company list waiting for a browser read/);
}));

test('attach refuses a list that did not fail, and rows that are not a list of objects, and writes nothing', async () => fixture(async (home) => {
  await scanWithFailure(home);
  const healthy = await cli(['scan', 'attach', '--home', home, '--partition', HEALTHY, '--file', await rowsFile(home, ROWS)]);
  assert.equal(healthy.code, 1);
  assert.match(healthy.stderr, /not a company list waiting/);
  for (const [name, body] of [['object.json', { title: 'x' }], ['strings.json', ['Data Intern']]]) {
    const bad = await cli(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', await rowsFile(home, body, name)]);
    assert.equal(bad.code, 1, name);
  }
  const missing = await cli(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', path.join(home, 'nope.json')]);
  assert.equal(missing.code, 1);
  const { db } = await openHomeDatabase(home);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n, 1, 'only the scan itself is recorded');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM observations WHERE partition=?').get(WALLED).n, 0);
  } finally { db.close(); }
  assert.equal((await json(['scan', 'failed-lists', '--home', home])).lists.length, 1, 'the list is still waiting');
}));

test('a row without a title or link is quarantined and counted, not dropped silently', async () => fixture(async (home) => {
  await scanWithFailure(home);
  const file = await rowsFile(home, [ROWS[0], { title: '', url: 'https://careers.walled.example.test/job/103', location: 'Austin, TX' }, { title: 'Finance Intern', location: 'Austin, TX' }]);
  const summary = await json(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', file]);
  assert.equal(summary.counts.raw, 3);
  assert.equal(summary.counts.quarantined, 2);
}));

test('a careers page that cannot be read in a browser either is recorded as a failed read and leaves the queue', async () => fixture(async (home) => {
  await scanWithFailure(home);
  const noReason = await cli(['scan', 'attach', '--home', home, '--partition', WALLED, '--unreadable']);
  assert.equal(noReason.code, 1);
  const summary = await json(['scan', 'attach', '--home', home, '--partition', WALLED, '--unreadable', '--reason', 'sign-in wall https://careers.walled.example.test/search'], '2026-11-08T04:00:00.000Z');
  assert.equal(summary.sources[0].status, 'error');
  assert.match(summary.sources[0].detail, /^browser read failed: sign-in wall/);
  assert.deepEqual((await json(['scan', 'failed-lists', '--home', home])).lists, []);
}));

test('a new scan in which the list fails again puts it back in the queue', async () => fixture(async (home) => {
  await scanWithFailure(home);
  await json(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', await rowsFile(home, ROWS)], '2026-11-08T04:00:00.000Z');
  await scanWithFailure(home, { runId: 'scan-night-2', now: '2026-11-09T03:00:00.000Z' });
  const state = await json(['scan', 'failed-lists', '--home', home]);
  assert.equal(state.scanRunId, 'scan-night-2');
  assert.deepEqual(state.lists.map((item) => item.partition), [WALLED]);
}));

test('a browser read is not a fetch attempt: the fail streak counts only the failures of the provider and the baseline ignores it', async () => fixture(async (home) => {
  const streaks = [];
  for (const [index, mode] of ['rows', 'unreadable', 'rows'].entries()) {
    const day = 7 + index;
    const scan = await scanWithFailure(home, { runId: `scan-night-${index + 1}`, now: `2026-11-0${day}T03:00:00.000Z` });
    const walled = scan.sources.find((item) => item.partition === WALLED);
    streaks.push(walled.failStreak);
    assert.equal(walled.baseline, null, 'student rows read in a browser are not a baseline for the whole list');
    assert.equal(scan.sources.find((item) => item.partition === HEALTHY).alert, null);
    if (mode === 'rows') await json(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', await rowsFile(home, ROWS)], `2026-11-0${day}T04:00:00.000Z`);
    else await json(['scan', 'attach', '--home', home, '--partition', WALLED, '--unreadable', '--reason', 'bot wall https://careers.walled.example.test/search'], `2026-11-0${day}T04:00:00.000Z`);
  }
  assert.deepEqual(streaks, [1, 2, 3], 'three nights the provider failed, whatever the browser read did in between');
}));

test('a posting the journal already knows keeps its record and its review; only new postings are ingested', async () => fixture(async (home) => {
  const known = { ...job(1), partition: WALLED, company: 'Walled Co', url: 'https://careers.walled.example.test/job/101', sourceId: 'w-101', id: 'w-101' };
  const { db } = await openHomeDatabase(home);
  let postingId; let before;
  try {
    await runScan({ db, profile: await loadScanProfile(home), runId: 'scan-night-0', now: '2026-11-07T03:00:00.000Z', collect: async () => ({
      sources: [{ source: 'careerops', partition: WALLED, status: 'ok', count: 1, rawCount: 1, truncated: false }],
      batches: [{ source: 'careerops', partition: WALLED, records: [known], rawCount: 1 }], careerOpsPartitions: [WALLED, HEALTHY] }) });
    postingId = db.prepare("SELECT posting_id FROM observations WHERE source='careerops' AND partition=?").get(WALLED)?.posting_id;
    assert.ok(postingId, 'the provider read stored the posting');
    assert.ok(db.prepare('SELECT 1 FROM reviews WHERE posting_id=?').get(postingId), 'and opened a review for it');
    // The reviewer found a sign-in wall on the posting page: a system hold that must survive.
    db.prepare("UPDATE reviews SET state='held',hold_owner='system',code='external_signin_wall' WHERE posting_id=?").run(postingId);
    before = { ...db.prepare('SELECT state,stage,decision,code,hold_owner FROM reviews WHERE posting_id=?').get(postingId) };
  } finally { db.close(); }
  await scanWithFailure(home, { runId: 'scan-night-1', now: '2026-11-08T03:00:00.000Z' });
  const rows = [{ ...ROWS[0], url: `${ROWS[0].url}?utm_source=careers` }, ROWS[0], ROWS[1]];
  const summary = await json(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', await rowsFile(home, rows)], '2026-11-08T04:00:00.000Z');
  assert.equal(summary.sources[0].count, 2, 'two postings were read (a tracking parameter does not make a third)');
  assert.equal(summary.counts.known, 1);
  assert.equal(summary.counts.raw, 1, 'only the new posting is ingested');
  const reopened = await openHomeDatabase(home);
  try {
    assert.deepEqual({ ...reopened.db.prepare('SELECT state,stage,decision,code,hold_owner FROM reviews WHERE posting_id=?').get(postingId) }, before);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM observations WHERE posting_id=?').get(postingId).n, 1, 'no thinner copy of a known posting is stored');
  } finally { reopened.db.close(); }
}));

test('while a scan is running nothing is offered or attached; a read made for the earlier scan does not hide the new failure', async () => fixture(async (home) => {
  await scanWithFailure(home);
  const { db } = await openHomeDatabase(home);
  try {
    // Read for scan-night-1, then a new scan starts, is seen running, and fails on the same list.
    db.prepare("INSERT INTO runs (run_id,kind,owner,started_at,heartbeat_at,status) VALUES ('scan-night-2','scan','o','2026-11-09T03:00:00.000Z','2026-11-09T03:05:00.000Z','running')").run();
  } finally { db.close(); }
  const during = await json(['scan', 'failed-lists', '--home', home], '2026-11-09T03:06:00.000Z');
  assert.deepEqual([during.scanRunning, during.scanRunId, during.lists], [true, 'scan-night-2', []]);
  const refused = await cli(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', await rowsFile(home, ROWS)], '2026-11-09T03:06:00.000Z');
  assert.equal(refused.code, 75);
  assert.match(refused.stderr, /still running/);
  // A dead run (no heartbeat for ten minutes) does not block; the read belongs to scan-night-1.
  const late = await json(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', await rowsFile(home, ROWS)], '2026-11-09T05:00:00.000Z');
  assert.equal(late.forScanRunId, 'scan-night-1');
  const again = await openHomeDatabase(home);
  try { again.db.prepare("DELETE FROM runs WHERE run_id='scan-night-2'").run(); } finally { again.db.close(); }
  await scanWithFailure(home, { runId: 'scan-night-2', now: '2026-11-09T03:00:00.000Z' });
  const after = await json(['scan', 'failed-lists', '--home', home], '2026-11-09T06:00:00.000Z');
  assert.equal(after.scanRunId, 'scan-night-2');
  assert.deepEqual(after.lists.map((item) => item.partition), [WALLED], 'the earlier read (started later than this scan) does not settle it');
}));

test('when ingesting the rows fails nothing is settled and the list can be attached again', async () => fixture(async (home) => {
  await scanWithFailure(home);
  const { db } = await openHomeDatabase(home);
  try {
    const profile = await loadScanProfile(home);
    const broken = new Proxy({}, { get() { throw new Error('profile unreadable'); } });
    assert.throws(() => attachBrowserList(db, { partition: WALLED, rows: ROWS, now: '2026-11-08T04:00:00.000Z', profile: broken }), /profile unreadable/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM run_sources WHERE detail LIKE 'browser%'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM observations WHERE partition=?').get(WALLED).n, 0);
    assert.deepEqual(failedLists(db, { now: '2026-11-08T04:01:00.000Z' }).lists.map((item) => item.partition), [WALLED]);
    const summary = attachBrowserList(db, { partition: WALLED, rows: ROWS, now: '2026-11-08T04:02:00.000Z', profile });
    assert.equal(summary.sources[0].count, 2);
    assert.deepEqual(failedLists(db, { now: '2026-11-08T04:03:00.000Z' }).lists, []);
  } finally { db.close(); }
}));

test('--reason without a value is refused; failed-lists prints one line per waiting list', async () => fixture(async (home) => {
  await scanWithFailure(home);
  const bare = await cli(['scan', 'attach', '--home', home, '--partition', WALLED, '--unreadable', '--reason']);
  assert.equal(bare.code, 1);
  const text = await cli(['scan', 'failed-lists', '--home', home]);
  assert.equal(text.stdout.trim(), `${WALLED}\thttps://careers.walled.example.test/search\tHTTP 403 Forbidden`);
}));

test('when the whole CareerOps step failed there is no company list to read by hand', async () => fixture(async (home) => {
  await scanWithFailure(home, { sources: [{ source: 'careerops', partition: 'all', status: 'error', count: 0, rawCount: 0, truncated: false, detail: 'CareerOps output exceeds byte limit' }] });
  const state = await json(['scan', 'failed-lists', '--home', home]);
  assert.equal(state.wholeScanFailed, true);
  assert.deepEqual(state.lists, []);
  const text = await cli(['scan', 'failed-lists', '--home', home]);
  assert.match(text.stdout, /whole CareerOps step failed/);
}));

test('the same posting listed under two locations is one row with both locations', async () => fixture(async (home) => {
  await scanWithFailure(home);
  const rows = [{ title: 'Data Intern', url: 'https://careers.walled.example.test/job/201', location: 'Toronto, ON, CA' },
    { title: 'Data Intern', url: 'https://careers.walled.example.test/job/201?utm_source=x', location: 'Chicago, IL' }];
  const summary = await json(['scan', 'attach', '--home', home, '--partition', WALLED, '--file', await rowsFile(home, rows)]);
  assert.equal(summary.sources[0].count, 1);
  const { db } = await openHomeDatabase(home);
  try {
    const stored = JSON.parse(db.prepare("SELECT fields_json FROM observations WHERE partition=?").get(WALLED).fields_json);
    assert.deepEqual(stored.locations, ['Toronto, ON, CA', 'Chicago, IL']);
  } finally { db.close(); }
}));

test('a list that failed after printing a cap warning is still a failed list, so it can be read in a browser', () => {
  const parsed = parseCareerOpsRaw({ ok: true, roles: [], configuredPartitions: ['demo:Capped'],
    partitions: [{ partition: 'demo:Capped', status: 'error', count: 0, rawCount: 0, error: 'HTTP 500', truncated: true, capDetected: true }] });
  assert.equal(parsed.sources[0].status, 'error');
  assert.equal(parsed.sources[0].detail, 'HTTP 500');
});

// A list read only in part (page cap, a failed later page) also gets a browser read (user 2026-11-13);
// the rows the scan did fetch stay stored and are not overwritten by the browser rows.
const CUT = 'demo:Cut Co';
const cutJob = (i) => ({ id: `c-${i}`, source: 'careerops', sourceId: `c-${i}`, partition: CUT, company: 'Cut Co', title: `Finance Intern ${i}`,
  url: `https://cut.example.test/jobs/${i}`, locations: ['Boston, MA'], description: 'Summer 2027 internship for students. Full provider text.', listed: true, completeness: {} });
async function scanWithPartial(home) {
  const { db } = await openHomeDatabase(home);
  try {
    return await runScan({ db, profile: await loadScanProfile(home), runId: 'scan-night-1', now: '2026-11-08T03:00:00.000Z', collect: async () => ({
      sources: [
        { source: 'careerops', partition: WALLED, status: 'error', count: 0, rawCount: 0, truncated: false, detail: 'HTTP 403 Forbidden', company: 'Walled Co', careersUrl: 'https://careers.walled.example.test/search' },
        { source: 'careerops', partition: CUT, status: 'partial', count: 2, rawCount: 2, truncated: true, company: 'Cut Co', careersUrl: 'https://cut.example.test/search' },
        { source: 'careerops', partition: HEALTHY, status: 'ok', count: 2, rawCount: 2, truncated: false },
      ],
      batches: [{ source: 'careerops', partition: CUT, records: [cutJob(1), cutJob(2)], rawCount: 2 }, { source: 'careerops', partition: HEALTHY, records: [job(1), job(2)], rawCount: 2 }],
      careerOpsPartitions: [WALLED, CUT, HEALTHY],
    }) });
  } finally { db.close(); }
}

test('failed-lists also names a partial list, marked as partly read with its fetched rows kept', async () => fixture(async (home) => {
  await scanWithPartial(home);
  const state = await json(['scan', 'failed-lists', '--home', home]);
  assert.equal(state.wholeScanFailed, false);
  assert.deepEqual(state.lists.map((item) => item.partition), [CUT, WALLED]);
  const cut = state.lists.find((item) => item.partition === CUT);
  assert.deepEqual([cut.status, cut.note, cut.company, cut.careersUrl, cut.error], ['partial', PARTIAL_LIST_NOTE, 'Cut Co', 'https://cut.example.test/search', null]);
  assert.equal('status' in state.lists.find((item) => item.partition === WALLED), false, 'a failed list keeps its old shape');
  const text = (await cli(['scan', 'failed-lists', '--home', home])).stdout;
  assert.match(text, new RegExp(`${CUT}\\thttps://cut.example.test/search\\t${PARTIAL_LIST_NOTE}`));
}));

test('attach accepts a partial list and adds only the postings the scan missed; fetched rows are not overwritten', async () => fixture(async (home) => {
  await scanWithPartial(home);
  const before = await (async () => { const { db } = await openHomeDatabase(home);
    try { return db.prepare("SELECT rowid,fields_json FROM observations WHERE partition=? ORDER BY rowid").all(CUT).map((row) => ({ ...row })); } finally { db.close(); } })();
  assert.equal(before.length, 2);
  const file = await rowsFile(home, [
    { title: 'Finance Intern 1', url: 'https://cut.example.test/jobs/1?utm_source=search', location: 'Boston, MA' },
    { title: 'Finance Intern 3', url: 'https://cut.example.test/jobs/3', location: 'Boston, MA' },
    { title: 'Finance Intern 3', url: 'https://cut.example.test/jobs/3', location: 'Chicago, IL' },
  ]);
  const summary = await json(['scan', 'attach', '--home', home, '--partition', CUT, '--file', file], '2026-11-08T04:00:00.000Z');
  assert.equal(summary.sources[0].status, 'partial');
  assert.equal(summary.sources[0].known, 1, 'the posting the scan already fetched is recognised');
  assert.equal(summary.counts.raw, 1, 'only the missed posting is ingested');
  const { db } = await openHomeDatabase(home);
  try {
    const after = db.prepare("SELECT rowid,fields_json FROM observations WHERE partition=? ORDER BY rowid").all(CUT).map((row) => ({ ...row }));
    assert.deepEqual(after.slice(0, 2), before, 'the fetched rows are untouched');
    assert.deepEqual(after.slice(2).map((row) => JSON.parse(row.fields_json).url), ['https://cut.example.test/jobs/3']);
    assert.deepEqual(JSON.parse(after[2].fields_json).locations, ['Boston, MA', 'Chicago, IL']);
  } finally { db.close(); }
  assert.deepEqual((await json(['scan', 'failed-lists', '--home', home])).lists.map((item) => item.partition), [WALLED], 'the partial list leaves the queue');
}));
