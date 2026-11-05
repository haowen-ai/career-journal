// Decide once (redesign B1): a nightly run re-queues only open work. Settled history stays settled,
// and its stored judgment provenance (dep_hashes_json) is left byte-identical. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insertPosting, insertReview, reviewOf, seedApplication, at, T0 } from '../../test-utils/funnel-v3.mjs';
import { reviewInputs, RULES, SCREENING_POLICY } from '../../test-utils/funnel-v3-fixtures.mjs';
import { scheduleRefresh } from '../../src/review/freshness.mjs';
import { replan, inputState } from '../../src/review/worker.mjs';
import { applyCompanyExclusion } from '../../src/review/exclusion-pass.mjs';
import { applyRoleDirection } from '../../src/review/direction-pass.mjs';
import { DIRECTION_CODE } from '../../src/review/direction.mjs';

const POLICY = { freshness: { activeDays: 7, negativeRecheckDays: 14, negativeHorizonDays: 60 } };

function settle(db, id, { decision, code = null, evidence = {}, deps = {}, updatedAt = T0 }) {
  db.prepare("UPDATE reviews SET state='done',stage='deliver',decision=?,code=?,evidence_json=?,dep_hashes_json=?,next_due=NULL,updated_at=? WHERE posting_id=?")
    .run(decision, code, JSON.stringify(evidence), JSON.stringify(deps), updatedAt, id);
}
function withLead(db, id, { status = 'lead', company = 'Example Corp' } = {}) {
  const app = seedApplication(db, { company, role: `Role ${id}`, status });
  db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, id);
  return app;
}

test('[B1] scheduleRefresh re-checks only queued leads, never settled negatives or withdrawn eligibles', () => {
  const db = freshDb();
  for (const id of ['neg', 'lead', 'gone']) { insertPosting(db, { id }); insertReview(db, { postingId: id }); }
  settle(db, 'neg', { decision: 'not_eligible', code: 'outside_area' });
  settle(db, 'lead', { decision: 'eligible' }); withLead(db, 'lead');
  settle(db, 'gone', { decision: 'eligible' }); withLead(db, 'gone', { status: 'withdrawn' });
  const result = scheduleRefresh(db, { now: at(20), policy: POLICY });
  assert.equal(result.requeued, 1);
  assert.equal(reviewOf(db, 'lead').state, 'due');
  assert.equal(reviewOf(db, 'neg').state, 'done');
  assert.equal(reviewOf(db, 'gone').state, 'done');
});

test('[B1] replan never re-queues settled history after a rule edit and leaves its hashes untouched', () => {
  const db = freshDb();
  const before = reviewInputs();
  const state = inputState(before);
  for (const id of ['settled', 'open', 'queued']) { insertPosting(db, { id }); insertReview(db, { postingId: id, stage: 'judge' }); }
  const deps = { inputs: state, runtime: {} };
  settle(db, 'settled', { decision: 'not_eligible', code: 'outside_area', deps });
  settle(db, 'queued', { decision: 'eligible', deps }); withLead(db, 'queued');
  db.prepare("UPDATE reviews SET decision='not_eligible',code='degree',dep_hashes_json=? WHERE posting_id='open'").run(JSON.stringify(deps));
  const storedBefore = reviewOf(db, 'settled').dep_hashes_json;
  const edited = reviewInputs({ rules: { ...RULES, screening: `${RULES.screening}\nA new rule line.\n` } });
  const { requeued } = replan(db, { inputs: edited, now: at(1) });
  // A rule edit does not invalidate an eligible verdict (unchanged relevance rule); the lead stays queued.
  assert.equal(requeued, 1, 'only the open row');
  assert.equal(reviewOf(db, 'settled').state, 'done');
  assert.equal(reviewOf(db, 'settled').dep_hashes_json, storedBefore, 'settled provenance byte-identical');
  assert.equal(reviewOf(db, 'open').state, 'due');
  assert.equal(reviewOf(db, 'queued').state, 'done');
});

test('[B1] lifting a company exclusion does not restore a settled exclusion by itself (needs review rejudge)', () => {
  const db = freshDb();
  insertPosting(db, { id: 'ex', company: 'Lifted Example Co' }); insertReview(db, { postingId: 'ex' });
  settle(db, 'ex', { decision: 'not_eligible', code: 'company_excluded',
    evidence: { companyExcluded: { source: 'user', match: 'lifted example co', judged: true, provenance: null }, provenance: 'automated' } });
  const app = withLead(db, 'ex', { status: 'withdrawn', company: 'Lifted Example Co' });
  const result = applyCompanyExclusion(db, { now: at(1), policy: { ...SCREENING_POLICY } });
  assert.equal(result.restored, 0);
  assert.equal(reviewOf(db, 'ex').state, 'done');
  assert.equal(db.prepare('SELECT status FROM applications WHERE id=?').get(app.id).status, 'withdrawn');
});

test('[B1] a settled role-direction rejection is not restored or re-queued when the direction rules change', () => {
  const db = freshDb();
  for (const id of ['dir', 'stale']) { insertPosting(db, { id, title: 'Data Science Intern' }); insertReview(db, { postingId: id }); }
  settle(db, 'dir', { decision: 'not_eligible', code: DIRECTION_CODE, evidence: { roleDirection: { note: 'x' }, provenance: 'automated' } });
  settle(db, 'stale', { decision: 'not_eligible', code: DIRECTION_CODE, evidence: { roleDirection: { note: 'x' }, provenance: 'automated' }, deps: { invalidated: true } });
  const result = applyRoleDirection(db, { now: at(1), policy: { ...SCREENING_POLICY, direction: null } });
  assert.equal(result.restored, 0);
  assert.equal(reviewOf(db, 'dir').state, 'done');
  assert.equal(reviewOf(db, 'stale').state, 'done');
});

test('[B1] a candidate-fact edit does not re-queue a settled not_eligible review either', () => {
  const db = freshDb();
  const deps = { inputs: inputState(reviewInputs()), runtime: {} };
  insertPosting(db, { id: 'neg' }); insertReview(db, { postingId: 'neg', stage: 'judge' });
  settle(db, 'neg', { decision: 'not_eligible', code: 'degree', deps });
  const facts = [...reviewInputs().facts, { id: 'new-fact', statement: 'Speaks a new language', polarity: 'has' }];
  assert.equal(replan(db, { inputs: reviewInputs({ facts }), now: at(1) }).requeued, 0);
  assert.equal(reviewOf(db, 'neg').state, 'done');
});
