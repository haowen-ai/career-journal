// Fetch failures that go to the browser on the first failure come from review policy fetcher.browserAtOnce.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0 } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, JUDGMENTS, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runReview, BROWSER_AT_ONCE, inputState } from '../../src/review/worker.mjs';
import { dependencyComparison } from '../../src/review/dependency-compat.mjs';
import { dependencyHash } from '../../src/review/inputs.mjs';
import { buildJudgeRequest } from '../../src/review/prompt.mjs';
import { browserAtOnce, DEFAULT_BROWSER_AT_ONCE } from '../../src/review/gates.mjs';

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
const judges = () => ({ primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) }),
  escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }) });
const withList = (list) => ({ ...REVIEW_POLICY, fetcher: { ...(REVIEW_POLICY.fetcher ?? {}), browserAtOnce: list } });
const LIVE_LIST = ['http_403', 'challenge', 'wrong_posting', 'too_short', 'missing_posting_content', 'detail_absent'];

function add(db, pages, id, result, { attempts } = {}) {
  insertPosting(db, { id, url: urlOf(id), company: 'Example Corp', title: 'Data Science Intern' });
  insertReview(db, { postingId: id, stage: 'fetch', lane: 'new' });
  if (attempts) db.prepare('UPDATE reviews SET attempts=? WHERE posting_id=?').run(attempts, id);
  pages[urlOf(id)] = result;
}
const run = (db, pages, { policy = REVIEW_POLICY, inputs } = {}) => runReview({ db, runId: 'review-bao', owner: 'worker-a',
  now: T0, budget: 50, deadlineMs: 600_000, attemptDir: null, sleep: async () => {}, fetcher: fakeFetcher(pages), judges: judges(),
  inputs: inputs ?? (() => reviewInputs({ policy })), hooks: {} });
const question = (row) => JSON.parse(row.evidence_json || '{}').question ?? '';

test('browserAtOnce: absent means the four default kinds; a valid list is used; BROWSER_AT_ONCE keeps its value', () => {
  assert.deepEqual([...DEFAULT_BROWSER_AT_ONCE], ['http_403', 'challenge', 'wrong_posting', 'too_short']);
  assert.deepEqual([...BROWSER_AT_ONCE], [...DEFAULT_BROWSER_AT_ONCE]);
  assert.deepEqual([...browserAtOnce({})], [...DEFAULT_BROWSER_AT_ONCE]);
  assert.deepEqual([...browserAtOnce({ fetcher: {} })], [...DEFAULT_BROWSER_AT_ONCE]);
  assert.deepEqual([...browserAtOnce(undefined)], [...DEFAULT_BROWSER_AT_ONCE]);
  assert.deepEqual([...browserAtOnce(withList(LIVE_LIST))], LIVE_LIST);
  assert.deepEqual([...browserAtOnce(withList([]))], [], 'an empty list is valid: nothing goes to the browser at once');
});

test('browserAtOnce: a value that is not a list of non-empty strings is rejected', () => {
  // null counts as absent, like the other review policy lists (escalationRouting).
  for (const bad of ['http_403', { a: 1 }, 7, [''], ['  '], ['http_403', 3], [null]])
    assert.throws(() => browserAtOnce(withList(bad)), /fetcher\.browserAtOnce/, JSON.stringify(bad));
});

test('default config: missing_posting_content on the first failure keeps retrying', async () => {
  const db = freshDb(); const pages = {};
  add(db, pages, 'p-mpc', { ok: false, error: 'missing_posting_content' });
  await run(db, pages);
  const row = reviewOf(db, 'p-mpc');
  assert.deepEqual([row.state, row.stage, row.attempts, row.last_error], ['due', 'fetch', 1, 'missing_posting_content']);
  assert.ok(Date.parse(row.next_due) > Date.parse(T0), 'a retry is scheduled');
});

for (const kind of ['missing_posting_content', 'detail_absent']) {
  test(`configured list with ${kind}: the first failure becomes held browser_review with the official URL`, async () => {
    const db = freshDb(); const pages = {};
    const id = `p-${kind}`;
    add(db, pages, id, { ok: false, error: kind });
    await run(db, pages, { policy: withList(LIVE_LIST) });
    const row = reviewOf(db, id);
    assert.deepEqual([row.state, row.code, row.attempts, row.last_error], ['held', 'browser_review', 1, kind]);
    assert.ok(question(row).includes(urlOf(id)), `question names the official URL: ${question(row)}`);
  });
}

