// Adaptive judge concurrency (AIMD): budgets.concurrency is the ceiling, the run starts lower, a rate-limited
// answer (HTTP 429, or 529 overloaded) halves the effective concurrency at most once per cool interval and puts
// the posting back after a backoff (retry-after when given) without counting toward the adapter-failure breaker.
// Steady successes raise it by one. Endless rate limiting at concurrency 1 stops the run as 'rate_limited'.
// Synthetic data only; every adapter is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APIError } from '@anthropic-ai/sdk';
import { freshDb, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, fakeClock, T0 } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runReview } from '../../src/review/worker.mjs';
import { claudeApiAdapter } from '../../src/review/claude-judge.mjs';
import { buildJudgeRequest } from '../../src/review/prompt.mjs';
import { createRateControl, rateControlSettings, rateLimitBackoffMs, isRateLimited, RATE_LIMIT_DEFAULTS, RATE_LIMIT_STALL_MS } from '../../src/review/rate-control.mjs';

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
const LIMITED = Object.freeze({ status: 'error', errorCode: 'rate_limited', error: 'Claude API HTTP 429 rate_limit_error' });
const run = (db, { pages, judges, budgets = {}, concurrency = 1, clock, sleep = async () => {}, deadlineMs = 3_600_000, runId = 'review-aimd' }) => runReview({
  db, runId, owner: 'worker-a', now: T0, budget: Infinity, concurrency, deadlineMs, attemptDir: null, sleep, ...(clock ? { clock } : {}),
  fetcher: fakeFetcher(pages), judges, inputs: () => reviewInputs({ policy: { ...REVIEW_POLICY, budgets: { ...REVIEW_POLICY.budgets, ...budgets } } }), hooks: {} });

// ------------------------------------------------------------------ settings

test('[aimd] settings: defaults for configs without the new fields; each new field is validated', () => {
  assert.deepEqual(RATE_LIMIT_DEFAULTS, { concurrencyStart: 10, rateLimitCoolSeconds: 30, rateLimitIncreaseAfter: 20 });
  assert.deepEqual(rateControlSettings(undefined), { start: 10, coolMs: 30_000, increaseAfter: 20 });
  assert.deepEqual(rateControlSettings({ concurrency: 100, quotaCooldownHours: 6 }), { start: 10, coolMs: 30_000, increaseAfter: 20 });
  assert.deepEqual(rateControlSettings({ concurrencyStart: 4, rateLimitCoolSeconds: 0, rateLimitIncreaseAfter: 5 }), { start: 4, coolMs: 0, increaseAfter: 5 });
  for (const bad of [{ concurrencyStart: 0 }, { concurrencyStart: 2.5 }, { concurrencyStart: '4' }, { rateLimitCoolSeconds: -1 }, { rateLimitCoolSeconds: 'x' },
    { rateLimitCoolSeconds: Infinity }, { rateLimitIncreaseAfter: 0 }, { rateLimitIncreaseAfter: 1.5 }]) {
    assert.throws(() => rateControlSettings(bad), /budgets\.(concurrencyStart|rateLimitCoolSeconds|rateLimitIncreaseAfter)/, JSON.stringify(bad));
  }
});

test('[aimd] a rate-limited result is HTTP 429 or 529 overloaded, by error code; other failures are not', () => {
  assert.equal(isRateLimited({ status: 'error', errorCode: 'rate_limited' }), true);
  assert.equal(isRateLimited({ status: 'error', errorCode: 'overloaded' }), true);
  for (const result of [{ status: 'ok' }, { status: 'quota' }, { status: 'error', errorCode: 'auth' }, { status: 'error', errorCode: 'unavailable' }, null]) {
    assert.equal(isRateLimited(result), false, JSON.stringify(result));
  }
});

