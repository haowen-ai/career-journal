// Role-direction regressions for the user rule of 2026-10-29: a lead's direction must be AI / machine learning /
// data science / data analytics, or a data-heavy product/tech PM. On the live queue the judge's function check let a
// buyer internship, a property-claims internship, operations, generic project management and generic software
// engineering roles through as eligible (several rated high fit), and the user skipped them by hand.
// Rulings:
//   RD1 profile/role-direction.json holds case-insensitive title patterns: allow (an AI/ML/data signal), block (an
//       out-of-direction function) and requireAllow (a borderline class such as software engineering or generic PM),
//       plus allowFunctions (patterns for the judge's function label). allow wins; block is out; requireAllow is out
//       unless the title or the judge's function label is allowed. A function label never overrides block. A title
//       matching no list is in direction. Without the file nothing is filtered. A malformed file fails loudly.
//   RD2 At delivery an eligible verdict whose posting is out of direction creates no visible lead: it is settled
//       not_eligible with code 'role_direction', automated provenance, never held for the user.
//   RD3 The worker passes the judge's function label to delivery, so an AI-labelled software role stays visible and a
//       generic software role does not.
//   RD4 The worker's startup pass withdraws visible review-delivered leads whose title is blocked (and requireAllow
//       leads whose stored function label is not allowed) without fetching or judging, and restores them when the
//       rules change so they pass. User-decided leads (prepared, user-skipped) are never touched.
//   RD5 The rules are not a judge dependency: changing them re-judges and re-queues nothing.
//   RD6 queue list flags blocked-title leads (directionOk false) and sorts them after every in-direction lead.
// Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, load, insertPosting, insertReview, reviewOf, eventsOf, applicationsCount, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SCREENING_POLICY, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { listQueue } from '../../src/commands/queue.mjs';

const directionModule = () => load('RD', './src/review/direction.mjs', ['directionRules', 'loadDirectionRules', 'roleDirection']);
const workerModule = () => load('B6', './src/review/worker.mjs', ['runReview', 'inputState']);
const delivery = async () => ({
  ...(await load('L2', './src/review/deliver.mjs', ['deliver'])),
  ...(await load('L2', './src/review/lease.mjs', ['claimItem'])),
});
const inputsModule = () => load('B1', './src/review/inputs.mjs', ['judgeDependencies', 'loadReviewInputs']);

const RAW_RULES = Object.freeze({
  rule: 'synthetic',
  allow: ['\\bA\\.?I\\b', 'machine learning', '\\bML\\b', '\\bdata\\b', 'analytic', '\\bquant'],
  block: ['\\bbuy(?:er|ing)\\b', 'merchandis', '\\bclaims?\\b', '\\bsales\\b', '\\boperations\\b'],
  requireAllow: ['software', 'developer', '\\bproducts?\\b', '\\bproject\\b'],
  allowFunctions: ['\\bai\\b', 'ai_', '\\bml\\b', 'machine', 'data', 'analytic', 'quant'],
});
const rules = async () => (await directionModule()).directionRules(RAW_RULES);
const ELIGIBLE = { decision: 'eligible', code: null, fit: { level: 'high', note: 'BI reporting matches' }, deadline: { kind: 'none' },
  location: { offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' }], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' } };
const COMPANY = 'Direction Example Co';

const urlOf = (id) => `https://job-boards.greenhouse.io/directionexample/jobs/${id.replace(/[^0-9a-z]/gi, '')}`;
const retitled = (text, title) => text.replace(snapshotTitle(text), `TITLE: ${title}`);
let seq = 0;
const queued = (db, options) => listQueue(db, null, options).map((row) => row.id);
const applicationOf = (db, postingId) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(postingId);
const evidenceOf = (db, id) => JSON.parse(reviewOf(db, id).evidence_json || '{}');
const attemptsCount = (db) => db.prepare('SELECT COUNT(*) n FROM attempts').get().n;
const reviewRows = (db) => JSON.stringify(db.prepare('SELECT posting_id, state, decision, code, next_due, hold_owner, dep_hashes_json FROM reviews ORDER BY posting_id').all());

