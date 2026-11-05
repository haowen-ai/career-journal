// Redesign B5, B7, B10, B11 and the company-size hook in the review worker. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0 } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, RULES, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runReview } from '../../src/review/worker.mjs';
import { JEV_SPLIT_QUESTIONS } from '../../src/review/jev-split.mjs';
import { needsConversionProof } from '../../src/review/conversion.mjs';
import { createReviewScheduler, explorationShare } from '../../src/review/schedule.mjs';

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
const THRESHOLDS = {
  reject: { degree: 0.3, term: 0.3, place: 0.3, auth: 0.3, function: 0.3, skills: 0.2 },
  accept: { degree: 0.7, term: 0.65, place: 0.8, auth: 0.55, function: 0.7, skills: 0.4 },
};
const JEV_POLICY = { ...REVIEW_POLICY, judge: { primary: { runner: 'jev-split', model: 'jev-test', thresholds: THRESHOLDS },
  fallback: { runner: 'codex', model: 'f' }, escalation: { runner: 'codex', model: 'e' } } };
const ACCEPT_ALL = { async ask() { return { probability: 0.99 }; } };
const judges = (answer = () => ({ output: JUDGMENTS.eligible })) => ({ primary: fakeJudge({ tier: 'primary', answers: answer }), escalation: fakeJudge({ tier: 'escalation', answers: answer }) });
function add(db, pages, id, { title, text = SNAPSHOTS.eligible, company = 'Example Corp', lane = 'new', result } = {}) {
  const body = title ? text.replace(snapshotTitle(text), title) : text;
  insertPosting(db, { id, url: urlOf(id), company, title: snapshotTitle(body) });
  insertReview(db, { postingId: id, stage: 'fetch', lane });
  pages[urlOf(id)] = result ?? page(urlOf(id), body);
}
const run = (db, pages, { j = judges(), policy = REVIEW_POLICY, jev, inputs, resolveCompanySizes, budget = 50 } = {}) => runReview({ db, runId: 'review-bw', owner: 'worker-a',
  now: T0, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {}, fetcher: fakeFetcher(pages), judges: j,
  inputs: inputs ?? (() => reviewInputs({ policy })), hooks: {}, ...(jev ? { jev } : {}), ...(resolveCompanySizes ? { resolveCompanySizes } : {}) });

test('[B5] a forbidden page, a bot wall, another posting or a stub becomes browser work on the first failed fetch', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-403', { result: { ok: false, httpStatus: 403, finalUrl: urlOf('p-403') } });
  add(db, pages, 'p-wall', { result: page(urlOf('p-wall'), `Please verify you are human. ${'x '.repeat(400)}`) });
  add(db, pages, 'p-short', { result: page(urlOf('p-short'), 'Data Science Intern\nApply now.') });
  add(db, pages, 'p-net', { result: { ok: false, error: 'ECONNRESET' } });
  add(db, pages, 'p-5xx', { result: { ok: false, httpStatus: 503, error: 'HTTP 503' } });
  await run(db, pages);
  for (const id of ['p-403', 'p-wall', 'p-short']) {
    const row = reviewOf(db, id);
    assert.deepEqual([row.state, row.code, row.attempts], ['held', 'browser_review', 1], id);
  }
  for (const id of ['p-net', 'p-5xx']) assert.equal(reviewOf(db, id).state, 'due', `${id}: transient errors keep retrying`);
});

test('[B7] the exploration share comes from review policy; 0 turns the lanes off; the default is unchanged', () => {
  assert.equal(explorationShare({}), 0.1);
  assert.equal(explorationShare({ exploration: { share: 0 } }), 0);
  assert.throws(() => explorationShare({ exploration: { share: 2 } }), /exploration.share/);
  const db = freshDb();
  insertPosting(db, { id: 'p-x' }); insertReview(db, { postingId: 'p-x', lane: 'no_student_signal' });
  const scheduler = (policy) => createReviewScheduler(db, { now: T0, owner: 'o', policy, budget: 20, unlistedOnly: new Set() });
  assert.equal(scheduler({}).explorationTarget, 1);
  assert.equal(scheduler({ exploration: { share: 0 } }).explorationTarget, 0);
});

