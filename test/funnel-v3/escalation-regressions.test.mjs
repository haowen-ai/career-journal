// Red tests for the escalation-skip rule (rulings E1, E2' and E3, approved 2026-10-27). Today every primary-tier
// not_eligible or unclear goes to the escalation tier, so nearly every posting pays for two judge calls.
// Rulings:
//   E1  A primary-tier not_eligible whose only blocking reason is code-verified geography (every alternative's
//       offices validated and outside the policy areas with no allowed remote: code outside_area) or an
//       out-of-window term validated the same way (code outside_window) is final at the primary tier. No
//       escalation call and no second-opinion call is made. Every other primary not_eligible still escalates
//       when no second opinion is configured.
//   E2' (supersedes E2) The primary tier is the cheaper Codex model; a second opinion (Jev) verifies every
//       other primary verdict. After a primary eligible or not_eligible, Jev is asked for the probability that
//       the candidate is eligible. They agree when the primary says not_eligible and p < threshold (0.1), or the
//       primary says eligible and p >= eligibleThreshold (0.7): the primary verdict is final, with no escalation.
//       Disagreement, a probability in between, a primary unclear (never asked) or an adapter error all
//       escalate to the stronger model as today. Jev never produces eligible, not_eligible or a hold by itself:
//       a non-final item is decided by the escalation tier. The second opinion is not a paid attempt in the
//       Codex budget.
//   E3  The adapter interface: { id, runner: 'jev', model, async ask({ state, question }) -> { probability, usage } },
//       injected like the judges as runOptions.secondOpinion. Tests never call the network.
// Contract fixed here:
//   policy:  reviewPolicy.judge.secondOpinion = { runner: 'jev', model, threshold: 0.1, eligibleThreshold: 0.7 }
//   inject:  runReview({ ..., secondOpinion: adapter })
//   receipt: receipt.counts.secondOpinion = { asked, agreed, escalated, errors } whenever a second opinion is
//            configured (all zero when it was never asked; absent when not configured). asked counts ask() calls,
//            including ones that threw; agreed counts verdicts made final by agreement; escalated counts asked
//            items that went on to the escalation tier; errors counts ask() calls that threw. Paid attempts
//            (attempts table, receipt.counts.attempts) never include the second opinion.
// Not fixed here (open): a primary eligible when no second opinion is configured (today it is final at primary).
// Synthetic data only: every employer, place, URL and candidate fact is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0 } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, SUMMER_CHICAGO, judgment, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';

const workerModule = () => load('B6', './src/review/worker.mjs', ['runReview']);

const SECOND_OPINION = Object.freeze({ runner: 'jev', model: 'jev-test', threshold: 0.1, eligibleThreshold: 0.7 });
const withSecondOpinion = Object.freeze({ ...REVIEW_POLICY, judge: { secondOpinion: SECOND_OPINION } });

// ------------------------------------------------------------------ postings

const retitled = (snapshot, title) => snapshot.replace(snapshotTitle(snapshot), title);
const NONE = Object.freeze({ scope: 'none', quote: null });

// Every office is in a state outside allowedStates, so decide() itself verifies the area as outside.
const OUTSIDE_AREA_TEXT = retitled(SNAPSHOTS.eligible, 'Data Science Intern Mill Creek').replace('Location: Chicago, IL', 'Location: Mill Creek, TX');
const OUTSIDE_AREA = judgment({ alternatives: [{ term: SUMMER_CHICAGO.term, offices: [{ place: 'Mill Creek, TX', area: 'outside', quote: 'Location: Mill Creek, TX' }], remote: NONE }] });
// A quoted summer 2028 term matches no policy window (both windows are 2027) at an allowed office.
const OUTSIDE_WINDOW_TEXT = retitled(SNAPSHOTS.eligible, 'Data Science Intern Later Cohort').replace('the summer of 2027', 'the summer of 2028');
const OUTSIDE_WINDOW = judgment({ alternatives: [{ ...SUMMER_CHICAGO, term: { label: 'summer', year: 2028, quote: 'Join our analytics team for the summer of 2028' } }] });

// Both tiers answer with the same judgment, so a posting's final outcome is the same whichever tier decides it;
// the tests tell the tiers apart by their call lists and the paid attempts.
const POSTINGS = Object.freeze({
  area: { text: OUTSIDE_AREA_TEXT, output: OUTSIDE_AREA, final: ['done', 'not_eligible', 'outside_area'] },
  window: { text: OUTSIDE_WINDOW_TEXT, output: OUTSIDE_WINDOW, final: ['done', 'not_eligible', 'outside_window'] },
  // A confirmed degree conflict: the primary tier rejects for a reason other than geography or term.
  degree: { text: SNAPSHOTS.undergradOnly, output: JUDGMENTS.undergradOnly, final: ['done', 'not_eligible', 'degree'] },
  // Today the primary tier's eligible is final; under E2' it is verified by the second opinion.
  eligible: { text: SNAPSHOTS.eligible, output: JUDGMENTS.eligible, final: ['done', 'eligible', null] },
  // A required clause citing a fact the candidate lacks: the primary tier is unclear, not not_eligible.
  unclear: { text: SNAPSHOTS.missingFact, output: JUDGMENTS.missingFact, final: ['held', 'unclear', 'missing_fact'] },
});