test('a network failure outside the list retries, and goes to the browser at attempts >= 3 (unchanged)', async () => {
  const db = freshDb(); const pages = {};
  add(db, pages, 'p-tls', { ok: false, error: '[SSL: SSLV3_ALERT_HANDSHAKE_FAILURE] sslv3 alert handshake failure' });
  add(db, pages, 'p-third', { ok: false, error: 'timeout' }, { attempts: 2 });
  await run(db, pages, { policy: withList(LIVE_LIST) });
  assert.deepEqual([reviewOf(db, 'p-tls').state, reviewOf(db, 'p-tls').stage], ['due', 'fetch']);
  const third = reviewOf(db, 'p-third');
  assert.deepEqual([third.state, third.code, third.attempts], ['held', 'browser_review', 3]);
});

test('invalid fetcher.browserAtOnce at run start stops with invalid_config and processes nothing', async () => {
  for (const bad of ['missing_posting_content', ['missing_posting_content', '']]) {
    const db = freshDb(); const pages = {};
    add(db, pages, 'p-x', { ok: false, error: 'missing_posting_content' });
    const fetcher = fakeFetcher(pages);
    const receipt = await runReview({ db, runId: 'review-bad', owner: 'worker-a', now: T0, budget: 50, deadlineMs: 600_000, attemptDir: null,
      sleep: async () => {}, fetcher, judges: judges(), inputs: () => reviewInputs({ policy: withList(bad) }), hooks: {} });
    assert.equal(receipt.stop_reason, 'invalid_config', JSON.stringify(bad));
    assert.ok(receipt.errors.some((e) => /fetcher\.browserAtOnce/.test(e)), receipt.errors.join('; '));
    assert.equal(fetcher.calls.length, 0, 'nothing fetched');
    const row = reviewOf(db, 'p-x');
    assert.deepEqual([row.state, row.attempts], ['due', 0]);
  }
});

test('a list that turns invalid mid-run keeps the last valid list and records a receipt warning', async () => {
  const db = freshDb(); const pages = {};
  add(db, pages, 'p-mid', { ok: false, error: 'missing_posting_content' });
  let calls = 0;
  const inputs = () => { calls += 1; return reviewInputs({ policy: withList(calls > 1 ? 'broken' : LIVE_LIST) }); };
  const receipt = await run(db, pages, { inputs });
  assert.ok(calls > 1, 'inputs were refreshed during the run');
  const row = reviewOf(db, 'p-mid');
  assert.deepEqual([row.state, row.code], ['held', 'browser_review'], 'the last valid list still applies');
  assert.ok(receipt.warnings.some((w) => /fetcher\.browserAtOnce/.test(typeof w === 'string' ? w : JSON.stringify(w))), JSON.stringify(receipt.warnings));
  assert.notEqual(receipt.stop_reason, 'invalid_config');
});

// Phase-driven inputs: the config each refresh sees moves forward when a scripted page is fetched.
function phased(phases) {
  let phase = 0; const order = [];
  const policyAt = () => phases[phase];
  return { order, inputs: () => reviewInputs({ policy: policyAt() }),
    page: (id, result, nextPhase) => async () => { order.push(id); phase = nextPhase; return result; } };
}

test('every refresh updates the cached list: A, then valid B, then invalid -> B is used', async () => {
  const db = freshDb(); const pages = {};
  // A = default list (no missing_posting_content), B = the live list, then a corrupt value.
  const flow = phased([REVIEW_POLICY, withList(LIVE_LIST), withList(['missing_posting_content', ''])]);
  // p-first is on its third attempt: it goes to the browser by attempts and never consults the list.
  add(db, pages, 'p-first', null, { attempts: 2 });
  add(db, pages, 'p-second', null);
  db.prepare("UPDATE reviews SET next_due='2020-01-01T00:00:00.000Z' WHERE posting_id='p-first'").run();
  pages[urlOf('p-first')] = flow.page('p-first', { ok: false, error: 'timeout' }, 1);
  pages[urlOf('p-second')] = flow.page('p-second', { ok: false, error: 'missing_posting_content' }, 2);
  const receipt = await run(db, pages, { inputs: flow.inputs });
  assert.deepEqual(flow.order, ['p-first', 'p-second'], 'fetch order this test relies on');
  assert.deepEqual([reviewOf(db, 'p-first').state, reviewOf(db, 'p-first').code], ['held', 'browser_review']);
  const second = reviewOf(db, 'p-second');
  assert.deepEqual([second.state, second.code, second.attempts], ['held', 'browser_review', 1], 'the last valid list B applies');
  assert.ok(receipt.warnings.some((w) => /fetcher\.browserAtOnce/.test(String(w)) && /missing_posting_content/.test(String(w))), JSON.stringify(receipt.warnings));
});

