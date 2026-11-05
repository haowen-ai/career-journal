// Failures wait (redesign B3): a Jev operational failure never decides and never escalates to Codex. The
// posting stays due, the real error is kept, and 20 consecutive failed postings stop Jev for the run.
// Synthetic data only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runReview } from '../../src/review/worker.mjs';
import { JEV_SPLIT_QUESTIONS } from '../../src/review/jev-split.mjs';
import { JevError, createJevAdapter } from '../../src/review/second-opinion.mjs';

const THRESHOLDS = {
  reject: { degree: 0.3, term: 0.3, place: 0.3, auth: 0.3, function: 0.3, skills: 0.2 },
  accept: { degree: 0.7, term: 0.65, place: 0.8, auth: 0.55, function: 0.7, skills: 0.4 },
};
const JEV_POLICY = { ...REVIEW_POLICY, judge: { primary: { runner: 'jev-split', model: 'jev-test', thresholds: THRESHOLDS },
  fallback: { runner: 'codex', model: 'codex-fallback' }, escalation: { runner: 'codex', model: 'codex-escalation' } } };
const SECOND_OPINION = { runner: 'jev', model: 'jev-test', threshold: 0.1, eligibleThreshold: 0.7 };
const SO_POLICY = { ...REVIEW_POLICY, judge: { secondOpinion: SECOND_OPINION } };
const HIGH = { degree: 0.97, term: 0.82, place: 0.87, auth: 0.95, function: 0.71, skills: 0.63 };
const dimensionOf = (question) => Object.keys(JEV_SPLIT_QUESTIONS).find((key) => JEV_SPLIT_QUESTIONS[key] === question);
const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;

function postings(db, ids, { text = SNAPSHOTS.eligible } = {}) {
  const pages = {};
  for (const id of ids) {
    insertPosting(db, { id, url: urlOf(id), title: snapshotTitle(text) });
    insertReview(db, { postingId: id, stage: 'fetch' });
    pages[urlOf(id)] = page(urlOf(id), text);
  }
  return pages;
}
function judges({ primary = () => ({ output: JUDGMENTS.eligible }), escalation = primary } = {}) {
  return { primary: fakeJudge({ tier: 'primary', answers: primary }), escalation: fakeJudge({ tier: 'escalation', answers: escalation }) };
}
const run = (db, { pages, judges: j, jev, secondOpinion, policy = JEV_POLICY, now = T0, runId = 'review-b3', budget = 50 }) => runReview({
  db, runId, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {}, fetcher: fakeFetcher(pages),
  judges: j, inputs: () => reviewInputs({ policy }), hooks: {}, ...(jev ? { jev } : {}), ...(secondOpinion ? { secondOpinion } : {}) });
const codexCalls = (j) => j.primary.calls.length + j.escalation.calls.length;
const errorsLogged = (db, id) => db.prepare("SELECT payload_json FROM review_log WHERE posting_id=? AND kind='error'").all(id).map((row) => JSON.parse(row.payload_json));

test('[B3] a Jev split failure keeps the posting due with the real error, makes no Codex call, and waits for every dimension first', async () => {
  const db = freshDb();
  const pages = postings(db, ['p-1']);
  const states = [];
  const jev = { async ask({ question }) {
    const dimension = dimensionOf(question);
    if (dimension === 'place') throw new JevError('Jev HTTP 429', { kind: 'http', status: 429 });
    await new Promise((done) => setTimeout(done, 15));
    states.push(reviewOf(db, 'p-1').state);
    return { probability: HIGH[dimension] };
  } };
  const j = judges();
  const receipt = await run(db, { pages, judges: j, jev });
  assert.equal(codexCalls(j), 0, 'no escalation to Codex on an operational failure');
  const row = reviewOf(db, 'p-1');
  assert.deepEqual([row.state, row.decision], ['due', null]);
  assert.match(row.last_error, /Jev HTTP 429/);
  assert.deepEqual(states, ['leased', 'leased', 'leased', 'leased', 'leased'], 'every outstanding dimension answered while the posting was still leased');
  const logged = errorsLogged(db, 'p-1').find((payload) => payload.source === 'jev');
  assert.deepEqual([logged.kind, logged.status], ['http', 429]);
  assert.equal(receipt.jev.errors, 1);
  assert.equal(receipt.jev.escalated, 0);
  assert.deepEqual([receipt.status, receipt.stop_reason], ['partial', 'external_failure'], 'B10: the waiting posting names an external failure');
  assert.ok(receipt.errors.some((error) => /Jev HTTP 429/.test(error)), JSON.stringify(receipt.errors));
});

test('[B3] 20 consecutive Jev-failed postings stop Jev for the run: partial, jev_unavailable, the rest stays due untouched', async () => {
  const db = freshDb();
  const ids = Array.from({ length: 23 }, (_, i) => `p-${String(i).padStart(2, '0')}`);
  const pages = postings(db, ids);
  const jev = { async ask() {
    throw new JevError('Jev HTTP 503', { kind: 'http', status: 503 });
  } };
  const j = judges();
  const receipt = await run(db, { pages, judges: j, jev });
  assert.equal(receipt.jev.postings, 20, 'Jev is asked for exactly 20 postings');
  assert.equal(codexCalls(j), 0);
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.stop_reason, 'jev_unavailable');
  assert.ok(receipt.errors.some((error) => /Jev HTTP 503/.test(error)));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state='due' AND decision IS NULL").get().n, 23);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state='leased'").get().n, 0, 'no lease is left');
});

