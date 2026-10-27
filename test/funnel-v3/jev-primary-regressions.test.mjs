// Red tests for the user ruling of 2026-10-27, "直接用 jev 做判断": Jev is the primary judge of the screening funnel.
// Today every fetched posting goes to the Codex primary tier (a paid attempt), Jev is only a second opinion on its
// verdicts, and `review eval` measures that chain. The split-question experiment (37 real cases) gave no false
// accepts and no false rejects with the thresholds below, leaving 6 cases in between.
// Rulings:
//   J1  judge.primary = { runner: 'jev-split', model, thresholds: { reject, accept } }. For each fetched posting the
//       worker asks Jev six separate noul questions (degree, term, place, auth, function, skills). Each call carries
//       only that dimension's candidate facts plus the posting text; the question texts are the split-experiment
//       texts, kept in a module constant. Decision:
//         any dimension p < reject[dimension]        -> not_eligible, code by dimension (the first in the order
//                                                       degree, term, place, auth, function, skills when several),
//                                                       evidence_json.jev = the six probabilities;
//         else every dimension p >= accept[dimension] -> eligible, flag 'jev_decided', evidence_json.jev;
//         otherwise (in between)                      -> the configured judge.fallback chain (today's Codex
//                                                       primary -> second opinion -> escalation), with
//                                                       evidence_json.jev kept on the final review.
//   J2  Jev calls are not Codex paid attempts (no attempts rows, no budget use). receipt.jev = { postings, calls,
//       decided_eligible, decided_not_eligible, escalated, errors }. Any Jev error for a posting (a throw or a
//       probability outside [0, 1]) sends it to the fallback; the worker never decides on partial answers.
//   J3  Code-verified exclusions and closures are unchanged. Exploration lanes take the same Jev path (non-eligible
//       ends not_eligible with the lane as code; eligible is found_by_sampling). Model-decides (H1) forced calls apply
//       only to holds produced by the fallback chain.
//   J4  `review eval` (runEval) uses the same strategy, so the gate measures it.
// Contract fixed here:
//   module:          src/review/jev-split.mjs exports JEV_SPLIT_QUESTIONS, keyed by the six dimensions; each entry is
//                    the question text (or an object whose .question is it), the same text as the experiment.
//   adapter:         runReview({ ..., jev }) and runEval({ ..., jev }) take a Jev adapter with the second-opinion
//                    interface ask({ state, question }) -> { probability }; one ask() per question. The command layer
//                    takes it from runtime.review.jev (otherwise it builds the real one from judge.primary).
//   fallback:        the injected judges keep their tier names: judges.primary is the Codex fallback (attempt tier
//                    'primary'), judges.escalation the escalation tier. createJudgeAdapters(policy) builds
//                    judges.primary from judge.fallback when judge.primary.runner is 'jev-split'.
//   fact routing:    as in the experiment: degree <- facts degree, graduation, bachelors, full-time-enrolled(-*), gpa
//                    facts; term <- availability facts; auth <- permanent-resident, sponsorship, no-defense-work;
//                    place <- the policy areas (and windows); function <- the policy functions; skills <- all facts.
//   receipt.jev:     counts per posting except calls (every ask() made); escalated includes postings with an error.
// Not fixed here (open): whether a Jev not_eligible also carries 'jev_decided'; whether Jev is asked for a posting
// whose company is excluded (only the outcome is fixed); exact eval case fields beyond decision/code/attempts.
// Synthetic data only: every employer, place, URL and candidate fact is invented. No network: fetch throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { schemaMigrations } from '../../src/storage/database.mjs';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { freshDb, load, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0 } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs, writeReviewFiles, writeReviewHome } from '../../test-utils/funnel-v3-fixtures.mjs';

const workerModule = () => load('B6', './src/review/worker.mjs', ['runReview']);
const evalModule = () => load('B8', './src/review/eval.mjs', ['runEval']);
const judgeModule = () => load('B1', './src/review/judge.mjs', ['createJudgeAdapters']);
const jevModule = () => load('J1', './src/review/jev-split.mjs', ['JEV_SPLIT_QUESTIONS']);

// ------------------------------------------------------------------ policy

const DIMENSIONS = Object.freeze(['degree', 'term', 'place', 'auth', 'function', 'skills']);
const THRESHOLDS = Object.freeze({
  reject: Object.freeze({ degree: 0.3, term: 0.3, place: 0.3, auth: 0.3, function: 0.3, skills: 0.2 }),
  accept: Object.freeze({ degree: 0.7, term: 0.65, place: 0.8, auth: 0.55, function: 0.7, skills: 0.4 }),
});
const CODES = Object.freeze({ degree: 'degree', term: 'outside_window', place: 'outside_area', auth: 'authorization', function: 'function_out_of_scope', skills: 'requirement' });
const JEV_JUDGE = Object.freeze({
  primary: { runner: 'jev-split', model: 'jev-test', thresholds: THRESHOLDS },
  fallback: { runner: 'codex', model: 'codex-auto-review' },
  escalation: { runner: 'codex', model: 'codex-escalation' },
});
const SECOND_OPINION = Object.freeze({ runner: 'jev', model: 'jev-test', threshold: 0.1, eligibleThreshold: 0.7 });
const JEV_POLICY = Object.freeze({ ...REVIEW_POLICY, judge: JEV_JUDGE });
const JEV_POLICY_SO = Object.freeze({ ...REVIEW_POLICY, judge: { ...JEV_JUDGE, secondOpinion: SECOND_OPINION } });

