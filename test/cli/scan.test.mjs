import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { doctor } from '../../src/commands/doctor.mjs';
import { runCli, HELP } from '../../src/cli/main.mjs';
import { createRuntime } from '../../src/runtime/create-runtime.mjs';
import { loadConfig, saveConfig } from '../../src/config/store.mjs';
import { defaultConfig } from '../../src/config/defaults.mjs';
import { openDatabase } from '../../src/storage/database.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createApplication } from '../../src/commands/application.mjs';
import { listTasks } from '../../src/automation/registry.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { ATS_URLS, SIMPLIFY_URL, defaultRoutes, fixtureFetch, readFixture } from '../../test-utils/scan-fixtures.mjs';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-cli-scan-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    await run(home);
  } finally { await rm(home, { recursive: true, force: true }); }
}

async function writeProfile(home, changes = (profile) => profile, file = path.join(home, '.career-journal', 'profile', 'profile.json')) {
  const profile = changes(structuredClone(await readFixture('profile.json')));
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(profile, null, 2), { mode: 0o600 });
  return file;
}

async function cli(args, { routes, calls = [] } = {}) {
  const runtime = { ...createRuntime({ root: process.cwd(), version: 'test' }), fetch: fixtureFetch(routes ?? await defaultRoutes(), calls) };
  const io = memoryIO();
  const code = await runCli(args, io, runtime);
  return { code, io, calls };
}

async function json(args, options) {
  const result = await cli([...args, '--json'], options);
  assert.equal(result.code, 0, result.io.stderr);
  return JSON.parse(result.io.stdout);
}

function database(home) {
  return openDatabase(path.join(home, '.career-journal', 'career-journal.db'));
}

// Scans no longer create leads (leads come from `review run`), so queue tests seed the leads they need.
const QUEUE_LEADS = [
  { company: 'Example Corp', role: 'Machine Learning Intern, Summer 2027', source: 'greenhouse', sourceId: '4000001', location: 'New York, NY', postedAt: '2026-09-28T18:00:00.000Z', fit: 'high', jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/4000001' },
  { company: 'Example Corp', role: 'Business Data Analyst Intern, Summer 2027', source: 'greenhouse', sourceId: '4000006', location: 'Seattle, WA', postedAt: '2026-09-30T08:00:00.000Z', fit: 'high', jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/4000006' },
  { company: 'Example Labs', role: 'Quantitative Research Intern', source: 'lever', sourceId: '11111111-1111-4111-8111-111111111111', location: 'New York, NY', postedAt: '2026-09-22T16:00:00.000Z', fit: 'medium', jobUrl: 'https://jobs.lever.co/examplelabs/11111111-1111-4111-8111-111111111111' },
  { company: 'Example Quant', role: 'Machine Learning Intern, Summer 2027', source: 'ashby', sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', location: 'Remote', postedAt: '2026-09-27T12:00:00.000Z', fit: 'high', jobUrl: 'https://jobs.ashbyhq.com/examplequant/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  { company: 'Example Quant', role: 'Data Science Intern, Summer 2027', source: 'ashby', sourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', location: 'Manhattan, New York; Seattle, WA', postedAt: '2026-09-29T12:00:00.000Z', fit: 'high', jobUrl: 'https://jobs.ashbyhq.com/examplequant/dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
];

async function seedQueue(home) {
  const { db } = await openHomeDatabase(home);
  try {
    return QUEUE_LEADS.map((lead) => {
      const application = createApplication(db, { company: lead.company, role: lead.role, jobUrl: lead.jobUrl }, '2026-10-01T00:00:00.000Z');
      db.prepare('UPDATE applications SET source = ?, source_id = ?, location = ?, posted_at = ?, fit = ? WHERE id = ?')
        .run(lead.source, lead.sourceId, lead.location, lead.postedAt, lead.fit, application.id);
      return application.id;
    });
  } finally { db.close(); }
}

test('help lists the scan and queue commands', () => {
  assert.match(HELP, /^ {2}scan {10}Scan official job boards for roles that match the profile$/m);
  assert.match(HELP, /^ {2}queue {9}List or verify queued roles before applying$/m);
});

test('scan run --dry-run collects and classifies without writing anything', async () => fixture(async (home) => {
  await writeProfile(home);
  const databaseFile = path.join(home, '.career-journal', 'career-journal.db');
  const summary = await json(['scan', 'run', '--home', home, '--dry-run']);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.counts.observed, 17, 'every board record, including malformed rows and unlisted postings, is observed');
  assert.equal(summary.counts.quarantined, 2);
  assert.equal('queued' in summary.counts, false);
  assert.equal(existsSync(databaseFile), false, 'a dry run on a fresh workspace creates no database');

  assert.equal((await cli(['scan', 'run', '--home', home])).code, 0);
  const db = database(home);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) count FROM applications').get().count, 0, 'a scan never creates leads');
    assert.ok(db.prepare('SELECT COUNT(*) count FROM observations').get().count > 0);
  } finally { db.close(); }
  const before = await readFile(databaseFile);
  const again = await json(['scan', 'run', '--home', home, '--dry-run']);
  assert.equal(again.counts.observed, 17);
  assert.deepEqual(await readFile(databaseFile), before, 'a dry run leaves an existing database unchanged');
}));

