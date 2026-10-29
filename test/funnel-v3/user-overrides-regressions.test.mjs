// User overrides of 2026-10-29 that must not touch the judge dependency hashes.
//   1. 「大型零售/消费/世界知名品牌，美国任何地点都可以」: for a listed brand, any US location is acceptable. Every other
//      rule still applies (US only, degree, term, function, requirements, caps).
//   2. A company the user excluded earlier is allowed again (re-allowed), and two related companies each have their own
//      cap of at most N ACTIVE applications at a time (ended applications do not count).
// The screening policy, review policy and judge rules feed the dependency hashes; editing them re-queues every settled
// review for a paid re-judgment. So the overrides live in separate profile files, read at decision time:
//   profile/location-exempt-brands.json  { rule, brands[], windows? }
//   profile/company-overrides.json        { rule, reallowedCompanies[], activeCaps[{ company, max }], liftedSkipReasons[] }
// Rulings:
//   O1  A decision with code outside_area for an exempt brand is replayed by the same deterministic decision code with
//       the brand's US offices counted as in area; the replay result stands only if it no longer is outside_area, so
//       a non-US office, an office in a home-only work window, or any other failed dimension keeps the posting out.
//       Brand names match case-insensitively after removing punctuation and legal suffixes (Inc, Company).
//   O2  With the Jev split primary, a place-only rejection (no other dimension below its reject threshold) of an exempt
//       brand goes on to the model tiers, which quote the offices; any other rejection is final as before.
//   O3  Replaying stored decisions (review redecide) applies the same exemption without a judge or Jev call, and can be
//       limited to listed postings. A Jev-decided review is replayed from its stored probabilities.
//   O4  The override files are not judge dependencies: adding them changes neither the dependency hash nor the review
//       input state, and re-queues nothing.
//   O5  A re-allowed company is neither dropped at scan nor excluded at delivery; other excluded companies still are.
//   O6  An active cap counts applications in applied/assessment/interview/offer for that company; at the cap an
//       eligible verdict is settled company_cap (automated, restorable), and it is restored once an application ends.
//   O7  A lead withdrawn by a lifted company rule (skip reason starting with a lifted prefix, company re-allowed) can be
//       restored by an eligible review; a withdrawal with any other reason stays the user's.
// Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, load, insertPosting, insertReview, reviewOf, eventsOf, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SCREENING_POLICY, SNAPSHOTS, SUMMER_CHICAGO, judgment, page, snapshotTitle, reviewInputs, writeReviewHome } from '../../test-utils/funnel-v3-fixtures.mjs';
import { listQueue } from '../../src/commands/queue.mjs';

const overridesModule = () => load('O1', './src/review/overrides.mjs', ['loadUserOverrides', 'withOverrides', 'locationExempt', 'exemptVerdict']);
const decideModule = () => load('O1', './src/review/decide.mjs', ['decide']);
const workerModule = () => load('O2', './src/review/worker.mjs', ['runReview', 'inputState']);
const redecideModule = () => load('O3', './src/review/redecide.mjs', ['redecideReviews']);
const inputsModule = () => load('O4', './src/review/inputs.mjs', ['judgeDependencies', 'loadReviewInputs']);
const deliveryModule = async () => ({
  ...(await load('O5', './src/review/deliver.mjs', ['deliver', 'deliveryPolicy'])),
  ...(await load('O5', './src/review/lease.mjs', ['claimItem'])),
});
const classifyModule = () => load('O5', './src/funnel/classify.mjs', ['classifyRole']);

// ------------------------------------------------------------------ fixtures

const BRAND = 'Example Burger';                       // as the user lists it
const BRAND_COMPANY = 'The Example Burger Company, Inc.'; // as a posting names it
const OTHER = 'Plain Example Co';
const REALLOWED = 'Excluded Example Co';               // excluded in SCREENING_POLICY, re-allowed by the override
const STILL_EXCLUDED = 'Still Excluded Example';
const OVERRIDES = Object.freeze({
  locationExempt: { brands: [BRAND, 'Example Coffee'] },
  reallowedCompanies: [REALLOWED],
  activeCaps: [{ company: REALLOWED, max: 2 }, { company: 'Sister Example Co', max: 2 }],
  liftedSkipReasons: ['RULE shared cap:'],
});
const SCREENING = Object.freeze({ ...SCREENING_POLICY, userExcludedCompanies: [REALLOWED, STILL_EXCLUDED] });