test('[aimd] backoff honors retry-after, otherwise grows from 2s to a 60s ceiling', () => {
  assert.equal(rateLimitBackoffMs({ retryAfterMs: 7000, streak: 1 }), 7000);
  assert.equal(rateLimitBackoffMs({ retryAfterMs: 0, streak: 3 }), 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((streak) => rateLimitBackoffMs({ streak })), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(rateLimitBackoffMs({ retryAfterMs: 10 * RATE_LIMIT_STALL_MS, streak: 1 }), RATE_LIMIT_STALL_MS, 'a huge retry-after is capped at the stall window');
});

// ------------------------------------------------------------------ controller

test('[aimd] controller: starts at min(max, start); halves once per cool interval down to 1; +1 after N successes up to max', () => {
  let now = 0;
  const rate = createRateControl({ max: 100, start: 10, coolMs: 30_000, increaseAfter: 3, clock: () => now });
  assert.equal(rate.effective, 10);
  assert.equal(createRateControl({ max: 4, start: 10, coolMs: 0, increaseAfter: 3, clock: () => now }).effective, 4);
  rate.rateLimited();
  assert.equal(rate.effective, 5);
  rate.rateLimited(); now += 29_999; rate.rateLimited();
  assert.equal(rate.effective, 5, 'no second cut inside the cool interval');
  now += 1; rate.rateLimited();
  assert.equal(rate.effective, 2);
  for (let i = 0; i < 3; i += 1) { now += 30_000; rate.rateLimited(); }
  assert.equal(rate.effective, 1, 'never below 1');
  for (let i = 0; i < 2; i += 1) rate.success();
  assert.equal(rate.effective, 1);
  rate.success();
  assert.equal(rate.effective, 2);
  rate.rateLimited(); // a rate limit also restarts the success count
  for (let i = 0; i < 3 * 200; i += 1) rate.success();
  assert.equal(rate.effective, 100, 'capped at max');
  assert.deepEqual(rate.stats(), { max: 100, start: 10, peak: 100, final: 100, rate_limit_backoffs: 8, cuts: 4 });
});

test('[aimd] controller: rate limits at concurrency 1 for the stall window report stalled; a success clears it', () => {
  let now = 0;
  const rate = createRateControl({ max: 2, start: 1, coolMs: 30_000, increaseAfter: 20, clock: () => now });
  assert.equal(rate.rateLimited().stalled, false);
  now += RATE_LIMIT_STALL_MS - 1;
  assert.equal(rate.rateLimited().stalled, false);
  rate.success();
  now += 1;
  assert.equal(rate.rateLimited().stalled, false, 'the window restarts after a success');
  now += RATE_LIMIT_STALL_MS;
  assert.equal(rate.rateLimited().stalled, true);
});

test('[aimd] controller: acquire never lets more than the effective concurrency run; an increase admits a waiter', async () => {
  const rate = createRateControl({ max: 3, start: 1, coolMs: 0, increaseAfter: 1, clock: () => 0 });
  await rate.acquire();
  let second = false;
  const waiting = rate.acquire().then(() => { second = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second, false);
  rate.success(); // effective 1 -> 2
  await waiting;
  assert.equal(second, true);
  assert.equal(rate.inFlight, 2);
  rate.release(); rate.release();
  assert.equal(rate.inFlight, 0);
});

// ------------------------------------------------------------------ Claude adapter

const apiError = (status, type, headers = {}) => APIError.generate(status, { type: 'error', error: { type, message: 'synthetic body' } }, undefined, new Headers(headers));
function failingClient(error) { return { messages: { async create() { throw error; } } }; }
async function claudeResult(error) {
  const judge = claudeApiAdapter({ runner: 'claude', model: 'claude-sonnet-5-5', effort: 'low', tier: 'primary', client: failingClient(error) });
  const inputs = await reviewInputs();
  const request = await buildJudgeRequest({ posting: { id: 'p-1', company: 'Example Corp', title: 'Data Science Intern' }, snapshot: { text: SNAPSHOTS.eligible }, sections: [], inputs, adapter: judge, tier: 'primary' });
  return judge.judge(request, { attemptId: 'a-1' });
}

test('[aimd] the Claude adapter reports 429 and 529 as rate limits and passes retry-after on', async () => {
  const limited = await claudeResult(apiError(429, 'rate_limit_error', { 'retry-after': '3' }));
  assert.deepEqual([limited.status, limited.errorCode, limited.retryAfterMs], ['error', 'rate_limited', 3000]);
  const precise = await claudeResult(apiError(429, 'rate_limit_error', { 'retry-after-ms': '1500', 'retry-after': '9' }));
  assert.equal(precise.retryAfterMs, 1500);
  const overloaded = await claudeResult(apiError(529, 'overloaded_error'));
  assert.deepEqual([overloaded.errorCode, overloaded.retryAfterMs], ['overloaded', null]);
  assert.equal(isRateLimited(overloaded), true);
  const down = await claudeResult(apiError(503, 'api_error', { 'retry-after': '3' }));
  assert.equal(down.errorCode, 'unavailable');
  assert.equal(isRateLimited(down), false);
});

// ------------------------------------------------------------------ worker

test('[aimd] rate limits slow the run instead of stopping it: no adapter_failure, every posting judged, retry-after honored', async () => {
  const db = freshDb();
  const pages = postings(db, ids(5));
  let call = 0;
  const primary = fakeJudge({ tier: 'primary', answers: () => (++call <= 4 ? { ...LIMITED, retryAfterMs: 1234 } : { output: JUDGMENTS.eligible }) });
  const escalation = fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) });
  const slept = [];
  const receipt = await run(db, { pages, judges: { primary, escalation }, concurrency: 8, budgets: { concurrencyStart: 4 }, sleep: async (ms) => { slept.push(ms); } });
  assert.notEqual(receipt.stop_reason, 'adapter_failure');
  assert.notEqual(receipt.stop_reason, 'rate_limited');
  for (const id of ids(5)) assert.notEqual(reviewOf(db, id).state, 'due', `${id} was judged after its backoff`);
  assert.equal(primary.calls.length, 9, 'four rate-limited calls retried, five answered');
  assert.deepEqual(slept, [1234, 1234, 1234, 1234]);
  assert.deepEqual(receipt.errors, [], 'a rate limit is not a run error');
  assert.equal(receipt.concurrency.rate_limit_backoffs, 4);
  assert.equal(receipt.concurrency.max, 8);
  assert.equal(receipt.concurrency.start, 4);
  assert.ok(receipt.concurrency.final < 4, `effective concurrency was cut: ${JSON.stringify(receipt.concurrency)}`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM attempts WHERE state='failed' AND error LIKE '%429%'").get().n, 4, 'each rate-limited attempt is recorded');
});

