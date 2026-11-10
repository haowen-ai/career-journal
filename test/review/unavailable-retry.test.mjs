// Transient network failures of the judge API (claude-judge errorCode 'unavailable': network, timeout, other 5xx) are
// retried on the same posting after a backoff, never feed the identical-failure breaker, and stop the run only when the
// per-posting retry budget or the run's stall budget is spent (stop_reason network_unavailable). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, fakeClock, T0 } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, judgment, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runReview } from '../../src/review/worker.mjs';
import { unavailableSettings, isUnavailable, UNAVAILABLE_DEFAULTS } from '../../src/review/rate-control.mjs';
import { nightlySummary } from '../../src/review/summary.mjs';

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
function postings(db, ids) {
  const pages = {};
  for (const id of ids) {
    insertPosting(db, { id, url: urlOf(id), title: snapshotTitle(SNAPSHOTS.eligible) });
    insertReview(db, { postingId: id, stage: 'fetch' });
    pages[urlOf(id)] = page(urlOf(id), SNAPSHOTS.eligible);
  }
  return pages;
}
const ids = (n) => Array.from({ length: n }, (_, i) => `p-${i + 1}`);
const DOWN = Object.freeze({ status: 'error', errorCode: 'unavailable', error: 'Claude API network error' });
const LIMITED = Object.freeze({ status: 'error', errorCode: 'rate_limited', error: 'Claude API HTTP 429 rate_limit_error' });
const run = (db, { pages, judges, budgets = {}, clock, sleep = async () => {}, deadlineMs = 4 * 3_600_000, budget = Infinity }) => runReview({
  db, runId: 'review-net', owner: 'worker-a', now: T0, budget, concurrency: 1, deadlineMs, attemptDir: null, sleep, ...(clock ? { clock } : {}),
  fetcher: fakeFetcher(pages), judges, inputs: () => reviewInputs({ policy: { ...REVIEW_POLICY, budgets: { ...REVIEW_POLICY.budgets, attempts: null, ...budgets } } }), hooks: {} });
const eligible = () => fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) });

test('[net] settings: defaults 5 retries per posting and a 10-minute stall; invalid values are refused', () => {
  assert.deepEqual(UNAVAILABLE_DEFAULTS, { unavailableRetries: 5, unavailableStallMinutes: 10 });
  assert.deepEqual(unavailableSettings(undefined), { retries: 5, stallMs: 600_000 });
  assert.deepEqual(unavailableSettings({ unavailableRetries: 0, unavailableStallMinutes: 1.5 }), { retries: 0, stallMs: 90_000 });
  for (const bad of [{ unavailableRetries: -1 }, { unavailableRetries: 1.5 }, { unavailableStallMinutes: 0 }, { unavailableStallMinutes: 'x' }]) {
    assert.throws(() => unavailableSettings(bad), /budgets\.unavailable/, JSON.stringify(bad));
  }
  assert.equal(isUnavailable(DOWN), true);
  assert.equal(isUnavailable(LIMITED), false);
  assert.equal(isUnavailable({ status: 'quota', errorCode: 'unavailable' }), false);
});

test('[net] a single transient network failure recovers on retry after the backoff', async () => {
  const db = freshDb();
  const pages = postings(db, ids(1));
  const time = fakeClock();
  let call = 0;
  const primary = fakeJudge({ tier: 'primary', answers: () => (call++ === 0 ? DOWN : { output: JUDGMENTS.eligible }) });
  const receipt = await run(db, { pages, judges: { primary, escalation: eligible() }, clock: time.clock, sleep: time.sleep });
  assert.equal(primary.calls.length, 2);
  assert.deepEqual([reviewOf(db, 'p-1').state, reviewOf(db, 'p-1').decision], ['done', 'eligible']);
  assert.equal(receipt.counts.unavailable_retries, 1);
  assert.equal(time.clock() - Date.parse(T0) >= 2000, true, 'waited the 2 s backoff');
  assert.equal(receipt.stop_reason, null);
});

test('[net] three network failures in a row no longer trip the adapter breaker', async () => {
  const db = freshDb();
  const pages = postings(db, ids(3));
  const script = [DOWN, DOWN, DOWN];
  let call = 0;
  const primary = fakeJudge({ tier: 'primary', answers: () => script[call++] ?? { output: JUDGMENTS.eligible } });
  const receipt = await run(db, { pages, judges: { primary, escalation: eligible() } });
  assert.notEqual(receipt.stop_reason, 'adapter_failure');
  assert.equal(receipt.status, 'ok');
  for (const id of ids(3)) assert.equal(reviewOf(db, id).decision, 'eligible', id);
  assert.equal(receipt.counts.unavailable_retries, 3);
  // A posting out of retries stays due for a later run; the breaker still is not fed.
  const db2 = freshDb();
  const pages2 = postings(db2, ids(1));
  const down = fakeJudge({ tier: 'primary', answers: () => DOWN });
  const out = await run(db2, { pages: pages2, judges: { primary: down, escalation: eligible() }, budgets: { unavailableRetries: 2 } });
  assert.equal(down.calls.length, 3);
  assert.equal(reviewOf(db2, 'p-1').state, 'due');
  assert.notEqual(out.stop_reason, 'adapter_failure');
  assert.ok(out.errors.some((error) => /unavailable/.test(error)), JSON.stringify(out.errors));
});

