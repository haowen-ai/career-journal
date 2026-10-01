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
import { openDatabase } from '../../src/storage/database.mjs';
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

test('help lists the scan and queue commands', () => {
  assert.match(HELP, /^ {2}scan {10}Scan official job boards for roles that match the profile$/m);
  assert.match(HELP, /^ {2}queue {9}List or verify queued roles before applying$/m);
});

test('scan run --dry-run fetches, filters, and scores without writing anything', async () => fixture(async (home) => {
  await writeProfile(home);
  const databaseFile = path.join(home, '.career-journal', 'career-journal.db');
  const summary = await json(['scan', 'run', '--home', home, '--dry-run']);
  assert.equal(summary.dryRun, true);
  assert.deepEqual(summary.counts, { fetched: 14, dropped: 9, duplicates: 0, queued: 5, possibleDuplicates: 0 });
  assert.ok(summary.queued.every((item) => item.id === null && item.fitEngine === 'rules'));
  assert.equal(existsSync(databaseFile), false, 'a dry run on a fresh workspace creates no database');

  assert.equal((await cli(['scan', 'run', '--home', home])).code, 0);
  const before = await readFile(databaseFile);
  const again = await json(['scan', 'run', '--home', home, '--dry-run']);
  assert.equal(again.counts.duplicates, 5);
  assert.equal(again.counts.queued, 0);
  assert.deepEqual(await readFile(databaseFile), before, 'a dry run leaves an existing database unchanged');
}));

test('scan run queues kept roles as leads with source, location, and fit, and explains every drop', async () => fixture(async (home) => {
  await writeProfile(home);
  const summary = await json(['scan', 'run', '--home', home]);
  assert.equal(summary.dryRun, false);
  assert.deepEqual(summary.sources.map((item) => [item.source, item.status, item.count]), [
    ['greenhouse', 'ok', 6], ['lever', 'ok', 5], ['ashby', 'ok', 3], ['careerops', 'skipped', 0], ['simplify', 'skipped', 0],
  ]);
  assert.deepEqual(summary.counts, { fetched: 14, dropped: 9, duplicates: 0, queued: 5, possibleDuplicates: 0 });
  assert.deepEqual(summary.dropReasons, {
    season: 1, direction: 1, 'degree-phd-only': 1, 'degree-undergrad-only': 2, citizenship: 1, clearance: 1,
    'no-return-offer': 1, location: 1, 'job-type': 1,
  });
  for (const item of summary.dropped) {
    assert.ok(item.reasons.length > 0, item.title);
    assert.ok(item.reasons.every((reason) => /^[a-z-]+: .{20,}/.test(reason)), item.reasons.join(' | '));
  }
  assert.deepEqual(summary.queued.map((item) => [item.title, item.fit, item.locRank]), [
    ['Data Science Intern, Summer 2027', 'high', 1],
    ['Machine Learning Intern, Summer 2027', 'high', 1],
    ['Business Data Analyst Intern, Summer 2027', 'high', 2],
    ['Machine Learning Intern, Summer 2027', 'high', 3],
    ['Quantitative Research Intern', 'medium', 1],
  ]);

  const db = database(home);
  try {
    const leads = db.prepare(`SELECT id, company, role, status, external_id, job_url, source, source_id, location, posted_at,
      fit, fit_confidence, fit_note, verified_at, skip_reason FROM applications ORDER BY id`).all();
    assert.equal(leads.length, 5);
    assert.ok(leads.every((lead) => lead.status === 'lead' && lead.verified_at === null && lead.skip_reason === null));
    const ml = leads.find((lead) => lead.source === 'greenhouse' && lead.source_id === '4000001');
    assert.deepEqual({ ...ml, id: undefined }, {
      id: undefined,
      company: 'Example Corp',
      role: 'Machine Learning Intern, Summer 2027',
      status: 'lead',
      external_id: 'greenhouse:4000001',
      job_url: 'https://job-boards.greenhouse.io/examplecorp/jobs/4000001',
      source: 'greenhouse',
      source_id: '4000001',
      location: 'New York, NY',
      posted_at: '2026-09-28T18:00:00.000Z',
      fit: 'high',
      fit_confidence: null,
      fit_note: 'Rule-based fit (no semantic provider decided): primary direction ai-ml ("machine learning") in the title',
      verified_at: null,
      skip_reason: null,
    });
    const event = db.prepare("SELECT event_type, title, source_json, status_after FROM application_events WHERE application_id = ?").get(ml.id);
    assert.equal(event.event_type, 'role_found');
    assert.equal(event.status_after, null);
    assert.equal(JSON.parse(event.source_json).kind, 'role-scan');
    const trace = db.prepare("SELECT engine, mode, applied, decision_json FROM decision_traces WHERE application_id = ?").get(ml.id);
    assert.deepEqual({ engine: trace.engine, mode: trace.mode, applied: trace.applied }, { engine: 'rules', mode: 'role-fit', applied: 1 });
    assert.equal(JSON.parse(trace.decision_json).ruleBased, true);
  } finally { db.close(); }

  const rerun = await json(['scan', 'run', '--home', home]);
  assert.equal(rerun.counts.queued, 0, 'a second scan never queues the same roles again');
  assert.equal(rerun.counts.duplicates, 5);
  assert.match(rerun.duplicates[0].reason, /^duplicate: same source id as .+ \(lead\)$/);
}));