// Problems with a posting the filter must keep out of the queue (empty when RD2/RD4 hold).
function directionProblems(db, postingId) {
  const problems = [];
  const row = reviewOf(db, postingId);
  if (row.code !== 'role_direction') problems.push(`${postingId}: review code ${row.code} (state ${row.state}, decision ${row.decision}), expected role_direction`);
  if (row.decision === 'eligible') problems.push(`${postingId}: still decided eligible`);
  if (['due', 'leased', 'held'].includes(row.state)) problems.push(`${postingId}: state ${row.state}, expected done`);
  if (row.hold_owner === 'user') problems.push(`${postingId}: held for the user`);
  if (evidenceOf(db, postingId).provenance !== 'automated') problems.push(`${postingId}: evidence provenance ${evidenceOf(db, postingId).provenance}, expected automated`);
  const app = applicationOf(db, postingId);
  if (app && queued(db).includes(app.id)) problems.push(`${postingId}: lead ${app.id} is visible in the queue`);
  return problems;
}

function queue() {
  const pages = {};
  const answers = {};
  return {
    pages,
    answers,
    add(db, id, { title = 'Data Science Intern', judgment = JUDGMENTS.eligible } = {}) {
      insertPosting(db, { id, url: urlOf(id), company: COMPANY, title });
      insertReview(db, { postingId: id, stage: 'fetch', firstSeen: T0, nextDue: T0 });
      pages[urlOf(id)] = page(urlOf(id), retitled(SNAPSHOTS.eligible, title));
      answers[id] = { output: judgment };
      return id;
    },
  };
}

// A lead the worker delivered as eligible before the filter existed: visible, review done eligible.
function deliveredLead(db, id, { title, functionLabel, now = at(-1) } = {}) {
  const appId = `lead-${id}`;
  db.prepare(`INSERT INTO applications (id, company, role, job_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'lead', ?, ?)`)
    .run(appId, COMPANY, title, urlOf(id), now, now);
  insertPosting(db, { id, url: urlOf(id), company: COMPANY, title, applicationId: appId, firstSeen: now });
  insertReview(db, { postingId: id, stage: 'deliver', state: 'done', decision: 'eligible', firstSeen: now, nextDue: null });
  const evidence = { fit: ELIGIBLE.fit, location: ELIGIBLE.location, deadline: { kind: 'none' }, evidence: [], ...(functionLabel === undefined ? {} : { function: functionLabel }) };
  db.prepare('UPDATE reviews SET evidence_json = ? WHERE posting_id = ?').run(JSON.stringify(evidence), id);
  db.prepare(`INSERT INTO application_events (id, application_id, event_type, observed_at, recorded_at, title, note, source_json, status_after, content_hash)
    VALUES (?, ?, 'review_delivered', ?, ?, 'review_delivered', '', ?, NULL, ?)`).run(`delivered-${id}`, appId, now, now, JSON.stringify({ actor: 'review-worker', postingId: id }), `h-${id}`);
  return appId;
}

function judges(answers) {
  const respond = (request) => answers[request.postingId];
  return { primary: fakeJudge({ tier: 'primary', answers: respond }), escalation: fakeJudge({ tier: 'escalation', answers: respond }) };
}
const judgedIds = (j) => [...j.primary.calls, ...j.escalation.calls].map((call) => call.request.postingId);

async function offline(run) {
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => { attempts.push(String(url)); throw new Error(`network access in a test: ${url}`); };
  try { return await run(); } finally {
    globalThis.fetch = original;
    assert.deepEqual(attempts, [], 'no network request is made');
  }
}
async function review(db, { pages = {}, answers = {}, direction, budget = 20, now = T0, runId = `review-direction-${seq += 1}` } = {}) {
  const { runReview } = await workerModule();
  const fetcher = fakeFetcher(pages);
  const j = judges(answers);
  const receipt = await offline(() => runReview({ db, runId, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher, judges: j, inputs: () => reviewInputs({ direction }), hooks: {} }));
  return { receipt, fetcher, judges: j };
}

