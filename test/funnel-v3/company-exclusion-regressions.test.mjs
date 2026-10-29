// Company exclusions the user adds outside the judge dependencies (user decisions of 2026-10-29: some employers are
// disliked or declined, and a whole class of employers is out). screening-policy.json userExcludedCompanies is a judge
// dependency: editing it re-queues every settled review for a paid re-judgment. So these exclusions live in
// profile/company-overrides.json, read at scan, decision and delivery time only:
//   { rule, ..., excludedCompanies[], excludedCompanyPatterns[] }
// Rulings:
//   CE1 excludedCompanies is a list of company names; excludedCompanyPatterns a list of case-insensitive regular
//       expressions tested against the company name. Missing keys mean nothing extra is excluded; a non-list, an empty
//       entry or an invalid expression fails loudly.
//   CE2 Both merge into the effective user exclusion: a name matches with the same company key and aliases as
//       userExcludedCompanies (case, punctuation, legal suffixes, a leading "The"); a pattern matches the raw name.
//       A re-allowed company is never excluded. The screening policy object itself is not modified.
//   CE3 Scan drops a posting at an override-excluded company with code company_excluded, exactly like a user-excluded
//       one.
//   CE4 At delivery an eligible verdict at an override-excluded company creates no lead: the review is settled
//       not_eligible company_excluded with automated provenance, and a withdrawn lead's reason reads
//       "company_excluded (user)".
//   CE5 The startup pass, without fetching or judging, withdraws visible review-delivered leads at excluded companies
//       and settles due and held reviews there. Applied, prepared, user-skipped and user-logged applications are never
//       touched. A second run changes nothing; a refresh that re-queues a settled review is settled again. When the
//       user removes the exclusion, a judged lead is restored without a model call and an unjudged review goes back
//       to the fetch queue.
//   CE6 The new keys are not judge dependencies: adding them changes neither the dependency hash nor the review input
//       state, and re-judges nothing.
// Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, load, insertPosting, insertReview, reviewOf, eventsOf, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { SCREENING_POLICY, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs, writeReviewHome } from '../../test-utils/funnel-v3-fixtures.mjs';
import { listQueue } from '../../src/commands/queue.mjs';

const overridesModule = () => load('CE1', './src/review/overrides.mjs', ['loadUserOverrides', 'withOverrides', 'emptyOverrides', 'companyExcluded']);
const workerModule = () => load('CE5', './src/review/worker.mjs', ['runReview', 'inputState']);
const inputsModule = () => load('CE6', './src/review/inputs.mjs', ['judgeDependencies', 'loadReviewInputs']);
const classifyModule = () => load('CE3', './src/funnel/classify.mjs', ['classifyRole']);
const deliveryModule = async () => ({
  ...(await load('CE4', './src/review/deliver.mjs', ['deliver', 'deliveryPolicy'])),
  ...(await load('CE4', './src/review/lease.mjs', ['claimItem'])),
});

const DISLIKED = 'Disliked Example Group';            // as the user lists it
const DISLIKED_POSTING = 'disliked example group, inc.'; // as a posting names it
const AGENCY = 'Department of Example Affairs';         // hit by a pattern
const PRIVATE = 'Example Departments Store Co';         // must not be hit by the pattern
const ALIASED = 'DEG Labs';                              // an alias of DISLIKED in the screening policy
const REALLOWED = 'Reallowed Example Co';
const OK = 'Plain Example Co';
const RAW = Object.freeze({
  rule: 'synthetic',
  excludedCompanies: [DISLIKED, '  Another Disliked Co  '],
  excludedCompanyPatterns: ['^department of\\b', '^the example federal reserve\\b', `^${REALLOWED}$`],
  reallowedCompanies: [REALLOWED],
});
const SCREENING = Object.freeze({ ...SCREENING_POLICY, userExcludedCompanies: ['Screening Excluded Co'], companyAliases: { [ALIASED]: DISLIKED } });

