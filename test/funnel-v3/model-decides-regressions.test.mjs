// Red tests for the user ruling of 2026-10-27, "不要等待我决定，必须要用模型决定": postings must not wait in a
// user-owned hold; models decide. Today the escalation tier's unclear verdicts (missing_fact, requirement_unclear,
// user_review, term_or_area) are delivered as holds with hold_owner 'user', bootstrap holds every application of
// unknown provenance for the user, and any change to the review policy (even the judge model or the budgets)
// re-queues settled negative reviews for paid re-judgment.
// Rulings:
//   H1  When the escalation tier's decision would hold an item for the user, the worker makes ONE forced-decision
//       call to the escalation judge, then asks the second opinion (Jev) to verify it. The forced decision is final.
//       No hold_owner 'user' is created. A failed forced call (error, quota, or an output that is not a decision)
//       leaves the item due for a later run (system-owned), never user-held. Exploration lanes keep their rule
//       (never held; non-eligible ends not_eligible with the lane as code) and make no forced call.
//   H2  Legacy holds of code provenance_unknown (bootstrap) are system work: re-queued for fetch and judgment like
//       any other review, both at bootstrap and for rows an earlier bootstrap already wrote. Explicit user decisions
//       (user declines, submitted, prepared) stay untouched.
//   H3  The receipt and `review report` show model-decided items in their own section with their assumption;
//       awaiting_user is empty in normal operation.
//   P1  Only screening-relevant policy parts (windows, areas, functions, fit, jobType) are a replan dependency.
//       Judge, budgets, fetcher, retention, mail and serviceTargets changes, and the judge adapter's model, never
//       re-queue done or held reviews by themselves; new reviews simply use the new judge.
// Contract fixed here:
//   forced request:  judges.escalation.judge(request, context) with request.forceDecision === true and
//                    request.postingId; request.prompt contains the hold's question. The first (ordinary) escalation
//                    request has no forceDecision flag. The forced call is a paid escalation-tier attempt.
//   forced output:   { decision: 'eligible' | 'not_eligible', assumption: <non-empty string> }. Anything else
//                    (decision 'unclear', a missing assumption) is a failed forced call.
//   verification:    secondOpinion.ask({ state, question }) once after a successful forced call (when
//                    policy.judge.secondOpinion is configured); state carries the forced decision and assumption.
//   final review:    state 'done', decision = the forced decision, code = the original hold code, hold_owner null,
//                    flags_json includes 'model_decided'; also 'disputed' when the forced decision is eligible and
//                    p < threshold (0.1), or not_eligible and p >= eligibleThreshold (0.7). Jev never overrides.
//   evidence:        evidence_json.modelDecision = { question, assumption, jevProbability } (jevProbability null
//                    when Jev failed); question is the hold's question as decide() produced it.
//   lead:            for an eligible forced decision the application's fit_note contains the assumption.
//   receipt:         receipt.model_decided = [{ postingId, decision, assumption, disputed, ... }] for the items
//                    decided this way in the run; receipt.awaiting_user and awaiting_user_summary are [].
//   report:          an English `## Model-decided` section lists each such posting with its assumption and marks
//                    disputed ones with the word "disputed"; they never appear under `## Awaiting you`.
// Not fixed here (open): the Chinese report heading; holds written by releases before H1 (they stay listed until
// resolved, see the amended trial T3 test); browser_review and company-quota holds, which H1 does not cover.
// Synthetic data only: every employer, place, URL and candidate fact is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, seedApplication, seedCheckerWithdrawal, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, SUMMER_CHICAGO, PROVENANCE, judgment, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';

const workerModule = () => load('B6', './src/review/worker.mjs', ['runReview']);
const decideModule = () => load('B6', './src/review/decide.mjs', ['decide']);
const reportModule = () => load('B7', './src/review/report.mjs', ['reviewReport']);
const bootstrapModule = () => load('L1', './src/funnel/bootstrap.mjs', ['bootstrapExisting']);

const SECOND_OPINION = Object.freeze({ runner: 'jev', model: 'jev-test', threshold: 0.1, eligibleThreshold: 0.7 });
const WITH_JEV = Object.freeze({ ...REVIEW_POLICY, judge: { secondOpinion: SECOND_OPINION } });

// ------------------------------------------------------------------ postings