// Candidate facts with the experiment's fact ids, so each question can be given only its own facts.
const DEGREE_FACT = 'Pursuing a Master of Science in Statistics with graduation in May 2028';
const TERM_FACT = 'Available for a full-time internship in the summer of 2027';
const AUTH_FACT = 'Authorized to work in the United States without visa sponsorship';
const PYTHON_FACT = 'Uses Python daily in coursework and work';
const SCALA_FACT = 'Has no Scala experience';
const SPLIT_FACTS = Object.freeze([
  { id: 'degree', statement: DEGREE_FACT, polarity: 'constraint', value: { level: 'masters', graduation: '2028-05' } },
  { id: 'availability', statement: TERM_FACT, polarity: 'has' },
  { id: 'sponsorship', statement: AUTH_FACT, polarity: 'has' },
  { id: 'python', statement: PYTHON_FACT, polarity: 'has' },
  { id: 'sql', statement: 'Writes SQL for analytics', polarity: 'has' },
  { id: 'scala', statement: SCALA_FACT, polarity: 'lacks' },
]);

// ------------------------------------------------------------------ Jev answers

// Case 01 of the experiment: every dimension at or above its accept threshold.
const HIGH = Object.freeze({ degree: 0.97, term: 0.82, place: 0.87, auth: 0.95, function: 0.71, skills: 0.63 });
const AT_ACCEPT = Object.freeze({ ...THRESHOLDS.accept });
const BETWEEN = Object.freeze({ ...HIGH, skills: 0.3 }); // skills >= 0.2 (no reject) but < 0.4 (no accept)
const LOW = Object.freeze({ degree: 0.1, term: 0.1, place: 0.1, auth: 0.1, function: 0.1, skills: 0.05 });
const below = (dimension) => ({ ...HIGH, [dimension]: LOW[dimension] });

// Each experiment question is recognised by one phrase of its text.
const QUESTION_PATTERNS = Object.freeze({
  degree: /degree level/i, term: /offers a work term/i, place: /allowed areas/i,
  auth: /work authorization/i, function: /main function/i, skills: /mandatory/i,
});
// Phrases of the experiment texts the module constant must keep.
const EXPERIMENT_PHRASES = Object.freeze({
  degree: /does not restrict degree/,
  term: /first seen in fall 2026, it means 2027/,
  place: /at least one office or remote option in the posting is inside the candidate's allowed areas for that work term/,
  auth: /not US military\/defense work or a clearance-required role/,
  function: /the role's main function is one of the wanted directions/,
  skills: /Preferred or "nice to have" items do not count/,
});
function dimensionOf(question) {
  const hits = DIMENSIONS.filter((dimension) => QUESTION_PATTERNS[dimension].test(String(question ?? '')));
  if (hits.length !== 1) throw new Error(`fake Jev: not one of the six split questions: ${String(question).slice(0, 120)}`);
  return hits[0];
}
const textOf = (entry) => (typeof entry === 'string' ? entry : entry?.question);
const stateText = (state) => (typeof state === 'string' ? state : JSON.stringify(state ?? null));
const markerLine = (id) => `Case marker ${id}.`;

// Fake Jev adapter: answers by the case marker in the posting text and by the question's dimension.
// script[id] is { dimension: probability | Error } or a function (dimension, call) -> probability.
function fakeJev(script) {
  const calls = [];
  return {
    id: 'fake-jev-split', runner: 'jev', model: 'jev-test', calls,
    async ask(call) {
      calls.push(call);
      const text = stateText(call?.state);
      const id = Object.keys(script).find((key) => text.includes(markerLine(key)));
      if (!id) throw new Error('fake Jev: no case marker in the state');
      const dimension = dimensionOf(call?.question);
      const answer = script[id];
      const value = typeof answer === 'function' ? await answer(dimension, call) : answer[dimension];
      if (value instanceof Error) throw value;
      return { probability: value, usage: { requests: 1 } };
    },
  };
}
const jevCallsFor = (jev, id) => jev.calls.filter((call) => stateText(call?.state).includes(markerLine(id)));

// Fake second-opinion adapter (escalation E3 interface), answering by case marker.
function fakeSecondOpinion(answer) {
  const calls = [];
  return {
    id: 'fake-second-opinion', runner: 'jev', model: 'jev-test', calls,
    async ask(call) {
      calls.push(call);
      const probability = typeof answer === 'function' ? await answer(stateText(call.state)) : answer;
      return { probability, usage: { requests: 1 } };
    },
  };
}

// ------------------------------------------------------------------ postings and harness

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
const titled = (text, title) => text.replace(snapshotTitle(text), title);