// ===================================================================== RD1 — rules

test('[RD] title rules: allow wins, block is out even with an allowed function label, requireAllow needs an allowed title or label, no rules filter nothing (role direction RD1)', async () => {
  const { roleDirection } = await directionModule();
  const r = await rules();
  const cases = [
    ['Associate Buyer Internship (Starting Summer 2027)', undefined, false],
    ['Claims Intern - Property', 'analytics', false],
    ['(USA) Summer 2027 Corporate Intern: Delivery Operations', undefined, false],
    ['Global Sales Operations - 2027 Internship', 'ai_automation', false],
    ['Software Engineer Intern', undefined, false],
    ['Software Engineer Intern', 'software_engineering', false],
    ['Software Engineer Intern', 'ai_engineering', true],
    ['Product Manager Intern', 'product_general', false],
    ['Consumer Deposit and Payment Products Intern', undefined, false],
    ['Summer 2027 Internship - Project Management', undefined, false],
    ['Machine Learning Software Engineer Intern', undefined, true],
    ['AI Product Manager Intern', undefined, true],
    ['Sales Analytics Intern', undefined, true],
    ['Data Science Intern', undefined, true],
    ['Quantitative Research Intern', undefined, true],
    ['Research Intern', undefined, true],
  ];
  const wrong = cases.filter(([title, functionValue, ok]) => roleDirection(title, r, { functionValue }).ok !== ok)
    .map(([title, functionValue, ok]) => `${title} [${functionValue ?? '-'}]: expected ${ok ? 'in' : 'out of'} direction`);
  assert.deepEqual(wrong, []);
  assert.equal(roleDirection('Associate Buyer Internship', null).ok, true, 'without rules nothing is filtered');
});