const retitled = (snapshot, title) => snapshot.replace(snapshotTitle(snapshot), title);
const PYTHON_CLAUSE = 'Proficiency in Python or R for data analysis.';

// One posting per escalation-tier hold code. Both tiers answer with the same judgment, so the escalation tier's
// own decision is the hold; the primary tier is unclear and escalates without asking the second opinion.
const HOLDS = Object.freeze({
  missing_fact: { text: retitled(SNAPSHOTS.missingFact, 'Platform Data Intern Forced'), output: JUDGMENTS.missingFact },
  requirement_unclear: {
    text: retitled(SNAPSHOTS.eligible, 'Data Science Intern Forced'),
    // A conflict citing a fact the candidate has: not confirmed, so the requirement is unclear.
    output: judgment({ criteria: [{ key: 'requirement', status: 'conflicts', quote: PYTHON_CLAUSE, clause_alternatives: [], fact_ids: ['python'] }] }),
  },
  user_review: { text: retitled(SNAPSHOTS.sales, 'Revenue Insights Analyst Intern Forced'), output: JUDGMENTS.sales },
  term_or_area: {
    text: retitled(SNAPSHOTS.eligible, 'Data Science Intern Unknown Office'),
    output: judgment({ alternatives: [{ ...SUMMER_CHICAGO, offices: [{ place: 'Chicago, IL', area: 'unknown', quote: 'Location: Chicago, IL' }] }] }),
  },
});

// Every office is in a state outside allowedStates: a code-verified outside_area rejection.
const OUTSIDE_AREA_TEXT = retitled(SNAPSHOTS.eligible, 'Data Science Intern Mill Creek').replace('Location: Chicago, IL', 'Location: Mill Creek, TX');
const OUTSIDE_AREA = judgment({ alternatives: [{ term: SUMMER_CHICAGO.term, offices: [{ place: 'Mill Creek, TX', area: 'outside', quote: 'Location: Mill Creek, TX' }], remote: { scope: 'none', quote: null } }] });

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;

function queue() {
  const pages = {};
  const answers = {};
  return {
    pages,
    answers,
    add(db, id, { text, output, lane = 'new', firstSeen = T0 }) {
      insertPosting(db, { id, url: urlOf(id), company: 'Example Corp', title: snapshotTitle(text), firstSeen });
      insertReview(db, { postingId: id, stage: 'fetch', firstSeen, nextDue: firstSeen, lane });
      pages[urlOf(id)] = page(urlOf(id), text);
      answers[id] = { output };
      return id;
    },
  };
}

// ------------------------------------------------------------------ harness

const forcedOutput = (decision, assumption) => ({ output: { decision, assumption } });

// Fake judges: an ordinary request is answered from `answers`; a forced-decision request from `forced`.
function makeJudges({ answers, forced = {}, primaryModel }) {
  const respond = (request) => {
    if (request.forceDecision === true) {
      const answer = forced[request.postingId];
      return typeof answer === 'function' ? answer(request) : answer;
    }
    return typeof answers === 'function' ? answers(request) : answers[request.postingId];
  };
  return {
    primary: fakeJudge({ tier: 'primary', ...(primaryModel ? { model: primaryModel } : {}), answers: respond }),
    escalation: fakeJudge({ tier: 'escalation', answers: respond }),
  };
}

// Fake second-opinion adapter (escalation E3 interface).
function fakeSecondOpinion(answer) {
  const calls = [];
  return {
    id: 'fake-jev', runner: 'jev', model: 'jev-test', calls,
    async ask(call) {
      calls.push(call);
      const probability = typeof answer === 'function' ? await answer(call) : answer;
      return { probability, usage: { requests: 1 } };
    },
  };
}

// Any network use during a run fails the test.
async function offline(run) {
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => { attempts.push(String(url)); throw new Error(`network access in a test: ${url}`); };
  try { return await run(); } finally {
    globalThis.fetch = original;
    assert.deepEqual(attempts, [], 'no network request is made');
  }
}

async function review(db, { pages, judges, policy = WITH_JEV, secondOpinion, budget = 20, now = T0, runId = 'review-model-decides', fetcher }) {
  const { runReview } = await workerModule();
  const options = {
    db, runId, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fetcher ?? fakeFetcher(pages), judges, inputs: () => reviewInputs({ policy }), hooks: {},
    ...(secondOpinion ? { secondOpinion } : {}),
  };
  return offline(() => runReview(options));
}