test('the opt-in Simplify source adds new roles and is deduplicated against official boards', async () => fixture(async (home) => {
  const profilePath = await writeProfile(home, (profile) => {
    profile.sources.simplify = { enabled: true, url: SIMPLIFY_URL };
    return profile;
  }, path.join(home, 'custom-profile.json'));
  const calls = [];
  const summary = await json(['scan', 'run', '--home', home, '--profile', profilePath], {
    routes: await defaultRoutes({ [SIMPLIFY_URL]: await readFixture('simplify-listings.json') }), calls,
  });
  assert.ok(calls.includes(SIMPLIFY_URL));
  assert.deepEqual(summary.counts, { fetched: 20, dropped: 11, duplicates: 2, queued: 7, possibleDuplicates: 1 });
  assert.deepEqual(summary.duplicates.map((item) => [item.source, item.title]), [
    ['simplify', 'Machine Learning Intern, Summer 2027'],
    ['simplify', 'Machine Learning Intern - Summer 2027'],
  ]);
  assert.match(summary.duplicates[0].reason, /same requisition id in the link/);
  const possible = summary.queued.find((item) => item.possibleDuplicateOf);
  assert.equal(possible.title, 'Machine Learning Intern, Summer 2027 - NLP');
  const db = database(home);
  try {
    const note = db.prepare("SELECT fit_note FROM applications WHERE source = 'simplify' AND role LIKE '%NLP%'").get().fit_note;
    assert.match(note, /Possible duplicate of "Machine Learning Intern, Summer 2027" \(title similarity 0\.83\); check before applying/);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM applications WHERE source = 'simplify'").get().count, 2);
  } finally { db.close(); }
}));

test('fit goes through configured Jev during a real scan but never during a dry run', async () => fixture(async (home) => {
  await writeProfile(home);
  const config = await loadConfig(home);
  config.jev = { ...config.jev, accessState: 'enabled', mode: 'active', threshold: 0.8, secretRef: 'env:CAREER_JOURNAL_SCAN_TEST_JEV', retryDelaysMs: [] };
  await saveConfig(home, config);
  process.env.CAREER_JOURNAL_SCAN_TEST_JEV = 'fixture-secret';
  try {
    const routes = await defaultRoutes();
    const dryCalls = [];
    await json(['scan', 'run', '--home', home, '--dry-run'], { routes, calls: dryCalls });
    assert.equal(dryCalls.includes(JEV_URL), false);

    const jevRoutes = { ...routes, [JEV_URL]: { answers: { fit: { type: 'choice', choice: 'medium', confidence: 0.93 } } } };
    const calls = [];
    const summary = await json(['scan', 'run', '--home', home], { routes: jevRoutes, calls });
    assert.equal(calls.filter((url) => url === JEV_URL).length, 5);
    assert.ok(summary.queued.every((item) => item.fit === 'medium' && item.fitEngine === 'jev' && item.fitConfidence === 0.93));
    const db = database(home);
    try {
      const row = db.prepare("SELECT fit, fit_confidence, fit_note FROM applications WHERE source = 'lever'").get();
      assert.deepEqual({ ...row }, { fit: 'medium', fit_confidence: 0.93, fit_note: 'Fit by Jev (confidence 0.93)' });
    } finally { db.close(); }
  } finally { delete process.env.CAREER_JOURNAL_SCAN_TEST_JEV; }
}));

