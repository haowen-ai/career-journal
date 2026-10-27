// Regression tests for the read-only review of the merged screening funnel (feat/funnel-v3, fad8cc2..efb6f9c)
// plus four follow-up findings (#19–#22). Each title names its finding as "(merged #n)"; [B] covers lane A/B
// logic, [C] covers lane C. Synthetic data only: every employer, requisition, URL and candidate fact is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate, schemaMigrations } from '../../src/storage/database.mjs';
import { createApplication } from '../../src/commands/application.mjs';
import { verifyQueuedRole } from '../../src/commands/queue.mjs';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { defaultRoutes, fixtureFetch, readFixture, ATS_URLS } from '../../test-utils/scan-fixtures.mjs';
import {
  freshDb, load, insertPosting, insertReview, reviewOf, application, seedApplication, seedCheckerWithdrawal,
  fakeJudge, fakeFetcher, Crash, T0, at,
} from '../../test-utils/funnel-v3.mjs';
import {
  FACTS, REVIEW_POLICY, SCREENING_POLICY, PROFILE, PROVENANCE, SNAPSHOTS, JUDGMENTS, MORE_SNAPSHOTS, MORE_JUDGMENTS,
  SUMMER_CHICAGO, judgment, page, record, snapshotTitle, reviewInputs, writeReviewHome,
} from '../../test-utils/funnel-v3-fixtures.mjs';

const ROOT = new URL('../../', import.meta.url);
const workerModule = () => load('B6', './src/review/worker.mjs', ['runReview']);
const decideModule = () => load('B2', './src/review/decide.mjs', ['decide']);
const clausesModule = () => load('B2', './src/review/clauses.mjs', ['validateCriterion', 'segmentSections']);
const fetchModule = () => load('B4', './src/review/fetch.mjs', ['commandFetcher', 'builtinFetcher', 'validateSnapshot']);
const judgeModule = () => load('B1', './src/review/judge.mjs', ['codexExecAdapter']);
const deliveryModules = async () => ({
  ...(await load('B5', './src/review/deliver.mjs', ['deliver'])),
  ...(await load('B5', './src/review/lease.mjs', ['claimItem'])),
});
const mailModule = () => load('B5', './src/review/mail.mjs', ['matchMailHits']);
const bootstrapModule = () => load('L1', './src/funnel/bootstrap.mjs', ['bootstrapExisting']);
const ingestModule = () => load('A4', './src/funnel/ingest.mjs', ['ingestBatch']);
const pruneModule = () => load('C1', './src/retention/prune.mjs', ['retentionPolicy', 'prune']);

const tempDir = (prefix) => mkdtemp(path.join(os.tmpdir(), prefix));

// ------------------------------------------------------------------ shared harness (copied from lane B tests)

function queue() {
  const pages = {};
  let serial = 0;
  return {
    pages,
    add(db, { id, now = T0, snapshot = 'eligible', text, lane = 'new', flags = [], deadline = null, company = 'Example Corp' } = {}) {
      serial += 1;
      const postingId = id ?? `p-${String(serial).padStart(4, '0')}`;
      const url = `https://job-boards.greenhouse.io/examplecorp/jobs/${postingId}`;
      const body = text ?? SNAPSHOTS[snapshot];
      insertPosting(db, { id: postingId, url, company, title: snapshotTitle(body), firstSeen: now });
      insertReview(db, { postingId, stage: 'fetch', firstSeen: now, nextDue: now, lane, flags, deadline });
      pages[url] = page(url, body);
      return postingId;
    },
  };
}

const eligibleJudges = () => ({
  primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) }),
  escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }),
});

function runOptions(db, { now = T0, runId = 'review-1', budget = 10, judges, fetcher, pages = {}, inputs, ...rest } = {}) {
  return {
    db, runId, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fetcher ?? fakeFetcher(pages),
    judges: judges ?? eligibleJudges(),
    inputs: inputs ?? (() => reviewInputs()),
    hooks: {},
    ...rest,
  };
}

const callsFor = (judge, postingId) => judge.calls.filter((call) => call.request.postingId === postingId).length;
const applicationOf = (db, postingId) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(postingId);

const verdict = (overrides = {}) => ({
  decision: 'eligible', code: null, escalate: false, factsUsed: ['degree'], evidence: [],
  fit: { level: 'high', note: 'SQL and Python match' },
  deadline: { kind: 'none', date: null, time: null, tz: null, precision: null, quote: null },
  program: null,
  location: { offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' }], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' },
  needs: { essay: false, documents: false, assessment: false, quotes: { essay: null, documents: null, assessment: null } },
  ...overrides,
});
async function deliverVerdict(db, postingId, value, now = T0) {
  const { deliver, claimItem } = await deliveryModules();
  db.prepare("UPDATE reviews SET state = 'due', stage = 'deliver' WHERE posting_id = ? AND state != 'leased'").run(postingId);
  const fence = claimItem(db, postingId, { owner: 'worker-a', now });
  return deliver(db, { postingId, verdict: value, fence, now, policy: SCREENING_POLICY });
}

async function decideWith({ text, judged, tier = 'escalation', policy = REVIEW_POLICY, facts = FACTS }) {
  const { decide } = await decideModule();
  return decide({ snapshotText: text, judgment: judged, facts, policy, tier });
}

// A data home at schema 6 (setup), closed and removed afterwards.
async function withHome(run) {
  if (!schemaMigrations.some((item) => item.version === 6)) throw new Error('NOT IMPLEMENTED [L1]: migration 006-funnel is not registered in schemaMigrations');
  const home = await tempDir('cj-merged-review-');
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

async function cli(args, runtimeExtra = {}) {
  const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
  const { runCli } = await import('../../src/cli/main.mjs');
  const runtime = { ...createRuntime({ root: process.cwd(), version: 'test' }), ...runtimeExtra };
  const io = memoryIO();
  const code = await runCli(args, io, runtime);
  return { code, stdout: io.stdout, stderr: io.stderr };
}

async function writeScanProfile(home, changes = (profile) => profile) {
  const profile = changes(structuredClone(await readFixture('profile.json')));
  const file = path.join(home, '.career-journal', 'profile', 'profile.json');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(profile, null, 2), { mode: 0o600 });
}