const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const flagsOf = (db, id) => parse(reviewOf(db, id).flags_json, []);
const evidenceOf = (db, id) => parse(reviewOf(db, id).evidence_json, {});
const applicationOf = (db, postingId) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(postingId);
const callsFor = (judge, id) => judge.calls.filter((call) => call.request.postingId === id);
const forcedCalls = (judge, id) => callsFor(judge, id).filter((call) => call.request.forceDecision === true);
const tiersOf = (db, id) => db.prepare('SELECT tier FROM attempts WHERE posting_id = ? ORDER BY rowid').all(id).map((row) => row.tier);
const userHolds = (db) => db.prepare("SELECT posting_id FROM reviews WHERE hold_owner = 'user'").all().map((row) => row.posting_id);

// The question the escalation tier's hold carries, as decide() produces it (also a fixture sanity check).
async function holdQuestion(kind) {
  const { decide } = await decideModule();
  const inputs = reviewInputs();
  const verdict = decide({ snapshotText: HOLDS[kind].text, judgment: HOLDS[kind].output, facts: inputs.facts, policy: inputs.policy,
    tier: 'escalation', firstSeen: T0, jobType: inputs.profile?.search?.jobType });
  assert.deepEqual([verdict.decision, verdict.code], ['unclear', kind], `fixture sanity: the escalation tier holds ${kind}`);
  assert.ok(String(verdict.question ?? '').trim(), `fixture sanity: the ${kind} hold carries a question`);
  return verdict.question;
}

// ------------------------------------------------------------------ H1

test('[B] an escalation-tier hold (missing_fact, requirement_unclear, user_review, term_or_area) gets one forced-decision call and Jev verification; the forced decision is final, model_decided, and never user-held (model-decides H1)', async () => {
  for (const [kind, decision, probability] of [
    ['missing_fact', 'eligible', 0.8],
    ['requirement_unclear', 'not_eligible', 0.05],
    ['user_review', 'eligible', 0.75],
    ['term_or_area', 'not_eligible', 0.3],
  ]) {
    const question = await holdQuestion(kind);
    const db = freshDb();
    const q = queue();
    const id = q.add(db, `p-${kind.replaceAll('_', '-')}`, HOLDS[kind]);
    const assumption = `Assumed for ${kind}: the open point does not block this candidate`;
    const judges = makeJudges({ answers: q.answers, forced: { [id]: forcedOutput(decision, assumption) } });
    const jev = fakeSecondOpinion(probability);
    const receipt = await review(db, { pages: q.pages, judges, secondOpinion: jev });

    assert.equal(callsFor(judges.primary, id).length, 1, `${kind}: one primary call`);
    const escalation = callsFor(judges.escalation, id);
    assert.equal(escalation.length, 2, `${kind}: the escalation tier is called twice (ordinary, then forced): ${escalation.length}`);
    assert.notEqual(escalation[0].request.forceDecision, true, `${kind}: the first escalation request is the ordinary judgment`);
    assert.equal(escalation[1].request.forceDecision, true, `${kind}: the second escalation request carries forceDecision: true`);
    assert.equal(forcedCalls(judges.primary, id).length, 0, `${kind}: the primary tier never gets a forced request`);
    assert.ok(String(escalation[1].request.prompt ?? '').includes(question.replace(/^•\s*/, '')),
      `${kind}: the forced request's prompt states the open question "${question}"`);
    assert.deepEqual(tiersOf(db, id), ['primary', 'escalation', 'escalation'], `${kind}: the forced call is one paid escalation attempt`);

    assert.equal(jev.calls.length, 1, `${kind}: Jev verifies the forced decision once (${jev.calls.length} calls)`);
    assert.deepEqual(Object.keys(jev.calls[0]).sort(), ['question', 'state'], `${kind}: ask() receives { state, question }`);
    assert.ok(JSON.stringify(jev.calls[0].state).includes(assumption), `${kind}: Jev sees the forced decision's assumption`);

    const row = reviewOf(db, id);
    assert.deepEqual([row.state, row.decision, row.code, row.hold_owner], ['done', decision, kind, null],
      `${kind}: the forced ${decision} is final, keeps the hold code, and holds nothing for the user`);
    assert.ok(flagsOf(db, id).includes('model_decided'), `${kind}: flagged model_decided: ${row.flags_json}`);
    assert.equal(flagsOf(db, id).includes('disputed'), false, `${kind}: Jev at ${probability} does not dispute a forced ${decision}`);
    assert.deepEqual(evidenceOf(db, id).modelDecision, { question, assumption, jevProbability: probability },
      `${kind}: the review evidence keeps the open question, the assumption and Jev's probability`);
    if (decision === 'eligible') {
      const app = applicationOf(db, id);
      assert.ok(app, `${kind}: the eligible posting is delivered as a lead`);
      assert.equal(app.skip_reason, null, `${kind}: the lead is visible, not hidden for review: ${app.skip_reason}`);
      assert.ok(String(app.fit_note ?? '').includes(assumption), `${kind}: the lead's fit_note tells the user the assumption: ${app.fit_note}`);
    }
    assert.deepEqual(receipt.awaiting_user, [], `${kind}: nothing awaits the user: ${JSON.stringify(receipt.awaiting_user)}`);
    assert.deepEqual(receipt.awaiting_user_summary, [], `${kind}: no awaiting-user groups`);
    assert.deepEqual(userHolds(db), [], `${kind}: no user-owned hold exists`);
  }
});

