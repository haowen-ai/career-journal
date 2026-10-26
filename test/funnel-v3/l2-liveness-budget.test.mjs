// Lane L2 — central attempt budget, ordering/reserved capacity, numeric service targets, breaches, receipts, exit codes
// (spec sections 7, 9; review-v3 F5, F6, §5.5; plan 7.1 #8, #9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, load, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { FACTS, REVIEW_POLICY, SCREENING_POLICY, SNAPSHOTS, JUDGMENTS, page } from '../../test-utils/funnel-v3-fixtures.mjs';

const worker = () => load('L2', './src/review/worker.mjs', ['runReview']);
const budgetModule = () => load('L2', './src/review/budget.mjs', ['createBudget']);
const receiptModule = () => load('L2', './src/review/receipt.mjs', ['reviewExitCode', 'worstExit', 'readCurrentReceipt', 'writeReceipt']);

const pages = {};
let serial = 0;
function arrive(db, { now, deadline = null, snapshot = 'eligible' } = {}) {
  serial += 1;
  const id = `p-${String(serial).padStart(4, '0')}`;
  const url = `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
  insertPosting(db, { id, url, firstSeen: now });
  insertReview(db, { postingId: id, stage: 'fetch', firstSeen: now, nextDue: now, lane: deadline ? 'deadline' : 'new', deadline: deadline ? { kind: 'cutoff', date: deadline } : null });
  pages[url] = page(url, SNAPSHOTS[snapshot]);
  return id;
}

function nightOptions(db, { now, budget, runId, judges, fetcher }) {
  return {
    db, runId, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fetcher ?? fakeFetcher(pages),
    judges: judges ?? { primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) }), escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }) },
    inputs: () => ({ facts: FACTS, policy: REVIEW_POLICY, screeningPolicy: SCREENING_POLICY }),
    hooks: {},
  };
}

// --------------------------------------------------------------- budget

test('[L2] the budget reserves every attempt before dispatch and refuses beyond the cap', async () => {
  const { createBudget } = await budgetModule();
  const db = freshDb();
  insertPosting(db, { id: 'p-b' });
  const budget = createBudget(db, { runId: 'review-1', limit: 2 });
  const first = budget.reserve({ postingId: 'p-b', stage: 'judge', runner: 'fake', model: 'm', tier: 'primary', now: T0 });
  assert.equal(db.prepare('SELECT state FROM attempts WHERE id = ?').get(first.id).state, 'dispatched', 'persisted before the call');
  budget.markFailed(first.id, { error: 'timeout', now: T0 });
  assert.ok(budget.reserve({ postingId: 'p-b', stage: 'judge', runner: 'fake', model: 'm', tier: 'escalation', now: T0 }));
  assert.equal(budget.reserve({ postingId: 'p-b', stage: 'judge', runner: 'fake', model: 'm', tier: 'primary', now: T0 }), null);
  assert.equal(budget.used(), 2, 'failed attempts count');
});

test('[L2] every judge call has exactly one attempt row; escalations count; nothing beyond the cap', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  const ids = [arrive(db, { now: T0, snapshot: 'undergradOnly' }), arrive(db, { now: T0 }), arrive(db, { now: T0 })];
  const primary = fakeJudge({ tier: 'primary', answers: (request) => ({ output: request.postingId === ids[0] ? JUDGMENTS.undergradOnly : JUDGMENTS.eligible }) });
  const escalation = fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.undergradOnly }) });
  const receipt = await runReview(nightOptions(db, { now: T0, budget: 3, runId: 'review-1', judges: { primary, escalation } }));
  const attempts = db.prepare('SELECT COUNT(*) n FROM attempts').get().n;
  assert.equal(attempts, primary.calls.length + escalation.calls.length);
  assert.ok(attempts <= 3);
  assert.equal(escalation.calls.length, 1, 'the cheap-model rejection was escalated');
  assert.equal(receipt.counts.escalations, 1);
  assert.equal(receipt.counts.attempts, attempts);
});

test('[L2] budget exhausted mid-run leaves remaining items due with no partial rows', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  for (let i = 0; i < 5; i += 1) arrive(db, { now: T0 });
  await runReview(nightOptions(db, { now: T0, budget: 2, runId: 'review-1' }));
  const states = db.prepare('SELECT state, COUNT(*) n FROM reviews GROUP BY state').all();
  assert.deepEqual(Object.fromEntries(states.map((row) => [row.state, row.n])), { done: 2, due: 3 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM attempts WHERE state = 'dispatched'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM applications').get().n, 2);
});

test('[L2] a failed judge call is not retried automatically; it is retried on a later run and counted again', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  const id = arrive(db, { now: T0 });
  let calls = 0;
  const flaky = fakeJudge({ tier: 'primary', answers: () => { calls += 1; return calls === 1 ? { status: 'error', error: 'rate limited' } : { output: JUDGMENTS.eligible }; } });
  await runReview(nightOptions(db, { now: T0, budget: 1, runId: 'review-1', judges: { primary: flaky, escalation: fakeJudge({ tier: 'escalation' }) } }));
  assert.equal(flaky.calls.length, 1);
  assert.equal(reviewOf(db, id).state, 'due');
  await runReview(nightOptions(db, { now: at(1), budget: 1, runId: 'review-2', judges: { primary: flaky, escalation: fakeJudge({ tier: 'escalation' }) } }));
  assert.equal(reviewOf(db, id).decision, 'eligible');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attempts').get().n, 2);
});

// ----------------------------------------------------- liveness/fairness

test('[L2] a finite backlog drains with progress every night, including zero-discovery nights', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  for (let i = 0; i < 12; i += 1) arrive(db, { now: T0 });
  let previous = 0;
  for (let night = 0; night < 3; night += 1) {
    await runReview(nightOptions(db, { now: at(night), budget: 5, runId: `review-${night}` }));
    const done = db.prepare("SELECT COUNT(*) n FROM reviews WHERE state = 'done'").get().n;
    assert.ok(done > previous, `night ${night} made progress`);
    previous = done;
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state IN ('due','leased')").get().n, 0);
});

test('[L2] sustained overload: deadline items first, aged capacity reserved, every late item is a reported breach', async () => {
  const { runReview } = await worker();
  const { reviewExitCode } = await receiptModule();
  const db = freshDb();
  const budget = 4;
  for (let night = 0; night < 10; night += 1) {
    const now = at(night);
    const deadlineId = arrive(db, { now, deadline: at(night + 5).slice(0, 10) });
    for (let i = 0; i < 5; i += 1) arrive(db, { now });
    const receipt = await runReview(nightOptions(db, { now, budget, runId: `review-${night}` }));
    assert.equal(reviewOf(db, deadlineId).state, 'done', `night ${night}: deadline ≤ 7 days handled the night it arrived`);
    const late = db.prepare("SELECT posting_id FROM reviews WHERE state IN ('due','leased') AND hold_owner IS NULL AND first_seen <= ?").all(at(night - REVIEW_POLICY.serviceTargets.maxWaitNights)).map((row) => row.posting_id);
    const breached = new Set(receipt.breaches.map((item) => item.postingId));
    for (const id of late) assert.ok(breached.has(id), `night ${night}: ${id} is late and must be reported`);
    if (late.length) {
      assert.equal(receipt.status, 'partial');
      assert.equal(reviewExitCode(receipt), 2);
      assert.ok(receipt.backlog.recommendation, 'a breach comes with a budget recommendation');
    }
    if (night >= 3) {
      const processedToday = db.prepare("SELECT first_seen FROM reviews WHERE state = 'done' AND updated_at = ?").all(now);
      const aged = processedToday.filter((row) => row.first_seen <= at(night - REVIEW_POLICY.serviceTargets.agedAfterDays)).length;
      assert.ok(aged >= Math.floor(budget * REVIEW_POLICY.serviceTargets.agedReserveShare), `night ${night}: aged items got reserved capacity`);
    }
  }
});

test('[L2] repeated fetch failures become a user-owned browser_review hold, reported apart from system breaches', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  const id = arrive(db, { now: T0 });
  const failing = fakeFetcher({});
  let receipt;
  for (let night = 0; night < 3; night += 1) receipt = await runReview(nightOptions(db, { now: at(night), budget: 5, runId: `review-${night}`, fetcher: failing }));
  const review = reviewOf(db, id);
  assert.deepEqual([review.state, review.code, review.hold_owner], ['held', 'browser_review', 'user']);
  assert.ok(receipt.awaiting_user.some((item) => item.postingId === id));
  assert.ok(!receipt.breaches.some((item) => item.postingId === id));
});

// --------------------------------------------------- receipts and exits

test('[L2] exit-code mapping: scan/review statuses and the wrapper worst-of rule', async () => {
  const { reviewExitCode, worstExit } = await receiptModule();
  assert.equal(reviewExitCode({ status: 'ok' }), 0);
  assert.equal(reviewExitCode({ status: 'partial' }), 2);
  assert.equal(reviewExitCode({ status: 'failed' }), 1);
  assert.equal(reviewExitCode({ status: 'busy' }), 75);
  assert.equal(worstExit([0, 2, 0]), 2);
  assert.equal(worstExit([2, 75]), 75);
  assert.equal(worstExit([75, 1, 2]), 1);
  assert.equal(worstExit([0, 0]), 0);
});

test('[L2] the consumer reads the current run receipt, never yesterday\'s', async () => {
  const { readCurrentReceipt, writeReceipt } = await receiptModule();
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-receipt-'));
  try {
    await mkdir(path.join(home, '.career-journal', 'runs'), { recursive: true });
    assert.equal((await readCurrentReceipt(home, { date: '2026-11-02' })).state, 'missing');
    await writeReceipt(home, { schema: 1, run_id: 'daily-1101', run_date: '2026-11-01', kind: 'daily', status: 'ok', finished: '2026-11-01T22:00:00Z' });
    assert.equal((await readCurrentReceipt(home, { date: '2026-11-02' })).state, 'stale');
    await writeReceipt(home, { schema: 1, run_id: 'daily-1102', run_date: '2026-11-02', kind: 'daily', status: 'running', finished: null });
    assert.equal((await readCurrentReceipt(home, { date: '2026-11-02' })).state, 'running');
    await writeReceipt(home, { schema: 1, run_id: 'daily-1102', run_date: '2026-11-02', kind: 'daily', status: 'partial', finished: '2026-11-02T22:10:00Z' });
    const current = await readCurrentReceipt(home, { date: '2026-11-02' });
    assert.deepEqual([current.state, current.receipt.status], ['finished', 'partial']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('[L2] review run through the CLI exits 75 while another run holds the lease', async () => {
  const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
  const { runCli } = await import('../../src/cli/main.mjs');
  const { memoryIO } = await import('../../test-utils/helpers.mjs');
  const runtime = createRuntime({ root: process.cwd(), version: 'test' });
  if (!runtime.commands.has('review')) throw new Error('NOT IMPLEMENTED [L2]: `review` command is not registered in create-runtime.mjs');
  const { acquireRunLease } = await load('L2', './src/review/lease.mjs', ['acquireRunLease']);
  const { openHomeDatabase } = await import('../../src/runtime/home.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-cli-busy-'));
  try {
    const { setup } = await import('../../src/commands/setup.mjs');
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const context = await openHomeDatabase(home);
    acquireRunLease(context.db, { kind: 'review', owner: 'other', runId: 'review-x', now: new Date().toISOString() });
    context.db.close();
    assert.equal(await runCli(['review', 'run', '--home', home, '--budget', '1', '--json'], memoryIO(), runtime), 75);
  } finally { await rm(home, { recursive: true, force: true }); }
});