function queue() {
  const pages = {};
  const answers = {};
  const script = {};
  return {
    pages, answers, script,
    add(db, id, { jev, fallback = JUDGMENTS.eligible, text = SNAPSHOTS.eligible, lane = 'new', company = 'Example Corp', closed = false }) {
      const body = `${titled(text, `${snapshotTitle(text)} ${id}`)}\n${markerLine(id)}\n`;
      insertPosting(db, { id, url: urlOf(id), company, title: snapshotTitle(body), firstSeen: T0 });
      insertReview(db, { postingId: id, stage: 'fetch', firstSeen: T0, nextDue: T0, lane });
      pages[urlOf(id)] = page(urlOf(id), body, closed ? { closedWording: true } : {});
      answers[id] = { output: fallback };
      if (jev) script[id] = jev;
      return id;
    },
  };
}

// Fake Codex judges: judges.primary is the fallback tier; forced (H1) requests are answered from `forced`.
function makeJudges({ answers, escalation = answers, forced = {} }) {
  const respond = (table) => (request) => {
    if (request.forceDecision === true) return forced[request.postingId];
    return typeof table === 'function' ? table(request) : table[request.postingId];
  };
  return {
    primary: fakeJudge({ tier: 'primary', model: 'codex-auto-review', answers: respond(answers) }),
    escalation: fakeJudge({ tier: 'escalation', model: 'codex-escalation', answers: respond(escalation) }),
  };
}

// Any network use fails the test.
async function offline(run) {
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => { attempts.push(String(url)); throw new Error(`network access in a test: ${url}`); };
  try { return await run(); } finally {
    globalThis.fetch = original;
    assert.deepEqual(attempts, [], 'no network request is made');
  }
}

async function review(db, { pages, judges, jev, secondOpinion, policy = JEV_POLICY, budget = 20, runId = 'review-jev-primary' }) {
  const { runReview } = await workerModule();
  return offline(() => runReview({
    db, runId, owner: 'worker-a', now: T0, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fakeFetcher(pages), judges, inputs: () => reviewInputs({ policy, facts: SPLIT_FACTS }), hooks: {},
    ...(jev ? { jev } : {}), ...(secondOpinion ? { secondOpinion } : {}),
  }));
}

const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const flagsOf = (db, id) => parse(reviewOf(db, id).flags_json, []);
const evidenceOf = (db, id) => parse(reviewOf(db, id).evidence_json, {});
const outcome = (db, id) => { const row = reviewOf(db, id); return [row.state, row.decision, row.code]; };
const applicationOf = (db, postingId) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(postingId);
const callsFor = (judge, id) => judge.calls.filter((call) => call.request.postingId === id);
const codexCalls = (judges, id) => callsFor(judges.primary, id).length + callsFor(judges.escalation, id).length;
const attemptsOf = (db) => db.prepare('SELECT posting_id, tier, runner FROM attempts ORDER BY posting_id, rowid').all().map((row) => ({ ...row }));
const tiersOf = (db, id) => db.prepare('SELECT tier FROM attempts WHERE posting_id = ? ORDER BY rowid').all(id).map((row) => row.tier);

// ------------------------------------------------------------------ J1

test('[B] Jev is asked six separate split questions per posting, with the module constant\'s texts and only each question\'s own candidate facts plus the posting text (jev-primary J1)', async () => {
  const { JEV_SPLIT_QUESTIONS } = await jevModule();
  assert.deepEqual(Object.keys(JEV_SPLIT_QUESTIONS).sort(), [...DIMENSIONS].sort(), 'one question per dimension');
  for (const dimension of DIMENSIONS) {
    const text = textOf(JEV_SPLIT_QUESTIONS[dimension]);
    assert.match(String(text), /^Is this statement true: /, `${dimension}: a noul statement question as in the experiment`);
    assert.equal(dimensionOf(text), dimension, `${dimension}: the experiment's question for this dimension`);
    assert.match(text, EXPERIMENT_PHRASES[dimension], `${dimension}: the experiment's text is kept`);
  }

  const db = freshDb();
  const q = queue();
  const id = q.add(db, 'p-split', { jev: HIGH });
  const judges = makeJudges({ answers: q.answers });
  const jev = fakeJev(q.script);
  await review(db, { pages: q.pages, judges, jev });

  const calls = jevCallsFor(jev, id);
  assert.equal(calls.length, 6, `six separate Jev calls for the posting (got ${jev.calls.length})`);
  assert.deepEqual(calls.map((call) => dimensionOf(call.question)).sort(), [...DIMENSIONS].sort(), 'each dimension is asked once');
  const own = { degree: [DEGREE_FACT], term: [TERM_FACT], auth: [AUTH_FACT], skills: [PYTHON_FACT, SCALA_FACT], place: [REVIEW_POLICY.areas.text], function: [] };
  const foreign = {
    degree: [TERM_FACT, AUTH_FACT, PYTHON_FACT], term: [DEGREE_FACT, AUTH_FACT, PYTHON_FACT], auth: [DEGREE_FACT, TERM_FACT, PYTHON_FACT],
    place: [DEGREE_FACT, AUTH_FACT, PYTHON_FACT], function: [DEGREE_FACT, AUTH_FACT, PYTHON_FACT], skills: [],
  };
  for (const call of calls) {
    const dimension = dimensionOf(call.question);
    assert.equal(call.question, textOf(JEV_SPLIT_QUESTIONS[dimension]), `${dimension}: the question is the module constant's text`);
    const state = stateText(call.state);
    assert.ok(state.includes('Proficiency in Python or R for data analysis.') && state.includes(markerLine(id)), `${dimension}: the state carries the posting text`);
    for (const fact of own[dimension]) assert.ok(state.includes(fact), `${dimension}: the state carries its own context "${fact}"`);
    for (const fact of foreign[dimension]) assert.equal(state.includes(fact), false, `${dimension}: the state does not carry another question's fact "${fact}"`);
  }
});