test('[B] Jev verifies a forced decision but never overrides it: strong disagreement adds disputed, an adapter error leaves jevProbability null (model-decides H1)', async () => {
  const question = await holdQuestion('missing_fact');
  for (const [name, decision, answer, disputed, stored] of [
    ['forced eligible, p 0.05 < 0.1', 'eligible', 0.05, true, 0.05],
    ['forced eligible, p exactly 0.1', 'eligible', 0.1, false, 0.1],
    ['forced not_eligible, p exactly 0.7', 'not_eligible', 0.7, true, 0.7],
    ['forced not_eligible, p 0.69', 'not_eligible', 0.69, false, 0.69],
    ['forced eligible, Jev throws', 'eligible', () => { throw new Error('second opinion unavailable'); }, false, null],
  ]) {
    const db = freshDb();
    const q = queue();
    const id = q.add(db, 'p-verified', HOLDS.missing_fact);
    const assumption = 'Assumed the cluster experience is a nice-to-have for interns';
    const judges = makeJudges({ answers: q.answers, forced: { [id]: forcedOutput(decision, assumption) } });
    const jev = fakeSecondOpinion(answer);
    const receipt = await review(db, { pages: q.pages, judges, secondOpinion: jev });

    assert.equal(jev.calls.length, 1, `${name}: Jev is asked once`);
    const row = reviewOf(db, id);
    assert.deepEqual([row.state, row.decision, row.hold_owner], ['done', decision, null], `${name}: the forced decision stands`);
    assert.ok(flagsOf(db, id).includes('model_decided'), `${name}: model_decided: ${row.flags_json}`);
    assert.equal(flagsOf(db, id).includes('disputed'), disputed, `${name}: disputed is ${disputed}: ${row.flags_json}`);
    assert.deepEqual(evidenceOf(db, id).modelDecision, { question, assumption, jevProbability: stored }, `${name}: modelDecision evidence`);
    assert.equal(callsFor(judges.escalation, id).length, 2, `${name}: no further escalation after verification`);
    assert.deepEqual(receipt.awaiting_user, [], `${name}: nothing awaits the user`);
  }
});