function queue(db, entries) {
  const pages = {};
  const answers = {};
  for (const [id, kind] of Object.entries(entries)) {
    const { text, output } = POSTINGS[kind];
    const url = `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
    insertPosting(db, { id, url, company: 'Example Corp', title: snapshotTitle(text), firstSeen: T0 });
    insertReview(db, { postingId: id, stage: 'fetch', firstSeen: T0, nextDue: T0 });
    pages[url] = page(url, text);
    answers[id] = { output };
  }
  return { pages, answers };
}

// ------------------------------------------------------------------ harness

// Fake second-opinion adapter (E3 interface). `answer` is a probability or a function of the call.
function fakeSecondOpinion(answer) {
  const calls = [];
  return {
    id: 'fake-jev',
    runner: 'jev',
    model: 'jev-test',
    calls,
    async ask(call) {
      calls.push(call);
      const probability = typeof answer === 'function' ? await answer(call) : answer;
      return { probability, usage: { requests: 1 } };
    },
  };
}
const throwing = () => fakeSecondOpinion(() => { throw new Error('second opinion unavailable'); });

// Any network use during a run fails the test (the real Jev adapter calls an HTTP API; tests never do).
async function offline(run) {
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => { attempts.push(String(url)); throw new Error(`network access in a test: ${url}`); };
  try { return await run(); } finally {
    globalThis.fetch = original;
    assert.deepEqual(attempts, [], 'no network request is made');
  }
}

async function review(db, { pages, answers, policy = REVIEW_POLICY, secondOpinion, budget = 20 }) {
  const { runReview } = await workerModule();
  const judges = {
    primary: fakeJudge({ tier: 'primary', model: 'codex-auto-review', answers }),
    escalation: fakeJudge({ tier: 'escalation', answers }),
  };
  const options = {
    db, runId: 'review-escalation', owner: 'worker-a', now: T0, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fakeFetcher(pages), judges, inputs: () => reviewInputs({ policy }), hooks: {},
    ...(secondOpinion ? { secondOpinion } : {}),
  };
  const receipt = await offline(() => runReview(options));
  const called = (tier) => judges[tier].calls.map((call) => call.request.postingId);
  return { receipt, called };
}

const outcome = (db, id) => { const row = reviewOf(db, id); return [row.state, row.decision, row.code]; };
const paidRows = (db) => db.prepare("SELECT posting_id, runner, tier FROM attempts WHERE run_id = 'review-escalation' ORDER BY posting_id, tier").all().map((row) => ({ ...row }));
const asked = (adapter) => adapter.calls.length;

// ------------------------------------------------------------------ E1

test('[B] a primary-tier not_eligible from code-verified geography (outside_area) or term (outside_window) is final with zero escalation calls; a degree not_eligible with no second opinion configured still escalates (escalation E1)', async () => {
  const db = freshDb();
  const q = queue(db, { 'p-outside-area': 'area', 'p-outside-window': 'window', 'p-degree-guard': 'degree' });
  const { receipt, called } = await review(db, q);

  assert.deepEqual(called('primary').sort(), ['p-degree-guard', 'p-outside-area', 'p-outside-window'], 'every posting is judged once at the primary tier');
  assert.deepEqual(called('escalation'), ['p-degree-guard'],
    `only the degree rejection escalates; code-verified outside_area/outside_window is final at the primary tier: escalated ${JSON.stringify(called('escalation'))}`);
  assert.deepEqual(outcome(db, 'p-outside-area'), POSTINGS.area.final, 'outside_area is delivered as a final not_eligible');
  assert.deepEqual(outcome(db, 'p-outside-window'), POSTINGS.window.final, 'outside_window is delivered as a final not_eligible');
  assert.deepEqual(outcome(db, 'p-degree-guard'), POSTINGS.degree.final, 'the degree rejection is decided at the escalation tier, as today');
  for (const id of ['p-outside-area', 'p-outside-window']) {
    assert.equal(reviewOf(db, id).hold_owner, null, `${id} is not held`);
    assert.equal(reviewOf(db, id).paid_attempts, 1, `${id} paid for one primary call only`);
  }
  assert.equal(receipt.counts.escalations, 1, `one escalation attempt in the receipt: ${JSON.stringify(receipt.counts)}`);
  assert.equal(receipt.counts.attempts, 4, `three primary attempts and one escalation attempt: ${JSON.stringify(receipt.counts)}`);
  assert.equal(receipt.counts.secondOpinion, undefined, 'without a configured second opinion the receipt has no second-opinion counts');
});

// ------------------------------------------------------------------ E2'

test('[B] a second opinion that agrees with a primary not_eligible (p 0.05 < 0.1) makes it final: zero escalation calls, no hold, not a paid attempt; outside_area is never asked (escalation E2)', async () => {
  const db = freshDb();
  // The outside_area posting is final by E1 and is never put to the second opinion.
  const q = queue(db, { 'p-degree-agreed': 'degree', 'p-outside-area': 'area' });
  const jev = fakeSecondOpinion(0.05);
  const { receipt, called } = await review(db, { ...q, policy: withSecondOpinion, secondOpinion: jev });

  assert.deepEqual(called('escalation'), [], `no escalation call is made: escalated ${JSON.stringify(called('escalation'))}`);
  assert.equal(asked(jev), 1, `the second opinion is asked once, for the degree rejection only: ${asked(jev)} calls`);
  const row = reviewOf(db, 'p-degree-agreed');
  assert.deepEqual([row.state, row.decision, row.code, row.hold_owner], ['done', 'not_eligible', 'degree', null],
    'the primary not_eligible is final and delivered, with no hold');
  assert.deepEqual(outcome(db, 'p-outside-area'), POSTINGS.area.final);
  assert.deepEqual(receipt.counts.secondOpinion, { asked: 1, agreed: 1, escalated: 0, errors: 0 }, `receipt second-opinion counts: ${JSON.stringify(receipt.counts)}`);
  assert.equal(receipt.counts.escalations, 0);
  assert.equal(receipt.counts.attempts, 2, 'only the two primary judge calls are paid attempts');
  assert.deepEqual(paidRows(db).map((r) => r.tier), ['primary', 'primary'], 'the second opinion never appears in the paid attempts table');
  assert.equal(row.paid_attempts, 1, 'the degree posting paid for its primary call only');
});

test('[B] a second opinion that agrees with a primary eligible (p 0.9 >= 0.7) makes it final with zero escalation calls (escalation E2)', async () => {
  const db = freshDb();
  const q = queue(db, { 'p-eligible-agreed': 'eligible' });
  const jev = fakeSecondOpinion(0.9);
  const { receipt, called } = await review(db, { ...q, policy: withSecondOpinion, secondOpinion: jev });

  assert.equal(asked(jev), 1, `every primary eligible is verified by the second opinion: ${asked(jev)} calls`);
  assert.deepEqual(called('escalation'), [], 'an agreed eligible does not escalate');
  assert.deepEqual(outcome(db, 'p-eligible-agreed'), POSTINGS.eligible.final, 'the primary eligible is delivered');
  assert.deepEqual(receipt.counts.secondOpinion, { asked: 1, agreed: 1, escalated: 0, errors: 0 }, `receipt second-opinion counts: ${JSON.stringify(receipt.counts)}`);
  assert.equal(receipt.counts.attempts, 1, 'one paid primary attempt');
});

test('[B] a second opinion that disagrees or is in between escalates as today, and never decides the item itself (escalation E2)', async () => {
  for (const [name, kind, probability] of [
    ['primary not_eligible, p 0.4 (in between)', 'degree', 0.4],
    ['primary not_eligible, p 0.9 (disagrees; the second opinion never produces eligible)', 'degree', 0.9],
    ['primary not_eligible, p exactly 0.1 (not below the threshold)', 'degree', 0.1],
    ['primary eligible, p 0.4 (in between)', 'eligible', 0.4],
    ['primary eligible, p 0.05 (disagrees; the second opinion never produces not_eligible)', 'eligible', 0.05],
  ]) {
    const db = freshDb();
    const q = queue(db, { 'p-escalated': kind });
    const jev = fakeSecondOpinion(probability);
    const { receipt, called } = await review(db, { ...q, policy: withSecondOpinion, secondOpinion: jev });

    assert.equal(asked(jev), 1, `${name}: the primary verdict is put to the second opinion first (${asked(jev)} calls)`);
    assert.deepEqual(called('escalation'), ['p-escalated'], `${name}: the item escalates`);
    assert.deepEqual(outcome(db, 'p-escalated'), POSTINGS[kind].final, `${name}: the escalation tier decides`);
    assert.equal(reviewOf(db, 'p-escalated').hold_owner, null, `${name}: no hold is created`);
    assert.deepEqual(receipt.counts.secondOpinion, { asked: 1, agreed: 0, escalated: 1, errors: 0 }, `${name}: receipt second-opinion counts: ${JSON.stringify(receipt.counts)}`);
    assert.equal(receipt.counts.escalations, 1, `${name}: one escalation attempt`);
    assert.equal(receipt.counts.attempts, 2, `${name}: primary and escalation are the only paid attempts`);
  }
});

test('[B] a second-opinion adapter that throws escalates exactly as today and is counted as an error (escalation E2)', async () => {
  for (const kind of ['degree', 'eligible']) {
    const db = freshDb();
    const q = queue(db, { 'p-error': kind });
    const jev = throwing();
    const { receipt, called } = await review(db, { ...q, policy: withSecondOpinion, secondOpinion: jev });

    assert.equal(asked(jev), 1, `primary ${kind}: the configured second opinion is asked (${asked(jev)} calls)`);
    assert.deepEqual(called('escalation'), ['p-error'], `primary ${kind}: an adapter error escalates`);
    assert.deepEqual(outcome(db, 'p-error'), POSTINGS[kind].final, `primary ${kind}: the escalation tier decides`);
    assert.equal(reviewOf(db, 'p-error').hold_owner, null, `primary ${kind}: the error creates no hold`);
    assert.deepEqual(receipt.counts.secondOpinion, { asked: 1, agreed: 0, escalated: 1, errors: 1 }, `primary ${kind}: receipt second-opinion counts: ${JSON.stringify(receipt.counts)}`);
    assert.equal(receipt.status, 'ok', `primary ${kind}: a second-opinion error does not degrade the run: ${receipt.status} ${JSON.stringify(receipt.errors)}`);
    assert.equal(receipt.counts.attempts, 2, `primary ${kind}: primary and escalation are the only paid attempts`);
  }
});

test('[B] a primary unclear always escalates without asking the second opinion (escalation E2)', async () => {
  const db = freshDb();
  const q = queue(db, { 'p-unclear': 'unclear' });
  // Even a confident "not eligible" second opinion is not consulted for an unclear item.
  const jev = fakeSecondOpinion(0.01);
  const { receipt, called } = await review(db, { ...q, policy: withSecondOpinion, secondOpinion: jev });

  assert.equal(asked(jev), 0, 'a primary unclear is never put to the second opinion');
  assert.deepEqual(called('escalation'), ['p-unclear'], 'a primary unclear escalates');
  assert.deepEqual(outcome(db, 'p-unclear'), POSTINGS.unclear.final, 'the escalation tier decides, as today');
  assert.deepEqual(receipt.counts.secondOpinion, { asked: 0, agreed: 0, escalated: 0, errors: 0 },
    `a configured second opinion is reported even when it was never asked: ${JSON.stringify(receipt.counts)}`);
});

// ------------------------------------------------------------------ E3

test('[B] the second opinion is injected as runOptions.secondOpinion and asked with { state, question }; it stays outside the Codex budget and no network is used (escalation E3)', async () => {
  for (const [kind, probability] of [['degree', 0.05], ['eligible', 0.9]]) {
    const db = freshDb();
    const q = queue(db, { 'p-interface': kind });
    const jev = fakeSecondOpinion(probability);
    // Budget 1 covers exactly the primary call: the second opinion must not need, or consume, a paid attempt.
    const { receipt, called } = await review(db, { ...q, policy: withSecondOpinion, secondOpinion: jev, budget: 1 });

    assert.equal(asked(jev), 1, `primary ${kind}: the injected adapter is used (${asked(jev)} calls)`);
    const [call] = jev.calls;
    assert.deepEqual(Object.keys(call).sort(), ['question', 'state'], `primary ${kind}: ask() receives exactly { state, question }: ${JSON.stringify(Object.keys(call))}`);
    assert.ok(call.state && typeof call.state === 'object' && !Array.isArray(call.state), `primary ${kind}: state is an object`);
    assert.ok(typeof call.question === 'string' && call.question.trim(), `primary ${kind}: question is a non-empty string`);
    assert.deepEqual(called('escalation'), [], `primary ${kind}: no escalation`);
    assert.deepEqual(outcome(db, 'p-interface'), POSTINGS[kind].final, `primary ${kind}: the agreed verdict is final within a one-attempt budget`);
    assert.deepEqual(paidRows(db), [{ posting_id: 'p-interface', runner: 'fake', tier: 'primary' }], `primary ${kind}: the attempts table holds the primary call only`);
    assert.deepEqual(receipt.counts.secondOpinion, { asked: 1, agreed: 1, escalated: 0, errors: 0 });
    assert.notEqual(receipt.stop_reason, 'budget', `primary ${kind}: the second opinion does not exhaust the Codex budget: ${receipt.stop_reason}`);
  }
});