test('[net] judgments unavailable for the stall budget stop the run as network_unavailable; postings stay due', async () => {
  const db = freshDb();
  const pages = postings(db, ids(3));
  const time = fakeClock();
  const primary = fakeJudge({ tier: 'primary', answers: () => DOWN });
  const receipt = await run(db, { pages, judges: { primary, escalation: eligible() }, clock: time.clock, sleep: time.sleep, budgets: { unavailableRetries: 1000 } });
  assert.deepEqual([receipt.status, receipt.stop_reason], ['partial', 'network_unavailable']);
  const elapsed = time.clock() - Date.parse(T0);
  assert.ok(elapsed >= 600_000 && elapsed < 600_000 + 5 * 60_000, `stopped after ~10 minutes: ${elapsed}`);
  for (const id of ids(3)) assert.equal(reviewOf(db, id).state, 'due', id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state='leased'").get().n, 0);
  assert.match(nightlySummary(receipt, { lang: 'zh' }), /network_unavailable（判定接口网络持续不可用/);
});

test('[net] rate limiting keeps its own path: backoffs counted there, not as network retries', async () => {
  const db = freshDb();
  const pages = postings(db, ids(2));
  const script = [LIMITED, LIMITED, LIMITED];
  let call = 0;
  const primary = fakeJudge({ tier: 'primary', answers: () => script[call++] ?? { output: JUDGMENTS.eligible } });
  const receipt = await run(db, { pages, judges: { primary, escalation: eligible() } });
  assert.equal(receipt.concurrency.rate_limit_backoffs, 3);
  assert.equal(receipt.counts.unavailable_retries, 0);
  for (const id of ids(2)) assert.equal(reviewOf(db, id).decision, 'eligible', id);
});

test('[net] a network retry does not use the attempt budget', async () => {
  const db = freshDb();
  const pages = postings(db, ids(1));
  let call = 0;
  const primary = fakeJudge({ tier: 'primary', answers: () => (call++ < 2 ? DOWN : { output: JUDGMENTS.eligible }) });
  const receipt = await run(db, { pages, judges: { primary, escalation: eligible() }, budget: 1 });
  assert.equal(primary.calls.length, 3);
  assert.equal(reviewOf(db, 'p-1').decision, 'eligible');
  assert.notEqual(receipt.stop_reason, 'budget');
  assert.equal(reviewOf(db, 'p-1').paid_attempts, 1, 'only the answered call is a paid attempt');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM attempts WHERE state='failed' AND error LIKE '[unavailable]%'").get().n, 2, 'the failures stay on record');
});

test('[net] a long backoff never sleeps past the stall deadline; the deadline is checked before the next dispatch', async () => {
  const db = freshDb();
  const pages = postings(db, ids(1));
  const time = fakeClock();
  let call = 0;
  const primary = fakeJudge({ tier: 'primary', answers: () => (call++ === 0 ? { ...DOWN, retryAfterMs: 5 * 60_000 } : { output: JUDGMENTS.eligible }) });
  const receipt = await run(db, { pages, judges: { primary, escalation: eligible() }, clock: time.clock, sleep: time.sleep, budgets: { unavailableStallMinutes: 1 } });
  assert.equal(receipt.stop_reason, 'network_unavailable');
  assert.equal(primary.calls.length, 1, 'no success after the deadline resets it');
  assert.equal(time.clock() - Date.parse(T0), 60_000, 'slept only up to the stall deadline');
  assert.equal(receipt.counts.unavailable_retries, 0);
  assert.equal(reviewOf(db, 'p-1').state, 'due');
});

test('[net] one retry allowance per posting is shared by the primary and escalation tiers', async () => {
  const db = freshDb();
  const pages = postings(db, ids(1));
  // A rejection whose code is not final, so the primary escalates.
  const nonFinal = judgment({ criteria: [{ key: 'requirement', status: 'conflicts', quote: "Currently pursuing a Bachelor's or Master's degree in Statistics, Computer Science, or a related field.", clause_alternatives: [], fact_ids: ['degree'] }] });
  let p = 0; let e = 0;
  const primary = fakeJudge({ tier: 'primary', answers: () => (p++ === 0 ? DOWN : { output: nonFinal }) });
  const escalation = fakeJudge({ tier: 'escalation', answers: () => (e++ < 2 ? DOWN : { output: JUDGMENTS.eligible }) });
  const receipt = await run(db, { pages, judges: { primary, escalation }, budgets: { unavailableRetries: 2 } });
  assert.equal(primary.calls.length, 2);
  assert.equal(escalation.calls.length, 2, 'the escalation gets only what the primary left of the allowance');
  assert.equal(reviewOf(db, 'p-1').state, 'due');
  assert.equal(receipt.counts.unavailable_retries, 2);
});

test('[net] a retry is counted only when it is dispatched', async () => {
  const db = freshDb();
  const pages = postings(db, ids(1));
  const time = fakeClock();
  const primary = fakeJudge({ tier: 'primary', answers: () => DOWN });
  const receipt = await run(db, { pages, judges: { primary, escalation: eligible() }, clock: time.clock, sleep: time.sleep, deadlineMs: 1000 });
  assert.equal(primary.calls.length, 1);
  assert.equal(receipt.counts.unavailable_retries, 0, 'the deadline came during the backoff: nothing was retried');
  assert.equal(reviewOf(db, 'p-1').state, 'due');
});