test('[B] a failed forced-decision call (error, quota, unclear or no assumption) leaves the item due for a later run, never user-held; the later run decides it (model-decides H1)', async () => {
  for (const [name, answer] of [
    ['adapter error', { status: 'error', error: 'forced judge failed' }],
    ['quota', { status: 'quota', error: 'quota exhausted' }],
    ['the judge answers unclear', forcedOutput('unclear', 'Cannot tell')],
    ['no assumption', { output: { decision: 'eligible' } }],
  ]) {
    const db = freshDb();
    const q = queue();
    const id = q.add(db, 'p-forced-fails', HOLDS.missing_fact);
    const judges = makeJudges({ answers: q.answers, forced: { [id]: answer } });
    const jev = fakeSecondOpinion(0.9);
    const receipt = await review(db, { pages: q.pages, judges, secondOpinion: jev });

    assert.equal(forcedCalls(judges.escalation, id).length, 1, `${name}: exactly one forced call is made`);
    const row = reviewOf(db, id);
    assert.deepEqual([row.state, row.hold_owner], ['due', null], `${name}: the item stays due and system-owned: ${row.state}/${row.hold_owner}`);
    assert.equal(flagsOf(db, id).includes('model_decided'), false, `${name}: not model_decided`);
    assert.equal(jev.calls.length, 0, `${name}: nothing to verify`);
    assert.deepEqual(receipt.awaiting_user, [], `${name}: nothing awaits the user`);
    assert.deepEqual(userHolds(db), [], `${name}: no user-owned hold exists`);

    if (name === 'adapter error') {
      // The next run reuses the cached tier judgments and only repeats the forced call.
      const assumption = 'Assumed the requirement is trainable on the job';
      const later = makeJudges({ answers: q.answers, forced: { [id]: forcedOutput('eligible', assumption) } });
      await review(db, { pages: q.pages, judges: later, secondOpinion: fakeSecondOpinion(0.9), now: at(1), runId: 'review-model-decides-2' });
      assert.equal(later.primary.calls.length, 0, 'the later run does not re-judge the primary tier');
      assert.deepEqual(later.escalation.calls.map((call) => call.request.forceDecision === true), [true], 'the later run makes only the forced call');
      const decided = reviewOf(db, id);
      assert.deepEqual([decided.state, decided.decision, decided.hold_owner], ['done', 'eligible', null], 'the later run decides it');
      assert.ok(flagsOf(db, id).includes('model_decided'));
    }
  }
});

test('[B] exploration lanes keep their rule without a forced call, while an ordinary-lane hold is decided by the model (model-decides H1)', async () => {
  const db = freshDb();
  const q = queue();
  const sampled = q.add(db, 'p-sampled-hold', { ...HOLDS.missing_fact, text: retitled(HOLDS.missing_fact.text, 'Platform Data Intern Sampled'), lane: 'no_student_signal' });
  const control = q.add(db, 'p-control-hold', { ...HOLDS.missing_fact, text: retitled(HOLDS.missing_fact.text, 'Platform Data Intern Control') });
  const forced = { [sampled]: forcedOutput('eligible', 'never used'), [control]: forcedOutput('eligible', 'Assumed the cluster work is taught on the job') };
  const judges = makeJudges({ answers: q.answers, forced });
  // Budget 40 gives an exploration share of ceil(40 * 0.10) = 4, so the sampled item is judged.
  const receipt = await review(db, { pages: q.pages, judges, secondOpinion: fakeSecondOpinion(0.9), budget: 40 });

  assert.equal(forcedCalls(judges.escalation, sampled).length, 0, 'an exploration-lane item makes no forced call');
  const row = reviewOf(db, sampled);
  assert.deepEqual([row.state, row.decision, row.code, row.hold_owner], ['done', 'not_eligible', 'no_student_signal', null],
    'the exploration item ends not_eligible with its lane as code');
  assert.equal(flagsOf(db, sampled).includes('model_decided'), false, 'the exploration item is not model_decided');

  assert.equal(forcedCalls(judges.escalation, control).length, 1, 'the ordinary-lane hold gets one forced call');
  const decided = reviewOf(db, control);
  assert.deepEqual([decided.state, decided.decision, decided.hold_owner], ['done', 'eligible', null], 'the ordinary-lane hold is decided by the model');
  assert.ok(flagsOf(db, control).includes('model_decided'));
  assert.deepEqual(receipt.awaiting_user, [], 'nothing awaits the user');
});

// ------------------------------------------------------------------ H2

