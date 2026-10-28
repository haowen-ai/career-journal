// Company cap regressions for the user rule of 2026-10-27, 「同一家公司3个月最多投递5个」: at most five applications
// per company in any rolling 90 days. On the live queue, companies already over that count still had open leads
// reaching the queue, and the user skipped them by hand.
// Rulings:
//   C1  A submission is an application with status applied/assessment/interview/rejected/offer. Its date is
//       applied_at, else the latest 'submitted' event's occurred_at, else updated_at (live rows recorded today have
//       applied_at NULL). Submissions are grouped by companyKey with the screening policy's companyAliases.
//   C2  A company with >= max submissions inside the window gets no new visible lead: an eligible verdict is settled
//       not visible with code 'company_cap' and automated provenance, never held for the user. A due review of a
//       capped company is settled by the worker's startup pass without fetching or judging it.
//   C3  The worker's startup pass also withdraws existing visible leads of a capped company (actor review-worker,
//       skip_owner 'review'). Leads the user decided (prepared, user-skipped) are never touched.
//   C4  Once older submissions leave the window, the same pass restores what it capped: a capped eligible verdict
//       is re-delivered as a visible lead without a model call; a review capped before judgment is due again. Only
//       automated withdrawals are restored, never a user's skip.
//   C5  Fewer than max submissions in the window (or the extra ones older than the window) leave the company uncapped.
//   C6  The cap is review policy (policy.companyCap = { max, windowDays }); without it nothing is capped. It is not a
//       judge dependency: changing it re-queues and re-judges nothing (a budget-0 run makes zero paid attempts).
//   C7  Submitted applications (rows and events) are never modified.
// Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, insertPosting, insertReview, reviewOf, eventsOf, applicationsCount, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SCREENING_POLICY, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { listQueue } from '../../src/commands/queue.mjs';

const workerModule = () => load('B6', './src/review/worker.mjs', ['runReview']);
const delivery = async () => ({
  ...(await load('L2', './src/review/deliver.mjs', ['deliver'])),
  ...(await load('L2', './src/review/lease.mjs', ['claimItem'])),
});
const inputsModule = () => load('B1', './src/review/inputs.mjs', ['judgeDependencies']);

const CAPPED = 'Capped Example Co';
const FREE = 'Free Example Co';
const CAP = Object.freeze({ max: 5, windowDays: 90 });
const CAP_POLICY = Object.freeze({ ...REVIEW_POLICY, companyCap: CAP });
const SCREENING = Object.freeze({ ...SCREENING_POLICY, companyAliases: { 'Capped Example Holdings': CAPPED } });
const ELIGIBLE = { decision: 'eligible', code: null, fit: { level: 'medium', note: 'SQL and Python match' }, deadline: { kind: 'none' },
  location: { offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' }], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' } };

// ------------------------------------------------------------------ helpers

const urlOf = (id) => `https://job-boards.greenhouse.io/capexample/jobs/${id.replace(/[^0-9a-z]/gi, '')}`;
const retitled = (text, title) => text.replace(snapshotTitle(text), title);
let seq = 0;