const withPlace = (place) => SNAPSHOTS.eligible.replace('Location: Chicago, IL', `Location: ${place}`);
const office = (place, area = 'outside') => ({ place, area, quote: `Location: ${place}` });
const placeJudgment = (place, overrides = {}) => judgment({ alternatives: [{ ...SUMMER_CHICAGO, offices: [office(place)] }], ...overrides });
const COOP_TEXT = withPlace('Columbus, OH').replace('Join our analytics team for the summer of 2027', 'Join our analytics team for a spring 2027 co-op');
const COOP = judgment({ alternatives: [{ term: { label: 'spring', kind: 'co-op', year: 2027, quote: 'Join our analytics team for a spring 2027 co-op' }, offices: [office('Columbus, OH')], remote: { scope: 'none', quote: null } }] });
const SALES_TEXT = `${withPlace('Columbus, OH')}This role sits in the technical pre-sales organisation and supports account executives.\n`;
const SALES = placeJudgment('Columbus, OH', { function: { value: 'sales', quote: 'This role sits in the technical pre-sales organisation and supports account executives.' } });
const MISSING_TEXT = `${withPlace('Columbus, OH')}\nRequired Qualifications\n• Hands-on experience operating Kubernetes clusters.\n`;
const MISSING = placeJudgment('Columbus, OH', { criteria: [{ key: 'requirement', status: 'conflicts', quote: 'Hands-on experience operating Kubernetes clusters.', clause_alternatives: [], fact_ids: ['kubernetes'] }] });

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id.replace(/[^0-9a-z]/gi, '')}`;
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const flagsOf = (db, id) => parse(reviewOf(db, id).flags_json, []);
const outcome = (db, id) => { const row = reviewOf(db, id); return [row.state, row.decision, row.code]; };
const applicationOf = (db, postingId) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(postingId);
const queued = (db) => listQueue(db).map((row) => row.id);
const attemptsCount = (db) => db.prepare('SELECT COUNT(*) n FROM attempts').get().n;
const why = (verdict) => JSON.stringify({ decision: verdict.decision, code: verdict.code, question: verdict.question ?? null });

async function offline(run) {
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => { attempts.push(String(url)); throw new Error(`network access in a test: ${url}`); };
  try { return await run(); } finally {
    globalThis.fetch = original;
    assert.deepEqual(attempts, [], 'no network request is made');
  }
}

function queue() {
  const pages = {};
  const answers = {};
  const script = {};
  return {
    pages, answers, script,
    add(db, id, { company = BRAND_COMPANY, text = withPlace('Columbus, OH'), output = placeJudgment('Columbus, OH'), jev } = {}) {
      const body = `${text.replace(snapshotTitle(text), `${snapshotTitle(text)} ${id}`)}\nCase marker ${id}.\n`;
      insertPosting(db, { id, url: urlOf(id), company, title: snapshotTitle(body), firstSeen: T0 });
      insertReview(db, { postingId: id, stage: 'fetch', firstSeen: T0, nextDue: T0 });
      pages[urlOf(id)] = page(urlOf(id), body);
      answers[id] = { output };
      if (jev) script[id] = jev;
      return id;
    },
  };
}
function judges(answers) {
  const respond = (request) => answers[request.postingId];
  return { primary: fakeJudge({ tier: 'primary', model: 'codex-auto-review', answers: respond }), escalation: fakeJudge({ tier: 'escalation', model: 'codex-escalation', answers: respond }) };
}
const judgedIds = (j) => [...j.primary.calls, ...j.escalation.calls].map((call) => call.request.postingId);

async function review(db, { pages = {}, answers = {}, policy = REVIEW_POLICY, overrides, jev, budget = 20, now = T0, screeningPolicy = SCREENING }) {
  const { runReview } = await workerModule();
  const j = judges(answers);
  const receipt = await offline(() => runReview({ db, runId: `review-overrides-${Math.random()}`, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null,
    sleep: async () => {}, fetcher: fakeFetcher(pages), judges: j, inputs: () => reviewInputs({ policy, screeningPolicy, ...(overrides ? { overrides } : {}) }), hooks: {},
    ...(jev ? { jev } : {}) }));
  return { receipt, judges: j };
}

// ===================================================================== O1 — the exemption replays decide

test('[L2] an exempt brand\'s US office outside the policy areas is accepted when every other dimension passes; non-exempt, non-US, home-only windows and other failures stay out (overrides O1)', async () => {
  const { decide } = await decideModule();
  const { exemptVerdict, locationExempt } = await overridesModule();
  const facts = reviewInputs().facts;
  const run = ({ text, output, company = BRAND_COMPANY, tier = 'escalation', overrides = OVERRIDES }) => {
    const args = { snapshotText: text, judgment: output, facts, policy: REVIEW_POLICY, tier, firstSeen: T0, jobType: 'internship' };
    const verdict = decide(args);
    return { before: verdict, after: exemptVerdict({ ...args, verdict, company, overrides, aliases: {} }) };
  };

  assert.equal(locationExempt('the example burger co.', OVERRIDES), true, 'case, punctuation and legal suffixes are ignored');
  assert.equal(locationExempt(BRAND_COMPANY, OVERRIDES), true);
  assert.equal(locationExempt('Example Burgers International', OVERRIDES), false, 'a different name is not a brand');
  assert.equal(locationExempt(BRAND_COMPANY, {}), false, 'no overrides, no exemption');

  const us = run({ text: withPlace('Columbus, OH'), output: placeJudgment('Columbus, OH') });
  assert.deepEqual([us.before.decision, us.before.code], ['not_eligible', 'outside_area'], `fixture: outside the areas: ${why(us.before)}`);
  assert.deepEqual([us.after.decision, us.after.code], ['eligible', null], `a US office of an exempt brand is accepted: ${why(us.after)}`);
  assert.ok(us.after.flags.includes('location_exempt'), 'the exemption is flagged');
  assert.deepEqual(us.after.location.display, 'Columbus, OH', 'the delivered location is the quoted office');

  const stateName = run({ text: withPlace('Dayton, Ohio'), output: placeJudgment('Dayton, Ohio') });
  assert.equal(stateName.after.decision, 'eligible', `a full state name is a US place: ${why(stateName.after)}`);

  const primary = run({ text: withPlace('Columbus, OH'), output: placeJudgment('Columbus, OH'), tier: 'primary' });
  assert.equal(primary.before.primaryRejection, true, 'fixture: a primary-tier code-verified rejection');
  assert.equal(primary.after.decision, 'eligible', `the primary tier is exempted too: ${why(primary.after)}`);

  const kept = [
    ['non-exempt company', run({ text: withPlace('Columbus, OH'), output: placeJudgment('Columbus, OH'), company: OTHER })],
    ['non-US office', run({ text: withPlace('Reading, United Kingdom'), output: placeJudgment('Reading, United Kingdom') })],
    ['office without a state or country', run({ text: withPlace('Weybridge'), output: placeJudgment('Weybridge') })],
    ['home-only off-season window', run({ text: COOP_TEXT, output: COOP })],
  ];
  for (const [name, { before, after }] of kept) {
    assert.deepEqual([after.decision, after.code], [before.decision, before.code], `${name}: unchanged: ${why(after)}`);
    assert.equal(after.code, 'outside_area', `${name}: still outside_area`);
  }
  const sales = run({ text: SALES_TEXT, output: SALES });
  assert.deepEqual([sales.after.decision, sales.after.code], ['unclear', 'user_review'], `the function rule still applies: ${why(sales.after)}`);
  const missing = run({ text: MISSING_TEXT, output: MISSING });
  assert.equal(missing.before.code, 'outside_area', 'fixture: the area check comes first');
  assert.notEqual(missing.after.decision, 'eligible', `a requirement still applies: ${why(missing.after)}`);
  const inArea = run({ text: SNAPSHOTS.eligible, output: judgment() });
  assert.equal(inArea.after, inArea.before, 'a verdict that is not outside_area is returned as is');
});

// ===================================================================== O1/O2 — the worker

test('[B] the worker delivers an exempt brand\'s out-of-area US posting as a lead; a non-exempt company stays outside_area (overrides O1)', async () => {
  const db = freshDb();
  const q = queue();
  q.add(db, 'p-brand');
  q.add(db, 'p-other', { company: OTHER });
  await review(db, { pages: q.pages, answers: q.answers, overrides: OVERRIDES });
  assert.deepEqual(outcome(db, 'p-brand'), ['done', 'eligible', null]);
  assert.ok(flagsOf(db, 'p-brand').includes('location_exempt'));
  assert.ok(queued(db).includes(applicationOf(db, 'p-brand')?.id), 'the exempt posting is a visible lead');
  assert.deepEqual(outcome(db, 'p-other'), ['done', 'not_eligible', 'outside_area']);
});

const THRESHOLDS = Object.freeze({
  reject: { degree: 0.3, term: 0.3, place: 0.3, auth: 0.3, function: 0.3, skills: 0.2 },
  accept: { degree: 0.7, term: 0.65, place: 0.8, auth: 0.55, function: 0.7, skills: 0.4 },
});
const JEV_POLICY = Object.freeze({ ...REVIEW_POLICY, judge: { primary: { runner: 'jev-split', model: 'jev-test', thresholds: THRESHOLDS },
  fallback: { runner: 'codex', model: 'codex-auto-review' }, escalation: { runner: 'codex', model: 'codex-escalation' } } });
const HIGH = Object.freeze({ degree: 0.97, term: 0.82, place: 0.87, auth: 0.95, function: 0.71, skills: 0.63 });
const PATTERNS = { degree: /degree level/i, term: /offers a work term/i, place: /allowed areas/i, auth: /work authorization/i, function: /main function/i, skills: /mandatory/i };
function fakeJev(script) {
  const calls = [];
  return {
    id: 'fake-jev-split', runner: 'jev', model: 'jev-test', calls,
    async ask(call) {
      calls.push(call);
      const text = typeof call.state === 'string' ? call.state : JSON.stringify(call.state);
      const id = Object.keys(script).find((key) => text.includes(`Case marker ${key}.`));
      const dimension = Object.keys(PATTERNS).find((key) => PATTERNS[key].test(call.question));
      return { probability: script[id][dimension], usage: { requests: 1 } };
    },
  };
}

test('[B] with the Jev split primary, an exempt brand\'s place-only rejection goes on to the model tiers and is accepted; other rejections stay final without a model call (overrides O2)', async () => {
  const db = freshDb();
  const q = queue();
  q.add(db, 'p-jev-brand', { jev: { ...HIGH, place: 0.1 } });
  q.add(db, 'p-jev-other', { company: OTHER, jev: { ...HIGH, place: 0.1 } });
  q.add(db, 'p-jev-degree', { jev: { ...HIGH, place: 0.1, degree: 0.1 } });
  const jev = fakeJev(q.script);
  const { judges: j } = await review(db, { pages: q.pages, answers: q.answers, overrides: OVERRIDES, policy: JEV_POLICY, jev });
  assert.deepEqual(outcome(db, 'p-jev-brand'), ['done', 'eligible', null], 'the exempt brand is judged by the model and accepted');
  assert.ok(flagsOf(db, 'p-jev-brand').includes('location_exempt'));
  assert.deepEqual(parse(reviewOf(db, 'p-jev-brand').evidence_json, {}).jev?.place, 0.1, 'the Jev probabilities are kept');
  assert.deepEqual(outcome(db, 'p-jev-other'), ['done', 'not_eligible', 'outside_area']);
  assert.deepEqual(outcome(db, 'p-jev-degree'), ['done', 'not_eligible', 'degree']);
  assert.deepEqual([...new Set(judgedIds(j))], ['p-jev-brand'], 'only the exempt place-only rejection reaches the model');
});

// ===================================================================== O3 — replay

test('[B] review redecide applies the exemption to stored judgments and Jev probabilities without a judge or Jev call, limited to listed postings (overrides O3/O5)', async () => {
  const { redecideReviews } = await redecideModule();
  const db = freshDb();
  const q = queue();
  q.add(db, 'p-replay-a');
  q.add(db, 'p-replay-b');
  q.add(db, 'p-replay-other', { company: OTHER });
  await review(db, { pages: q.pages, answers: q.answers });
  for (const id of ['p-replay-a', 'p-replay-b']) assert.deepEqual(outcome(db, id), ['done', 'not_eligible', 'outside_area'], `${id}: fixture without overrides`);

  const j = judges({});
  const inputs = reviewInputs({ screeningPolicy: SCREENING, overrides: OVERRIDES });
  const report = await redecideReviews(db, { inputs, judges: j, held: true, done: true, now: at(1), postingIds: ['p-replay-a', 'p-replay-other'] });
  assert.deepEqual(judgedIds(j), [], 'no judge call');
  assert.equal(report.changed, 1, JSON.stringify(report));
  assert.deepEqual(outcome(db, 'p-replay-a'), ['done', 'eligible', null]);
  assert.ok(queued(db).includes(applicationOf(db, 'p-replay-a')?.id), 'the replayed posting is a visible lead');
  assert.deepEqual(outcome(db, 'p-replay-b'), ['done', 'not_eligible', 'outside_area'], 'an unlisted posting is untouched');
  assert.deepEqual(outcome(db, 'p-replay-other'), ['done', 'not_eligible', 'outside_area']);

  // A Jev-decided eligible review of a company excluded at the time is restored when the company is re-allowed.
  const jq = queue();
  jq.add(db, 'p-jev-excluded', { company: REALLOWED, text: SNAPSHOTS.eligible, output: judgment(), jev: HIGH });
  const jev = fakeJev(jq.script);
  await review(db, { pages: jq.pages, answers: jq.answers, policy: JEV_POLICY, jev });
  assert.deepEqual(outcome(db, 'p-jev-excluded'), ['done', 'not_eligible', 'company_excluded'], 'fixture: excluded at the time');
  const asked = jev.calls.length;
  const replay = await redecideReviews(db, { inputs: reviewInputs({ policy: JEV_POLICY, screeningPolicy: SCREENING, overrides: OVERRIDES }), judges: judges({}),
    held: true, done: true, now: at(1), postingIds: ['p-jev-excluded'] });
  assert.equal(jev.calls.length, asked, 'no Jev call');
  assert.equal(replay.changed, 1, JSON.stringify(replay));
  assert.deepEqual(outcome(db, 'p-jev-excluded'), ['done', 'eligible', null]);
  const app = applicationOf(db, 'p-jev-excluded');
  assert.equal(app.status, 'lead', 'the withdrawn lead is restored');
  assert.ok(queued(db).includes(app.id));
});

// ===================================================================== O4 — not dependencies

test('[B] the override files are read with the review inputs but are not judge dependencies: hashes and input state are unchanged and nothing is re-queued (overrides O4)', async () => {
  const { judgeDependencies, loadReviewInputs } = await inputsModule();
  const { inputState } = await workerModule();
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-overrides-'));
  try {
    const profile = await writeReviewHome(home, { screeningPolicy: SCREENING });
    const without = await loadReviewInputs(home);
    await writeFile(path.join(profile, 'location-exempt-brands.json'), JSON.stringify({ rule: 'synthetic', brands: OVERRIDES.locationExempt.brands }));
    await writeFile(path.join(profile, 'company-overrides.json'), JSON.stringify({ rule: 'synthetic', reallowedCompanies: OVERRIDES.reallowedCompanies,
      activeCaps: OVERRIDES.activeCaps, liftedSkipReasons: OVERRIDES.liftedSkipReasons }));
    const withFiles = await loadReviewInputs(home);
    assert.deepEqual(withFiles.overrides.locationExempt.brands, OVERRIDES.locationExempt.brands, 'the brand list is loaded');
    assert.deepEqual(withFiles.overrides.reallowedCompanies, [REALLOWED]);
    assert.deepEqual(withFiles.overrides.activeCaps, OVERRIDES.activeCaps);
    assert.deepEqual(without.overrides, { locationExempt: { brands: [], windows: null }, reallowedCompanies: [], activeCaps: [], liftedSkipReasons: [] }, 'missing files mean no overrides');
    const adapter = { runner: 'fake', model: 'fake-primary', tier: 'primary', effort: null, cliVersion: 'fake-1' };
    const deps = (inputs) => judgeDependencies({ inputs, adapter, skeletonVersion: 'v', schemaHash: 's', decideVersion: 'd' }).hash;
    assert.equal(deps(withFiles), deps(without), 'the dependency hash is unchanged');
    assert.deepEqual(inputState(withFiles), inputState(without), 'the review input state is unchanged');
    await writeFile(path.join(profile, 'company-overrides.json'), '{"reallowedCompanies": "not a list"}');
    await assert.rejects(loadReviewInputs(home), /company-overrides/, 'a malformed override file fails loudly');
  } finally { await rm(home, { recursive: true, force: true }); }

  const db = freshDb();
  const q = queue();
  q.add(db, 'p-settled');
  await review(db, { pages: q.pages, answers: q.answers });
  const rows = JSON.stringify(db.prepare('SELECT posting_id, state, decision, code, next_due, dep_hashes_json FROM reviews').all());
  const attempts = attemptsCount(db);
  const { judges: j } = await review(db, { budget: 0, now: at(1), overrides: OVERRIDES });
  assert.deepEqual(judgedIds(j), []);
  assert.equal(attemptsCount(db), attempts, 'no paid attempt');
  assert.equal(JSON.stringify(db.prepare('SELECT posting_id, state, decision, code, next_due, dep_hashes_json FROM reviews').all()), rows, 'no review is re-queued');
});

// ===================================================================== O5 — re-allowed company

test('[L2] a re-allowed company is not dropped at scan and not excluded at delivery; other excluded companies still are (overrides O5)', async () => {
  const { withOverrides } = await overridesModule();
  const { classifyRole } = await classifyModule();
  const { deliver, deliveryPolicy, claimItem } = await deliveryModule();
  const policy = withOverrides(SCREENING, OVERRIDES);
  assert.deepEqual(SCREENING.userExcludedCompanies, [REALLOWED, STILL_EXCLUDED], 'the screening policy itself is not modified');
  const record = (company) => ({ company, title: 'Data Science Intern', url: urlOf(company), locations: ['Chicago, IL'], completeness: { locations: 'complete', arrangement: 'known' }, remote: false });
  assert.equal(classifyRole(record('excluded example company'), { policy }).kind, 'review', 'the re-allowed company is reviewed');
  assert.equal(classifyRole(record(STILL_EXCLUDED), { policy }).code, 'company_excluded');
  assert.equal(classifyRole(record(REALLOWED), { policy: SCREENING }).code, 'company_excluded', 'fixture: excluded without the override');

  const db = freshDb();
  const eligible = { decision: 'eligible', code: null, fit: { level: 'medium', note: '' }, deadline: { kind: 'none' }, location: { offices: [], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' } };
  const delivered = (id, company) => {
    insertPosting(db, { id, url: urlOf(id), company });
    insertReview(db, { postingId: id, stage: 'deliver' });
    const fence = claimItem(db, id, { owner: 'worker-a', now: T0 });
    deliver(db, { postingId: id, fence, now: T0, verdict: eligible, policy: deliveryPolicy(reviewInputs({ screeningPolicy: SCREENING, overrides: OVERRIDES })) });
    return outcome(db, id);
  };
  assert.deepEqual(delivered('p-reallowed', REALLOWED), ['done', 'eligible', null]);
  assert.deepEqual(delivered('p-still', STILL_EXCLUDED), ['done', 'not_eligible', 'company_excluded']);
});

// ===================================================================== O6 — active cap

function application(db, { company, status, id = `app-${company}-${status}-${Math.random()}` }) {
  db.prepare(`INSERT INTO applications (id, company, role, job_url, status, applied_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, company, `Role ${id}`, `https://jobs.example.test/${id}`, status, status === 'lead' || status === 'withdrawn' ? null : at(-200), at(-200), at(-200));
  return id;
}