test('[B] every dimension at or above its accept threshold makes the posting eligible by Jev alone: jev_decided, evidence jev, a visible lead, no Codex call (jev-primary J1)', async () => {
  const db = freshDb();
  const q = queue();
  // The fallback would reject both: only Jev can make them eligible.
  q.add(db, 'p-high', { jev: HIGH, fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly });
  q.add(db, 'p-at-accept', { jev: AT_ACCEPT, fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly });
  const judges = makeJudges({ answers: q.answers });
  const jev = fakeJev(q.script);
  const receipt = await review(db, { pages: q.pages, judges, jev });

  for (const [id, probabilities] of [['p-high', HIGH], ['p-at-accept', AT_ACCEPT]]) {
    assert.equal(jevCallsFor(jev, id).length, 6, `${id}: six Jev calls (got ${jevCallsFor(jev, id).length})`);
    assert.equal(codexCalls(judges, id), 0, `${id}: no Codex call`);
    const row = reviewOf(db, id);
    assert.deepEqual([row.state, row.decision, row.hold_owner], ['done', 'eligible', null], `${id}: eligible by Jev: ${outcome(db, id)}`);
    assert.ok(flagsOf(db, id).includes('jev_decided'), `${id}: flagged jev_decided: ${row.flags_json}`);
    assert.deepEqual(evidenceOf(db, id).jev, probabilities, `${id}: evidence jev holds the six probabilities`);
    const app = applicationOf(db, id);
    assert.ok(app, `${id}: delivered as a lead`);
    assert.deepEqual([app.status, app.skip_reason], ['lead', null], `${id}: the lead is visible`);
  }
  assert.deepEqual(attemptsOf(db), [], 'no paid attempt is recorded');
  assert.equal(receipt.counts.attempts, 0);
});

test('[B] any dimension below its reject threshold makes the posting not_eligible with that dimension\'s code and evidence jev, without a Codex call; the first dimension in order wins (jev-primary J1)', async () => {
  const db = freshDb();
  const q = queue();
  const expected = {};
  for (const dimension of DIMENSIONS) {
    const id = q.add(db, `p-low-${dimension}`, { jev: below(dimension) }); // the fallback would accept
    expected[id] = { code: CODES[dimension], jev: below(dimension) };
  }
  const both = { ...HIGH, degree: LOW.degree, skills: LOW.skills };
  q.add(db, 'p-low-two', { jev: both });
  expected['p-low-two'] = { code: 'degree', jev: both };
  const judges = makeJudges({ answers: q.answers });
  const jev = fakeJev(q.script);
  await review(db, { pages: q.pages, judges, jev });

  for (const [id, { code, jev: probabilities }] of Object.entries(expected)) {
    assert.equal(jevCallsFor(jev, id).length > 0, true, `${id}: Jev is asked`);
    assert.equal(codexCalls(judges, id), 0, `${id}: no Codex call`);
    assert.deepEqual(outcome(db, id), ['done', 'not_eligible', code], `${id}: not_eligible with code ${code}`);
    assert.deepEqual(evidenceOf(db, id).jev, probabilities, `${id}: evidence jev holds the six probabilities`);
    assert.equal(applicationOf(db, id), undefined, `${id}: no lead is created`);
  }
  assert.deepEqual(attemptsOf(db), [], 'no paid attempt is recorded');
});