// Review finding 2026-11-05: a successful but uncertain split screen inside a posting is not a recovered Jev. The
// streak resets only when a posting's Jev stages all succeed, so 20 postings whose second opinion fails stop the run.
test('[B3] 20 consecutive second-opinion failures stop the run even when each split screen answered', async () => {
  const db = freshDb();
  const ids = Array.from({ length: 25 }, (_, i) => `p-so-${String(i).padStart(2, '0')}`);
  const pages = postings(db, ids);
  const uncertain = { async ask() { return { probability: 0.5 }; } };
  let asked = 0;
  const failing = { async ask() { asked += 1; throw new JevError('Jev HTTP 503', { kind: 'http', status: 503 }); } };
  const receipt = await run(db, { pages, judges: judges(), jev: uncertain, secondOpinion: failing,
    policy: { ...JEV_POLICY, judge: { ...JEV_POLICY.judge, secondOpinion: SECOND_OPINION } } });
  assert.ok(asked > 0, 'fixture: the second opinion was asked');
  assert.ok(asked <= 20, `the second opinion is asked for at most 20 postings (asked ${asked})`);
  assert.deepEqual([receipt.status, receipt.stop_reason], ['partial', 'jev_unavailable']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state='due' AND decision IS NULL").get().n, 25);
});

test('[B3] a failed second opinion leaves the posting due without escalating; the next run replays the cached primary judgment', async () => {
  const db = freshDb();
  const pages = postings(db, ['p-so']);
  const j = judges();
  const failing = { async ask() { throw new JevError('Jev timeout', { kind: 'timeout' }); } };
  const first = await run(db, { pages, judges: j, secondOpinion: failing, policy: SO_POLICY });
  assert.equal(j.primary.calls.length, 1);
  assert.equal(j.escalation.calls.length, 0, 'no escalation on a Jev failure');
  assert.deepEqual([reviewOf(db, 'p-so').state, reviewOf(db, 'p-so').decision], ['due', null]);
  assert.equal(first.counts.secondOpinion.errors, 1);
  assert.equal(first.counts.secondOpinion.escalated, 0);
  const again = judges();
  await run(db, { pages, judges: again, secondOpinion: { async ask() { return { probability: 0.9 }; } }, policy: SO_POLICY, now: at(1), runId: 'review-b3-2' });
  assert.equal(codexCalls(again), 0, 'the cached primary judgment is replayed, no new paid call');
  assert.deepEqual([reviewOf(db, 'p-so').state, reviewOf(db, 'p-so').decision], ['done', 'eligible']);
});

test('[B3] a genuine second-opinion disagreement still escalates as today', async () => {
  const db = freshDb();
  const pages = postings(db, ['p-dis']);
  const j = judges();
  await run(db, { pages, judges: j, secondOpinion: { async ask() { return { probability: 0.3 }; } }, policy: SO_POLICY });
  assert.equal(j.escalation.calls.length, 1);
});

test('[B3] a failed verification of a forced decision decides nothing: the posting stays due', async () => {
  const db = freshDb();
  const pages = postings(db, ['p-forced'], { text: SNAPSHOTS.missingFact });
  const j = judges({ primary: () => ({ output: JUDGMENTS.missingFact }),
    escalation: (request) => (request.forceDecision ? { output: { decision: 'eligible', assumption: 'Assumed the tool can be learned' } } : { output: JUDGMENTS.missingFact }) });
  const receipt = await run(db, { pages, judges: j, secondOpinion: { async ask() { throw new JevError('Jev HTTP 500', { kind: 'http', status: 500 }); } }, policy: SO_POLICY });
  assert.ok(j.escalation.calls.some((call) => call.request.forceDecision), 'fixture: the forced decision was asked');
  assert.deepEqual([reviewOf(db, 'p-forced').state, reviewOf(db, 'p-forced').decision], ['due', null]);
  assert.equal(receipt.model_decided.length, 0);
});

async function withFetch(responder, fn) {
  const original = globalThis.fetch; const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  globalThis.fetch = responder;
  try { return await fn(); } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
  }
}

test('[B3] the Jev adapter reports the HTTP status and kind, never the credential', async () => {
  for (const [status, kind] of [[429, 'http'], [401, 'auth'], [503, 'http']]) {
    await withFetch(async () => new Response('secret body test-key', { status }), async () => {
      const jev = createJevAdapter({ model: 'jev-test', retryDelayMs: 0 });
      const error = await jev.ask({ state: 's', question: 'q' }).then(() => null, (failure) => failure);
      assert.ok(error instanceof JevError);
      assert.deepEqual([error.kind, error.status, error.message], [kind, status, `Jev HTTP ${status}`]);
      assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /test-key|secret body/);
    });
  }
  await withFetch(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }, async () => {
    const error = await createJevAdapter({ model: 'jev-test', retryDelayMs: 0 }).ask({ state: 's', question: 'q' }).catch((failure) => failure);
    assert.deepEqual([error.kind, error.message], ['timeout', 'Jev timeout']);
  });
});