test('[B] at most N active applications per company: at the cap an eligible verdict is settled company_cap and restored once one ends; ended ones do not count (overrides O6)', async () => {
  const db = freshDb();
  application(db, { company: REALLOWED, status: 'rejected' });
  application(db, { company: REALLOWED, status: 'withdrawn' });
  application(db, { company: REALLOWED, status: 'applied' });
  const second = application(db, { company: 'excluded example company', status: 'assessment' });
  application(db, { company: 'Sister Example Co', status: 'interview' });
  const q = queue();
  q.add(db, 'p-cap-active', { company: REALLOWED, text: SNAPSHOTS.eligible, output: judgment() });
  q.add(db, 'p-cap-sister', { company: 'Sister Example Co', text: SNAPSHOTS.eligible, output: judgment() });
  await review(db, { pages: q.pages, answers: q.answers, overrides: OVERRIDES });
  assert.deepEqual(outcome(db, 'p-cap-active'), ['done', 'not_eligible', 'company_cap'], 'two active applications fill the cap');
  assert.equal(parse(reviewOf(db, 'p-cap-active').evidence_json, {}).provenance, 'automated');
  assert.deepEqual(outcome(db, 'p-cap-sister'), ['done', 'eligible', null], 'the other company has its own cap with one active');

  db.prepare("UPDATE applications SET status = 'rejected' WHERE id = ?").run(second);
  const { judges: j } = await review(db, { budget: 0, now: at(1), overrides: OVERRIDES });
  assert.deepEqual(judgedIds(j), [], 'restoring makes no judge call');
  assert.deepEqual(outcome(db, 'p-cap-active'), ['done', 'eligible', null], 'restored once an application ended');
  assert.ok(queued(db).includes(applicationOf(db, 'p-cap-active')?.id));
});

