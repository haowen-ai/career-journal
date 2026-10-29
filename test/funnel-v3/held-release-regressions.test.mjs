// Red tests for held reviews released without an answer (live queue, 2026-10-27 cutover): leads held with an open
// question ("待核: term_or_area", "待核: requirement_unclear") came back as visible queued leads although nobody
// answered the question. Two paths did it: a decision-code deploy replayed the old cached judgment under the new
// decide() and delivered its eligible verdict (no judge call at all), and a fresh judgment of an undated posting was
// eligible only because decide() inferred next summer's term, which is the very question the term_or_area hold asked.
// Rulings:
//   HR1 A review whose settled verdict is a question hold (decision 'unclear' with a model-hold code or
//       browser_review) is never delivered as a visible lead by an eligible verdict replayed from stored judgments
//       (redecide, decision-code replay, explicit release replay). It stays held with its own code and question; its
//       application stays hidden (or withdrawn); no review_restored / review_delivered event is written.
//   HR2 Allowed releases: a user's `review resolve` (explicit), or a fresh judge verdict with decision eligible,
//       which includes the forced model decision (model_decided).
//   HR3 A fresh judgment that is eligible only through an inferred term does not answer a term_or_area hold: the
//       worker keeps the hold's question and lets the forced decision settle it; if that call fails the item is not
//       visible.
//   HR4 Control: a fresh eligible judgment with a stated term releases a missing_fact hold as before.
// Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, insertPosting, insertReview, reviewOf, eventsOf, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SCREENING_POLICY, PROFILE, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { listQueue } from '../../src/commands/queue.mjs';

const delivery = async () => ({
  ...(await load('L2', './src/review/deliver.mjs', ['deliver'])),
  ...(await load('L2', './src/review/lease.mjs', ['claimItem'])),
});
const workerModule = () => load('B6', './src/review/worker.mjs', ['runReview']);

const TERM_QUESTION = 'Which stated work window and office or remote scope match your policy?';
const FACT_QUESTION = '• Hands-on experience operating Kubernetes clusters.';
const ELIGIBLE = { decision: 'eligible', code: null, fit: { level: 'medium', note: 'SQL and Python match' }, deadline: { kind: 'none' },
  location: { offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' }], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' } };
const urlOf = (id) => `https://job-boards.greenhouse.io/heldexample/jobs/${id}`;
const applicationOf = (db, postingId) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(postingId);
const queued = (db) => listQueue(db).map((row) => row.id);
// Release events written after the application's first hold.
const releaseEvents = (db, appId) => {
  const events = eventsOf(db, appId);
  return events.slice(events.findIndex((event) => event.type === 'review_held') + 1).filter((event) => ['review_restored', 'review_delivered'].includes(event.type));
};

async function deliverAs(db, postingId, verdict, now, options = {}) {
  const { deliver, claimItem } = await delivery();
  const fence = claimItem(db, postingId, { owner: 'worker-a', now });
  assert.ok(fence, `${postingId} can be claimed`);
  return deliver(db, { postingId, verdict, fence, now, policy: SCREENING_POLICY, ...options });
}

// A question hold as releases before model-decides H1 delivered it, then re-queued as replan/release-holds leave it:
// state due, the held decision and code kept.
async function heldPosting(db, id, { code = 'missing_fact', question = FACT_QUESTION, withdrawnFirst = false, text = SNAPSHOTS.eligible, requeue = 'judge' } = {}) {
  insertPosting(db, { id, url: urlOf(id), company: 'Held Example Co', title: snapshotTitle(text), firstSeen: T0 });
  insertReview(db, { postingId: id, stage: 'fetch', firstSeen: T0, nextDue: T0 });
  if (withdrawnFirst) { // a lead the review later withdrew, as the old checker's automated skip did
    await deliverAs(db, id, ELIGIBLE, at(0.005), { fresh: true });
    db.prepare("UPDATE reviews SET state = 'due' WHERE posting_id = ?").run(id);
    await deliverAs(db, id, { decision: 'not_eligible', code: 'degree' }, at(0.01));
    db.prepare("UPDATE reviews SET state = 'due' WHERE posting_id = ?").run(id);
  }
  await deliverAs(db, id, { decision: 'unclear', code, question, nextAction: 'user_review', holdFactIds: code === 'missing_fact' ? ['kubernetes'] : [] }, at(0.02));
  const held = reviewOf(db, id);
  assert.deepEqual([held.state, held.decision, held.code, held.hold_owner], ['held', 'unclear', code, 'user'], `fixture sanity: ${id} is held for the user`);
  if (requeue) db.prepare("UPDATE reviews SET state = 'due', stage = ?, next_due = ?, hold_owner = NULL, hold_since = NULL WHERE posting_id = ?").run(requeue, at(0.03), id);
  return applicationOf(db, id);
}

function assertStillHeld(db, id, app, { code, question, status = 'lead' }) {
  const row = reviewOf(db, id);
  assert.deepEqual([row.state, row.decision, row.code], ['held', 'unclear', code], `${id}: the review stays held with its own code`);
  assert.equal(JSON.parse(row.evidence_json).question, question, `${id}: the open question is kept`);
  const after = applicationOf(db, id);
  assert.equal(after.status, status, `${id}: application status unchanged`);
  if (status === 'lead') assert.match(after.skip_reason ?? '', /^待核: /, `${id}: the application stays hidden behind its question`);
  assert.ok(!queued(db).includes(app.id), `${id}: not a visible queued lead`);
  assert.deepEqual(releaseEvents(db, app.id), [], `${id}: no review_restored / review_delivered event after the hold`);
}