test('a list that turns invalid is warned about even when the failure goes to the browser by attempts', async () => {
  const db = freshDb(); const pages = {};
  const flow = phased([withList(LIVE_LIST), withList('broken')]);
  add(db, pages, 'p-third', null, { attempts: 2 });
  pages[urlOf('p-third')] = flow.page('p-third', { ok: false, error: 'timeout' }, 1);
  const receipt = await run(db, pages, { inputs: flow.inputs });
  const row = reviewOf(db, 'p-third');
  assert.deepEqual([row.state, row.code, row.attempts], ['held', 'browser_review', 3]);
  assert.ok(receipt.warnings.some((w) => /fetcher\.browserAtOnce/.test(String(w))), JSON.stringify(receipt.warnings));
  assert.notEqual(receipt.stop_reason, 'invalid_config');
});

// Before P1, judgment and input policy hashes covered the whole review policy. fetcher.browserAtOnce did not exist
// then, so adding it must not cost those legacy hashes their mapping (that would requeue settled rejections).
const legacyHashes = (inputs, policy) => ({
  input: dependencyHash({ policy, jobType: null }),
  judgment: dependencyHash({ policy, screeningPolicy: inputs.screeningPolicy, provenance: inputs.provenance, jobType: null }),
});

test('a legacy full-policy hash recognised without the key is still recognised with it', () => {
  const db = freshDb();
  const without = reviewInputs();
  const legacy = legacyHashes(without, without.policy);
  const before = dependencyComparison(db, without);
  assert.ok(before.policyAlias(legacy.judgment), 'recognised without the key');
  const withKey = reviewInputs({ policy: withList(LIVE_LIST) });
  const after = dependencyComparison(db, withKey);
  assert.equal(after.policyAlias(legacy.judgment), before.policyAlias(legacy.judgment), 'same alias with the key');
  const state = inputState(withKey).policy;
  assert.equal(after.inputPolicyMatches(legacy.input, state), true, 'legacy input policy still matches');
});

test('a run with the key present requeues no settled legacy hold because of it', async () => {
  const db = freshDb();
  const without = reviewInputs();
  const j = judges();
  const runtime = {};
  for (const tier of ['primary', 'escalation'])
    runtime[tier] = (await buildJudgeRequest({ posting: {}, snapshot: { text: '' }, sections: [], inputs: without, adapter: j[tier], tier })).deps.parts;
  const legacy = legacyHashes(without, without.policy);
  insertPosting(db, { id: 'p-legacy', url: urlOf('p-legacy') });
  // Only open states (due/held/leased/failed) are replanned; a held question is the settled kind at risk.
  insertReview(db, { postingId: 'p-legacy', stage: 'deliver', state: 'held', decision: 'unclear', code: 'term_or_area', holdOwner: 'user' });
  const { formatVersion, ...oldInputs } = inputState(without);
  const stored = { inputs: { ...oldInputs, policy: legacy.input },
    runtime: { primary: { ...runtime.primary, policy: legacy.judgment } } };
  db.prepare('UPDATE reviews SET dep_hashes_json=? WHERE posting_id=?').run(JSON.stringify(stored), 'p-legacy');
  const receipt = await run(db, {}, { policy: withList(LIVE_LIST) });
  const row = reviewOf(db, 'p-legacy');
  assert.deepEqual([row.state, row.decision, row.code], ['held', 'unclear', 'term_or_area'], JSON.stringify(receipt.errors));
  assert.equal(JSON.parse(row.dep_hashes_json).invalidated ?? false, false);
});

for (const [shape, fetcher] of [['null', null], ['{}', {}], ['absent', undefined], ['with other keys', { timeoutMs: 45000 }]]) {
  test(`a legacy policy with fetcher ${shape} is recognised before and after adding only browserAtOnce`, () => {
    const db = freshDb();
    const legacyPolicy = { ...REVIEW_POLICY }; delete legacyPolicy.fetcher;
    if (shape !== 'absent') legacyPolicy.fetcher = fetcher;
    const without = reviewInputs({ policy: legacyPolicy });
    const legacy = legacyHashes(without, legacyPolicy);
    const before = dependencyComparison(db, without);
    assert.ok(before.policyAlias(legacy.judgment), 'recognised without the key');
    const withKey = reviewInputs({ policy: { ...legacyPolicy, fetcher: { ...(fetcher ?? {}), browserAtOnce: LIVE_LIST } } });
    const after = dependencyComparison(db, withKey);
    assert.equal(after.policyAlias(legacy.judgment), before.policyAlias(legacy.judgment), 'same alias with the key');
    assert.equal(after.inputPolicyMatches(legacy.input, inputState(withKey).policy), true, 'legacy input policy still matches');
  });
}