// ===================================================================== O7 — lifted rule withdrawals

function withdrawnLead(db, id, { company, reason }) {
  const appId = `lead-${id}`;
  db.prepare(`INSERT INTO applications (id, company, role, job_url, status, skip_reason, skip_owner, created_at, updated_at) VALUES (?, ?, 'Data Science Intern', ?, 'withdrawn', ?, 'review', ?, ?)`)
    .run(appId, company, urlOf(id), reason, at(-30), at(-30));
  db.prepare(`INSERT INTO application_events (id, application_id, event_type, observed_at, recorded_at, title, note, source_json, status_after, content_hash)
    VALUES (?, ?, 'queue_skipped', ?, ?, 'queue_skipped', ?, ?, 'withdrawn', ?)`).run(`skip-${id}`, appId, at(-30), at(-30), reason, JSON.stringify({ kind: 'queue-verify', reason, result: 'skip' }), `h-${id}`);
  insertPosting(db, { id, url: urlOf(id), company, applicationId: appId, firstSeen: at(-30) });
  insertReview(db, { postingId: id, stage: 'deliver', firstSeen: at(-30) });
  return appId;
}

test('[L2] a lead withdrawn by a lifted company rule is restored by an eligible review; other withdrawals stay the user\'s (overrides O7)', async () => {
  const { deliver, deliveryPolicy, claimItem } = await deliveryModule();
  const db = freshDb();
  const policy = deliveryPolicy(reviewInputs({ screeningPolicy: SCREENING, overrides: OVERRIDES }));
  const eligible = { decision: 'eligible', code: null, fit: { level: 'high', note: '' }, deadline: { kind: 'none' } };
  const run = (id) => deliver(db, { postingId: id, fence: claimItem(db, id, { owner: 'worker-a', now: T0 }), now: T0, verdict: eligible, policy });
  const lifted = withdrawnLead(db, 'p-lifted', { company: REALLOWED, reason: 'RULE shared cap: two at most' });
  const otherReason = withdrawnLead(db, 'p-other-reason', { company: REALLOWED, reason: 'not interested' });
  const otherCompany = withdrawnLead(db, 'p-other-company', { company: OTHER, reason: 'RULE shared cap: two at most' });
  assert.equal(run('p-lifted').action, 'restored');
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(lifted);
  assert.deepEqual([app.status, app.skip_reason], ['lead', null]);
  const restore = eventsOf(db, lifted).at(-1);
  assert.equal(restore.type, 'review_restored');
  assert.equal(restore.source.liftedRule, 'RULE shared cap:', 'the restore names the lifted rule');
  for (const [id, appId] of [['p-other-reason', otherReason], ['p-other-company', otherCompany]]) {
    assert.equal(run(id).action, 'superseded_by_user', `${id}: stays withdrawn`);
    assert.equal(db.prepare('SELECT status FROM applications WHERE id = ?').get(appId).status, 'withdrawn');
  }
});