// ------------------------------------------------------------------ HR1, HR2 (delivery boundary)

test('[HR1] an eligible verdict replayed from stored judgments never releases a question hold; it stays held and hidden', async () => {
  const db = freshDb();
  const app = await heldPosting(db, 'p-replayed');
  await deliverAs(db, 'p-replayed', ELIGIBLE, at(0.1));
  assertStillHeld(db, 'p-replayed', app, { code: 'missing_fact', question: FACT_QUESTION });

  // Fanatics: an automated withdrawal, then a hold, then an eligible replay must not restore the lead.
  const withdrawn = await heldPosting(db, 'p-withdrawn-held', { code: 'term_or_area', question: TERM_QUESTION, withdrawnFirst: true });
  assert.equal(withdrawn.status, 'withdrawn', 'fixture sanity: the held application was withdrawn by the review');
  await deliverAs(db, 'p-withdrawn-held', { ...ELIGIBLE, flags: ['term_inferred'] }, at(0.1));
  assertStillHeld(db, 'p-withdrawn-held', withdrawn, { code: 'term_or_area', question: TERM_QUESTION, status: 'withdrawn' });
});

test('[HR2] a user resolve or a fresh eligible judge verdict releases a question hold', async () => {
  const db = freshDb();
  const resolved = await heldPosting(db, 'p-resolved');
  await deliverAs(db, 'p-resolved', ELIGIBLE, at(0.1), { explicit: true });
  const fresh = await heldPosting(db, 'p-fresh');
  await deliverAs(db, 'p-fresh', ELIGIBLE, at(0.1), { fresh: true });
  for (const [id, app] of [['p-resolved', resolved], ['p-fresh', fresh]]) {
    const row = reviewOf(db, id);
    assert.deepEqual([row.state, row.decision], ['done', 'eligible'], `${id}: delivered as eligible`);
    assert.equal(applicationOf(db, id).skip_reason, null, `${id}: visible`);
    assert.ok(queued(db).includes(app.id), `${id}: queued`);
  }
});

// ------------------------------------------------------------------ HR3, HR4 (worker)

async function review(db, { pages, answers, forced = {}, now = at(0.2) }) {
  const { runReview } = await workerModule();
  const respond = (request) => (request.forceDecision === true ? forced[request.postingId] : answers[request.postingId]);
  const judges = { primary: fakeJudge({ tier: 'primary', answers: respond }), escalation: fakeJudge({ tier: 'escalation', answers: respond }) };
  await runReview({ db, runId: `review-held-${now}`, owner: 'worker-a', now, budget: 20, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fakeFetcher(pages), judges, inputs: () => reviewInputs({ policy: REVIEW_POLICY, profile: PROFILE }), hooks: {} });
  return judges;
}

test('[HR3] a fresh judgment eligible only through an inferred term does not answer a term_or_area hold; the forced decision settles it', async () => {
  const db = freshDb();
  const ids = { failed: 'p-undated-forced-fails', decided: 'p-undated-forced-eligible' };
  const pages = {}; const answers = {}; const apps = {};
  for (const id of Object.values(ids)) {
    apps[id] = await heldPosting(db, id, { code: 'term_or_area', question: TERM_QUESTION, text: SNAPSHOTS.noTerm, requeue: 'fetch' });
    pages[urlOf(id)] = page(urlOf(id), SNAPSHOTS.noTerm);
    answers[id] = { output: JUDGMENTS.noTerm };
  }
  const judges = await review(db, { pages, answers,
    forced: { [ids.failed]: { status: 'error', error: 'forced call failed' }, [ids.decided]: { output: { decision: 'eligible', assumption: 'Assumed the internship runs in summer 2027' } } } });

  for (const id of Object.values(ids)) {
    const forced = judges.escalation.calls.filter((call) => call.request.postingId === id && call.request.forceDecision === true);
    assert.equal(forced.length, 1, `${id}: the hold's question goes to one forced decision`);
    assert.ok(String(forced[0].request.prompt).includes(TERM_QUESTION), `${id}: the forced request asks the hold's question`);
  }
  const failed = applicationOf(db, ids.failed);
  assert.equal(failed.skip_reason?.startsWith('待核: '), true, `${ids.failed}: still hidden when the forced call fails`);
  assert.ok(!queued(db).includes(failed.id), `${ids.failed}: not a visible lead`);
  assert.deepEqual(releaseEvents(db, failed.id), [], `${ids.failed}: no release event`);

  const decided = reviewOf(db, ids.decided);
  assert.deepEqual([decided.state, decided.decision], ['done', 'eligible'], `${ids.decided}: the forced eligible decision is final`);
  assert.ok(JSON.parse(decided.flags_json).includes('model_decided'), `${ids.decided}: flagged model_decided`);
  assert.ok(queued(db).includes(apps[ids.decided].id), `${ids.decided}: a fresh judge decision releases it`);
});

test('[HR4] control: a fresh eligible judgment with a stated term releases a missing_fact hold', async () => {
  const db = freshDb();
  const id = 'p-fresh-stated-term';
  const app = await heldPosting(db, id, { requeue: 'fetch' });
  const judges = await review(db, { pages: { [urlOf(id)]: page(urlOf(id), SNAPSHOTS.eligible) }, answers: { [id]: { output: JUDGMENTS.eligible } } });
  assert.equal(judges.escalation.calls.length, 0, 'no escalation is needed');
  const row = reviewOf(db, id);
  assert.deepEqual([row.state, row.decision, row.code], ['done', 'eligible', null], 'delivered as eligible');
  assert.ok(queued(db).includes(app.id), 'visible in the queue');
});