test('queue list orders by fit, deadline, location rank, then newest posting', async () => fixture(async (home) => {
  await writeProfile(home);
  await json(['scan', 'run', '--home', home]);
  const queue = await json(['queue', 'list', '--home', home]);
  assert.deepEqual(queue.map((item) => [item.company, item.role, item.fit, item.locRank]), [
    ['Example Quant', 'Data Science Intern, Summer 2027', 'high', 1],
    ['Example Corp', 'Machine Learning Intern, Summer 2027', 'high', 1],
    ['Example Corp', 'Business Data Analyst Intern, Summer 2027', 'high', 2],
    ['Example Quant', 'Machine Learning Intern, Summer 2027', 'high', 3],
    ['Example Labs', 'Quantitative Research Intern', 'medium', 1],
  ]);
  const analyst = queue[2];
  const verified = await cli(['queue', 'verify', '--home', home, '--id', analyst.id, '--result', 'ok', '--reason', 'Official posting open; degree and authorization fit', '--deadline', '2026-10-15T23:59:00-07:00']);
  assert.equal(verified.code, 0, verified.io.stderr);
  const record = JSON.parse(verified.io.stdout);
  assert.equal(record.status, 'lead');
  assert.equal(record.deadlineAt, '2026-10-15T23:59:00-07:00');
  assert.match(record.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  const reordered = await json(['queue', 'list', '--home', home]);
  assert.equal(reordered[0].id, analyst.id, 'a known deadline moves a role ahead within its fit');

  const text = await cli(['queue', 'list', '--home', home]);
  assert.equal(text.io.stdout.trim().split('\n').length, 5);
  assert.match(text.io.stdout.split('\n')[0], /^high\t2026-10-15T23:59:00-07:00\tSeattle, WA\tExample Corp\tBusiness Data Analyst Intern, Summer 2027\t/);

  const noProfile = path.join(home, 'missing.json');
  assert.match((await cli(['queue', 'list', '--home', home, '--profile', noProfile])).io.stderr, /No search profile found/);
  await rm(path.join(home, '.career-journal', 'profile'), { recursive: true });
  const unranked = await json(['queue', 'list', '--home', home]);
  assert.ok(unranked.every((item) => item.locRank === null), 'without a profile the queue still lists, unranked');
}));

test('queue verify --result skip withdraws the lead with an event carrying the reason', async () => fixture(async (home) => {
  await writeProfile(home);
  await json(['scan', 'run', '--home', home]);
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
  const rescan = await json(['scan', 'run', '--home', home]);
  assert.equal(rescan.counts.queued, 0, 'a skipped role does not come back on the next scan');
  assert.ok(rescan.duplicates.some((item) => item.duplicateOf === first.id && /\(withdrawn\)/.test(item.reason)));

  const again = await cli(['queue', 'verify', '--home', home, '--id', first.id, '--result', 'ok', '--reason', 'retry']);
  assert.equal(again.code, 1);
  assert.match(again.io.stderr, /is not in the queue \(status withdrawn\)/);
}));

test('queue verify validates its inputs before writing', async () => fixture(async (home) => {
  await writeProfile(home);
  await json(['scan', 'run', '--home', home]);
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
  assert.match(failed.io.stdout, /Sources: greenhouse\/examplecorp error \(HTTP 500\)/);

  const partial = await cli(['scan', 'run', '--home', home], {
    routes: { ...(await defaultRoutes()), [ATS_URLS.lever]: 503 },
  });
  assert.equal(partial.code, 0, partial.io.stderr);
  assert.match(partial.io.stdout, /^Role scan\nSources: greenhouse\/examplecorp ok 6; lever\/examplelabs error \(HTTP 503\); ashby\/examplequant ok 3; careerops skipped \(not enabled in the profile\); simplify skipped \(opt-in source is not enabled\)\nFetched 9; queued 4; dropped 5; duplicates 0\n/);
  assert.match(partial.io.stdout, /Dropped by reason: /);
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
  assert.equal(result.changed, 5);
  assert.equal(result.message, '5 new role(s) queued');
  const quiet = await cli(['automation', 'run', '--home', home, '--task', 'role-scan']);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.io.stdout, '', 'an unchanged scan prints nothing');

  const db = database(home);
  try {
    assert.deepEqual(listTasks(db).map((item) => item.type), ['role-scan']);
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