const urlOf = (id) => `https://job-boards.greenhouse.io/exclusionexample/jobs/${id.replace(/[^0-9a-z]/gi, '')}`;
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const evidenceOf = (db, id) => parse(reviewOf(db, id).evidence_json, {});
const outcome = (db, id) => { const row = reviewOf(db, id); return [row.state, row.decision, row.code]; };
const applicationOf = (db, postingId) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(postingId);
const queued = (db) => listQueue(db).map((row) => row.id);
const attemptsCount = (db) => db.prepare('SELECT COUNT(*) n FROM attempts').get().n;
const reviewRows = (db) => JSON.stringify(db.prepare('SELECT posting_id, state, decision, code, next_due, hold_owner, evidence_json, dep_hashes_json FROM reviews ORDER BY posting_id').all());
const ELIGIBLE = { decision: 'eligible', code: null, fit: { level: 'high', note: 'analytics' }, deadline: { kind: 'none' },
  location: { offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' }], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' } };

async function overrides(raw = RAW) {
  const { loadUserOverrides } = await overridesModule();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cj-exclusion-'));
  try {
    await writeFile(path.join(dir, 'company-overrides.json'), JSON.stringify(raw));
    return await loadUserOverrides(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// A lead the worker delivered as eligible before the exclusion existed: visible, review done eligible.
function deliveredLead(db, id, { company, now = at(-1) }) {
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
function dueReview(db, id, { company, state = 'due', holdOwner = null }) {
  insertPosting(db, { id, url: urlOf(id), company });
  insertReview(db, { postingId: id, stage: state === 'held' ? 'deliver' : 'fetch', state, holdOwner, decision: state === 'held' ? 'unclear' : null, code: state === 'held' ? 'user_review' : null });
  return id;
}

function judges(answers = {}) {
  const respond = (request) => answers[request.postingId] ?? { output: JUDGMENTS.eligible };
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
let seq = 0;
async function review(db, { pages = {}, answers = {}, overrides: o, budget = 20, now = T0 } = {}) {
  const { runReview } = await workerModule();
  const fetcher = fakeFetcher(pages);
  const j = judges(answers);
  const receipt = await offline(() => runReview({ db, runId: `review-exclusion-${seq += 1}`, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null,
    sleep: async () => {}, fetcher, judges: j, inputs: () => reviewInputs({ screeningPolicy: SCREENING, ...(o ? { overrides: o } : {}) }), hooks: {} }));
  return { receipt, fetcher, judges: j };
}

// ===================================================================== CE1 — loading

test('[CE] excludedCompanies and excludedCompanyPatterns load from company-overrides.json; missing keys exclude nothing and malformed ones fail loudly (exclusion CE1)', async () => {
  const { loadUserOverrides, emptyOverrides } = await overridesModule();
  const loaded = await overrides();
  assert.deepEqual(loaded.excludedCompanies, [DISLIKED, 'Another Disliked Co'], 'names are trimmed');
  assert.deepEqual(loaded.excludedCompanyPatterns, RAW.excludedCompanyPatterns);
  const empty = emptyOverrides();
  assert.deepEqual([empty.excludedCompanies, empty.excludedCompanyPatterns], [[], []]);
  const older = await overrides({ rule: 'synthetic', reallowedCompanies: [REALLOWED] });
  assert.deepEqual([older.excludedCompanies, older.excludedCompanyPatterns], [[], []], 'a file without the keys excludes nothing');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cj-exclusion-bad-'));
  try {
    for (const bad of [{ excludedCompanies: 'Disliked' }, { excludedCompanies: [''] }, { excludedCompanyPatterns: ['(unclosed'] }, { excludedCompanyPatterns: [3] }]) {
      await writeFile(path.join(dir, 'company-overrides.json'), JSON.stringify(bad));
      await assert.rejects(loadUserOverrides(dir), /company-overrides\.json/, JSON.stringify(bad));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ===================================================================== CE2 — matching

test('[CE] names match like userExcludedCompanies (case, suffixes, aliases), patterns match whole classes narrowly, re-allowed wins, the policy is not modified (exclusion CE2)', async () => {
  const { withOverrides, companyExcluded } = await overridesModule();
  const policy = withOverrides(SCREENING, await overrides());
  assert.deepEqual(SCREENING.userExcludedCompanies, ['Screening Excluded Co'], 'the screening policy object is not modified');
  const cases = [
    [DISLIKED, 'user'], [DISLIKED_POSTING, 'user'], ['The Disliked Example Group LLC', 'user'], [ALIASED, 'user'], ['another disliked co', 'user'],
    [AGENCY, 'user'], ['department of example transit', 'user'], ['The Example Federal Reserve Bank of Somewhere', 'user'],
    ['Screening Excluded Co', 'screening'],
    [PRIVATE, null], [OK, null], ['Disliked Example Groupon', null], [REALLOWED, null], [null, null],
  ];
  const wrong = cases.filter(([company, source]) => (companyExcluded(company, policy)?.source ?? null) !== source)
    .map(([company, source]) => `${company}: expected ${source ?? 'not excluded'}, got ${companyExcluded(company, policy)?.source ?? 'not excluded'}`);
  assert.deepEqual(wrong, []);
  assert.equal(companyExcluded(DISLIKED, withOverrides(SCREENING, null)), null, 'without overrides only the screening list applies');
});

// ===================================================================== CE3 — scan

test('[CE] scan drops a posting at an override-excluded company as company_excluded, exactly like a user-excluded one (exclusion CE3)', async () => {
  const { withOverrides } = await overridesModule();
  const { classifyRole } = await classifyModule();
  const policy = withOverrides(SCREENING, await overrides());
  const record = (company) => ({ company, title: 'Data Science Intern', url: urlOf(company), locations: ['Chicago, IL'], completeness: { locations: 'complete', arrangement: 'known' }, remote: false });
  for (const company of [DISLIKED_POSTING, ALIASED, AGENCY, 'Screening Excluded Co']) {
    const result = classifyRole(record(company), { policy });
    assert.deepEqual([result.kind, result.code], ['drop', 'company_excluded'], company);
  }
  for (const company of [PRIVATE, OK, REALLOWED]) assert.equal(classifyRole(record(company), { policy }).kind, 'review', company);
});

// ===================================================================== CE4 — delivery

test('[CE] an eligible verdict at an override-excluded company creates no lead and is settled company_excluded, automated (exclusion CE4)', async () => {
  const { deliver, deliveryPolicy, claimItem } = await deliveryModule();
  const o = await overrides();
  const db = freshDb();
  const policy = deliveryPolicy(reviewInputs({ screeningPolicy: SCREENING, overrides: o }));
  const delivered = (id, company) => {
    insertPosting(db, { id, url: urlOf(id), company });
    insertReview(db, { postingId: id, stage: 'deliver' });
    const fence = claimItem(db, id, { owner: 'worker-a', now: T0 });
    return deliver(db, { postingId: id, fence, now: T0, verdict: ELIGIBLE, policy });
  };
  for (const [id, company] of [['p-disliked', DISLIKED_POSTING], ['p-agency', AGENCY]]) {
    assert.notEqual(delivered(id, company).action, 'created', company);
    assert.deepEqual(outcome(db, id), ['done', 'not_eligible', 'company_excluded'], company);
    assert.equal(evidenceOf(db, id).provenance, 'automated', `${company}: automated provenance`);
    assert.equal(evidenceOf(db, id).companyExcluded?.source, 'user', `${company}: the exclusion source is kept`);
    assert.equal(applicationOf(db, id), undefined, `${company}: no application`);
  }
  assert.equal(delivered('p-ok', PRIVATE).action, 'created', 'a private company the pattern does not hit is delivered');
  assert.equal(delivered('p-reallowed', REALLOWED).action, 'created', 'a re-allowed company is delivered');
});

// ===================================================================== CE5 — startup pass

test('[B] the startup pass withdraws visible leads and settles due and held reviews at excluded companies without a model call; user decisions are untouched; removing the exclusion restores (exclusion CE5)', async () => {
  const o = await overrides();
  const db = freshDb();
  const visible = deliveredLead(db, 'p-lead-disliked', { company: DISLIKED_POSTING });
  const agencyLead = deliveredLead(db, 'p-lead-agency', { company: AGENCY });
  const kept = deliveredLead(db, 'p-lead-ok', { company: OK });
  const privateLead = deliveredLead(db, 'p-lead-private', { company: PRIVATE });
  dueReview(db, 'p-due-disliked', { company: ALIASED });
  dueReview(db, 'p-held-agency', { company: AGENCY, state: 'held', holdOwner: 'user' });
  // User decisions at excluded companies.
  const applied = deliveredLead(db, 'p-applied', { company: DISLIKED });
  db.prepare("UPDATE applications SET status = 'applied', applied_at = ? WHERE id = ?").run(at(-1), applied);
  const prepared = deliveredLead(db, 'p-prepared', { company: DISLIKED });
  db.prepare("UPDATE applications SET status = 'prepared' WHERE id = ?").run(prepared);
  const skipped = deliveredLead(db, 'p-skipped', { company: AGENCY });
  db.prepare("UPDATE applications SET status = 'withdrawn', skip_reason = 'not interested', skip_owner = 'user' WHERE id = ?").run(skipped);
  const logged = deliveredLead(db, 'p-user-logged', { company: AGENCY });
  db.prepare("INSERT INTO review_log (posting_id, at, stage, kind, attempt_id, payload_json) VALUES ('p-user-logged', ?, 'deliver', 'user', NULL, '{}')").run(at(-1));
  const userRows = () => JSON.stringify([applied, prepared, skipped, logged].map((id) => ({ row: db.prepare('SELECT * FROM applications WHERE id = ?').get(id), events: eventsOf(db, id),
    review: reviewOf(db, id.replace(/^lead-/, '')) })));
  const users = userRows();

  const first = await review(db, { budget: 20, overrides: o });
  assert.deepEqual(judgedIds(first.judges), [], 'no judge call');
  assert.deepEqual(first.fetcher.calls, [], 'no fetch');
  assert.equal(attemptsCount(db), 0, 'no paid attempt');
  const problems = [];
  for (const [id, appId] of [['p-lead-disliked', visible], ['p-lead-agency', agencyLead]]) {
    if (outcome(db, id).join() !== 'done,not_eligible,company_excluded') problems.push(`${id}: ${outcome(db, id)}`);
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId);
    if (app.status !== 'withdrawn' || app.skip_owner !== 'review' || app.skip_reason !== 'company_excluded (user)') problems.push(`${id}: application ${app.status}/${app.skip_owner}/${app.skip_reason}`);
    const withdrawal = [...eventsOf(db, appId)].reverse().find((event) => event.statusAfter);
    if (withdrawal?.statusAfter !== 'withdrawn' || withdrawal.source?.actor !== 'review-worker') problems.push(`${id}: last status event ${withdrawal?.type} by ${withdrawal?.source?.actor}`);
  }
  for (const id of ['p-due-disliked', 'p-held-agency']) if (outcome(db, id).join() !== 'done,not_eligible,company_excluded') problems.push(`${id}: ${outcome(db, id)}`);
  assert.deepEqual(problems, [], `CE5: excluded leads and reviews are settled:\n${problems.join('\n')}`);
  assert.deepEqual(queued(db).sort(), [kept, privateLead].sort(), 'only the leads at companies not excluded stay visible');
  assert.equal(userRows(), users, 'applied, prepared, user-skipped and user-logged applications are untouched');

  // A second run with the same overrides changes nothing; a refresh that re-queues a settled review is settled again.
  const settled = reviewRows(db);
  await review(db, { budget: 0, now: at(1), overrides: o });
  assert.equal(reviewRows(db), settled, 'a settled company_excluded review is not touched again');
  db.prepare("UPDATE reviews SET state = 'due', stage = 'fetch', next_due = ? WHERE posting_id = 'p-lead-disliked'").run(at(2));
  const refreshed = await review(db, { budget: 20, now: at(2), overrides: o });
  assert.deepEqual(judgedIds(refreshed.judges), [], 'a refreshed excluded review is not judged');
  assert.deepEqual(refreshed.fetcher.calls, [], 'nor fetched');
  assert.deepEqual(outcome(db, 'p-lead-disliked'), ['done', 'not_eligible', 'company_excluded']);

  // The user removes the exclusions: the judged leads come back without a model call; the unjudged review is re-queued.
  const later = await review(db, { budget: 0, now: at(3), overrides: await overrides({ rule: 'synthetic' }) });
  assert.deepEqual(judgedIds(later.judges), []);
  assert.equal(attemptsCount(db), 0, 'restoring makes no paid attempt');
  for (const id of [visible, agencyLead]) {
    const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
    assert.deepEqual([row.status, row.skip_reason], ['lead', null], `${id} is restored`);
  }
  assert.deepEqual(outcome(db, 'p-lead-disliked'), ['done', 'eligible', null]);
  assert.equal(evidenceOf(db, 'p-lead-disliked').provenance, undefined, 'the automated provenance of the exclusion is dropped on restore');
  for (const id of ['p-due-disliked', 'p-held-agency']) assert.deepEqual([reviewOf(db, id).state, reviewOf(db, id).stage], ['due', 'fetch'], `${id} goes back to the fetch queue`);
  assert.equal(userRows(), users, 'user decisions are still untouched');
});

test('[B] the worker settles a new posting at an excluded company without fetching or judging, while other postings are judged (exclusion CE5)', async () => {
  const o = await overrides();
  const db = freshDb();
  const pages = {};
  for (const [id, company] of [['p-new-disliked', DISLIKED_POSTING], ['p-new-ok', OK]]) {
    insertPosting(db, { id, url: urlOf(id), company, title: snapshotTitle(SNAPSHOTS.eligible) });
    insertReview(db, { postingId: id, stage: 'fetch', firstSeen: T0, nextDue: T0 });
    pages[urlOf(id)] = page(urlOf(id), SNAPSHOTS.eligible);
  }
  const { judges: j, fetcher } = await review(db, { pages, overrides: o });
  assert.deepEqual(judgedIds(j), ['p-new-ok'], 'only the posting at a company not excluded is judged');
  assert.ok(!fetcher.calls.some((call) => String(call.url ?? call).includes('pnewdisliked')), 'the excluded posting is not fetched');
  assert.deepEqual(outcome(db, 'p-new-disliked'), ['done', 'not_eligible', 'company_excluded']);
  assert.equal(applicationOf(db, 'p-new-disliked'), undefined);
});

// ===================================================================== CE6 — not a dependency

test('[B] the exclusion keys are not judge dependencies: the hash and input state are unchanged and nothing is re-judged (exclusion CE6)', async () => {
  const { judgeDependencies, loadReviewInputs } = await inputsModule();
  const { inputState } = await workerModule();
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-exclusion-home-'));
  try {
    const profile = await writeReviewHome(home, { screeningPolicy: SCREENING });
    await writeFile(path.join(profile, 'company-overrides.json'), JSON.stringify({ rule: 'synthetic', reallowedCompanies: [REALLOWED] }));
    const before = await loadReviewInputs(home);
    await writeFile(path.join(profile, 'company-overrides.json'), JSON.stringify(RAW));
    const after = await loadReviewInputs(home);
    assert.deepEqual(after.overrides.excludedCompanies, [DISLIKED, 'Another Disliked Co'], 'the exclusions are loaded');
    const adapter = { runner: 'fake', model: 'fake-primary', tier: 'primary', effort: null, cliVersion: 'fake-1' };
    const deps = (inputs) => judgeDependencies({ inputs, adapter, skeletonVersion: 'v', schemaHash: 's', decideVersion: 'd' }).hash;
    assert.equal(deps(after), deps(before), 'the dependency hash is unchanged');
    assert.deepEqual(inputState(after), inputState(before), 'the review input state is unchanged');
  } finally { await rm(home, { recursive: true, force: true }); }

  const db = freshDb();
  const pages = {};
  insertPosting(db, { id: 'p-settled', url: urlOf('p-settled'), company: OK, title: snapshotTitle(SNAPSHOTS.eligible) });
  insertReview(db, { postingId: 'p-settled', stage: 'fetch', firstSeen: T0, nextDue: T0 });
  pages[urlOf('p-settled')] = page(urlOf('p-settled'), SNAPSHOTS.eligible);
  await review(db, { pages });
  const rows = reviewRows(db);
  const attempts = attemptsCount(db);
  const { judges: j } = await review(db, { budget: 20, now: at(1), pages, overrides: await overrides() });
  assert.deepEqual(judgedIds(j), [], 'adding the exclusions re-judges nothing');
  assert.equal(attemptsCount(db), attempts, 'no paid attempt');
  assert.equal(reviewRows(db), rows, 'a review at a company not excluded is not re-queued or changed');
});