test('[B] bootstrap re-queues provenance_unknown applications as system work that is fetched and judged; user declines, submitted and prepared stay untouched (model-decides H2)', async () => {
  const { bootstrapExisting } = await bootstrapModule();
  const db = freshDb();
  const title = (suffix) => `Data Science Intern Legacy ${suffix}`;
  const url = (n) => `https://job-boards.greenhouse.io/examplecorp/jobs/${8100000 + n}`;
  const apps = {
    withdrawn: seedCheckerWithdrawal(db, { company: 'Example Corp', role: title('Withdrawn'), jobUrl: url(1), note: 'skip, see notes' }),
    hidden: seedApplication(db, { company: 'Example Corp', role: title('Hidden'), jobUrl: url(2), skipReason: 'waiting on recruiter answer', skipOwner: 'legacy' }),
    declined: seedCheckerWithdrawal(db, { company: 'Example Corp', role: title('Declined'), jobUrl: url(3), note: 'USER declined: not interested' }),
    submitted: seedApplication(db, { company: 'Example Corp', role: title('Submitted'), jobUrl: url(4), status: 'applied', appliedAt: '2026-10-05T00:00:00.000Z' }),
    prepared: seedApplication(db, { company: 'Example Corp', role: title('Prepared'), jobUrl: url(5), status: 'prepared' }),
  };
  const counts = bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  const postingOf = (app) => db.prepare('SELECT id FROM postings WHERE application_id = ?').get(app.id)?.id;
  const ids = Object.fromEntries(Object.entries(apps).map(([name, app]) => [name, postingOf(app)]));

  assert.equal(counts.held, 0, `bootstrap holds nothing for the user: ${JSON.stringify(counts)}`);
  assert.deepEqual(userHolds(db), [], 'no provenance_unknown user hold is written');
  for (const name of ['withdrawn', 'hidden']) {
    const row = reviewOf(db, ids[name]);
    assert.deepEqual([row.state, row.hold_owner], ['due', null], `${name}: the unknown-provenance application is queued as system work`);
    assert.notEqual(row.code, 'provenance_unknown', `${name}: no provenance_unknown hold`);
  }
  const protectedNames = ['declined', 'submitted', 'prepared'];
  const before = Object.fromEntries(protectedNames.map((name) => [name, { review: { ...reviewOf(db, ids[name]) }, app: { ...applicationOf(db, ids[name]) } }]));

  const pages = Object.fromEntries(Object.keys(apps).map((name, index) => [url(index + 1), page(url(index + 1), retitled(SNAPSHOTS.eligible, title(name[0].toUpperCase() + name.slice(1))))]));
  const fetcher = fakeFetcher(pages);
  const judges = makeJudges({ answers: () => ({ output: JUDGMENTS.eligible }) });
  await review(db, { judges, fetcher, policy: REVIEW_POLICY });

  const fetched = fetcher.calls.map((call) => call.url);
  for (const n of [1, 2]) assert.ok(fetched.includes(url(n)), `the unknown-provenance posting ${url(n)} is fetched: ${JSON.stringify(fetched)}`);
  for (const n of [3, 4, 5]) assert.equal(fetched.includes(url(n)), false, `the user-decided posting ${url(n)} is never fetched`);
  for (const name of ['withdrawn', 'hidden']) {
    const row = reviewOf(db, ids[name]);
    assert.deepEqual([row.state, row.decision, row.code, row.hold_owner], ['done', 'eligible', null, null], `${name}: judged and delivered like any other review`);
    const app = applicationOf(db, ids[name]);
    assert.deepEqual([app.status, app.skip_reason], ['lead', null], `${name}: the eligible posting is a visible lead again`);
  }
  for (const name of protectedNames) {
    assert.deepEqual({ review: { ...reviewOf(db, ids[name]) }, app: { ...applicationOf(db, ids[name]) } }, before[name], `${name}: untouched`);
  }
});