function seedAttemptRow(db, { id, postingId, runId = 'review-0', at: when, state = 'dispatched', outputPath = null, tier = 'primary' }) {
  db.prepare(`INSERT INTO attempts (id, run_id, posting_id, stage, runner, model, tier, state, dispatched_at, finished_at, output_path, usage_json, transport_retries, error)
    VALUES (?, ?, ?, 'judge', 'fake', ?, ?, ?, ?, NULL, ?, '{}', 0, NULL)`).run(id, runId, postingId, `fake-${tier}`, tier, state, when, outputPath);
}

// ===================================================================== #1

test('[B] recovering a lost attempt never reopens a posting the user already decided (merged #1)', async () => {
  const { runReview } = await workerModule();
  const db = freshDb();
  const text = SNAPSHOTS.undergradOnly;
  const urlUser = 'https://job-boards.greenhouse.io/examplecorp/jobs/9100001';
  const urlControl = 'https://job-boards.greenhouse.io/examplecorp/jobs/9100002';
  insertPosting(db, { id: 'p-user', url: urlUser, title: snapshotTitle(text), firstSeen: at(-1) });
  insertPosting(db, { id: 'p-control', url: urlControl, title: snapshotTitle(text), firstSeen: at(-1) });
  for (const id of ['p-user', 'p-control']) {
    insertReview(db, { postingId: id, stage: 'fetch', firstSeen: at(-1), nextDue: at(-1) });
    db.prepare("UPDATE reviews SET state = 'leased', lease_owner = 'dead-worker', lease_generation = 1, lease_until = ? WHERE posting_id = ?").run(at(0.25), id);
    seedAttemptRow(db, { id: `a-${id}`, postingId: id, at: at(0.2) });
  }
  // The user's own lead, bound to the posting, then checked with `queue verify --result ok` after the worker died.
  const lead = createApplication(db, { company: 'Example Corp', role: snapshotTitle(text), jobUrl: urlUser, status: 'lead' }, at(-1));
  assert.equal(db.prepare("SELECT application_id FROM postings WHERE id = 'p-user'").get().application_id, lead.id);
  verifyQueuedRole(db, { id: lead.id, result: 'ok', reason: 'Checked the official posting myself' }, at(0.5));
  assert.deepEqual([reviewOf(db, 'p-user').state, reviewOf(db, 'p-user').decision], ['done', 'eligible']);

  const answers = () => ({ output: JUDGMENTS.undergradOnly });
  const judges = { primary: fakeJudge({ tier: 'primary', answers }), escalation: fakeJudge({ tier: 'escalation', answers }) };
  await runReview(runOptions(db, { now: at(1), judges, pages: { [urlUser]: page(urlUser, text), [urlControl]: page(urlControl, text) } }));

  assert.notEqual(db.prepare("SELECT state FROM attempts WHERE id = 'a-p-user'").get().state, 'dispatched', 'the lost attempt itself is closed');
  assert.equal(callsFor(judges.primary, 'p-user') + callsFor(judges.escalation, 'p-user'), 0, 'a user-decided posting is never dispatched again');
  assert.deepEqual([reviewOf(db, 'p-user').state, reviewOf(db, 'p-user').decision], ['done', 'eligible'], 'the user decision stands');
  assert.equal(application(db, lead.id).status, 'lead', 'the verified lead is not withdrawn by a later worker');
  assert.ok(callsFor(judges.primary, 'p-control') >= 1, 'an undecided posting with a lost attempt is still recovered and judged');
});

// ===================================================================== #2

test('[B] a term quote from one track and an office quote from another track do not prove eligibility (merged #2)', async () => {
  const text = SNAPSHOTS.alternatives;
  const mixed = judgment({
    alternatives: [{
      term: { label: 'summer', year: 2027, quote: 'a Summer 2027 internship based in Austin, TX' },
      offices: [{ place: 'San Jose, CA', area: 'california', quote: 'a Spring 2027 co-op based in San Jose, CA' }],
      remote: { scope: 'none', quote: null },
    }],
    criteria: [],
    function: { value: 'data_eng', quote: 'Both tracks build data pipelines in Python and SQL' },
  });
  const result = await decideWith({ text, judged: mixed });
  assert.notEqual(result.decision, 'eligible', 'the Summer window belongs to Austin; San Jose is the Spring co-op');
  const honest = await decideWith({ text: SNAPSHOTS.eligible, judged: JUDGMENTS.eligible });
  assert.equal(honest.decision, 'eligible', 'a single stated alternative with its own term and office still qualifies');
});

// ===================================================================== #3

test('[B] a constraint the candidate satisfies is not a confirmed conflict because of its fact category (merged #3)', async () => {
  const { validateCriterion } = await clausesModule();
  const text = SNAPSHOTS.eligible.replace(
    "• Currently pursuing a Bachelor's or Master's degree in Statistics, Computer Science, or a related field.",
    "• Must be currently pursuing a Master's degree.",
  );
  const quote = "Must be currently pursuing a Master's degree.";
  const criterion = { key: 'degree', status: 'conflicts', quote, clause_alternatives: [], fact_ids: ['degree'] };
  assert.equal(validateCriterion(text, criterion, FACTS).confirmedConflict, false, 'Pursuing a Master of Science satisfies the requirement');
  const result = await decideWith({ text, judged: judgment({ criteria: [criterion] }) });
  assert.notEqual(result.decision, 'not_eligible');

  const real = await decideWith({ text: SNAPSHOTS.undergradOnly, judged: JUDGMENTS.undergradOnly });
  assert.equal(real.decision, 'not_eligible', 'an undergraduate-only requirement still conflicts with a master\'s student');
});

// ===================================================================== #4