test('the opt-in Simplify source and the official board are one posting with two observations and no application', async () => fixture(async (home) => {
  const profilePath = await writeProfile(home, (profile) => {
    profile.sources.simplify = { enabled: true, url: SIMPLIFY_URL };
    return profile;
  }, path.join(home, 'custom-profile.json'));
  const calls = [];
  const summary = await json(['scan', 'run', '--home', home, '--profile', profilePath], {
    routes: await defaultRoutes({ [SIMPLIFY_URL]: await readFixture('simplify-listings.json') }), calls,
  });
  assert.ok(calls.includes(SIMPLIFY_URL));
  assert.equal(summary.counts.observed, 24);
  const db = database(home);
  try {
    const postingId = db.prepare("SELECT posting_id FROM posting_aliases WHERE alias = 'source:greenhouse:4000001'").get()?.posting_id;
    assert.ok(postingId, 'the board posting exists');
    const sources = db.prepare('SELECT source FROM observations WHERE posting_id = ? ORDER BY source').all(postingId).map((row) => row.source);
    assert.deepEqual(sources, ['greenhouse', 'simplify'], 'the Simplify listing of the same posting is a second observation, not a second posting');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM applications').get().count, 0);
  } finally { db.close(); }
}));

test('queue list orders by fit, cutoff, location rank, company load, then newest posting', async () => fixture(async (home) => {
  await writeProfile(home);
  const ids = await seedQueue(home);
  const queue = await json(['queue', 'list', '--home', home]);
  assert.deepEqual(queue.map((item) => [item.company, item.role, item.fit, item.locRank]), [
    ['Example Quant', 'Data Science Intern, Summer 2027', 'high', 1],
    ['Example Corp', 'Machine Learning Intern, Summer 2027', 'high', 1],
    ['Example Corp', 'Business Data Analyst Intern, Summer 2027', 'high', 2],
    ['Example Quant', 'Machine Learning Intern, Summer 2027', 'high', 3],
    ['Example Labs', 'Quantitative Research Intern', 'medium', 1],
  ]);
  for (const item of queue) {
    for (const key of ['companyLoad', 'tabHint', 'deadlinePrecision', 'postingEndAt']) assert.ok(key in item, `${key} in queue rows`);
    assert.equal(item.companyLoad, 0);
    assert.equal(item.tabHint, `✅ Ready to submit ${item.company}`);
  }
  const analyst = queue[2];
  const verified = await cli(['queue', 'verify', '--home', home, '--id', analyst.id, '--result', 'ok', '--reason', 'Official posting open; degree and authorization fit', '--deadline', '2026-10-15T23:59:00-07:00']);
  assert.equal(verified.code, 0, verified.io.stderr);
  const record = JSON.parse(verified.io.stdout);
  assert.equal(record.status, 'lead');
  assert.equal(record.deadlineAt, '2026-10-15T23:59:00-07:00');
  assert.match(record.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  const reordered = await json(['queue', 'list', '--home', home]);
  assert.equal(reordered[0].id, analyst.id, 'a known deadline moves a role ahead within its fit');

  // A date-only cutoff is the end of that day in the configured time zone (UTC here), never midnight at its start.
  const [corpMl, , , quantMl] = ids;
  const db = database(home);
  try {
    db.prepare("UPDATE applications SET deadline_at = '2026-10-15T12:00:00Z', deadline_precision = 'datetime', deadline_source = 'review' WHERE id = ?").run(corpMl);
    db.prepare("UPDATE applications SET deadline_at = '2026-10-15', deadline_precision = 'date', deadline_source = 'review' WHERE id = ?").run(quantMl);
  } finally { db.close(); }
  const cutoffs = await json(['queue', 'list', '--home', home]);
  assert.deepEqual(cutoffs.slice(0, 3).map((item) => item.id), [corpMl, quantMl, analyst.id]);
  assert.equal(cutoffs[1].deadlinePrecision, 'date');

  const text = await cli(['queue', 'list', '--home', home]);
  assert.equal(text.io.stdout.trim().split('\n').length, 5);
  assert.match(text.io.stdout.split('\n')[0], /^high\t2026-10-15T12:00:00Z\tNew York, NY\tExample Corp\tMachine Learning Intern, Summer 2027\t/);

  const noProfile = path.join(home, 'missing.json');
  assert.match((await cli(['queue', 'list', '--home', home, '--profile', noProfile])).io.stderr, /No search profile found/);
  await rm(path.join(home, '.career-journal', 'profile'), { recursive: true });
  const unranked = await json(['queue', 'list', '--home', home]);
  assert.ok(unranked.every((item) => item.locRank === null), 'without a profile the queue still lists, unranked');
}));

test('queue verify --result skip withdraws the lead with an event carrying the reason', async () => fixture(async (home) => {
  await writeProfile(home);
  await seedQueue(home);
  const [first] = await json(['queue', 'list', '--home', home]);
  const reason = 'Posting requires graduation before May 2027';
  const skipped = await cli(['queue', 'verify', '--home', home, '--id', first.id, '--result', 'skip', '--reason', reason]);
  assert.equal(skipped.code, 0, skipped.io.stderr);
  const record = JSON.parse(skipped.io.stdout);
  assert.deepEqual([record.status, record.skipReason], ['withdrawn', reason]);
  const db = database(home);
  try {
    const event = db.prepare("SELECT event_type, note, source_json, status_after FROM application_events WHERE application_id = ? AND event_type = 'queue_skipped'").get(first.id);
    assert.equal(event.note, reason);
    assert.equal(event.status_after, 'withdrawn');
    assert.deepEqual(JSON.parse(event.source_json), { kind: 'queue-verify', reason, result: 'skip' });
  } finally { db.close(); }
  const queue = await json(['queue', 'list', '--home', home]);
  assert.equal(queue.some((item) => item.id === first.id), false);
  await json(['scan', 'run', '--home', home]);
  const after = database(home);
  try {
    assert.equal(after.prepare('SELECT status FROM applications WHERE id = ?').get(first.id).status, 'withdrawn', 'a skipped role does not come back on the next scan');
    assert.equal(after.prepare('SELECT COUNT(*) count FROM applications').get().count, QUEUE_LEADS.length, 'the scan creates no application');
  } finally { after.close(); }

  const again = await cli(['queue', 'verify', '--home', home, '--id', first.id, '--result', 'ok', '--reason', 'retry']);
  assert.equal(again.code, 1);
  assert.match(again.io.stderr, /is not in the queue \(status withdrawn\)/);
}));

test('queue verify validates its inputs before writing', async () => fixture(async (home) => {
  await writeProfile(home);
  await seedQueue(home);
  const [first] = await json(['queue', 'list', '--home', home]);
  const cases = [
    [['--id', first.id, '--result', 'maybe', '--reason', 'x'], /result must be ok or skip/],
    [['--id', first.id, '--result', 'skip'], /reason is required/],
    [['--id', first.id, '--result', 'ok', '--reason', 'x', '--deadline', 'next Friday'], /deadline must be an ISO 8601 timestamp with a UTC offset/],
    [['--id', 'missing-role', '--result', 'ok', '--reason', 'x'], /Application not found/],
  ];
  for (const [args, pattern] of cases) {
    const result = await cli(['queue', 'verify', '--home', home, ...args]);
    assert.equal(result.code, 1);
    assert.match(result.io.stderr, pattern);
  }
  const db = database(home);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) count FROM application_events WHERE event_type LIKE 'queue_%'").get().count, 0);
  } finally { db.close(); }
  assert.match((await cli(['queue', 'drop', '--home', home])).io.stderr, /Usage: career-journal queue list/);
}));