test('[B] provenance_unknown user holds already written by an earlier bootstrap are re-queued, fetched and judged; a user decline is not (model-decides H2)', async () => {
  const db = freshDb();
  const seen = '2026-10-20T00:00:00.000Z';
  const postingOf = (app) => db.prepare('SELECT id FROM postings WHERE application_id = ?').get(app.id).id;
  const text = retitled(SNAPSHOTS.eligible, 'Data Science Intern Legacy Held');
  const url = urlOf('8200001');
  // The rows an earlier bootstrap wrote: a legacy-owned hidden lead held for the user as provenance_unknown.
  const legacy = seedApplication(db, { company: 'Example Corp', role: snapshotTitle(text), jobUrl: url, skipReason: 'waiting on recruiter answer', skipOwner: 'legacy' });
  const held = postingOf(legacy);
  insertReview(db, { postingId: held, stage: 'fetch', state: 'held', decision: 'unclear', code: 'provenance_unknown', holdOwner: 'user', lane: 'refresh', nextDue: null, firstSeen: seen });
  // Control: an explicit user decline from the same bootstrap.
  const declinedText = retitled(SNAPSHOTS.eligible, 'Data Science Intern Declined');
  const declinedUrl = urlOf('8200002');
  const declinedApp = seedCheckerWithdrawal(db, { company: 'Example Corp', role: snapshotTitle(declinedText), jobUrl: declinedUrl, note: 'USER declined: not interested' });
  db.prepare("UPDATE applications SET skip_owner = 'user' WHERE id = ?").run(declinedApp.id);
  const declined = postingOf(declinedApp);
  insertReview(db, { postingId: declined, stage: 'fetch', state: 'done', decision: 'reused', code: 'user_declined', lane: 'refresh', nextDue: null, firstSeen: seen });
  const declinedBefore = { review: { ...reviewOf(db, declined) }, app: { ...applicationOf(db, declined) } };

  const fetcher = fakeFetcher({ [url]: page(url, text), [declinedUrl]: page(declinedUrl, declinedText) });
  const judges = makeJudges({ answers: () => ({ output: JUDGMENTS.eligible }) });
  const receipt = await review(db, { judges, fetcher, policy: REVIEW_POLICY });

  assert.deepEqual(fetcher.calls.map((call) => call.url), [url], 'only the legacy hold is fetched');
  const row = reviewOf(db, held);
  assert.deepEqual([row.state, row.decision, row.code, row.hold_owner], ['done', 'eligible', null, null], 'the legacy hold is judged and delivered as system work');
  const app = applicationOf(db, held);
  assert.deepEqual([app.status, app.skip_reason], ['lead', null], 'the eligible legacy lead is visible');
  assert.deepEqual(receipt.awaiting_user, [], `nothing awaits the user: ${JSON.stringify(receipt.awaiting_user)}`);
  assert.deepEqual({ review: { ...reviewOf(db, declined) }, app: { ...applicationOf(db, declined) } }, declinedBefore, 'the user decline is untouched');
});

// ------------------------------------------------------------------ H3

test('[B] the receipt and the report list model-decided items in their own section with their assumption; awaiting_user stays empty (model-decides H3)', async () => {
  const { reviewReport } = await reportModule();
  const db = freshDb();
  const q = queue();
  const lead = q.add(db, 'p-model-lead', HOLDS.missing_fact);
  const rejected = q.add(db, 'p-model-rejected', HOLDS.user_review);
  const assumptions = {
    [lead]: 'Assumed cluster experience can be learned during the internship',
    [rejected]: 'Assumed the pre-sales role is outside the data focus',
  };
  const judges = makeJudges({ answers: q.answers, forced: {
    [lead]: forcedOutput('eligible', assumptions[lead]),
    [rejected]: forcedOutput('not_eligible', assumptions[rejected]),
  } });
  // Jev agrees with the lead (0.8) and strongly disagrees with the rejection (0.9 >= 0.7): disputed.
  const jev = fakeSecondOpinion(({ state }) => (JSON.stringify(state).includes(assumptions[lead]) ? 0.8 : 0.9));
  const receipt = await review(db, { pages: q.pages, judges, secondOpinion: jev });

  assert.deepEqual(receipt.awaiting_user, [], `awaiting_user is empty: ${JSON.stringify(receipt.awaiting_user)}`);
  assert.deepEqual(receipt.awaiting_user_summary, [], 'awaiting_user_summary is empty');
  assert.ok(Array.isArray(receipt.model_decided), `receipt.model_decided lists the model-decided items: ${JSON.stringify(receipt)}`);
  const entries = Object.fromEntries(receipt.model_decided.map((item) => [item.postingId, item]));
  assert.deepEqual(Object.keys(entries).sort(), [lead, rejected].sort(), `both items are listed once: ${JSON.stringify(receipt.model_decided)}`);
  assert.deepEqual([entries[lead].decision, entries[lead].assumption, entries[lead].disputed], ['eligible', assumptions[lead], false]);
  assert.deepEqual([entries[rejected].decision, entries[rejected].assumption, entries[rejected].disputed], ['not_eligible', assumptions[rejected], true]);

  const report = reviewReport(db, { receipt });
  const lines = report.split('\n');
  const section = (heading) => {
    const start = lines.findIndex((line) => line.trim() === heading);
    if (start < 0) return null;
    const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
  };
  const decided = section('## Model-decided');
  assert.ok(decided !== null, `the report has a "## Model-decided" section:\n${report}`);
  for (const id of [lead, rejected]) {
    assert.ok(decided.includes(urlOf(id)), `${id} is listed under Model-decided:\n${decided}`);
    assert.ok(decided.includes(assumptions[id]), `${id}'s assumption is shown:\n${decided}`);
  }
  const rejectedBlock = decided.split('\n').filter((line) => line.includes(urlOf(rejected)) || line.includes(assumptions[rejected])).join('\n');
  assert.match(rejectedBlock, /disputed/i, `the disputed decision is marked:\n${decided}`);
  const leadBlock = decided.split('\n').filter((line) => line.includes(urlOf(lead)) || line.includes(assumptions[lead])).join('\n');
  assert.doesNotMatch(leadBlock, /disputed/i, `the agreed decision is not marked disputed:\n${decided}`);
  const awaiting = section('## Awaiting you') ?? '';
  for (const id of [lead, rejected]) assert.equal(awaiting.includes(urlOf(id)), false, `${id} is not awaiting the user:\n${awaiting}`);
});