test('[B] inline preferred wording under a Required heading never confirms a conflict (merged #4)', async () => {
  const { validateCriterion } = await clausesModule();
  const withLine = (line) => SNAPSHOTS.eligible.replace('• Proficiency in Python or R for data analysis.', line);
  const preferred = withLine('• Scala experience preferred.');
  const criterion = (quote) => ({ key: 'requirement', status: 'conflicts', quote, clause_alternatives: [], fact_ids: ['scala'] });
  assert.equal(validateCriterion(preferred, criterion('Scala experience preferred.'), FACTS).confirmedConflict, false);
  const result = await decideWith({ text: preferred, judged: judgment({ criteria: [criterion('Scala experience preferred.')] }) });
  assert.notEqual(result.decision, 'not_eligible', 'preferred wording never blocks');

  const mandatory = withLine('• Experience with Scala.');
  assert.equal(validateCriterion(mandatory, criterion('Experience with Scala.'), FACTS).confirmedConflict, true, 'a mandatory Scala clause with a lacks fact still conflicts');
});

// ===================================================================== #5

test('[B] the built-in Lever fetch keeps lists and additional sections in the snapshot text (merged #5)', async () => {
  const { builtinFetcher, validateSnapshot } = await fetchModule();
  const id = '3b1f0c2e-1111-4222-8333-444455556666';
  const url = `https://jobs.lever.co/examplelabs/${id}`;
  const body = {
    id,
    text: 'Data Science Intern',
    categories: { location: 'Chicago, IL', commitment: 'Intern', team: 'Analytics' },
    descriptionPlain: 'Join the analytics team for the summer of 2027. You will build dashboards, write SQL and Python, and present findings to product leaders. '.repeat(6),
    description: '<p>Join the analytics team for the summer of 2027.</p>',
    lists: [{ text: 'Requirements', content: '<li>Undergraduate students only</li><li>Proficiency in Python</li>' }],
    additionalPlain: 'Applicants must be enrolled at a United States university.',
    additional: '<p>Applicants must be enrolled at a United States university.</p>',
    hostedUrl: url,
  };
  const fetchImpl = async (target) => {
    if (String(target) === `https://api.lever.co/v0/postings/examplelabs/${id}`) return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
  const result = await builtinFetcher({ fetchImpl, timeoutMs: 5000 }).fetch({ postingId: 'p-lever', url, known: { company: 'Example Labs', title: 'Data Science Intern' } });
  assert.equal(result.ok, true);
  assert.ok(validateSnapshot({ url, title: 'Data Science Intern', company: 'Example Labs' }, result).identityOk);
  assert.match(result.text, /Undergraduate students only/, 'a requirement listed only in lists[] reaches the judgment input');
  assert.match(result.text, /enrolled at a United States university/, 'the additional section is kept');
  assert.match(result.text, /build dashboards/, 'the description is kept');
});

// ===================================================================== #6

test('[B] an automated withdrawal classified by bootstrap is restored by an eligible verdict (merged #6)', async () => {
  const { bootstrapExisting } = await bootstrapModule();
  const db = freshDb();
  const automated = seedCheckerWithdrawal(db, { company: 'Example Corp', role: 'Analytics Intern', jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/7100001', note: 'AUTO-CHECK not eligible: undergraduate only' });
  const declined = seedCheckerWithdrawal(db, { company: 'Example Corp', role: 'Ops Intern', jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/7100002', note: 'USER declined: not interested' });
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  const postingOf = (app) => db.prepare('SELECT id FROM postings WHERE application_id = ?').get(app.id).id;
  assert.equal(reviewOf(db, postingOf(automated)).state, 'due', 'bootstrap re-queues the automated withdrawal');

  const restored = await deliverVerdict(db, postingOf(automated), verdict(), at(1));
  assert.equal(restored.action, 'restored', 'the verified automated provenance permits the guarded restore');
  assert.equal(application(db, automated.id).status, 'lead');
  assert.notEqual(reviewOf(db, postingOf(automated)).code, 'superseded_by_user');

  const kept = await deliverVerdict(db, postingOf(declined), verdict(), at(1));
  assert.equal(kept.action, 'superseded_by_user', 'a user decline is never restored');
  assert.equal(application(db, declined.id).status, 'withdrawn');
});

// ===================================================================== #7

test('[B] a deadline that existed before migration 006 is never cleared or replaced by review (merged #7)', async () => {
  const db = openDatabase(':memory:');
  migrate(db, { migrations: schemaMigrations.filter((item) => item.version <= 5) });
  db.prepare(`INSERT INTO applications (id, company, role, status, job_url, deadline_at, created_at, updated_at)
    VALUES ('a-legacy', 'Example Corp', 'Data Science Intern', 'lead', 'https://job-boards.greenhouse.io/examplecorp/jobs/7200001', '2027-02-01T23:59:00-05:00', '2026-10-01', '2026-10-01')`).run();
  db.prepare(`INSERT INTO applications (id, company, role, status, job_url, created_at, updated_at)
    VALUES ('a-empty', 'Example Corp', 'Analytics Intern', 'lead', 'https://job-boards.greenhouse.io/examplecorp/jobs/7200002', '2026-10-01', '2026-10-01')`).run();
  if (!schemaMigrations.some((item) => item.version === 6)) throw new Error('NOT IMPLEMENTED [L1]: migration 006-funnel is not registered in schemaMigrations');
  migrate(db);
  insertPosting(db, { id: 'p-legacy', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/7200001', applicationId: 'a-legacy' });
  insertPosting(db, { id: 'p-empty', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/7200002', applicationId: 'a-empty' });
  insertReview(db, { postingId: 'p-legacy', stage: 'deliver' });
  insertReview(db, { postingId: 'p-empty', stage: 'deliver' });
  const deadlineOf = (id) => db.prepare('SELECT deadline_at FROM applications WHERE id = ?').get(id).deadline_at;

  await deliverVerdict(db, 'p-legacy', verdict(), at(1));
  assert.equal(deadlineOf('a-legacy'), '2027-02-01T23:59:00-05:00', 'a verdict without a deadline leaves the existing deadline');
  const quote = 'Applications close on January 15, 2027.';
  await deliverVerdict(db, 'p-legacy', verdict({ deadline: { kind: 'cutoff', date: '2027-01-15', time: null, tz: null, precision: 'date', quote } }), at(2));
  assert.equal(deadlineOf('a-legacy'), '2027-02-01T23:59:00-05:00', 'a review deadline does not overwrite a pre-existing one');

  await deliverVerdict(db, 'p-empty', verdict({ deadline: { kind: 'cutoff', date: '2027-01-15', time: null, tz: null, precision: 'date', quote } }), at(1));
  assert.equal(deadlineOf('a-empty'), '2027-01-15', 'an empty legacy deadline is still filled by review');
});

// ===================================================================== #8

test('[B] a requisition named in a mail without confirmation wording does not mark the lead applied (merged #8)', async () => {
  const { matchMailHits } = await mailModule();
  const { annotateMail } = await load('B5', './src/review/deliver.mjs', ['annotateMail']);
  const db = freshDb();
  const lead = seedApplication(db, { company: 'Example Corp', role: 'Data Science Intern', now: T0 });
  insertPosting(db, { id: 'p-r5001', applicationId: lead.id, aliases: [['company_req:example:R5001', 'company_req']] });
  const hit = (subject, excerpt) => ({ messageId: `<m-${subject.length}@example.com>`, receivedAt: '2026-11-02T03:00:00.000+00:00', sender: 'careers@examplecorp.example', subject, mailbox: 'INBOX', excerpt, searchedTerm: 'Example Corp' });
  const [invitation, confirmation] = matchMailHits(db, [
    hit('Invitation to apply: R5001', 'Example Corp thinks you would be a great fit. Apply now for requisition R5001.'),
    hit('Application received R5001', 'Thank you for applying to Example Corp.'),
  ], { now: T0 });
  assert.notEqual(invitation.match, 'exact', 'an invitation to apply is not evidence of an application');
  assert.deepEqual([confirmation.match, confirmation.postingId], ['exact', 'p-r5001'], 'a real confirmation still matches exactly');
  if (invitation.postingId) annotateMail(db, { postingId: invitation.postingId, match: invitation.match, messageId: '<i@example.com>', subject: 'Invitation to apply: R5001', received: '2026-11-02T03:00:00.000+00:00', matched: invitation.token, now: T0 });
  assert.equal(application(db, lead.id).skip_reason, null, 'the lead stays visible');
});

// ===================================================================== #9

function seedRunRow(db, { runId, kind = 'scan', at: when }) {
  db.prepare(`INSERT INTO runs (run_id, kind, owner, started_at, heartbeat_at, finished_at, status, receipt_json) VALUES (?, ?, 'test', ?, ?, ?, 'ok', '{}')`).run(runId, kind, when, when, when);
}
function seedRunSourceRow(db, { runId, partition, status = 'ok' }) {
  db.prepare(`INSERT INTO run_sources (run_id, source, partition, status, count, errors, truncated, expected, detail, baseline, alert, raw_count, quarantined)
    VALUES (?, 'greenhouse', ?, ?, 10, ?, 0, 1, '', NULL, NULL, 10, 0)`).run(runId, partition, status, status === 'error' ? 1 : 0);
}
function seedSightingRow(db, { runId, postingId, partition, at: when }) {
  const observationId = `o-${postingId}-${runId}`;
  db.prepare(`INSERT INTO observations (id, posting_id, source, source_id, partition, first_run_id, observed_at, fields_json, completeness_json, listed, content_hash)
    VALUES (?, ?, 'greenhouse', ?, ?, ?, ?, '{}', '{}', 1, ?)`).run(observationId, postingId, postingId, partition, runId, when, observationId);
  db.prepare('INSERT INTO observation_sightings (run_id, posting_id, observation_id, source, partition, seen_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, postingId, observationId, 'greenhouse', partition, when);
}

test('[C] pruning old sightings does not erase the partition membership closure depends on (merged #9)', async () => {
  const { retentionPolicy, prune } = await pruneModule();
  const { runReview } = await workerModule();
  const NOW = '2027-06-01T03:00:00.000Z';
  const ago = (days) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
  const A = 'greenhouse:examplecorp-a';
  const B = 'greenhouse:examplecorp-b';
  await withHome(async ({ home, db }) => {
    const pages = {};
    for (const id of ['p-two', 'p-only-b']) {
      const url = `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
      insertPosting(db, { id, url, firstSeen: ago(70) });
      insertReview(db, { postingId: id, stage: 'fetch', firstSeen: ago(70), nextDue: NOW });
      pages[url] = { ok: false, httpStatus: 404, error: 'not found' };
    }
    // p-two was listed in partition A 60 days ago (A has been failing since) and in partition B 30 days ago.
    seedRunRow(db, { runId: 'scan-a0', at: ago(60) }); seedRunSourceRow(db, { runId: 'scan-a0', partition: A });
    seedSightingRow(db, { runId: 'scan-a0', postingId: 'p-two', partition: A, at: ago(60) });
    seedRunRow(db, { runId: 'scan-b0', at: ago(30) }); seedRunSourceRow(db, { runId: 'scan-b0', partition: B }); seedRunSourceRow(db, { runId: 'scan-b0', partition: A, status: 'error' });
    seedSightingRow(db, { runId: 'scan-b0', postingId: 'p-two', partition: B, at: ago(30) });
    seedSightingRow(db, { runId: 'scan-b0', postingId: 'p-only-b', partition: B, at: ago(30) });
    // Two later successful B censuses without either posting; A errors each time.
    for (const [runId, days] of [['scan-b1', 10], ['scan-b2', 5]]) {
      seedRunRow(db, { runId, at: ago(days) });
      seedRunSourceRow(db, { runId, partition: B });
      seedRunSourceRow(db, { runId, partition: A, status: 'error' });
    }
    await prune(db, home, { now: NOW, policy: retentionPolicy(REVIEW_POLICY), dryRun: false });
    await runReview(runOptions(db, { now: NOW, pages }));

    const availability = (id) => db.prepare('SELECT availability FROM postings WHERE id = ?').get(id).availability;
    assert.notEqual(availability('p-two'), 'closed_verified', 'partition A never had two healthy censuses, so closure is not proven');
    assert.notEqual(reviewOf(db, 'p-two').code, 'closed_verified');
    assert.equal(availability('p-only-b'), 'closed_verified', 'a posting absent from two healthy censuses of its only partition still closes');
  });
});

// ===================================================================== #10

test('[B] review bootstrap applies the configured company aliases to legacy applications (merged #10)', async () => {
  const { ingestBatch } = await ingestModule();
  await withHome(async ({ home, db }) => {
    db.prepare(`INSERT INTO applications (id, company, role, status, external_id, applied_at, created_at, updated_at)
      VALUES ('a-holdings', 'Example Holdings', 'Data Intern', 'applied', 'R900522', '2026-09-29T00:00:00Z', '2026-09-29', '2026-09-29')`).run();
    const screeningPolicy = { ...SCREENING_POLICY, companyAliases: { 'Example Holdings': 'Example Group' } };
    await writeReviewHome(home, { screeningPolicy });
    const result = await cli(['review', 'bootstrap', '--home', home]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(db.prepare("SELECT id FROM postings WHERE application_id = 'a-holdings'").get(), 'bootstrap bound the legacy application');
    const counts = ingestBatch(db, { runId: 'scan-1', now: T0, policy: screeningPolicy, profile: PROFILE, source: 'simplify', partition: 'simplify:1', records: [
      record({ source: 'simplify', sourceId: 's-522', partition: 'simplify:1', company: 'Example Group', title: 'Data Intern', url: 'https://careers.example.com/group/data-intern-522', requisitionId: 'R900522' }),
    ] });
    assert.equal(counts.newPostings, 0, 'Example Holdings is configured as Example Group, so R900522 is the submitted posting');
    assert.equal(counts.reused, 1);
  });
});

// ===================================================================== #11

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function goneWithin(pid, ms) {
  const end = Date.now() + ms;
  while (isAlive(pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
  return !isAlive(pid);
}
async function settleWithin(promise, ms) {
  const started = Date.now();
  let timer;
  const outcome = await Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ hung: true }), ms); }),
  ]);
  clearTimeout(timer);
  return { ...outcome, elapsed: Date.now() - started };
}
async function readPids(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return []; } }
const killAll = (pids) => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };
// Starts one never-ending descendant that shares the output pipes, records both pids, then never finishes.
// `--version` answers immediately so the same file can stand in for the Codex CLI.
const stuckProgram = (pidFile) => `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.0.0-synthetic'); process.exit(0); }
const { spawn } = await import('node:child_process');
const { writeFileSync } = await import('node:fs');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, descendant.pid]));
setInterval(() => {}, 1000);
`;

test('[B] fetch and judge timeouts end the whole process tree within a bounded time (merged #11)', { timeout: 10_000 }, async () => {
  const { commandFetcher } = await fetchModule();
  const { codexExecAdapter } = await judgeModule();
  const root = await tempDir('cj-merged-tree-');
  const fetchPids = path.join(root, 'fetch-pids.json');
  const judgePids = path.join(root, 'judge-pids.json');
  try {
    const fetchScript = path.join(root, 'fetch.mjs');
    const judgeBin = path.join(root, 'codex-fake.mjs');
    await writeFile(fetchScript, stuckProgram(fetchPids));
    await writeFile(judgeBin, stuckProgram(judgePids));
    await chmod(judgeBin, 0o755);
    const fetcher = commandFetcher({ argv: [process.execPath, fetchScript], timeoutMs: 500 });
    const adapter = codexExecAdapter({ bin: judgeBin, codexHome: path.join(root, 'codex-home'), model: 'model-synthetic', tier: 'primary', timeoutMs: 500, workDir: root });
    const [fetched, judged] = await Promise.all([
      settleWithin(fetcher.fetch({ postingId: 'p-1', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9000001' }), 1500),
      settleWithin(adapter.ready.then(() => adapter.judge({ postingId: 'p-1', prompt: 'synthetic' }, { attemptId: 'attempt-1', outputPath: path.join(root, 'out.json') })), 1500),
    ]);
    const [fp, jp] = [await readPids(fetchPids), await readPids(judgePids)];
    assert.equal(fp.length, 2, 'the fetch command started its descendant before the timeout');
    assert.equal(jp.length, 2, 'the judge command started its descendant before the timeout');
    assert.ok(!fetched.hung, `the timed-out fetch settled within 1500 ms (timeout 500 ms); still waiting after ${fetched.elapsed} ms`);
    assert.ok(!judged.hung, `the timed-out judge call settled within 1500 ms (timeout 500 ms); still waiting after ${judged.elapsed} ms`);
    assert.deepEqual([fetched.value?.ok, fetched.value?.error], [false, 'timeout']);
    assert.equal(judged.value?.status, 'timeout');
    for (const pid of [...fp, ...jp]) assert.ok(await goneWithin(pid, 500), `process ${pid} of the timed-out tree was terminated`);
  } finally {
    killAll([...await readPids(fetchPids), ...await readPids(judgePids)]);
    await rm(root, { recursive: true, force: true });
  }
});

// ===================================================================== #12

test('[B] repeated missing judge output fails the run, and a single adapter failure is not ok (merged #12)', async () => {
  const { runReview } = await workerModule();
  const { codexExecAdapter } = await judgeModule();
  // A CLI that exits 0 without writing its -o output file: every attempt reports the output missing.
  const silent = (tier) => {
    const adapter = codexExecAdapter({ codexHome: '/tmp/cj-codex-home-synthetic', model: `model-${tier}`, tier, runImpl: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
    const calls = [];
    const judge = adapter.judge.bind(adapter);
    adapter.judge = (request, context) => { calls.push(request.postingId); return judge(request, context); };
    adapter.calls = calls;
    return adapter;
  };
  const db = freshDb();
  const q = queue();
  for (let i = 0; i < 5; i += 1) q.add(db);
  const judges = { primary: silent('primary'), escalation: silent('escalation') };
  const receipt = await runReview(runOptions(db, { pages: q.pages, judges }));
  assert.equal(judges.primary.calls.length, 3, 'the run stops after three equivalent adapter errors');
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.stop_reason, 'adapter_failure');
  assert.ok(receipt.errors.length >= 1, 'the receipt names the adapter error');

  const single = freshDb();
  const one = queue();
  one.add(single);
  const lone = await runReview(runOptions(single, { pages: one.pages, judges: { primary: silent('primary'), escalation: silent('escalation') } }));
  assert.notEqual(lone.status, 'ok', 'an attempt that produced no verdict leaves the run partial, not ok');
});

// ===================================================================== #13

test('[B] the exploration share is reserved before higher-lane escalations exhaust the budget (merged #13)', async () => {
  const { runReview } = await workerModule();
  const db = freshDb();
  const q = queue();
  const soon = q.add(db, { id: 'p-deadline', snapshot: 'undergradOnly', deadline: { kind: 'cutoff', date: at(3).slice(0, 10) } });
  const aged = q.add(db, { id: 'p-aged', snapshot: 'undergradOnly', now: at(-3) });
  const noSignal = q.add(db, { id: 'p-nosignal', lane: 'no_student_signal', flags: ['no_student_signal'] });
  const answers = { 'p-deadline': { output: JUDGMENTS.undergradOnly }, 'p-aged': { output: JUDGMENTS.undergradOnly }, 'p-nosignal': { output: JUDGMENTS.eligible } };
  const judges = { primary: fakeJudge({ tier: 'primary', answers }), escalation: fakeJudge({ tier: 'escalation', answers }) };
  await runReview(runOptions(db, { budget: 4, pages: q.pages, judges }));
  assert.ok(db.prepare('SELECT COALESCE(SUM(1 + transport_retries), 0) n FROM attempts').get().n <= 4, 'the budget is respected');
  assert.ok(callsFor(judges.primary, soon) >= 1, 'the imminent deadline is still judged');
  assert.ok(callsFor(judges.primary, noSignal) >= 1, `the due no-student-signal posting receives its reserved attempt (deadline ${callsFor(judges.primary, soon) + callsFor(judges.escalation, soon)}, aged ${callsFor(judges.primary, aged) + callsFor(judges.escalation, aged)})`);
});

// ===================================================================== #14

test('[C] retention recovery adopts only recoverable judgments, in the envelope the worker reuses (merged #14)', async () => {
  const { retentionPolicy, prune } = await pruneModule();
  const { runReview } = await workerModule();
  await withHome(async ({ home, db, dataDir }) => {
    const attemptDir = path.join(dataDir, 'attempts');
    await mkdir(attemptDir, { recursive: true });
    const q = queue();
    const id = q.add(db, { id: 'p-adopt' });
    // The CLI writes its -o file, then the process dies before the response is logged.
    const writesOutput = fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }),
      onCall: async (request, context) => { await writeFile(context.outputPath, JSON.stringify(JUDGMENTS.eligible)); } });
    await assert.rejects(runReview(runOptions(db, { pages: q.pages, attemptDir, judges: { primary: writesOutput, escalation: fakeJudge({ tier: 'escalation' }) },
      hooks: { afterResponse: () => { throw new Crash('afterResponse'); } } })), Crash);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM attempts WHERE posting_id = ? AND state = 'dispatched'").get(id).n, 1);

    // A second interrupted attempt whose output file is a JSON object but not a judgment.
    insertPosting(db, { id: 'p-junk', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/p-junk', title: snapshotTitle(SNAPSHOTS.eligible) });
    insertReview(db, { postingId: 'p-junk', stage: 'judge' });
    const junk = path.join(attemptDir, 'a-junk.json');
    await writeFile(junk, JSON.stringify({ note: 'partial write' }));
    seedAttemptRow(db, { id: 'a-junk', postingId: 'p-junk', at: T0, outputPath: junk });

    await prune(db, home, { now: at(2), policy: retentionPolicy(REVIEW_POLICY), dryRun: false });
    assert.notEqual(db.prepare("SELECT state FROM attempts WHERE id = 'a-junk'").get().state, 'adopted', 'an object that is not a judgment is not recoverable');

    const judges = eligibleJudges();
    await runReview(runOptions(db, { now: at(2), runId: 'review-2', pages: q.pages, attemptDir, judges }));
    assert.equal(callsFor(judges.primary, id), 0, 'the adopted judgment is reused instead of paying for another primary call');
    assert.equal(reviewOf(db, id).decision, 'eligible');
  });
});

// ===================================================================== #15

test('[C] raw-log retention keeps the judgment an unchanged page reuses (merged #15)', async () => {
  const { retentionPolicy, prune } = await pruneModule();
  const { runReview } = await workerModule();
  // Control: without pruning, an unchanged day-16 refresh costs nothing.
  const control = freshDb();
  const cq = queue();
  cq.add(control);
  await runReview(runOptions(control, { pages: cq.pages }));
  const controlJudges = eligibleJudges();
  await runReview(runOptions(control, { now: at(16), runId: 'review-16', pages: cq.pages, judges: controlJudges }));
  assert.equal(controlJudges.primary.calls.length, 0, 'control: unchanged content is reused');

  await withHome(async ({ home, db, dataDir }) => {
    const attemptDir = path.join(dataDir, 'attempts');
    const q = queue();
    const id = q.add(db);
    await runReview(runOptions(db, { pages: q.pages, attemptDir }));
    assert.equal(reviewOf(db, id).decision, 'eligible');
    await prune(db, home, { now: at(16), policy: retentionPolicy(REVIEW_POLICY), dryRun: false });
    const same = { fetcher: fakeFetcher(q.pages), judges: eligibleJudges() };
    await runReview(runOptions(db, { now: at(16), runId: 'review-16', attemptDir, ...same }));
    assert.equal(same.fetcher.calls.length, 1, 'the active lead is refreshed');
    assert.equal(same.judges.primary.calls.length, 0, 'an unchanged page after pruning makes no paid call');
    assert.equal(reviewOf(db, id).decision, 'eligible');
  });
});

// ===================================================================== #16

test('[B] a deadline clock and timezone need quoted evidence and a valid zone (merged #16)', async () => {
  const text = MORE_SNAPSHOTS.details;
  const invented = await decideWith({ text, judged: judgment({ ...MORE_JUDGMENTS.details, deadline: { kind: 'cutoff', date: '2027-01-15', time: '01:00', tz: 'Pacific/Honolulu', precision: 'datetime', quote: 'Applications close on January 15, 2027.' } }) });
  assert.deepEqual([invented.deadline.date, invented.deadline.time, invented.deadline.tz, invented.deadline.precision], ['2027-01-15', null, null, 'date'], 'an unquoted clock and zone keep date precision');

  const timed = text.replace('Applications close on January 15, 2027.', 'Applications close January 15, 2027 at 17:00 (America/Chicago).');
  const quoted = await decideWith({ text: timed, judged: judgment({ ...MORE_JUDGMENTS.details, deadline: { kind: 'cutoff', date: '2027-01-15', time: '17:00', tz: 'America/Chicago', precision: 'datetime', quote: 'Applications close January 15, 2027 at 17:00 (America/Chicago).' } }) });
  assert.deepEqual([quoted.deadline.time, quoted.deadline.tz, quoted.deadline.precision], ['17:00', 'America/Chicago', 'datetime'], 'a quoted clock and zone are kept');

  const db = freshDb();
  insertPosting(db, { id: 'p-badzone' });
  insertReview(db, { postingId: 'p-badzone', stage: 'deliver' });
  let outcome;
  try { outcome = await deliverVerdict(db, 'p-badzone', verdict({ deadline: { kind: 'cutoff', date: '2027-01-15', time: '17:00', tz: 'Not/A_Zone', precision: 'datetime', quote: 'Applications close on January 15, 2027.' } })); }
  catch (error) { outcome = error; }
  assert.ok(!(outcome instanceof Error), `an invalid zone does not abort delivery: ${outcome?.message}`);
  const row = db.prepare('SELECT deadline_at, deadline_precision FROM applications WHERE id = ?').get(outcome.applicationId);
  assert.deepEqual([row.deadline_at, row.deadline_precision], ['2027-01-15', 'date'], 'an invalid zone retains date precision');
});

// ===================================================================== #17

test('[B] the role-scan task exits with the worst of scan and review, and keeps busy as 75 (merged #17)', async () => {
  await withHome(async ({ home, db }) => {
    await writeScanProfile(home, (profile) => ({ ...profile, sources: { ...profile.sources, expected: ['atsBoards'] } }));
    await writeReviewHome(home);
    const configured = await cli(['automation', 'configure', '--home', home, '--task', 'role-scan', '--enabled']);
    assert.equal(configured.code, 0, configured.stderr);
    const runtime = async () => ({
      fetch: fixtureFetch({ ...(await defaultRoutes()), [ATS_URLS.lever]: 503 }),
      review: { judges: eligibleJudges(), fetcher: fakeFetcher({}) },
    });
    const partial = await cli(['automation', 'run', '--home', home, '--task', 'role-scan'], await runtime());
    const result = JSON.parse(partial.stdout);
    assert.equal(result.review?.status, 'ok', `the review stage itself is ok: ${partial.stdout}`);
    assert.equal(partial.code, 2, 'a partial scan followed by an ok review is partial (exit 2)');

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO runs (run_id, kind, owner, started_at, heartbeat_at, status, receipt_json) VALUES ('review-other', 'review', 'other-worker', ?, ?, 'running', '{}')`).run(now, now);
    const busy = await cli(['automation', 'run', '--home', home, '--task', 'role-scan'], { ...(await runtime()), fetch: fixtureFetch(await defaultRoutes()) });
    assert.equal(busy.code, 75, `a busy review stage exits 75, not a generic failure: ${busy.stderr}`);
  });
});

// ===================================================================== #18

test('[C] the apply fill brief stops only for roles outside the review-validated alternatives (merged #18)', async () => {
  const read = (file) => readFile(new URL(`.agents/skills/career-journal-apply/references/${file}`, ROOT), 'utf8');
  const [english, chinese] = await Promise.all([read('fill-brief.md'), read('fill-brief.zh-CN.md')]);
  const rows = (text) => [...text.matchAll(/^\| `\{\{(\w+)\}\}` \| (.+) \|$/gm)].map(([, name, description]) => ({ name, description }));
  const check = (text, { bullet, stop, review, sentenceSplit, thatList }) => {
    const table = rows(text);
    const preference = table.filter((row) => row.description.includes('search.locations')).map((row) => row.name);
    const validated = table.filter((row) => !row.description.includes('search.locations') && review.test(row.description) && /review/i.test(row.description)).map((row) => row.name);
    const line = text.split('\n').find((item) => bullet.test(item));
    assert.ok(line, 'the brief still has its location rule');
    assert.ok(validated.length >= 1, 'a placeholder carries the role\'s alternatives validated by review run');
    assert.ok(validated.some((name) => line.includes(`{{${name}}}`)), 'the location rule uses the validated alternatives');
    for (const sentence of line.split(sentenceSplit).filter((item) => stop.test(item))) {
      const usesValidated = validated.some((name) => sentence.includes(`{{${name}}}`));
      assert.ok(usesValidated || !(preference.some((name) => sentence.includes(`{{${name}}}`)) || thatList.test(sentence)),
        `a stop rule must not depend on the search.locations preference list: "${sentence.trim()}"`);
    }
  };
  check(english, { bullet: /^- \*\*Location\.\*\*/, stop: /\bstop\b|do not fill|don't fill|\bskip\b/i, review: /location|office|remote|alternative/i, sentenceSplit: /(?<=\.)\s+/, thatList: /\b(?:that|this|the) list\b/i });
  check(chinese, { bullet: /^- \*\*地点。\*\*/, stop: /停下|不要填写|跳过/, review: /地点|办公室|远程|备选/, sentenceSplit: /(?<=。)/, thatList: /这些地点/ });
});

// ===================================================================== #19

test('[B] scan run exits 75 while another scan run is active (merged #19)', async () => {
  await withHome(async ({ home, db }) => {
    await writeScanProfile(home);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO runs (run_id, kind, owner, started_at, heartbeat_at, status, receipt_json) VALUES ('scan-other', 'scan', 'other-scanner', ?, ?, 'running', '{}')`).run(now, now);
    const busy = await cli(['scan', 'run', '--home', home], { fetch: fixtureFetch(await defaultRoutes()) });
    assert.equal(busy.code, 75, `busy is exit 75: ${busy.stderr}`);
    db.prepare("UPDATE runs SET status = 'ok', finished_at = ? WHERE run_id = 'scan-other'").run(now);
    const free = await cli(['scan', 'run', '--home', home], { fetch: fixtureFetch(await defaultRoutes()) });
    assert.equal(free.code, 0, `without a concurrent scan the run succeeds: ${free.stderr}`);
  });
});

// ===================================================================== #20

test('[B] ordinary posting prose containing "research results" is not a challenge page (merged #20)', async () => {
  const { validateSnapshot } = await fetchModule();
  const url = 'https://job-boards.greenhouse.io/examplecorp/jobs/9200001';
  const posting = { url, title: snapshotTitle(SNAPSHOTS.eligible), company: 'Example Corp' };
  const prose = SNAPSHOTS.eligible.replace('• Prototype small models that forecast demand.', '• Integrate the research results into products used by partner teams.');
  assert.deepEqual(validateSnapshot(posting, page(url, prose)), { identityOk: true, reason: null });
  for (const challenge of ['Please verify you are human before continuing.', 'Enable JavaScript and cookies to continue.', 'Search results\n24 jobs match "data intern".']) {
    const text = `${challenge}\n${'This page is a gate in front of the job board. '.repeat(20)}`;
    assert.equal(validateSnapshot(posting, page(url, text, { title: posting.title })).reason, 'challenge', `still a challenge: ${challenge.split('\n')[0]}`);
  }
});

// ===================================================================== #21

test('[B] a season without a year infers the upcoming year from when the posting was first seen (merged #21)', async () => {
  const { runReview } = await workerModule();
  const noYear = SNAPSHOTS.eligible.replace('Join our analytics team for the summer of 2027.', 'Join our analytics team for our summer internship program.');
  const otherYear = SNAPSHOTS.eligible.replace('Join our analytics team for the summer of 2027.', 'Join our analytics team for the summer of 2026.');
  const term = (quote, year) => ({ ...SUMMER_CHICAGO, term: { label: 'summer', year, quote } });
  const answers = {
    'p-inferred': { output: judgment({ alternatives: [term('Join our analytics team for our summer internship program', null)] }) },
    'p-spring-seen': { output: judgment({ alternatives: [term('Join our analytics team for our summer internship program', null)] }) },
    'p-other-year': { output: judgment({ alternatives: [term('Join our analytics team for the summer of 2026', 2026)] }) },
  };
  const judges = () => ({ primary: fakeJudge({ tier: 'primary', answers }), escalation: fakeJudge({ tier: 'escalation', answers }) });

  // First observed 2026-11-02 (between Aug 1 and Dec 31 of 2026): "summer" means Summer 2027.
  const db = freshDb();
  const q = queue();
  q.add(db, { id: 'p-inferred', text: noYear });
  q.add(db, { id: 'p-other-year', text: otherYear });
  await runReview(runOptions(db, { pages: q.pages, judges: judges() }));
  const inferred = reviewOf(db, 'p-inferred');
  assert.equal(inferred.decision, 'eligible', 'the season-only quote is accepted with the inferred year');
  assert.match(JSON.stringify(inferred), /term_inferred/, 'the inference is flagged on the review');
  assert.notEqual(reviewOf(db, 'p-other-year').decision, 'eligible', 'a quote naming a different year still conflicts');

  // First observed in spring 2027: no inference window applies.
  const spring = freshDb();
  const sq = queue();
  sq.add(spring, { id: 'p-spring-seen', text: noYear, now: '2027-03-01T03:00:00.000Z' });
  await runReview(runOptions(spring, { now: '2027-03-01T03:00:00.000Z', pages: sq.pages, judges: judges() }));
  assert.notEqual(reviewOf(spring, 'p-spring-seen').decision, 'eligible', 'outside Aug–Dec of the prior year the year is not inferred');
});

// ===================================================================== #22

test('[B] common requirement headings, with or without emoji prefixes, parse as required (merged #22)', async () => {
  const { segmentSections } = await clausesModule();
  const kindUnder = (heading) => {
    const text = `Data Intern\n\nAbout the role\nYou will analyse data for partner teams.\n\n${heading}\n• Must be enrolled in a degree program.\n`;
    const offset = text.indexOf('• Must be enrolled');
    return segmentSections(text).find((section) => section.start <= offset && offset < section.end)?.kind;
  };
  for (const heading of ['What You Will Bring', "What We Require", "What We're Looking For", "Student qualities we're seeking", '📃 Minimum Qualifications:', '🎯 What You Will Bring:']) {
    assert.equal(kindUnder(heading), 'required', heading);
  }
  for (const heading of ['What You Will Bring (Nice to Have)', "What We're Looking For: Bonus Points", '⭐ Preferred Qualifications:']) {
    assert.equal(kindUnder(heading), 'preferred', heading);
  }
  assert.equal(kindUnder('Minimum Qualifications'), 'required', 'the plain form is unchanged');
});
