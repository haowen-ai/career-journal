// Lane L2 (one L1 case marked) — leases, fencing, crash boundaries, ambiguous attempts, freshness, replan
// (spec sections 6.0, 6.1, 6.5, 7.2, 7.4; review-v3 F4, F6, P1 fencing, §5.4; plan 7.1 #5, #7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { freshDb, tempDb, load, insertPosting, insertReview, reviewOf, applicationsCount, fakeJudge, fakeFetcher, Crash, T0, at, seedApplication } from '../../test-utils/funnel-v3.mjs';
import { FACTS, REVIEW_POLICY, SCREENING_POLICY, SNAPSHOTS, JUDGMENTS, page, record, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';

const worker = () => load('L2', './src/review/worker.mjs', ['runReview', 'replan']);
const lease = () => load('L2', './src/review/lease.mjs', ['acquireRunLease', 'claimItem', 'StaleLeaseError']);
const exits = () => load('L2', './src/review/receipt.mjs', ['reviewExitCode']);

function item(db, id, { snapshot = 'eligible', company = 'Example Corp', applicationId = null } = {}) {
  const url = `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
  insertPosting(db, { id, company, url, applicationId });
  insertReview(db, { postingId: id, stage: 'fetch' });
  return { id, url, page: page(url, SNAPSHOTS[snapshot]) };
}

function harness(items, { answers, escalationAnswers, judgeHook } = {}) {
  const pages = Object.fromEntries(items.map((entry) => [entry.url, entry.page]));
  const scripted = answers ?? Object.fromEntries(items.map((entry) => [entry.id, { output: JUDGMENTS.eligible }]));
  return {
    fetcher: fakeFetcher(pages),
    judges: {
      primary: fakeJudge({ tier: 'primary', answers: scripted, onCall: judgeHook }),
      escalation: fakeJudge({ tier: 'escalation', answers: escalationAnswers ?? scripted }),
    },
  };
}

function options(db, parts, overrides = {}) {
  return {
    db, runId: overrides.runId ?? 'review-1', owner: overrides.owner ?? 'worker-a', now: overrides.now ?? T0, budget: overrides.budget ?? 10, deadlineMs: 600_000,
    fetcher: parts.fetcher, judges: parts.judges, attemptDir: overrides.attemptDir ?? null, sleep: async () => {},
    inputs: overrides.inputs ?? (() => reviewInputs()),
    hooks: overrides.hooks ?? {},
  };
}

const attemptsRows = (db) => db.prepare('SELECT * FROM attempts ORDER BY dispatched_at, id').all();

// ------------------------------------------------------------- leases

test('[L2] an overlapping review run is busy (exit 75); a dead run is reclaimed and reported interrupted', async () => {
  const { runReview } = await worker();
  const { acquireRunLease } = await lease();
  const { reviewExitCode } = await exits();
  const db = freshDb();
  assert.ok(acquireRunLease(db, { kind: 'review', owner: 'other', runId: 'review-0', now: T0 }));
  const busy = await runReview(options(db, harness([]), { now: at(0.001) }));
  assert.equal(busy.status, 'busy');
  assert.equal(reviewExitCode(busy), 75);
  const later = await runReview(options(db, harness([]), { now: at(0.01), runId: 'review-2' })); // heartbeat now > 10 minutes old
  assert.equal(later.previous_run_interrupted, true);
  assert.equal(db.prepare("SELECT status FROM runs WHERE run_id = 'review-0'").get().status, 'interrupted');
});

test('[L2] a worker that outlived its item lease cannot commit after takeover (fencing)', async () => {
  const { claimItem, StaleLeaseError } = await lease();
  const { deliver } = await load('L2', './src/review/deliver.mjs', ['deliver']);
  const db = freshDb();
  insertPosting(db, { id: 'p-fence' });
  insertReview(db, { postingId: 'p-fence', stage: 'deliver' });
  const stale = claimItem(db, 'p-fence', { owner: 'worker-a', now: T0 });
  const fresh = claimItem(db, 'p-fence', { owner: 'worker-b', now: at(1 / 24) }); // 60 min later: the 30-min lease expired
  assert.ok(fresh.generation > stale.generation);
  assert.throws(() => deliver(db, { postingId: 'p-fence', verdict: { decision: 'eligible', fit: { level: 'high' } }, fence: stale, now: at(1 / 24), policy: SCREENING_POLICY }), StaleLeaseError);
  assert.equal(applicationsCount(db), 0);
  assert.equal(reviewOf(db, 'p-fence').lease_owner, 'worker-b');
});

// ------------------------------------------------------ crash boundaries

test('[L2] crash after dispatch, before the response is logged: the attempt is lost (counted), never silently re-billed', async () => {
  const { runReview } = await worker();
  const h = await tempDb();
  try {
    const one = item(h.db, 'p-lost');
    const parts = harness([one]);
    await assert.rejects(runReview(options(h.db, parts, { attemptDir: h.directory, hooks: { afterDispatch: () => { throw new Crash('afterDispatch'); } } })), Crash);
    h.reopen();
    const rerun = harness([one]);
    const receipt = await runReview(options(h.db, rerun, { attemptDir: h.directory, runId: 'review-2', now: at(0.01) }));
    const rows = attemptsRows(h.db);
    assert.equal(rows[0].state, 'lost');
    assert.equal(rows.length, 2, 'one lost attempt plus one new attempt; no hidden extra calls');
    assert.equal(rerun.judges.primary.calls.length, 1);
    assert.equal(receipt.counts.attempts_lost, 1);
    assert.equal(reviewOf(h.db, 'p-lost').lost_attempts, 1);
    assert.equal(reviewOf(h.db, 'p-lost').decision, 'eligible');
  } finally { await h.cleanup(); }
});

test('[L2] crash after the model answered but before logging: a persisted output file is adopted without a second call', async () => {
  const { runReview } = await worker();
  const h = await tempDb();
  try {
    const one = item(h.db, 'p-adopt');
    await assert.rejects(runReview(options(h.db, harness([one]), { attemptDir: h.directory, hooks: {
      afterResponse: async ({ outputPath }) => { await writeFile(outputPath, JSON.stringify(JUDGMENTS.eligible)); throw new Crash('afterResponse'); },
    } })), Crash);
    h.reopen();
    const rerun = harness([one]);
    await runReview(options(h.db, rerun, { attemptDir: h.directory, runId: 'review-2', now: at(0.01) }));
    assert.equal(rerun.judges.primary.calls.length, 0);
    assert.deepEqual(attemptsRows(h.db).map((row) => row.state), ['adopted']);
    assert.equal(reviewOf(h.db, 'p-adopt').decision, 'eligible');
  } finally { await h.cleanup(); }
});

test('[L2] crash after the raw response is logged, before the decision: resume decides from the log (no new attempt)', async () => {
  const { runReview } = await worker();
  const h = await tempDb();
  try {
    const one = item(h.db, 'p-logged');
    await assert.rejects(runReview(options(h.db, harness([one]), { attemptDir: h.directory, hooks: { afterLlmLog: () => { throw new Crash('afterLlmLog'); } } })), Crash);
    h.reopen();
    const rerun = harness([one]);
    await runReview(options(h.db, rerun, { attemptDir: h.directory, runId: 'review-2', now: at(0.01) }));
    assert.equal(rerun.judges.primary.calls.length, 0);
    assert.equal(attemptsRows(h.db).length, 1);
    assert.equal(reviewOf(h.db, 'p-logged').state, 'done');
  } finally { await h.cleanup(); }
});

test('[L2] crash inside R4 is all-or-nothing; the rerun delivers exactly one lead', async () => {
  const { runReview } = await worker();
  const h = await tempDb();
  try {
    const one = item(h.db, 'p-r4');
    await assert.rejects(runReview(options(h.db, harness([one]), { attemptDir: h.directory, hooks: { insideDeliver: () => { throw new Crash('insideDeliver'); } } })), Crash);
    h.reopen();
    assert.equal(applicationsCount(h.db), 0);
    assert.notEqual(reviewOf(h.db, 'p-r4').state, 'done');
    await runReview(options(h.db, harness([one]), { attemptDir: h.directory, runId: 'review-2', now: at(0.01) }));
    assert.equal(applicationsCount(h.db), 1);
    assert.equal(attemptsRows(h.db).length, 1, 'the logged response is reused; R4 retry costs nothing');
  } finally { await h.cleanup(); }
});

test('[L2] crash after R4 but before the run finishes: next receipt says interrupted, no duplicate lead', async () => {
  const { runReview } = await worker();
  const h = await tempDb();
  try {
    const one = item(h.db, 'p-fin');
    await assert.rejects(runReview(options(h.db, harness([one]), { attemptDir: h.directory, hooks: { beforeFinish: () => { throw new Crash('beforeFinish'); } } })), Crash);
    h.reopen();
    const receipt = await runReview(options(h.db, harness([one]), { attemptDir: h.directory, runId: 'review-2', now: at(0.02) }));
    assert.equal(receipt.previous_run_interrupted, true);
    assert.equal(applicationsCount(h.db), 1);
  } finally { await h.cleanup(); }
});

// ------------------------------------------- inputs changing during R3

test('[L2] a facts change during R3 invalidates the result at commit; nothing is delivered from stale inputs', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  const one = item(db, 'p-facts');
  let facts = FACTS;
  const parts = harness([one], { judgeHook: () => { facts = [...FACTS, { id: 'new', statement: 'Completed a statistics course', polarity: 'has' }]; } });
  await runReview(options(db, parts, { inputs: () => reviewInputs({ facts }) }));
  const review = reviewOf(db, 'p-facts');
  assert.ok(review.state === 'due' || (review.state === 'done' && parts.judges.primary.calls.length === 2), `stale result was not delivered as-is (state ${review.state})`);
  if (review.state === 'due') assert.equal(applicationsCount(db), 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM review_log WHERE posting_id = 'p-facts' AND kind = 'replan'").get().n >= 1);
});

test('[L2] a user submission during R3 is not overridden by the worker', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  const lead = seedApplication(db, { company: 'Example Corp', role: 'Data Intern' });
  const one = item(db, 'p-race', { snapshot: 'undergradOnly', applicationId: lead.id });
  const parts = harness([one], {
    answers: { 'p-race': { output: JUDGMENTS.undergradOnly } },
    judgeHook: () => { db.prepare("UPDATE applications SET status='applied', applied_at=? WHERE id=?").run(at(0.001), lead.id); },
  });
  await runReview(options(db, parts));
  assert.equal(db.prepare('SELECT status FROM applications WHERE id = ?').get(lead.id).status, 'applied');
});

// ---------------------------------------------------- evidence/freshness

test('[L2] R1 validation: wrong posting, conflicting requisition despite equal title, challenge page, short page, renamed title with same req', async () => {
  const { validateSnapshot } = await load('L2', './src/review/fetch.mjs', ['validateSnapshot']);
  const posting = { id: 'p', company: 'Example Corp', title: 'Data Science Intern', url: 'https://acme.wd5.myworkdayjobs.com/ext/job/X/Data-Science-Intern_R1001', requisition: 'R1001' };
  const ok = page(posting.url, SNAPSHOTS.eligible, { requisitionId: 'R1001', title: 'Data Science Intern' });
  assert.equal(validateSnapshot(posting, ok).identityOk, true);
  assert.equal(validateSnapshot(posting, { ...ok, title: 'Data Science Intern (Summer 2027)' }).identityOk, true, 'renamed title, same requisition');
  assert.equal(validateSnapshot(posting, { ...ok, requisitionId: 'R2002' }).reason, 'req_conflict', 'equal title never rescues a different requisition');
  assert.equal(validateSnapshot(posting, { ...ok, requisitionId: null, title: 'Senior Accountant' }).reason, 'wrong_posting');
  assert.equal(validateSnapshot(posting, { ...ok, text: 'Please sign in to continue. Verify you are human.' }).reason, 'challenge');
  assert.equal(validateSnapshot(posting, { ...ok, text: 'Data Science Intern. Apply now.' }).reason, 'too_short');
  assert.equal(validateSnapshot(posting, { ...ok, finalUrl: 'https://login.example-sso.com/auth' }).reason, 'host_mismatch');
  assert.equal(validateSnapshot(posting, { ok: false, httpStatus: 404 }).reason, 'not_found');
});

test('[L2] a 404 makes the posting unavailable with rechecks, never closed_verified on its own', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  const one = item(db, 'p-404');
  one.page = { ok: false, httpStatus: 404 };
  await runReview(options(db, harness([one])));
  assert.equal(db.prepare("SELECT availability FROM postings WHERE id = 'p-404'").get().availability, 'unavailable');
  assert.ok(reviewOf(db, 'p-404').next_due > T0);
});

test('[L2] closed_verified needs detail absent plus two consecutive successful censuses without the posting', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  const one = item(db, 'p-closed');
  one.page = { ok: false, httpStatus: 404 };
  db.prepare("INSERT INTO observations (id, posting_id, source, source_id, partition, first_run_id, observed_at, fields_json, completeness_json, listed, content_hash) VALUES ('o1','p-closed','greenhouse','p-closed','greenhouse:examplecorp','scan-1',?, '{}','{}',1,'h1')").run(T0);
  db.prepare("INSERT INTO observation_sightings (run_id, posting_id, observation_id, source, partition, seen_at) VALUES ('scan-1','p-closed','o1','greenhouse','greenhouse:examplecorp',?)").run(T0);
  for (const runId of ['scan-2', 'scan-3']) {
    db.prepare("INSERT INTO runs (run_id, kind, owner, started_at, heartbeat_at, finished_at, status, receipt_json) VALUES (?, 'scan', 'x', ?, ?, ?, 'ok', '{}')").run(runId, T0, T0, T0);
    db.prepare("INSERT INTO run_sources (run_id, source, partition, status, count, errors, truncated, expected, detail) VALUES (?, 'greenhouse', 'greenhouse:examplecorp', 'ok', 10, 0, 0, 1, '')").run(runId);
  }
  await runReview(options(db, harness([one])));
  assert.equal(db.prepare("SELECT availability FROM postings WHERE id = 'p-closed'").get().availability, 'closed_verified');
});

test('[L2] same content hash costs nothing on refresh; a changed JD is re-judged', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  const one = item(db, 'p-hash');
  await runReview(options(db, harness([one])));
  db.prepare("UPDATE reviews SET state='due', stage='fetch', lane='refresh' WHERE posting_id='p-hash'").run();
  const same = harness([one]);
  await runReview(options(db, same, { runId: 'review-2', now: at(7) }));
  assert.equal(same.judges.primary.calls.length, 0);
  db.prepare("UPDATE reviews SET state='due', stage='fetch', lane='refresh' WHERE posting_id='p-hash'").run();
  one.page = page(one.url, `${SNAPSHOTS.eligible}\nNew: the team now also uses Snowflake.\n`);
  const changed = harness([one]);
  await runReview(options(db, changed, { runId: 'review-3', now: at(14) }));
  assert.equal(changed.judges.primary.calls.length, 1);
});

test('[L2] replan after a facts change re-queues only R3-dependent held/not_eligible items; a second replan is a no-op', async () => {
  const { runReview, replan } = await worker();
  const db = freshDb();
  const neg = item(db, 'p-neg', { snapshot: 'undergradOnly' });
  const ok = item(db, 'p-ok');
  const parts = harness([neg, ok], { answers: { 'p-neg': { output: JUDGMENTS.undergradOnly }, 'p-ok': { output: JUDGMENTS.eligible } } });
  await runReview(options(db, parts));
  assert.equal(reviewOf(db, 'p-neg').decision, 'not_eligible');
  const facts2 = [...FACTS, { id: 'extra', statement: 'Took an operations research course', polarity: 'has' }];
  const inputs = () => reviewInputs({ facts: facts2 });
  const first = replan(db, { inputs, now: at(1) });
  assert.equal(first.requeued, 1);
  assert.equal(reviewOf(db, 'p-neg').state, 'due');
  assert.equal(reviewOf(db, 'p-ok').state, 'done', 'eligible delivered leads are not re-judged by a facts change');
  assert.equal(replan(db, { inputs, now: at(1) }).requeued, 0);
});

test('[L1] a posting reappearing after its freshness horizon renews its review', async () => {
  const { ingestBatch } = await load('L1', './src/funnel/ingest.mjs', ['ingestBatch']);
  const db = freshDb();
  const original = record({ sourceId: '9900001', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9900001' });
  ingestBatch(db, { runId: 'scan-1', source: 'greenhouse', partition: 'greenhouse:examplecorp', records: [original], now: T0, policy: SCREENING_POLICY });
  const postingId = db.prepare("SELECT posting_id FROM posting_aliases WHERE alias = 'source:greenhouse:9900001'").get().posting_id;
  db.prepare("UPDATE reviews SET state='done', decision='not_eligible', code='requirement_conflict', updated_at=? WHERE posting_id=?").run(T0, postingId);
  db.prepare('UPDATE postings SET last_seen = ? WHERE id = ?').run(T0, postingId);
  ingestBatch(db, { runId: 'scan-90', source: 'greenhouse', partition: 'greenhouse:examplecorp', records: [{ ...original, description: `${original.description} Reposted for 2027.` }], now: at(90), policy: SCREENING_POLICY });
  assert.equal(reviewOf(db, postingId).state, 'due');
});