test('[B10] a run that leaves due actionable work without an external failure is partial: unfinished', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-1');
  let calls = 0;
  // The rules change while the posting is judged: it is released due with no error.
  const inputs = () => { calls += 1; return reviewInputs({ rules: calls > 3 ? { ...RULES, screening: `${RULES.screening}\nedited` } : RULES }); };
  const receipt = await run(db, pages, { inputs });
  assert.equal(reviewOf(db, 'p-1').state, 'due');
  assert.deepEqual([receipt.status, receipt.stop_reason, receipt.errors], ['partial', 'unfinished', []]);
  assert.equal(receipt.backlog.actionable_due, 1);
  const clean = freshDb();
  const done = {};
  add(clean, done, 'p-2');
  const ok = await run(clean, done);
  assert.deepEqual([ok.status, ok.stop_reason, ok.backlog.actionable_due], ['ok', null, 0]);
});

test('[B11] needsConversionProof matches program types by title, not ordinary internships; policy can replace the list', () => {
  for (const title of ['AI Residency 2027', 'Summer Research Fellowship', 'Student Researcher, PhD', 'AI Resident', 'Research Training Program Intern', 'Data Science Fellow'])
    assert.equal(needsConversionProof(title, {}), true, title);
  for (const title of ['Data Science Intern', 'Resident Advisor Assistant', 'Residential Energy Analyst Intern', 'Research Analyst Intern'])
    assert.equal(needsConversionProof(title, {}), false, title);
  assert.equal(needsConversionProof('Scholar Intern', { conversionProof: { titlePatterns: ['\\bscholar\\b'] } }), true);
  assert.equal(needsConversionProof('AI Residency', { conversionProof: { titlePatterns: [] } }), false);
});

test('[B11] a Jev-direct eligible for a residency is not accepted; the Codex tiers decide it; a plain internship still is', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-res', { title: 'Machine Learning Residency' });
  add(db, pages, 'p-int', { title: 'Data Science Intern Two' });
  const j = judges();
  const receipt = await run(db, pages, { j, policy: JEV_POLICY, jev: ACCEPT_ALL });
  assert.deepEqual(j.primary.calls.map((call) => call.request.postingId), ['p-res']);
  assert.equal(receipt.counts.conversion_proof, 1);
  assert.equal(reviewOf(db, 'p-int').decision, 'eligible');
  assert.ok(JSON.parse(reviewOf(db, 'p-int').flags_json).includes('jev_decided'));
  assert.ok(!JSON.parse(reviewOf(db, 'p-res').flags_json).includes('jev_decided'));
  assert.ok(Object.keys(JEV_SPLIT_QUESTIONS).length === 6);
});

test('[hook] company sizes are resolved once before judging; a company left unknown keeps its postings due and names the failure', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-known', { company: 'Known Example Co' });
  add(db, pages, 'p-unknown', { company: 'Unknown Example Co', title: 'Data Science Intern Three' });
  const asked = [];
  const resolveCompanySizes = async ({ companies, now }) => { asked.push({ companies, now }); return { failed: [{ company: 'Unknown Example Co', error: 'Jev HTTP 503' }] }; };
  const j = judges();
  const receipt = await run(db, pages, { j, resolveCompanySizes });
  assert.deepEqual(asked, [{ companies: ['Known Example Co', 'Unknown Example Co'], now: T0 }]);
  assert.equal(reviewOf(db, 'p-known').state, 'done');
  assert.equal(reviewOf(db, 'p-unknown').state, 'due');
  assert.deepEqual(j.primary.calls.map((call) => call.request.postingId), ['p-known']);
  assert.deepEqual([receipt.status, receipt.stop_reason], ['partial', 'company_size_unavailable']);
  assert.ok(receipt.errors.some((error) => /Unknown Example Co: Jev HTTP 503/.test(error)));
});