// ------------------------------------------------------------------ P1

test('[B] operational policy blocks never re-queue judged reviews; screening policy blocks do (model-decides P1)', async () => {
  const db = freshDb();
  const q = queue();
  q.add(db, 'p-eligible', { text: SNAPSHOTS.eligible, output: JUDGMENTS.eligible });
  q.add(db, 'p-degree', { text: SNAPSHOTS.undergradOnly, output: JUDGMENTS.undergradOnly });
  q.add(db, 'p-area', { text: OUTSIDE_AREA_TEXT, output: OUTSIDE_AREA });
  const settled = ['p-eligible', 'p-degree', 'p-area'];
  const outcome = (id) => { const row = reviewOf(db, id); return [row.state, row.decision, row.code]; };

  const before = { ...REVIEW_POLICY, judge: { primary: { runner: 'codex', model: 'codex-older' } } };
  await review(db, { pages: q.pages, judges: makeJudges({ answers: q.answers }), policy: before });
  const judged = Object.fromEntries(settled.map((id) => [id, outcome(id)]));
  assert.deepEqual(judged, { 'p-eligible': ['done', 'eligible', null], 'p-degree': ['done', 'not_eligible', 'degree'], 'p-area': ['done', 'not_eligible', 'outside_area'] },
    'fixture sanity: three settled reviews');

  // Operational change only: another primary model (policy and adapter), a second opinion, and other budgets.
  const operational = { ...REVIEW_POLICY, judge: { primary: { runner: 'codex', model: 'codex-auto-review' }, secondOpinion: SECOND_OPINION },
    budgets: { ...REVIEW_POLICY.budgets, attempts: 40, fetches: 400, concurrency: 2 } };
  q.add(db, 'p-new', { text: retitled(SNAPSHOTS.eligible, 'Data Science Intern New Cohort'), output: JUDGMENTS.eligible, firstSeen: at(1) });
  const fetcher = fakeFetcher(q.pages);
  const judges = makeJudges({ answers: q.answers, primaryModel: 'codex-auto-review' });
  const jev = fakeSecondOpinion(0.9);
  await review(db, { judges, fetcher, policy: operational, secondOpinion: jev, now: at(1), runId: 'review-model-decides-2' });
  const called = [...judges.primary.calls, ...judges.escalation.calls].map((call) => call.request.postingId);
  assert.deepEqual(called.filter((id) => settled.includes(id)), [],
    `a judge/budget/second-opinion change re-judges no settled review: called ${JSON.stringify(called)}`);
  assert.deepEqual(fetcher.calls.map((call) => call.url).filter((url) => url !== urlOf('p-new')), [], 'and fetches none of them');
  for (const id of settled) assert.deepEqual(outcome(id), judged[id], `${id} keeps its decision`);
  assert.deepEqual(called, ['p-new'], 'a new review simply uses the new judge');

  // A screening change (areas) re-queues the affected negative reviews, as today.
  const screening = { ...operational, areas: { ...operational.areas, allowedStates: [...operational.areas.allowedStates, 'TX'] } };
  const after = makeJudges({ answers: q.answers, primaryModel: 'codex-auto-review' });
  await review(db, { pages: q.pages, judges: after, policy: screening, secondOpinion: fakeSecondOpinion(0.05), now: at(2), runId: 'review-model-decides-3' });
  const rejudged = after.primary.calls.map((call) => call.request.postingId);
  for (const id of ['p-degree', 'p-area']) assert.ok(rejudged.includes(id), `${id}: an areas change re-judges a not_eligible review: called ${JSON.stringify(rejudged)}`);
});