test('[B] an in-between posting (including one exactly at a reject threshold) goes to the fallback chain (Codex primary, second opinion, escalation) and keeps the Jev probabilities in evidence (jev-primary J1)', async () => {
  const db = freshDb();
  const q = queue();
  const atReject = { ...HIGH, degree: THRESHOLDS.reject.degree }; // 0.3 is not below 0.3, and below accept 0.7
  q.add(db, 'p-between', { jev: BETWEEN, fallback: JUDGMENTS.eligible });
  q.add(db, 'p-between-escalated', { jev: BETWEEN, fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly });
  q.add(db, 'p-at-reject', { jev: atReject, fallback: JUDGMENTS.eligible });
  const judges = makeJudges({ answers: q.answers, escalation: { 'p-between-escalated': { output: JUDGMENTS.eligible } } });
  const jev = fakeJev(q.script);
  // The second opinion agrees with the fallback's eligible verdicts (0.9) and does not confirm its rejection (0.5).
  const secondOpinion = fakeSecondOpinion((state) => (state.includes(markerLine('p-between-escalated')) ? 0.5 : 0.9));
  await review(db, { pages: q.pages, judges, jev, secondOpinion, policy: JEV_POLICY_SO });

  for (const [id, probabilities, tiers] of [
    ['p-between', BETWEEN, ['primary']],
    ['p-between-escalated', BETWEEN, ['primary', 'escalation']],
    ['p-at-reject', atReject, ['primary']],
  ]) {
    assert.equal(jevCallsFor(jev, id).length, 6, `${id}: Jev is asked the six questions first (got ${jevCallsFor(jev, id).length})`);
    assert.equal(callsFor(judges.primary, id).length, 1, `${id}: the Codex fallback judges it once`);
    assert.deepEqual(tiersOf(db, id), tiers, `${id}: the fallback chain's paid attempts`);
    assert.deepEqual(outcome(db, id), ['done', 'eligible', null], `${id}: the fallback chain decides`);
    assert.equal(flagsOf(db, id).includes('jev_decided'), false, `${id}: not jev_decided`);
    assert.deepEqual(evidenceOf(db, id).jev, probabilities, `${id}: evidence keeps the Jev probabilities`);
  }
  assert.equal(secondOpinion.calls.length, 3, 'the second opinion reviews each fallback primary verdict once');
});