test('[aimd] in-flight judge calls never exceed the effective concurrency; successes raise it to the maximum', async () => {
  const db = freshDb();
  const pages = postings(db, ids(12));
  let inFlight = 0; let peak = 0;
  const primary = fakeJudge({ tier: 'primary', onCall: async () => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
  }, answers: () => ({ output: JUDGMENTS.eligible }) });
  const escalation = fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) });
  const receipt = await run(db, { pages, judges: { primary, escalation }, concurrency: 3, budgets: { concurrencyStart: 1, rateLimitIncreaseAfter: 2 } });
  assert.ok(peak <= 3, `peak in flight ${peak}`);
  assert.equal(receipt.concurrency.start, 1);
  assert.equal(receipt.concurrency.peak, 3);
  assert.equal(receipt.concurrency.final, 3);
  assert.equal(receipt.concurrency.rate_limit_backoffs, 0);
});

test('[aimd] rate limits do not reset or feed the identical-failure breaker; real failures still stop the run', async () => {
  const db = freshDb();
  const pages = postings(db, ids(5));
  const failure = { status: 'error', errorCode: 'auth', error: 'Claude API HTTP 401 authentication_error' };
  const script = [failure, LIMITED, failure, LIMITED, LIMITED, failure];
  let call = 0;
  const primary = fakeJudge({ tier: 'primary', answers: () => script[call++] ?? { output: JUDGMENTS.eligible } });
  const escalation = fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) });
  const receipt = await run(db, { pages, judges: { primary, escalation } });
  assert.equal(primary.calls.length, 6);
  assert.deepEqual([receipt.status, receipt.stop_reason], ['partial', 'adapter_failure']);
  assert.equal(receipt.concurrency.rate_limit_backoffs, 3);
});

test('[aimd] endless rate limiting at concurrency 1 for the stall window stops the run partial as rate_limited; postings stay due', async () => {
  const db = freshDb();
  const pages = postings(db, ids(3));
  const time = fakeClock();
  const primary = fakeJudge({ tier: 'primary', answers: () => ({ ...LIMITED, retryAfterMs: 30_000 }) });
  const escalation = fakeJudge({ tier: 'escalation', answers: () => assert.fail('no escalation while the primary is rate-limited') });
  const receipt = await run(db, { pages, judges: { primary, escalation }, concurrency: 4, budgets: { concurrencyStart: 2, rateLimitCoolSeconds: 0 }, clock: time.clock, sleep: time.sleep, deadlineMs: 4 * 3_600_000 });
  assert.deepEqual([receipt.status, receipt.stop_reason], ['partial', 'rate_limited']);
  assert.ok(receipt.errors.some((error) => /rate.limit/i.test(error) && /429/.test(error)), JSON.stringify(receipt.errors));
  assert.equal(receipt.concurrency.final, 1);
  const elapsed = time.clock() - Date.parse(T0);
  assert.ok(elapsed >= RATE_LIMIT_STALL_MS && elapsed < RATE_LIMIT_STALL_MS + 5 * 60_000, `stopped after ~10 minutes, not at the deadline: ${elapsed}ms`);
  for (const id of ids(3)) assert.equal(reviewOf(db, id).state, 'due', id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state='leased'").get().n, 0);
});

test('[aimd] quota (billing or usage exhausted) keeps the existing cooldown, not the rate-limit path', async () => {
  const db = freshDb();
  const pages = postings(db, ids(3));
  const primary = fakeJudge({ tier: 'primary', answers: () => ({ status: 'quota', error: 'usage limit reached' }) });
  const escalation = fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) });
  const receipt = await run(db, { pages, judges: { primary, escalation } });
  assert.equal(receipt.stop_reason, 'quota');
  assert.equal(receipt.concurrency.rate_limit_backoffs, 0);
  assert.equal(db.prepare("SELECT reason FROM cooldowns WHERE key='judge:primary'").get().reason, 'quota');
});

test('[aimd] an invalid rate-limit setting stops the run before any dispatch', async () => {
  const db = freshDb();
  const pages = postings(db, ids(2));
  const primary = fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) });
  const escalation = fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) });
  const receipt = await run(db, { pages, judges: { primary, escalation }, budgets: { rateLimitIncreaseAfter: 0 } });
  assert.deepEqual([receipt.status, receipt.stop_reason], ['partial', 'invalid_config']);
  assert.ok(receipt.errors.some((error) => /budgets\.rateLimitIncreaseAfter/.test(error)));
  assert.equal(primary.calls.length, 0);
});