// A submitted application dated as live rows are: applied_at, or only a 'submitted' event, or only updated_at.
function submission(db, { company = CAPPED, daysAgo, now = T0, status = 'applied', dated = 'applied_at', role }) {
  const id = `sub-${seq += 1}`;
  const when = at(-daysAgo, now);
  const old = at(-400, now);
  db.prepare(`INSERT INTO applications (id, company, role, job_url, status, applied_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, company, role ?? `Submitted Role ${seq}`, `https://jobs.example.test/${id}`, status, dated === 'applied_at' ? when : null, old, dated === 'updated_at' ? when : old);
  if (dated === 'event') {
    db.prepare(`INSERT INTO application_events (id, application_id, event_type, occurred_at, observed_at, recorded_at, title, note, source_json, status_after, content_hash)
      VALUES (?, ?, 'submitted', ?, ?, ?, 'submitted', '', ?, 'applied', ?)`).run(`ev-${id}`, id, when, old, old, JSON.stringify({ kind: 'seed' }), `h-${id}`);
  }
  return id;
}
// Five submissions in the window, using every date source and the company alias (C1).
function fiveSubmissions(db, { now = T0, ages = [10, 20, 30, 40, 50] } = {}) {
  return [
    submission(db, { daysAgo: ages[0], now }),
    submission(db, { daysAgo: ages[1], now, status: 'rejected' }),
    submission(db, { daysAgo: ages[2], now, dated: 'event' }),
    submission(db, { daysAgo: ages[3], now, dated: 'updated_at', status: 'assessment' }),
    submission(db, { daysAgo: ages[4], now, company: 'Capped Example Holdings', status: 'interview' }),
  ];
}
const submittedState = (db, ids) => JSON.stringify(ids.map((id) => ({ row: db.prepare('SELECT * FROM applications WHERE id = ?').get(id), events: eventsOf(db, id) })));
const queued = (db) => listQueue(db).map((row) => row.id);
const applicationOf = (db, postingId) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(postingId);
const evidenceOf = (db, id) => JSON.parse(reviewOf(db, id).evidence_json || '{}');
const attemptsCount = (db) => db.prepare('SELECT COUNT(*) n FROM attempts').get().n;
const reviewRows = (db) => JSON.stringify(db.prepare('SELECT posting_id, state, decision, code, next_due, hold_owner, dep_hashes_json FROM reviews ORDER BY posting_id').all());

function queue() {
  const pages = {};
  const answers = {};
  return {
    pages,
    answers,
    add(db, id, { company = CAPPED, title = 'Data Science Intern', lane = 'new', firstSeen = T0 } = {}) {
      insertPosting(db, { id, url: urlOf(id), company, title, firstSeen });
      insertReview(db, { postingId: id, stage: 'fetch', firstSeen, nextDue: firstSeen, lane });
      pages[urlOf(id)] = page(urlOf(id), retitled(SNAPSHOTS.eligible, title));
      answers[id] = { output: JUDGMENTS.eligible };
      return id;
    },
  };
}

// A lead the worker delivered as eligible before the cap existed: visible, review done eligible.
function deliveredLead(db, id, { company = CAPPED, now = T0 } = {}) {
  const appId = `lead-${id}`;
  db.prepare(`INSERT INTO applications (id, company, role, job_url, status, created_at, updated_at) VALUES (?, ?, 'Data Science Intern', ?, 'lead', ?, ?)`)
    .run(appId, company, urlOf(id), now, now);
  insertPosting(db, { id, url: urlOf(id), company, applicationId: appId, firstSeen: now });
  insertReview(db, { postingId: id, stage: 'deliver', state: 'done', decision: 'eligible', firstSeen: now, nextDue: null });
  db.prepare('UPDATE reviews SET evidence_json = ? WHERE posting_id = ?').run(JSON.stringify({ fit: ELIGIBLE.fit, location: ELIGIBLE.location, deadline: { kind: 'none' }, evidence: [] }), id);
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
async function review(db, { pages = {}, answers = {}, policy = CAP_POLICY, budget = 20, now = T0, runId = `review-cap-${seq += 1}` } = {}) {
  const { runReview } = await workerModule();
  const fetcher = fakeFetcher(pages);
  const j = judges(answers);
  const receipt = await offline(() => runReview({ db, runId, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher, judges: j, inputs: () => reviewInputs({ policy, screeningPolicy: SCREENING }), hooks: {} }));
  return { receipt, fetcher, judges: j };
}

// Problems with a posting the cap must keep out of the queue (empty when C2/C3 hold).
function cappedProblems(db, postingId) {
  const problems = [];
  const row = reviewOf(db, postingId);
  if (row.code !== 'company_cap') problems.push(`${postingId}: review code ${row.code} (state ${row.state}, decision ${row.decision}), expected company_cap`);
  if (row.decision === 'eligible') problems.push(`${postingId}: still decided eligible`);
  if (['due', 'leased'].includes(row.state)) problems.push(`${postingId}: still queued (${row.state})`);
  if (row.hold_owner === 'user') problems.push(`${postingId}: held for the user`);
  if (evidenceOf(db, postingId).provenance !== 'automated') problems.push(`${postingId}: evidence provenance ${evidenceOf(db, postingId).provenance}, expected automated`);
  const app = applicationOf(db, postingId);
  if (app && queued(db).includes(app.id)) problems.push(`${postingId}: lead ${app.id} is visible in the queue`);
  return problems;
}

// ===================================================================== C2 — delivery guard

test('[L2] an eligible verdict for a company with five submissions in 90 days creates no visible lead: company_cap, automated, never user-held (company cap C1/C2/C7)', async () => {
  const { deliver, claimItem } = await delivery();
  const db = freshDb();
  const submitted = fiveSubmissions(db);
  const before = submittedState(db, submitted);
  insertPosting(db, { id: 'p-cap-deliver', url: urlOf('p-cap-deliver'), company: CAPPED });
  insertReview(db, { postingId: 'p-cap-deliver', stage: 'deliver' });
  const count = applicationsCount(db);
  const fence = claimItem(db, 'p-cap-deliver', { owner: 'worker-a', now: T0 });
  const result = deliver(db, { postingId: 'p-cap-deliver', verdict: ELIGIBLE, fence, now: T0, policy: { ...SCREENING, companyCap: CAP } });
  assert.notEqual(result.action, 'created', 'no lead is created');
  assert.equal(applicationsCount(db), count, 'no application is created');
  assert.deepEqual(cappedProblems(db, 'p-cap-deliver'), []);
  assert.equal(submittedState(db, submitted), before, 'the submitted applications are untouched (C7)');

  // The same verdict without a cap in the policy delivers normally (C6).
  insertPosting(db, { id: 'p-nocap-deliver', url: urlOf('p-nocap-deliver'), company: CAPPED });
  insertReview(db, { postingId: 'p-nocap-deliver', stage: 'deliver' });
  const open = claimItem(db, 'p-nocap-deliver', { owner: 'worker-a', now: T0 });
  assert.equal(deliver(db, { postingId: 'p-nocap-deliver', verdict: ELIGIBLE, fence: open, now: T0, policy: SCREENING }).action, 'created');
});

test('[B] the worker settles a due review of a capped company without fetching or judging it, and reviews other companies normally (company cap C2)', async () => {
  const db = freshDb();
  const submitted = fiveSubmissions(db);
  const before = submittedState(db, submitted);
  const q = queue();
  q.add(db, 'p-cap-new');
  q.add(db, 'p-cap-bootstrap', { title: 'Analytics Intern', lane: 'bootstrap' });
  q.add(db, 'p-free-new', { company: FREE });
  const { fetcher, judges: j } = await review(db, { pages: q.pages, answers: q.answers });
  assert.deepEqual(judgedIds(j), ['p-free-new'], 'only the uncapped company is judged');
  assert.deepEqual(fetcher.calls.map((call) => call.url), [urlOf('p-free-new')], 'only the uncapped company is fetched');
  const problems = ['p-cap-new', 'p-cap-bootstrap'].flatMap((id) => cappedProblems(db, id));
  assert.deepEqual(problems, [], `C2: a capped company gets no new lead:\n${problems.join('\n')}`);
  assert.equal(applicationOf(db, 'p-cap-new'), undefined, 'no application for a capped posting');
  assert.ok(queued(db).includes(applicationOf(db, 'p-free-new')?.id), 'the uncapped posting becomes a visible lead');
  assert.equal(submittedState(db, submitted), before, 'the submitted applications are untouched (C7)');
});

// ===================================================================== C3 + C4 — startup pass

test('[B] the startup pass withdraws visible leads of a capped company and restores them when submissions age out; user decisions stay (company cap C3/C4/C7)', async () => {
  const db = freshDb();
  // Two submissions 80 days before T0 leave the window by T0+15 days.
  const submitted = fiveSubmissions(db, { ages: [80, 80, 10, 5, 3] });
  const q = queue();
  const lead = deliveredLead(db, 'p-cap-lead', { now: at(-1) });
  const freeLead = deliveredLead(db, 'p-free-lead', { company: FREE, now: at(-1) });
  // The user prepared one lead and skipped another of the capped company.
  const prepared = deliveredLead(db, 'p-cap-prepared', { now: at(-1) });
  db.prepare("UPDATE applications SET status = 'prepared' WHERE id = ?").run(prepared);
  const skipped = deliveredLead(db, 'p-cap-skipped', { now: at(-1) });
  db.prepare("UPDATE applications SET status = 'withdrawn', skip_reason = 'not interested', skip_owner = 'user' WHERE id = ?").run(skipped);
  db.prepare(`INSERT INTO application_events (id, application_id, event_type, observed_at, recorded_at, title, note, source_json, status_after, content_hash)
    VALUES ('user-skip', ?, 'queue_skipped', ?, ?, 'skipped', 'not interested', ?, 'withdrawn', 'h-user-skip')`).run(skipped, at(-0.5), at(-0.5), JSON.stringify({ actor: 'user' }));
  q.add(db, 'p-cap-unjudged', { title: 'Analytics Intern' });
  const before = submittedState(db, submitted);
  const userRows = () => JSON.stringify([prepared, skipped].map((id) => ({ row: db.prepare('SELECT * FROM applications WHERE id = ?').get(id), events: eventsOf(db, id) })));
  const users = userRows();
  assert.deepEqual(queued(db).sort(), [lead, freeLead].sort(), 'fixture: both delivered leads are visible');

  const first = await review(db, { budget: 0, now: T0 });
  assert.equal(attemptsCount(db), 0, 'the cap makes no paid attempt');
  assert.deepEqual(judgedIds(first.judges), []);
  const problems = cappedProblems(db, 'p-cap-lead');
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(lead);
  if (app.status !== 'withdrawn') problems.push(`lead status ${app.status}, expected withdrawn`);
  if (app.skip_owner !== 'review') problems.push(`lead skip_owner ${app.skip_owner}, expected review`);
  const withdrawal = [...eventsOf(db, lead)].reverse().find((event) => event.statusAfter);
  if (withdrawal?.statusAfter !== 'withdrawn' || withdrawal.source?.actor !== 'review-worker') problems.push(`last status event ${withdrawal?.type} by ${withdrawal?.source?.actor}, expected a review-worker withdrawal`);
  problems.push(...cappedProblems(db, 'p-cap-unjudged'));
  assert.deepEqual(problems, [], `C3: visible leads of a capped company are withdrawn:\n${problems.join('\n')}`);
  assert.deepEqual(queued(db), [freeLead], 'the other company keeps its lead');
  assert.equal(userRows(), users, 'prepared and user-skipped leads are untouched');
  assert.equal(submittedState(db, submitted), before, 'the submitted applications are untouched (C7)');

  // A second run while still capped changes nothing.
  const settled = reviewRows(db);
  await review(db, { budget: 0, now: at(1) });
  assert.equal(reviewRows(db), settled, 'a capped review is not touched again while the company stays capped');

  // T0+15: the two 80-day submissions are 95 days old; three remain in the window.
  const later = await review(db, { budget: 0, now: at(15) });
  assert.equal(attemptsCount(db), 0, 'restoring makes no paid attempt');
  assert.deepEqual(judgedIds(later.judges), []);
  const restored = db.prepare('SELECT * FROM applications WHERE id = ?').get(lead);
  assert.equal(restored.status, 'lead', 'C4: the capped lead is restored');
  assert.equal(restored.skip_reason, null);
  assert.ok(queued(db).includes(lead), 'C4: the restored lead is visible again');
  assert.deepEqual([reviewOf(db, 'p-cap-lead').decision, reviewOf(db, 'p-cap-lead').code], ['eligible', null]);
  assert.equal(reviewOf(db, 'p-cap-unjudged').state, 'due', 'C4: a review capped before judgment is due again');
  assert.notEqual(reviewOf(db, 'p-cap-unjudged').code, 'company_cap');
  assert.equal(userRows(), users, 'C4: a user skip is never restored');
  assert.equal(submittedState(db, submitted), before, 'the submitted applications are untouched (C7)');
});

// ===================================================================== C5 — below the cap

test('[B] four submissions in 90 days, or a fifth older than the window, leave the company uncapped; leads and prepared applications do not count (company cap C1/C5)', async () => {
  for (const [name, seed] of [
    ['four submissions', (db) => [10, 20, 30, 40].forEach((daysAgo) => submission(db, { daysAgo }))],
    ['fifth older than the window', (db) => fiveSubmissions(db, { ages: [10, 20, 30, 40, 91] })],
    ['fifth is a lead, a prepared and a withdrawn application', (db) => {
      fiveSubmissions(db, { ages: [10, 20, 30, 40, 400] });
      for (const status of ['lead', 'prepared', 'withdrawn']) {
        db.prepare(`INSERT INTO applications (id, company, role, status, applied_at, created_at, updated_at) VALUES (?, ?, 'Other Role', ?, NULL, ?, ?)`)
          .run(`other-${status}`, CAPPED, status, at(-2), at(-2));
      }
    }],
  ]) {
    const db = freshDb();
    seed(db);
    const q = queue();
    q.add(db, 'p-cap-free');
    const { judges: j } = await review(db, { pages: q.pages, answers: q.answers });
    assert.deepEqual(judgedIds(j), ['p-cap-free'], `${name}: the posting is judged`);
    assert.equal(reviewOf(db, 'p-cap-free').decision, 'eligible', name);
    assert.ok(queued(db).includes(applicationOf(db, 'p-cap-free')?.id), `${name}: the lead is visible`);
  }
});

// ===================================================================== C6 — policy, not a dependency

test('[B] the cap comes from review policy and is not a judge dependency: adding or changing it re-judges and re-queues nothing (company cap C6)', async () => {
  const { judgeDependencies } = await inputsModule();
  const adapter = { runner: 'fake', model: 'fake-primary', tier: 'primary', effort: null, cliVersion: 'fake-1' };
  const deps = (policy) => judgeDependencies({ inputs: reviewInputs({ policy, screeningPolicy: SCREENING }), adapter, skeletonVersion: 'v', schemaHash: 's', decideVersion: 'd' }).hash;
  assert.equal(deps(CAP_POLICY), deps(REVIEW_POLICY), 'companyCap is not part of the judge dependency hash');
  assert.equal(deps({ ...REVIEW_POLICY, companyCap: { max: 2, windowDays: 30 } }), deps(REVIEW_POLICY));

  const db = freshDb();
  fiveSubmissions(db);
  const q = queue();
  q.add(db, 'p-uncapped-a');
  q.add(db, 'p-free-a', { company: FREE });
  const settledRun = await review(db, { pages: q.pages, answers: q.answers, policy: REVIEW_POLICY });
  assert.deepEqual(judgedIds(settledRun.judges).sort(), ['p-free-a', 'p-uncapped-a'], 'without companyCap nothing is capped');
  assert.equal(reviewOf(db, 'p-uncapped-a').decision, 'eligible');
  const attempts = attemptsCount(db);

  // A looser cap that caps nothing: a budget-0 run changes no review and makes no attempt.
  const rows = reviewRows(db);
  await review(db, { budget: 0, now: at(1), policy: { ...REVIEW_POLICY, companyCap: { max: 10, windowDays: 90 } } });
  assert.equal(attemptsCount(db), attempts, 'a companyCap change makes no paid attempt');
  assert.equal(reviewRows(db), rows, 'a companyCap change re-queues no settled review');

  // The real cap: the visible lead is withdrawn without any judge call or attempt; the other company is untouched.
  const capped = await review(db, { budget: 20, now: at(2), pages: q.pages, answers: q.answers, policy: CAP_POLICY });
  assert.deepEqual(judgedIds(capped.judges), [], 'adding the cap re-judges nothing');
  assert.equal(attemptsCount(db), attempts);
  assert.deepEqual(cappedProblems(db, 'p-uncapped-a'), []);
  assert.equal(reviewOf(db, 'p-free-a').decision, 'eligible');
  assert.equal(reviewOf(db, 'p-free-a').state, 'done');
});