test('[B] createJudgeAdapters builds the Codex fallback from judge.fallback when judge.primary is jev-split, and `review run` uses the injected Jev (jev-primary J1)', async () => {
  const { createJudgeAdapters } = await judgeModule();
  const runImpl = async () => { throw new Error('the adapter factory test never runs Codex'); };
  const codexHome = path.join(os.tmpdir(), 'cj-jev-primary-codex-home');
  const adapters = createJudgeAdapters({ judge: {
    primary: { runner: 'jev-split', model: 'jev-test', thresholds: THRESHOLDS },
    fallback: { runner: 'codex', model: 'codex-auto-review', codexHome, runImpl },
    escalation: { runner: 'codex', model: 'codex-escalation', codexHome, runImpl },
  } });
  assert.deepEqual([adapters.primary?.runner, adapters.primary?.model, adapters.primary?.tier], ['codex', 'codex-auto-review', 'primary'], 'the first Codex tier is the configured fallback');
  assert.deepEqual([adapters.escalation?.runner, adapters.escalation?.model], ['codex', 'codex-escalation']);

  if (!schemaMigrations.some((item) => item.version === 6)) throw new Error('NOT IMPLEMENTED [L1]: migration 006-funnel is not registered in schemaMigrations');
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-jev-primary-run-'));
  let context;
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    await writeReviewHome(home, { policy: JEV_POLICY, facts: SPLIT_FACTS });
    context = await openHomeDatabase(home);
    const q = queue();
    const id = q.add(context.db, 'p-cli', { jev: HIGH, fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly });
    const judges = makeJudges({ answers: q.answers });
    const jev = fakeJev(q.script);
    const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
    const { runCli } = await import('../../src/cli/main.mjs');
    const io = memoryIO();
    const code = await offline(() => runCli(['review', 'run', '--home', home, '--budget', '5'], io,
      { ...createRuntime({ root: process.cwd(), version: 'test' }), now: () => T0, review: { judges, jev, fetcher: fakeFetcher(q.pages) } }));
    assert.equal(code, 0, `${io.stderr}${io.stdout}`);
    assert.equal(jevCallsFor(jev, id).length, 6, `review run asks the injected Jev (got ${jev.calls.length})`);
    assert.equal(codexCalls(judges, id), 0, 'no Codex call');
    const row = reviewOf(context.db, id);
    assert.deepEqual([row.state, row.decision], ['done', 'eligible']);
    assert.ok(parse(row.flags_json, []).includes('jev_decided'), row.flags_json);
    assert.equal(parse(io.stdout, {}).jev?.postings, 1, `the printed receipt counts the Jev posting: ${io.stdout}`);
  } finally {
    try { context?.db.close(); } catch { /* closed */ }
    await rm(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ J2

test('[B] Jev calls are not paid attempts; receipt.jev counts postings, calls, Jev decisions, escalations and errors (jev-primary J2)', async () => {
  const db = freshDb();
  const q = queue();
  q.add(db, 'p-yes', { jev: HIGH });
  q.add(db, 'p-no', { jev: below('place') });
  q.add(db, 'p-mid', { jev: BETWEEN, fallback: JUDGMENTS.eligible });
  q.add(db, 'p-err', { jev: { ...HIGH, auth: new Error('Jev request failed') }, fallback: JUDGMENTS.eligible });
  const judges = makeJudges({ answers: q.answers });
  const jev = fakeJev(q.script);
  const receipt = await review(db, { pages: q.pages, judges, jev });

  assert.deepEqual(receipt.jev, { postings: 4, calls: jev.calls.length, decided_eligible: 1, decided_not_eligible: 1, escalated: 2, errors: 1 },
    `receipt.jev: ${JSON.stringify(receipt.jev)}`);
  assert.ok(jev.calls.length >= 19, `six calls for each answered posting and at least one for the failed one (got ${jev.calls.length})`);
  assert.deepEqual(attemptsOf(db), [
    { posting_id: 'p-err', tier: 'primary', runner: 'fake' },
    { posting_id: 'p-mid', tier: 'primary', runner: 'fake' },
  ], 'only the two fallback judgments are paid attempts');
  assert.equal(receipt.counts.attempts, 2);
  assert.deepEqual(outcome(db, 'p-yes'), ['done', 'eligible', null]);
  assert.deepEqual(outcome(db, 'p-no'), ['done', 'not_eligible', 'outside_area']);
});

test('[B] Jev decisions use no attempt budget: with budget 1 every Jev-decidable posting is still decided (jev-primary J2)', async () => {
  const db = freshDb();
  const q = queue();
  q.add(db, 'p-budget-1', { jev: HIGH });
  q.add(db, 'p-budget-2', { jev: below('degree') });
  q.add(db, 'p-budget-3', { jev: AT_ACCEPT });
  q.add(db, 'p-budget-4', { jev: below('function') });
  const judges = makeJudges({ answers: q.answers });
  const jev = fakeJev(q.script);
  const receipt = await review(db, { pages: q.pages, judges, jev, budget: 1 });

  assert.deepEqual(outcome(db, 'p-budget-1'), ['done', 'eligible', null]);
  assert.deepEqual(outcome(db, 'p-budget-2'), ['done', 'not_eligible', 'degree']);
  assert.deepEqual(outcome(db, 'p-budget-3'), ['done', 'eligible', null]);
  assert.deepEqual(outcome(db, 'p-budget-4'), ['done', 'not_eligible', 'function_out_of_scope']);
  assert.equal(jev.calls.length, 24, 'six Jev calls per posting');
  assert.deepEqual(attemptsOf(db), [], 'no attempt is spent');
  assert.equal(receipt.counts.attempts, 0);
  assert.notEqual(receipt.stop_reason, 'budget', 'the attempt budget is not exhausted by Jev');
});

test('[B] any Jev error for a posting (a throw or a probability outside [0, 1]) sends it to the fallback, even when the other answers would reject or accept (jev-primary J2)', async () => {
  const db = freshDb();
  const q = queue();
  // degree alone would reject, but auth failed: the fallback decides (eligible).
  q.add(db, 'p-err-reject', { jev: { ...below('degree'), auth: new Error('Jev request failed') }, fallback: JUDGMENTS.eligible });
  // five answers accept, skills failed: the fallback decides (not_eligible degree).
  q.add(db, 'p-err-accept', { jev: { ...HIGH, skills: new Error('Jev request failed') }, fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly });
  // an invalid probability is an error too.
  q.add(db, 'p-err-invalid', { jev: { ...HIGH, term: 1.5 }, fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly });
  const judges = makeJudges({ answers: q.answers });
  const jev = fakeJev(q.script);
  const receipt = await review(db, { pages: q.pages, judges, jev });

  for (const [id, expected] of [
    ['p-err-reject', ['done', 'eligible', null]],
    ['p-err-accept', ['done', 'not_eligible', 'degree']],
    ['p-err-invalid', ['done', 'not_eligible', 'degree']],
  ]) {
    assert.ok(jevCallsFor(jev, id).length >= 1, `${id}: Jev is asked`);
    assert.equal(callsFor(judges.primary, id).length, 1, `${id}: the error sends it to the Codex fallback`);
    assert.deepEqual(outcome(db, id), expected, `${id}: the fallback's verdict, never one from partial Jev answers`);
    assert.equal(flagsOf(db, id).includes('jev_decided'), false, `${id}: not jev_decided`);
  }
  assert.deepEqual(receipt.jev, { postings: 3, calls: jev.calls.length, decided_eligible: 0, decided_not_eligible: 0, escalated: 3, errors: 3 },
    `receipt.jev: ${JSON.stringify(receipt.jev)}`);
});

// ------------------------------------------------------------------ J3

test('[B] closures and company exclusions stay code-verified while open postings take the Jev path (jev-primary J3)', async () => {
  const db = freshDb();
  const q = queue();
  q.add(db, 'p-closed', { jev: HIGH, closed: true });
  q.add(db, 'p-excluded', { jev: HIGH, company: 'Excluded Example Co' });
  q.add(db, 'p-open', { jev: HIGH, fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly });
  const judges = makeJudges({ answers: q.answers });
  const jev = fakeJev(q.script);
  await review(db, { pages: q.pages, judges, jev });

  assert.deepEqual(outcome(db, 'p-closed'), ['done', 'not_eligible', 'closed_verified'], 'a closed posting is closed by code');
  assert.equal(jevCallsFor(jev, 'p-closed').length, 0, 'Jev is never asked about a closed posting');
  assert.equal(codexCalls(judges, 'p-closed'), 0);
  assert.deepEqual(outcome(db, 'p-excluded'), ['done', 'not_eligible', 'company_excluded'], 'an excluded company stays excluded whatever Jev answers');
  assert.equal(applicationOf(db, 'p-excluded'), undefined, 'no lead for an excluded company');
  assert.equal(jevCallsFor(jev, 'p-open').length, 6, 'the open posting is judged by Jev');
  assert.deepEqual(outcome(db, 'p-open'), ['done', 'eligible', null]);
  assert.ok(flagsOf(db, 'p-open').includes('jev_decided'));
});

test('[B] exploration lanes take the same Jev path: eligible is found_by_sampling, non-eligible ends not_eligible with the lane as code (jev-primary J3)', async () => {
  const db = freshDb();
  const q = queue();
  q.add(db, 'p-sample-yes', { jev: HIGH, lane: 'no_student_signal', fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly });
  q.add(db, 'p-sample-no', { jev: below('function'), lane: 'out_of_direction', fallback: JUDGMENTS.eligible });
  const judges = makeJudges({ answers: q.answers });
  const jev = fakeJev(q.script);
  // Budget 40 gives an exploration share of ceil(40 * 0.10) = 4, so both sampled items are judged.
  const receipt = await review(db, { pages: q.pages, judges, jev, budget: 40 });

  for (const id of ['p-sample-yes', 'p-sample-no']) {
    assert.equal(jevCallsFor(jev, id).length, 6, `${id}: judged by Jev (got ${jevCallsFor(jev, id).length})`);
    assert.equal(codexCalls(judges, id), 0, `${id}: no Codex call`);
  }
  assert.deepEqual(outcome(db, 'p-sample-yes'), ['done', 'eligible', null]);
  assert.ok(flagsOf(db, 'p-sample-yes').includes('found_by_sampling'), `found_by_sampling: ${reviewOf(db, 'p-sample-yes').flags_json}`);
  assert.ok(flagsOf(db, 'p-sample-yes').includes('jev_decided'));
  assert.deepEqual(outcome(db, 'p-sample-no'), ['done', 'not_eligible', 'out_of_direction'], 'the lane is the negative code');
  assert.deepEqual(evidenceOf(db, 'p-sample-no').jev, below('function'), 'the Jev probabilities stay in evidence');
  assert.deepEqual(receipt.sampling, { judged: 2, found: 1 });
});

test('[B] model-decides forced calls apply only to holds from the fallback chain, never to Jev-decided postings (jev-primary J3)', async () => {
  const db = freshDb();
  const q = queue();
  q.add(db, 'p-jev-yes', { jev: HIGH });
  q.add(db, 'p-jev-no', { jev: below('degree') });
  // In between; the fallback chain holds missing_fact at the escalation tier, then the model decides (H1).
  q.add(db, 'p-chain-hold', { jev: BETWEEN, fallback: JUDGMENTS.missingFact, text: SNAPSHOTS.missingFact });
  const assumption = 'Assumed cluster operations can be learned during the internship';
  const judges = makeJudges({ answers: q.answers, forced: { 'p-chain-hold': { output: { decision: 'eligible', assumption } } } });
  const jev = fakeJev(q.script);
  const receipt = await review(db, { pages: q.pages, judges, jev, secondOpinion: fakeSecondOpinion(0.8), policy: JEV_POLICY_SO });

  for (const id of ['p-jev-yes', 'p-jev-no']) {
    assert.equal(jevCallsFor(jev, id).length, 6, `${id}: decided by Jev`);
    assert.equal(codexCalls(judges, id), 0, `${id}: no Codex call, forced or not`);
    assert.equal(flagsOf(db, id).includes('model_decided'), false, `${id}: not model_decided`);
  }
  const forced = callsFor(judges.escalation, 'p-chain-hold').filter((call) => call.request.forceDecision === true);
  assert.equal(forced.length, 1, 'the fallback chain\'s hold gets one forced call');
  assert.deepEqual(outcome(db, 'p-chain-hold'), ['done', 'eligible', 'missing_fact'], 'the forced decision is final');
  assert.ok(flagsOf(db, 'p-chain-hold').includes('model_decided'));
  assert.deepEqual(evidenceOf(db, 'p-chain-hold').jev, BETWEEN, 'the Jev probabilities stay in evidence');
  assert.deepEqual(receipt.awaiting_user, [], 'nothing awaits the user');
});

// ------------------------------------------------------------------ J4

const EVAL_SEEN = '2026-10-20T00:00:00.000Z';

async function writeEvalSet(directory, cases) {
  await writeReviewFiles(path.join(directory, 'profiles', 'a'), { policy: JEV_POLICY, facts: SPLIT_FACTS });
  for (const item of cases) {
    const url = `https://job-boards.greenhouse.io/exampleeval/jobs/${item.id}`;
    const body = `${titled(item.text ?? SNAPSHOTS.eligible, `Data Science Intern ${item.id}`)}\n${markerLine(item.id)}\n`;
    item.title = snapshotTitle(body);
    item.url = url;
    await mkdir(path.join(directory, 'cases', item.id), { recursive: true });
    await writeFile(path.join(directory, 'cases', item.id, 'fetch.json'), JSON.stringify(page(url, body, { title: item.title, company: 'Example Eval Co' })));
  }
  const manifest = {
    setId: 'set-jev-primary', profiles: { a: 'profiles/a' }, gate: { maxFalseAccepts: 0, maxFalseRejects: 0, maxUnexpectedUnclear: 0 },
    cases: cases.map((item) => ({ id: item.id, profile: 'a', posting: { url: item.url, company: 'Example Eval Co', title: item.title, requisition: null, firstSeen: EVAL_SEEN },
      fetch: `cases/${item.id}/fetch.json`, expected: { decision: item.expected, acceptable: [item.expected], ...(item.code ? { code: item.code } : {}) } })),
  };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

async function withScratch(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('[B] runEval measures the Jev-primary strategy: Jev decides without Codex, in-between cases use the fallback, a Jev false accept fails the gate, metrics.jev counts (jev-primary J4)', async () => {
  const { runEval } = await evalModule();
  await withScratch('cj-jev-primary-eval-', async (directory) => {
    const cases = [
      { id: 'e1', jev: HIGH, expected: 'eligible', fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly },
      { id: 'e2', jev: below('degree'), expected: 'not_eligible', code: 'degree', fallback: JUDGMENTS.eligible },
      { id: 'e3', jev: BETWEEN, expected: 'eligible', fallback: JUDGMENTS.eligible },
      // Jev accepts a case labelled not_eligible: the gate must count it (the fallback alone would reject it).
      { id: 'e4', jev: HIGH, expected: 'not_eligible', fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly },
    ];
    await writeEvalSet(directory, cases);
    const judges = makeJudges({ answers: Object.fromEntries(cases.map((item) => [item.id, { output: item.fallback }])) });
    const jev = fakeJev(Object.fromEntries(cases.map((item) => [item.id, item.jev])));
    const result = await offline(() => runEval({ setDir: directory, concurrency: 1, judges, jev, judgePolicy: JEV_POLICY.judge }));

    const byId = Object.fromEntries(result.cases.map((item) => [item.id, item]));
    assert.deepEqual([byId.e1.decision, byId.e2.decision, byId.e2.code, byId.e3.decision, byId.e4.decision],
      ['eligible', 'not_eligible', 'degree', 'eligible', 'eligible'], `eval decisions: ${JSON.stringify(result.cases.map((item) => [item.id, item.decision, item.code]))}`);
    assert.deepEqual(judges.primary.calls.map((call) => call.request.postingId), ['e3'], 'only the in-between case reaches the Codex fallback');
    for (const id of ['e1', 'e2', 'e4']) {
      assert.deepEqual(byId[id].attempts.filter((attempt) => ['primary', 'escalation'].includes(attempt.tier)), [], `${id}: no Codex attempt`);
      assert.equal(jevCallsFor(jev, id).length, 6, `${id}: six Jev calls`);
    }
    assert.equal(result.metrics.falseAccepts, 1, 'the Jev false accept is counted');
    assert.equal(result.metrics.falseRejects, 0);
    assert.equal(result.pass, false, 'the gate fails on the Jev false accept');
    assert.deepEqual(result.metrics.jev, { postings: 4, calls: jev.calls.length, decided_eligible: 2, decided_not_eligible: 1, escalated: 1, errors: 0 },
      `metrics.jev: ${JSON.stringify(result.metrics.jev)}`);
  });
});

test('[B] `review eval` uses the data home\'s jev-split policy and the injected Jev (jev-primary J4)', async () => {
  if (!schemaMigrations.some((item) => item.version === 6)) throw new Error('NOT IMPLEMENTED [L1]: migration 006-funnel is not registered in schemaMigrations');
  await withScratch('cj-jev-primary-cli-eval-', async (scratch) => {
    const home = path.join(scratch, 'home');
    const set = path.join(scratch, 'set');
    await mkdir(home, { recursive: true });
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    await writeReviewHome(home, { policy: JEV_POLICY, facts: SPLIT_FACTS });
    // The fallback alone would get both cases wrong.
    const cases = [
      { id: 'c1', jev: HIGH, expected: 'eligible', fallback: JUDGMENTS.undergradOnly, text: SNAPSHOTS.undergradOnly },
      { id: 'c2', jev: below('degree'), expected: 'not_eligible', code: 'degree', fallback: JUDGMENTS.eligible },
    ];
    await writeEvalSet(set, cases);
    const judges = makeJudges({ answers: Object.fromEntries(cases.map((item) => [item.id, { output: item.fallback }])) });
    const jev = fakeJev(Object.fromEntries(cases.map((item) => [item.id, item.jev])));
    const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
    const { runCli } = await import('../../src/cli/main.mjs');
    const io = memoryIO();
    const code = await offline(() => runCli(['review', 'eval', '--home', home, '--set', set, '--concurrency', '1'], io,
      { ...createRuntime({ root: process.cwd(), version: 'test' }), review: { judges, jev } }));
    const result = parse(io.stdout, {});
    assert.equal(jev.calls.length, 12, `review eval asks the injected Jev six questions per case (got ${jev.calls.length})`);
    assert.equal(judges.primary.calls.length + judges.escalation.calls.length, 0, 'no Codex call');
    assert.equal(code, 0, `${io.stderr}${io.stdout}`);
    assert.equal(result.pass, true);
    assert.equal(result.metrics?.jev?.postings, 2, `metrics.jev: ${JSON.stringify(result.metrics?.jev)}`);
  });
});