test('[RD] the rules load from profile/role-direction.json; a missing file is no filter and a malformed one fails loudly (role direction RD1)', async () => {
  const { loadDirectionRules, roleDirection } = await directionModule();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cj-direction-'));
  try {
    assert.equal(await loadDirectionRules(dir), null, 'a missing file means no filter');
    await writeFile(path.join(dir, 'role-direction.json'), JSON.stringify(RAW_RULES));
    assert.equal(roleDirection('Associate Buyer Intern', await loadDirectionRules(dir)).ok, false);
    await writeFile(path.join(dir, 'role-direction.json'), JSON.stringify({ block: ['(unclosed'] }));
    await assert.rejects(loadDirectionRules(dir), /role-direction\.json/);
    await writeFile(path.join(dir, 'role-direction.json'), JSON.stringify({ allow: 'data' }));
    await assert.rejects(loadDirectionRules(dir), /role-direction\.json/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ===================================================================== RD2 — delivery guard

test('[L2] an eligible verdict for an out-of-direction posting creates no visible lead: role_direction, automated, never user-held (role direction RD2)', async () => {
  const { deliver, claimItem } = await delivery();
  const direction = await rules();
  const db = freshDb();
  const count = applicationsCount(db);
  for (const [id, title, functionValue] of [['p-buyer', 'Associate Buyer Intern'], ['p-claims', 'Claims Intern - Property', 'analytics'], ['p-swe', 'Software Engineer Intern', 'software_engineering'], ['p-swe-unlabelled', 'Software Engineer Intern']]) {
    insertPosting(db, { id, url: urlOf(id), company: COMPANY, title });
    insertReview(db, { postingId: id, stage: 'deliver' });
    const fence = claimItem(db, id, { owner: 'worker-a', now: T0 });
    const result = deliver(db, { postingId: id, verdict: { ...ELIGIBLE, functionValue }, fence, now: T0, policy: { ...SCREENING_POLICY, direction } });
    assert.notEqual(result.action, 'created', `${title}: no lead is created`);
    assert.deepEqual(directionProblems(db, id), []);
  }
  assert.equal(applicationsCount(db), count, 'no application is created');

  // In-direction titles, an AI-labelled software role, and any title without rules deliver normally.
  for (const [id, title, functionValue, policy] of [
    ['p-ds', 'Data Science Intern', undefined, { ...SCREENING_POLICY, direction }],
    ['p-swe-ai', 'Software Engineer Intern', 'ai_engineering', { ...SCREENING_POLICY, direction }],
    ['p-buyer-norules', 'Associate Buyer Intern', undefined, SCREENING_POLICY],
  ]) {
    insertPosting(db, { id, url: urlOf(id), company: COMPANY, title });
    insertReview(db, { postingId: id, stage: 'deliver' });
    const fence = claimItem(db, id, { owner: 'worker-a', now: T0 });
    assert.equal(deliver(db, { postingId: id, verdict: { ...ELIGIBLE, functionValue }, fence, now: T0, policy }).action, 'created', title);
    assert.equal(reviewOf(db, id).decision, 'eligible', title);
  }
});

// ===================================================================== RD3 — worker passes the function label

test('[B] the worker judges once and keeps blocked and generic software roles out of the queue, while AI-labelled and data roles stay (role direction RD2/RD3)', async () => {
  const direction = await rules();
  const db = freshDb();
  const q = queue();
  const quote = JUDGMENTS.eligible.function.quote;
  q.add(db, 'p-claims', { title: 'Claims Intern - Property' });
  q.add(db, 'p-swe-generic', { title: 'Software Engineer Intern', judgment: { ...JUDGMENTS.eligible, function: { value: 'software_engineering', quote } } });
  q.add(db, 'p-swe-ai', { title: 'Software Engineer Intern', judgment: { ...JUDGMENTS.eligible, function: { value: 'ai_ml', quote } } });
  q.add(db, 'p-analyst', { title: 'Data Analyst Intern' });
  const { judges: j } = await review(db, { pages: q.pages, answers: q.answers, direction });
  assert.deepEqual(judgedIds(j).sort(), ['p-analyst', 'p-claims', 'p-swe-ai', 'p-swe-generic'], 'each posting is judged once, no extra calls');
  const problems = ['p-claims', 'p-swe-generic'].flatMap((id) => directionProblems(db, id));
  assert.deepEqual(problems, [], `RD2/RD3: out-of-direction postings stay out of the queue:\n${problems.join('\n')}`);
  for (const id of ['p-swe-ai', 'p-analyst']) assert.ok(queued(db).includes(applicationOf(db, id)?.id), `${id} becomes a visible lead`);
  assert.equal(evidenceOf(db, 'p-swe-ai').function, 'ai_ml', 'the function label is kept for the startup pass');
});

// ===================================================================== RD4 — startup pass

test('[B] the startup pass withdraws visible out-of-direction leads without a model call, keeps user decisions, and restores when the rules change (role direction RD4)', async () => {
  const direction = await rules();
  const db = freshDb();
  const claims = deliveredLead(db, 'p-claims-lead', { title: 'Claims Intern - Property' });
  const generic = deliveredLead(db, 'p-swe-labelled', { title: 'Software Engineer Intern', functionLabel: 'software_engineering' });
  const unlabelled = deliveredLead(db, 'p-swe-unlabelled', { title: 'Software Engineer Intern' });
  const data = deliveredLead(db, 'p-data-lead', { title: 'Data Analyst Intern' });
  const prepared = deliveredLead(db, 'p-buyer-prepared', { title: 'Associate Buyer Intern' });
  db.prepare("UPDATE applications SET status = 'prepared' WHERE id = ?").run(prepared);
  const skipped = deliveredLead(db, 'p-buyer-skipped', { title: 'Associate Buyer Intern' });
  db.prepare("UPDATE applications SET status = 'withdrawn', skip_reason = 'not interested', skip_owner = 'user' WHERE id = ?").run(skipped);
  const userRows = () => JSON.stringify([prepared, skipped].map((id) => ({ row: db.prepare('SELECT * FROM applications WHERE id = ?').get(id), events: eventsOf(db, id) })));
  const users = userRows();
  assert.deepEqual(queued(db).sort(), [claims, data, generic, unlabelled].sort(), 'fixture: the delivered leads are visible');

  const first = await review(db, { budget: 0, now: T0, direction });
  assert.equal(attemptsCount(db), 0, 'the filter makes no paid attempt');
  assert.deepEqual(judgedIds(first.judges), []);
  const problems = ['p-claims-lead', 'p-swe-labelled'].flatMap((id) => directionProblems(db, id));
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(claims);
  if (app.status !== 'withdrawn') problems.push(`claims lead status ${app.status}, expected withdrawn`);
  if (app.skip_owner !== 'review') problems.push(`claims lead skip_owner ${app.skip_owner}, expected review`);
  const withdrawal = [...eventsOf(db, claims)].reverse().find((event) => event.statusAfter);
  if (withdrawal?.statusAfter !== 'withdrawn' || withdrawal.source?.actor !== 'review-worker') problems.push(`last status event ${withdrawal?.type} by ${withdrawal?.source?.actor}, expected a review-worker withdrawal`);
  assert.deepEqual(problems, [], `RD4: visible out-of-direction leads are withdrawn:\n${problems.join('\n')}`);
  assert.deepEqual(queued(db).sort(), [data, unlabelled].sort(), 'the data lead and the unlabelled software lead (no stored label) stay');
  assert.equal(userRows(), users, 'prepared and user-skipped leads are untouched');

  // A second run with the same rules changes nothing.
  const settled = reviewRows(db);
  await review(db, { budget: 0, now: at(1), direction });
  assert.equal(reviewRows(db), settled, 'a settled role_direction review is not touched again');

  // The user drops the rules file. Amended for the redesign (Lane C5, withdrawals stick): a normal run restores
  // nothing; only `review rejudge` (authorization 'rejudge') may turn the withdrawals back into leads.
  const later = await review(db, { budget: 0, now: at(2), direction: null });
  assert.equal(attemptsCount(db), 0, 'nothing is paid');
  assert.deepEqual(judgedIds(later.judges), []);
  for (const id of [claims, generic]) {
    const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
    assert.equal(row.status, 'withdrawn', `${id} stays withdrawn`);
  }
  assert.equal(reviewOf(db, 'p-claims-lead').decision, 'not_eligible');
  assert.equal(userRows(), users, 'a user skip is never restored');
});

test('[B] a refresh that re-queues a role_direction review is settled again without fetching or judging while it stays out of direction (role direction RD4)', async () => {
  const direction = await rules();
  const db = freshDb();
  const q = queue();
  q.add(db, 'p-buyer-refresh', { title: 'Associate Buyer Intern' });
  await review(db, { pages: q.pages, answers: q.answers, direction });
  assert.deepEqual(directionProblems(db, 'p-buyer-refresh'), []);
  const attempts = attemptsCount(db);
  // A freshness refresh puts the settled review back in the fetch queue.
  db.prepare("UPDATE reviews SET state = 'due', stage = 'fetch', next_due = ? WHERE posting_id = 'p-buyer-refresh'").run(at(1));
  const again = await review(db, { budget: 20, now: at(1), pages: q.pages, answers: q.answers, direction });
  assert.deepEqual(judgedIds(again.judges), [], 'no judge call');
  assert.deepEqual(again.fetcher.calls, [], 'no fetch');
  assert.equal(attemptsCount(db), attempts, 'no paid attempt');
  assert.deepEqual(directionProblems(db, 'p-buyer-refresh'), []);
});

// ===================================================================== RD5 — not a dependency

test('[B] the direction rules are not a judge dependency: adding or changing them re-judges and re-queues nothing (role direction RD5)', async () => {
  const { judgeDependencies } = await inputsModule();
  const { inputState } = await workerModule();
  const direction = await rules();
  const adapter = { runner: 'fake', model: 'fake-primary', tier: 'primary', effort: null, cliVersion: 'fake-1' };
  const deps = (inputs) => judgeDependencies({ inputs, adapter, skeletonVersion: 'v', schemaHash: 's', decideVersion: 'd' }).hash;
  assert.equal(deps(reviewInputs({ direction })), deps(reviewInputs()), 'direction is not part of the judge dependency hash');
  assert.equal(JSON.stringify(inputState(reviewInputs({ direction }))), JSON.stringify(inputState(reviewInputs())), 'direction is not part of the input state');

  const db = freshDb();
  const q = queue();
  q.add(db, 'p-data-a', { title: 'Data Analyst Intern' });
  q.add(db, 'p-buyer-a', { title: 'Associate Buyer Intern' });
  const settledRun = await review(db, { pages: q.pages, answers: q.answers });
  assert.deepEqual(judgedIds(settledRun.judges).sort(), ['p-buyer-a', 'p-data-a'], 'without rules nothing is filtered');
  const attempts = attemptsCount(db);

  // Rules that filter neither lead: a budget-0 run changes no review and makes no attempt.
  const rows = reviewRows(db);
  await review(db, { budget: 0, now: at(1), direction: (await directionModule()).directionRules({ block: ['\\bnothing-matches\\b'] }) });
  assert.equal(attemptsCount(db), attempts, 'a rules change makes no paid attempt');
  assert.equal(reviewRows(db), rows, 'a rules change re-queues no settled review');

  // The real rules withdraw the buyer lead without any judge call; the data lead is untouched.
  const filtered = await review(db, { budget: 20, now: at(2), pages: q.pages, answers: q.answers, direction });
  assert.deepEqual(judgedIds(filtered.judges), [], 'adding the rules re-judges nothing');
  assert.equal(attemptsCount(db), attempts);
  assert.deepEqual(directionProblems(db, 'p-buyer-a'), []);
  assert.equal(reviewOf(db, 'p-data-a').decision, 'eligible');
});

test('[B] loadReviewInputs reads profile/role-direction.json and leaves it out of every dependency (role direction RD5)', async () => {
  const { loadReviewInputs, judgeDependencies } = await inputsModule();
  const { writeReviewFiles } = await import('../../test-utils/funnel-v3-fixtures.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-direction-home-'));
  try {
    const profile = path.join(home, '.career-journal', 'profile');
    await writeReviewFiles(profile);
    const without = await loadReviewInputs(home);
    assert.equal(without.direction ?? null, null, 'no file, no rules');
    await writeFile(path.join(profile, 'role-direction.json'), JSON.stringify(RAW_RULES));
    const withRules = await loadReviewInputs(home);
    const { roleDirection } = await directionModule();
    assert.equal(roleDirection('Associate Buyer Intern', withRules.direction).ok, false, 'the rules are loaded');
    const adapter = { runner: 'fake', model: 'fake-primary', tier: 'primary', effort: null, cliVersion: 'fake-1' };
    const deps = (inputs) => judgeDependencies({ inputs, adapter, skeletonVersion: 'v', schemaHash: 's', decideVersion: 'd' }).hash;
    assert.equal(deps(withRules), deps(without));
  } finally { await rm(home, { recursive: true, force: true }); }
});

// ===================================================================== RD6 — queue list

test('[RD] queue list flags blocked-title leads and sorts them after every in-direction lead; without rules the order is unchanged (role direction RD6)', async () => {
  const direction = await rules();
  const db = freshDb();
  const add = (id, role, fit) => db.prepare(`INSERT INTO applications (id, company, role, status, fit, created_at, updated_at) VALUES (?, ?, ?, 'lead', ?, ?, ?)`)
    .run(id, COMPANY, role, fit, T0, T0);
  add('buyer', 'Associate Buyer Internship', 'high');
  add('claims', 'Claims Intern - Property', 'high');
  add('analyst', 'Data Analyst Intern', 'medium');
  add('quant', 'Quantitative Research Intern', 'low');
  assert.deepEqual(queued(db), ['buyer', 'claims', 'analyst', 'quant'], 'without rules: fit order');
  const rows = listQueue(db, null, { direction });
  assert.deepEqual(rows.map((row) => row.id), ['analyst', 'quant', 'buyer', 'claims'], 'blocked leads go last');
  assert.deepEqual(rows.map((row) => row.directionOk), [true, true, false, false]);
  assert.ok(rows.filter((row) => !row.directionOk).every((row) => typeof row.directionReason === 'string' && row.directionReason));
});