test('scan, queue, and the role-scan task read the profile of a legacy .jobops workspace', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-cli-scan-legacy-'));
  try {
    const config = defaultConfig('2026-09-19T00:00:00Z', 'UTC');
    config.data = { database: '.jobops/jobops.db', artifacts: '.jobops/artifacts' };
    await mkdir(path.join(home, '.jobops'), { recursive: true });
    await writeFile(path.join(home, '.jobops', 'config.json'), `${JSON.stringify(config)}\n`);
    await writeProfile(home, undefined, path.join(home, '.jobops', 'profile', 'profile.json'));

    const preview = await json(['scan', 'run', '--home', home, '--dry-run']);
    assert.equal(preview.dryRun, true);
    assert.ok(preview.counts.observed > 0);
    const summary = await json(['scan', 'run', '--home', home]);
    assert.equal(summary.counts.observed, preview.counts.observed);
    assert.equal(existsSync(path.join(home, '.career-journal')), false, 'no second workspace is created');
    assert.equal((await json(['queue', 'list', '--home', home])).length, 0, 'the scan reads the legacy profile and creates no leads');
    const configured = await cli(['automation', 'configure', '--home', home, '--task', 'role-scan', '--enabled']);
    assert.equal(configured.code, 0, configured.io.stderr);
    assert.equal(JSON.parse(configured.io.stdout).schedule, '08:30');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('scan run reports a missing profile, missing sources, and total source failure', async () => fixture(async (home) => {
  const missing = await cli(['scan', 'run', '--home', home]);
  assert.equal(missing.code, 1);
  assert.match(missing.io.stderr, /No search profile found/);

  await writeProfile(home, (profile) => ({ ...profile, sources: { atsBoards: [], careerOps: false, simplify: { enabled: false, url: null } } }));
  assert.match((await cli(['scan', 'run', '--home', home])).io.stderr, /The profile has no scan sources/);

  await writeProfile(home);
  const failed = await cli(['scan', 'run', '--home', home], {
    routes: { [ATS_URLS.greenhouse]: 500, [ATS_URLS.lever]: 503, [ATS_URLS.ashby]: new Error('offline') },
  });
  assert.equal(failed.code, 1);
  assert.match(failed.io.stderr, /Every scan source failed/);
  assert.match(failed.io.stdout, /greenhouse[^\n]*examplecorp[^\n]*error[^\n]*HTTP 500/);

  await writeProfile(home, (profile) => ({ ...profile, sources: { ...profile.sources, expected: ['atsBoards'] } }));
  const partial = await cli(['scan', 'run', '--home', home], {
    routes: { ...(await defaultRoutes()), [ATS_URLS.lever]: 503 },
  });
  assert.equal(partial.code, 2, 'an erroring expected partition makes the scan partial');
  assert.match(partial.io.stdout, /lever[^\n]*examplelabs[^\n]*error[^\n]*HTTP 503/);
}));

test('the optional role-scan task uses pace.scanTime, runs the scan, and is never required', async () => fixture(async (home) => {
  await writeProfile(home);
  const configured = await cli(['automation', 'configure', '--home', home, '--task', 'role-scan', '--enabled']);
  assert.equal(configured.code, 0, configured.io.stderr);
  const task = JSON.parse(configured.io.stdout);
  assert.deepEqual([task.id, task.type, task.schedule, task.enabled], ['career-journal-role-scan', 'role-scan', '08:30', true]);

  const run = await cli(['automation', 'run', '--home', home, '--task', 'role-scan']);
  assert.equal(run.code, 0, run.io.stderr);
  const result = JSON.parse(run.io.stdout);
  assert.equal(result.changed, 0, 'the scan stage creates no leads');
  assert.match(result.message, /review not configured/, 'without review inputs the task scans and reports that review is not configured');

  const db = database(home);
  try {
    assert.deepEqual(listTasks(db).map((item) => item.type), ['role-scan']);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM applications').get().count, 0);
    assert.ok(db.prepare('SELECT COUNT(*) count FROM observations').get().count > 0, 'the scan stage ran');
  } finally { db.close(); }
  const probed = [];
  const report = await doctor(home, {
    nodeVersion: '24.19.0',
    storage: async () => ({ ok: true, detail: 'writable' }),
    careerOps: async () => ({ ok: false, detail: 'optional' }),
    schedulerProbe: async (item) => { probed.push(item.type); return { ok: true }; },
  });
  assert.deepEqual(probed, [], 'doctor never probes the optional role-scan task');
  assert.doesNotMatch(report.checks.find((item) => item.id === 'automation').detail, /role-scan/);
}));

test('default onboarding does not create the role-scan task', async () => {
  const setupSource = await readFile(new URL('../../src/commands/setup.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(setupSource, /role-scan/);
});

test('an enabled Simplify source without a URL does not count as a scan source', async () => fixture(async (home) => {
  await writeProfile(home, (profile) => ({
    ...profile,
    sources: { atsBoards: [], careerOps: false, simplify: { enabled: true, url: null } },
  }));
  const result = await cli(['scan', 'run', '--home', home, '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.io.stderr, /The profile has no scan sources/);
}));

test('queue score rates queued roles that have no fit, through Jev, and leaves rated and skipped roles alone', async () => fixture(async (home) => {
  await writeProfile(home);
  const add = async (company, role) => JSON.parse((await cli(['application', 'add', '--home', home, '--company', company, '--role', role])).io.stdout).id;
  const unrated = await add('Example Corp', 'Machine Learning Intern');
  const quant = await add('Example Quant', 'Quantitative Research Intern');
  const skipped = await add('Example Labs', 'Data Science Intern');
  assert.equal((await cli(['queue', 'verify', '--home', home, '--id', skipped, '--result', 'skip', '--reason', 'PhD only'])).code, 0);

  const dry = await json(['queue', 'score', '--home', home, '--dry-run']);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.results.map((item) => [item.id, item.fit]), [[unrated, 'high'], [quant, 'medium']]);
  let db = database(home);
  try { assert.equal(db.prepare('SELECT COUNT(*) count FROM applications WHERE fit IS NOT NULL').get().count, 0, 'a dry run writes nothing'); } finally { db.close(); }

  const config = await loadConfig(home);
  config.jev = { ...config.jev, accessState: 'enabled', mode: 'active', threshold: 0.8, secretRef: 'env:CAREER_JOURNAL_SCAN_TEST_JEV', retryDelaysMs: [] };
  await saveConfig(home, config);
  process.env.CAREER_JOURNAL_SCAN_TEST_JEV = 'fixture-secret';
  try {
    const routes = { [JEV_URL]: { answers: { fit: { type: 'choice', choice: 'low', confidence: 0.9 } } } };
    const first = await json(['queue', 'score', '--home', home, '--limit', '1'], { routes });
    assert.equal(first.scored, 1);
    assert.equal(first.remaining, 1);
    const rest = await json(['queue', 'score', '--home', home], { routes });
    assert.deepEqual(rest.results.map((item) => item.id), [quant]);
    const again = await json(['queue', 'score', '--home', home], { routes });
    assert.equal(again.scored, 0, 'roles that already have a fit are not rescored without --all');
    db = database(home);
    try {
      assert.deepEqual(db.prepare('SELECT id, fit, fit_note FROM applications ORDER BY id').all().map((row) => ({ ...row })), [
        { id: quant, fit: 'low', fit_note: 'Fit by Jev (confidence 0.9)' },
        { id: unrated, fit: 'low', fit_note: 'Fit by Jev (confidence 0.9)' },
        { id: skipped, fit: null, fit_note: null },
      ].sort((a, b) => a.id.localeCompare(b.id)));
      assert.equal(db.prepare("SELECT COUNT(*) count FROM decision_traces WHERE mode = 'role-fit'").get().count, 2);
    } finally { db.close(); }
    const all = await json(['queue', 'score', '--home', home, '--all'], { routes });
    assert.equal(all.scored, 2);
  } finally { delete process.env.CAREER_JOURNAL_SCAN_TEST_JEV; }
}));

test('queue score needs a profile and a valid limit', async () => fixture(async (home) => {
  const missing = await cli(['queue', 'score', '--home', home]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.io.stderr, /queue score needs the search profile/);
  await writeProfile(home);
  const bad = await cli(['queue', 'score', '--home', home, '--limit', '0']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.io.stderr, /--limit must be a positive whole number/);
}));
