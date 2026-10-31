// Regressions for two leaks found on the live queue (2026-10-31).
//   FD1 Escalation inflated fit. When the primary judge is unsure, the escalation judge is asked and forced to decide,
//       and delivery took the escalation's fit wholesale: roles the primary rated medium were delivered high, and
//       several roles went from low to medium. When both judgments carry a fit level, the delivered level is the
//       lower of the two (low < medium < high), with the note of the judgment whose level was chosen (a tie keeps
//       the escalation's). A forced decision's assumption is still appended to the chosen note. A judgment without
//       a valid level leaves the other one's fit in place.
//   FD2 Pure software-engineering roles passed as eligible. The direction must be AI, ML, data science or data
//       analytics. At delivery an eligible verdict whose judge function label is a software-engineering function
//       (normalised: lowercase, spaces, '/' and '-' as '_'; matching software, engineer(ing), swe, full stack,
//       frontend, backend, developer or qa, and none of ai, ml, machine learning, data, analytics, research, quant,
//       scien...) is settled not_eligible with code out_of_direction. A missing or blank label changes nothing. A
//       title matching the role-direction allow patterns (profile/role-direction.json), or carrying a plain
//       AI/ML/data word, is never forced out. Like every direction rule it needs a role-direction.json.
//   FD3 Neutral titles (see the FD3 section below).
// Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, insertPosting, insertReview, reviewOf, applicationsCount, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SCREENING_POLICY, SNAPSHOTS, JUDGMENTS, judgment, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';

const fitModule = () => load('FD', './src/review/fit.mjs', ['lowerFit']);
const directionModule = () => load('FD', './src/review/direction.mjs', ['directionRules', 'softwareEngineeringFunction']);
const workerModule = () => load('B6', './src/review/worker.mjs', ['runReview']);
const delivery = async () => ({
  ...(await load('L2', './src/review/deliver.mjs', ['deliver'])),
  ...(await load('L2', './src/review/lease.mjs', ['claimItem'])),
});

const COMPANY = 'Fit Direction Example Co';
const PYTHON_CLAUSE = 'Proficiency in Python or R for data analysis.';
const FUNCTION_QUOTE = JUDGMENTS.eligible.function.quote;
const urlOf = (id) => `https://job-boards.greenhouse.io/fitdirectionexample/jobs/${id.replace(/[^0-9a-z]/gi, '')}`;
const retitled = (text, title) => text.replace(snapshotTitle(text), title);
const applicationOf = (db, postingId) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(postingId);
const evidenceOf = (db, id) => JSON.parse(reviewOf(db, id).evidence_json || '{}');
const fitOf = (level, strength) => ({ level, strengths: [strength], gaps: [] });
// A conflict citing a fact the candidate has: not confirmed, so the primary tier is unclear and escalates.
const unsure = (fit) => judgment({ criteria: [{ key: 'requirement', status: 'conflicts', quote: PYTHON_CLAUSE, clause_alternatives: [], fact_ids: ['python'] }], fit });
const sure = (fit, extra = {}) => judgment({ fit, ...extra });

let seq = 0;
function setup(db, entries) {
  const pages = {};
  const answers = { primary: {}, escalation: {}, forced: {} };
  for (const [id, { title = 'Data Science Intern', primary, escalation, forced }] of Object.entries(entries)) {
    insertPosting(db, { id, url: urlOf(id), company: COMPANY, title, firstSeen: T0 });
    insertReview(db, { postingId: id, stage: 'fetch', firstSeen: T0, nextDue: T0 });
    pages[urlOf(id)] = page(urlOf(id), retitled(SNAPSHOTS.eligible, title));
    answers.primary[id] = { output: primary };
    if (escalation) answers.escalation[id] = { output: escalation };
    if (forced) answers.forced[id] = { output: forced };
  }
  return { pages, answers };
}

async function offline(run) {
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => { attempts.push(String(url)); throw new Error(`network access in a test: ${url}`); };
  try { return await run(); } finally {
    globalThis.fetch = original;
    assert.deepEqual(attempts, [], 'no network request is made');
  }
}

async function review(db, { pages, answers, direction = null }) {
  const { runReview } = await workerModule();
  const judges = {
    primary: fakeJudge({ tier: 'primary', answers: (request) => answers.primary[request.postingId] }),
    escalation: fakeJudge({ tier: 'escalation', answers: (request) => (request.forceDecision === true ? answers.forced : answers.escalation)[request.postingId] }),
  };
  const receipt = await offline(() => runReview({ db, runId: `review-fit-direction-${seq += 1}`, owner: 'worker-a', now: T0, budget: 20, deadlineMs: 600_000,
    attemptDir: null, sleep: async () => {}, fetcher: fakeFetcher(pages), judges, inputs: () => reviewInputs({ policy: REVIEW_POLICY, direction }), hooks: {} }));
  return { receipt, judges };
}
const called = (judges, tier) => judges[tier].calls.map((call) => call.request.postingId);

// ===================================================================== FD1 — min fit

test('[FD] lowerFit keeps the lower level and that judgment\'s note; a tie keeps the escalation; a missing level keeps the other (FD1)', async () => {
  const { lowerFit } = await fitModule();
  const primary = (level) => ({ level, note: `primary ${level}` });
  const escalation = (level) => ({ level, note: `escalation ${level}` });
  assert.deepEqual(lowerFit(primary('medium'), escalation('high')), primary('medium'));
  assert.deepEqual(lowerFit(primary('low'), escalation('medium')), primary('low'));
  assert.deepEqual(lowerFit(primary('low'), escalation('high')), primary('low'));
  assert.deepEqual(lowerFit(primary('high'), escalation('low')), escalation('low'));
  assert.deepEqual(lowerFit(primary('medium'), escalation('medium')), escalation('medium'), 'a tie keeps the escalation');
  // Escalation only: the primary carries no usable level.
  for (const missing of [undefined, null, {}, { level: null, note: 'x' }, { level: 'excellent', note: 'x' }]) {
    assert.deepEqual(lowerFit(missing, escalation('high')), escalation('high'), `primary ${JSON.stringify(missing)}`);
  }
  // Primary only: the escalation carries no usable level.
  for (const missing of [undefined, null, {}, { level: '', note: 'x' }]) {
    assert.deepEqual(lowerFit(primary('high'), missing), primary('high'), `escalation ${JSON.stringify(missing)}`);
  }
});

test('[FD] an escalated posting is delivered with the lower of the primary and escalation fit, and the chosen judgment\'s note (FD1)', async () => {
  const db = freshDb();
  const { pages, answers } = setup(db, {
    'p-up': { primary: unsure(fitOf('medium', 'Primary medium strength')), escalation: sure(fitOf('high', 'Escalation high strength')) },
    'p-low-medium': { primary: unsure(fitOf('low', 'Primary low strength')), escalation: sure(fitOf('medium', 'Escalation medium strength')) },
    'p-down': { primary: unsure(fitOf('high', 'Primary high strength')), escalation: sure(fitOf('low', 'Escalation low strength')) },
  });
  const { judges } = await review(db, { pages, answers });
  assert.deepEqual(called(judges, 'escalation').sort(), ['p-down', 'p-low-medium', 'p-up'], 'fixture: every posting escalates');
  const expected = { 'p-up': ['medium', 'Primary medium strength'], 'p-low-medium': ['low', 'Primary low strength'], 'p-down': ['low', 'Escalation low strength'] };
  const wrong = [];
  for (const [id, [level, strength]] of Object.entries(expected)) {
    const row = reviewOf(db, id);
    if (row.decision !== 'eligible') { wrong.push(`${id}: decision ${row.decision} (${row.code}), expected eligible`); continue; }
    const app = applicationOf(db, id);
    if (app?.fit !== level) wrong.push(`${id}: applications.fit ${app?.fit}, expected ${level}`);
    if (!String(app?.fit_note).includes(strength)) wrong.push(`${id}: fit_note ${JSON.stringify(app?.fit_note)}, expected the note with ${strength}`);
    const evidence = evidenceOf(db, id);
    if (evidence.fit?.level !== level) wrong.push(`${id}: evidence fit ${evidence.fit?.level}, expected ${level}`);
  }
  assert.deepEqual(wrong, []);
});

test('[FD] a forced escalation decision cannot raise the fit: the primary low level and note stay, the assumption is appended (FD1)', async () => {
  const db = freshDb();
  const assumption = 'Assume the candidate can learn Python on the job';
  const { pages, answers } = setup(db, {
    'p-forced': { primary: unsure(fitOf('low', 'Primary low strength')), escalation: unsure(fitOf('high', 'Escalation high strength')),
      forced: { decision: 'eligible', assumption } },
  });
  await review(db, { pages, answers });
  const row = reviewOf(db, 'p-forced');
  assert.equal(row.decision, 'eligible', `fixture: the forced decision is final (${row.state} ${row.code})`);
  assert.ok(JSON.parse(row.flags_json).includes('model_decided'));
  const app = applicationOf(db, 'p-forced');
  assert.equal(app.fit, 'low');
  assert.ok(app.fit_note.includes('Primary low strength'), app.fit_note);
  assert.ok(!app.fit_note.includes('Escalation high strength'), app.fit_note);
  assert.ok(app.fit_note.includes(assumption), 'the forced assumption is still shown (model-decides H1)');
});

test('[FD] a posting decided at the primary tier keeps the primary fit (FD1)', async () => {
  const db = freshDb();
  const { pages, answers } = setup(db, { 'p-primary': { primary: sure(fitOf('high', 'Primary high strength')), escalation: sure(fitOf('low', 'Escalation low strength')) } });
  const { judges } = await review(db, { pages, answers });
  assert.deepEqual(called(judges, 'escalation'), [], 'fixture: no escalation');
  const app = applicationOf(db, 'p-primary');
  assert.equal(app.fit, 'high');
  assert.ok(app.fit_note.includes('Primary high strength'));
});

// ===================================================================== FD2 — software-engineering function

test('[FD] softwareEngineeringFunction: SWE labels match after normalisation; AI/ML/data labels and blanks do not (FD2)', async () => {
  const { softwareEngineeringFunction } = await directionModule();
  const yes = ['engineering', 'software_engineering', 'Software Engineering', 'software-engineering', 'swe', 'SWE', 'full_stack', 'Full-Stack',
    'full stack development', 'frontend', 'front-end', 'backend', 'back_end', 'developer', 'web developer', 'qa', 'QA engineering', 'software_engineer',
    'engineering/software', 'html_developer', 'Software & Web Development', 'software engineering (backend)'];
  const no = ['ai_ml', 'AI/ML engineering', 'ai_ml_engineer', 'ML engineering', 'machine learning engineering', 'data_science', 'data_engineering',
    'analytics_bi', 'analytics engineering', 'quant', 'quant_developer', 'research_engineering', 'research', 'applied science', 'product_general', 'sales', 'hardware',
    'genai_engineering', 'mlops_engineering', 'llm_engineering', 'LLM engineering', 'llms_developer', 'software engineering (AI/ML)', 'software engineering [ML]', 'Software Engineering (AI)',
    '', '   ', '()', null, undefined, 42];
  const wrong = [...yes.filter((value) => softwareEngineeringFunction(value) !== true).map((value) => `${JSON.stringify(value)}: expected software engineering`),
    ...no.filter((value) => softwareEngineeringFunction(value) !== false).map((value) => `${JSON.stringify(value)}: expected not software engineering`)];
  assert.deepEqual(wrong, []);
});

const ELIGIBLE = { decision: 'eligible', code: null, fit: { level: 'high', note: 'synthetic' }, deadline: { kind: 'none' },
  location: { offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' }], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' } };

test('[L2] an eligible verdict labelled with a software-engineering function is delivered out_of_direction; AI/ML labels, blanks and allowed titles stay (FD2)', async () => {
  const { deliver, claimItem } = await delivery();
  const { directionRules } = await directionModule();
  // The direction rules need a role-direction.json; plain has no allow pattern for 'forward deployed', rules has.
  const plain = directionRules({ allow: ['\\bdata\\b'] });
  const rules = directionRules({ allow: ['\\bA\\.?I\\b', 'machine learning', '\\bdata\\b', 'analytic', 'forward deployed'], block: [], requireAllow: [], allowFunctions: [] });
  const db = freshDb();
  const deliverOne = (id, title, functionValue, direction = plain) => {
    insertPosting(db, { id, url: urlOf(id), company: COMPANY, title });
    insertReview(db, { postingId: id, stage: 'deliver' });
    const fence = claimItem(db, id, { owner: 'worker-a', now: T0 });
    const verdict = functionValue === undefined ? ELIGIBLE : { ...ELIGIBLE, functionValue };
    return deliver(db, { postingId: id, verdict, fence, now: T0, policy: { ...SCREENING_POLICY, direction } });
  };
  const count = applicationsCount(db);
  const out = [
    ['p-swe', 'Software Engineer Intern', 'engineering'],
    ['p-fullstack', 'Full-Stack Developer Intern', 'software_engineering'],
    ['p-tools', 'Media Tools Intern', 'engineering'],
    ['p-swe-rules', 'Software Engineer Intern', 'Software Engineering', rules],
    // The allow pattern overrides only when the rules carry it.
    ['p-fde-plain', 'Forward Deployed Engineer Intern', 'software_engineering'],
  ];
  const wrong = [];
  for (const [id, title, functionValue, direction] of out) {
    const result = deliverOne(id, title, functionValue, direction);
    const row = reviewOf(db, id);
    if (result.action === 'created') wrong.push(`${id}: a lead was created`);
    if (row.decision !== 'not_eligible' || row.code !== 'out_of_direction') wrong.push(`${id}: ${row.decision}/${row.code}, expected not_eligible/out_of_direction`);
    if (row.state !== 'done' || row.hold_owner) wrong.push(`${id}: state ${row.state}, hold_owner ${row.hold_owner}`);
    if (evidenceOf(db, id).function !== functionValue) wrong.push(`${id}: stored function ${evidenceOf(db, id).function}`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
  assert.equal(applicationsCount(db), count, 'no application is created');

  const stay = [
    ['p-aiml', 'Software Engineer Intern', 'AI/ML engineering'],
    ['p-aiml-eng', 'Software Engineer Intern', 'ai_ml_engineer'],
    ['p-data', 'Software Engineer Intern', 'data_engineering'],
    ['p-blank', 'Software Engineer Intern', ''],
    ['p-spaces', 'Software Engineer Intern', '   '],
    ['p-null', 'Software Engineer Intern', null],
    ['p-missing', 'Software Engineer Intern', undefined],
    ['p-allowed-title', 'Data Platform Software Engineer Intern', 'software_engineering', rules],
    ['p-allowed-ai', 'AI Software Engineer Intern', 'engineering', rules],
    ['p-allowed-fde', 'Forward Deployed Engineer Intern', 'software_engineering', rules],
    // A plain AI/ML/data word in the title keeps the role even when the allow patterns miss it.
    ['p-ml-title', 'Machine Learning Engineer Intern', 'software_engineering'],
    // Without a role-direction.json nothing is filtered (role direction RD1).
    ['p-no-rules', 'Software Engineer Intern', 'software_engineering', null],
  ];
  for (const [id, title, functionValue, direction] of stay) {
    const result = deliverOne(id, title, functionValue, direction);
    const row = reviewOf(db, id);
    if (result.action !== 'created' || row.decision !== 'eligible') wrong.push(`${id} [${JSON.stringify(functionValue)}]: ${result.action}, ${row.decision}/${row.code}, expected an eligible lead`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
});

test('[B] the worker settles a judge-eligible role labelled engineering as out_of_direction, and keeps an AI/ML-labelled one (FD2)', async () => {
  const db = freshDb();
  const { pages, answers } = setup(db, {
    'p-eng': { title: 'Software Engineer Intern', primary: sure(fitOf('high', 'x'), { function: { value: 'engineering', quote: FUNCTION_QUOTE } }) },
    'p-ml': { title: 'Software Engineer Intern', primary: sure(fitOf('high', 'x'), { function: { value: 'AI/ML engineering', quote: FUNCTION_QUOTE } }) },
  });
  const { directionRules } = await directionModule();
  await review(db, { pages, answers, direction: directionRules({ allow: ['\\bdata\\b'] }) });
  const eng = reviewOf(db, 'p-eng');
  assert.deepEqual([eng.state, eng.decision, eng.code], ['done', 'not_eligible', 'out_of_direction']);
  assert.equal(applicationOf(db, 'p-eng'), undefined, 'no lead for the engineering role');
  assert.equal(reviewOf(db, 'p-ml').decision, 'eligible');
  assert.ok(applicationOf(db, 'p-ml'), 'the AI/ML role becomes a lead');
});

// ===================================================================== FD3 — neutral titles
// A title matching none of allow, block and requireAllow was always in direction, and the judge's generous function
// labels let pricing, risk-management, media-tools and evaluation roles through. role-direction.json gains an optional
// "neutral": "deny" | "allow" (default "allow"). With "deny" a neutral title is out (reason 'neutral'), no function
// label rescues it, and the startup pass withdraws such visible leads like blocked ones, with the same guards.

const NEUTRAL_RAW = Object.freeze({
  allow: ['\\bA\\.?I\\b', 'machine learning', '\\bdata\\b', 'analytic'],
  block: ['\\bsales\\b'],
  requireAllow: ['software', 'developer'],
  allowFunctions: ['\\bai\\b', 'data', 'analytic', 'scien'],
});

test('[RD] neutral "deny" puts a title matching no list out of direction, and no function label rescues it; "allow" and a missing key keep it in (FD3)', async () => {
  const { directionRules, roleDirection, directionNote } = await load('FD', './src/review/direction.mjs', ['directionRules', 'roleDirection', 'directionNote']);
  const deny = directionRules({ ...NEUTRAL_RAW, neutral: 'deny' });
  const allow = directionRules({ ...NEUTRAL_RAW, neutral: 'allow' });
  const legacy = directionRules(NEUTRAL_RAW);
  const neutralTitles = [['Fleet Pricing Intern', 'sales_analytics'], ['Investment Risk Management Intern', 'analytics'], ['Media Tools Intern', 'engineering'],
    ['Global Capabilities and Life Science', 'data_science'], ['Evaluation & Learning Intern', 'analytics'], ['Evaluation & Learning Intern', undefined]];
  const wrong = [];
  for (const [title, functionValue] of neutralTitles) {
    const denied = roleDirection(title, deny, { functionValue });
    if (denied.ok !== false || denied.reason !== 'neutral' || denied.match !== null) wrong.push(`deny ${title} [${functionValue}]: ${JSON.stringify(denied)}`);
    for (const [name, rules] of [['allow', allow], ['missing', legacy]]) {
      if (roleDirection(title, rules, { functionValue }).ok !== true) wrong.push(`${name} ${title}: expected in direction`);
    }
  }
  // The other lists are unchanged under deny.
  if (roleDirection('Data Analyst Intern', deny).ok !== true) wrong.push('deny: an allowed title stays in');
  if (roleDirection('Software Engineer Intern', deny, { functionValue: 'data_science' }).reason !== 'allow_function') wrong.push('deny: requireAllow still takes an allowed label');
  if (roleDirection('Software Engineer Intern', deny, { functionValue: 'engineering' }).reason !== 'require_allow') wrong.push('deny: requireAllow without an allowed label');
  if (roleDirection('Regional Sales Intern', deny, { functionValue: 'analytics' }).reason !== 'block') wrong.push('deny: block');
  assert.deepEqual(wrong, [], wrong.join('\n'));
  assert.equal(directionNote(roleDirection('Fleet Pricing Intern', deny)), 'title has no AI/ML/data signal');
  assert.equal(legacy.neutral, 'allow', 'a missing key defaults to allow');
  assert.throws(() => directionRules({ ...NEUTRAL_RAW, neutral: 'maybe' }), /role-direction\.json/);
});

test('[L2] under neutral "deny" an eligible verdict for a neutral title is delivered role_direction even with a generous function label (FD3)', async () => {
  const { deliver, claimItem } = await delivery();
  const { directionRules } = await directionModule();
  const db = freshDb();
  const deliverOne = (id, title, functionValue, direction) => {
    insertPosting(db, { id, url: urlOf(id), company: COMPANY, title });
    insertReview(db, { postingId: id, stage: 'deliver' });
    const fence = claimItem(db, id, { owner: 'worker-a', now: T0 });
    return deliver(db, { postingId: id, verdict: { ...ELIGIBLE, functionValue }, fence, now: T0, policy: { ...SCREENING_POLICY, direction } });
  };
  const deny = directionRules({ ...NEUTRAL_RAW, neutral: 'deny' });
  assert.notEqual(deliverOne('p-risk', 'Investment Risk Management Intern', 'analytics', deny).action, 'created');
  const risk = reviewOf(db, 'p-risk');
  assert.deepEqual([risk.state, risk.decision, risk.code, risk.hold_owner], ['done', 'not_eligible', 'role_direction', null]);
  assert.equal(evidenceOf(db, 'p-risk').roleDirection?.note, 'title has no AI/ML/data signal');
  assert.equal(evidenceOf(db, 'p-risk').provenance, 'automated');
  assert.equal(deliverOne('p-risk-allow', 'Investment Risk Management Intern', 'analytics', directionRules({ ...NEUTRAL_RAW, neutral: 'allow' })).action, 'created');
  assert.equal(deliverOne('p-data-deny', 'Data Analyst Intern', 'analytics', deny).action, 'created');
});

// A lead the worker delivered as eligible before the rule: visible, review done eligible.
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

test('[B] under neutral "deny" the startup pass withdraws visible neutral-title leads without a model call, keeps user decisions, and restores them under "allow" (FD3)', async () => {
  const { directionRules } = await directionModule();
  const { listQueue } = await import('../../src/commands/queue.mjs');
  const queued = (db) => listQueue(db, null).map((row) => row.id);
  const db = freshDb();
  const pricing = deliveredLead(db, 'p-pricing', { title: 'Fleet Pricing Intern', functionLabel: 'sales_analytics' });
  const evaluation = deliveredLead(db, 'p-evaluation', { title: 'Evaluation & Learning Intern' });
  const data = deliveredLead(db, 'p-data', { title: 'Data Analyst Intern', functionLabel: 'analytics' });
  const prepared = deliveredLead(db, 'p-prepared', { title: 'Media Tools Intern', functionLabel: 'engineering' });
  db.prepare("UPDATE applications SET status = 'prepared' WHERE id = ?").run(prepared);
  const applied = deliveredLead(db, 'p-applied', { title: 'Investment Risk Management Intern', functionLabel: 'analytics' });
  db.prepare("UPDATE applications SET status = 'applied', applied_at = ? WHERE id = ?").run(at(-1), applied);
  const skipped = deliveredLead(db, 'p-skipped', { title: 'Fleet Pricing Program', functionLabel: 'analytics' });
  db.prepare("UPDATE applications SET status = 'withdrawn', skip_reason = 'not interested', skip_owner = 'user' WHERE id = ?").run(skipped);
  const userRows = () => JSON.stringify([prepared, applied, skipped].map((id) => db.prepare('SELECT * FROM applications WHERE id = ?').get(id)));
  const users = userRows();
  assert.deepEqual(queued(db).sort(), [data, evaluation, pricing].sort(), 'fixture: the delivered leads are visible');

  const { runReview } = await workerModule();
  const run = (direction, now) => offline(() => runReview({ db, runId: `review-neutral-${seq += 1}`, owner: 'worker-a', now, budget: 0, deadlineMs: 600_000,
    attemptDir: null, sleep: async () => {}, fetcher: fakeFetcher({}), judges: { primary: fakeJudge({ tier: 'primary' }), escalation: fakeJudge({ tier: 'escalation' }) },
    inputs: () => reviewInputs({ policy: REVIEW_POLICY, direction }), hooks: {} }));
  await run(directionRules({ ...NEUTRAL_RAW, neutral: 'deny' }), T0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attempts').get().n, 0, 'no paid attempt');
  const wrong = [];
  for (const [id, appId] of [['p-pricing', pricing], ['p-evaluation', evaluation]]) {
    const row = reviewOf(db, id);
    if (row.decision !== 'not_eligible' || row.code !== 'role_direction' || row.state !== 'done') wrong.push(`${id}: ${row.state} ${row.decision}/${row.code}`);
    const app = db.prepare('SELECT status, skip_owner FROM applications WHERE id = ?').get(appId);
    if (app.status !== 'withdrawn' || app.skip_owner !== 'review') wrong.push(`${id}: application ${app.status}/${app.skip_owner}`);
    if (evidenceOf(db, id).roleDirection?.note !== 'title has no AI/ML/data signal') wrong.push(`${id}: note ${evidenceOf(db, id).roleDirection?.note}`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
  assert.deepEqual(queued(db), [data], 'only the data lead stays visible');
  assert.equal(userRows(), users, 'prepared, applied and user-skipped leads are untouched');

  await run(directionRules({ ...NEUTRAL_RAW, neutral: 'allow' }), at(1));
  assert.deepEqual(queued(db).sort(), [data, evaluation, pricing].sort(), 'under allow the withdrawn neutral leads come back');
  assert.equal(userRows(), users);
});

// ===================================================================== review round 1 (Codex)

test('[B] the startup pass withdraws visible leads labelled pure software engineering, flags them in the queue, leaves exploration settlements alone, and restores them when the rules go (FD2)', async () => {
  const { directionRules } = await directionModule();
  const { listQueue } = await import('../../src/commands/queue.mjs');
  const rules = directionRules({ allow: ['\\bdata\\b'] });
  const db = freshDb();
  const swe = deliveredLead(db, 'p-swe-lead', { title: 'Software Engineer Intern', functionLabel: 'engineering' });
  const tools = deliveredLead(db, 'p-tools-lead', { title: 'Media Tools Intern', functionLabel: 'software_engineering' });
  const ml = deliveredLead(db, 'p-ml-lead', { title: 'Software Engineer Intern', functionLabel: 'llm_engineering' });
  const unlabelled = deliveredLead(db, 'p-unlabelled-lead', { title: 'Software Engineer Intern' });
  const prepared = deliveredLead(db, 'p-swe-prepared', { title: 'Software Engineer Intern', functionLabel: 'engineering' });
  db.prepare("UPDATE applications SET status = 'prepared' WHERE id = ?").run(prepared);
  // An exploration-lane settlement shares the code but carries no software marker.
  insertPosting(db, { id: 'p-explore', url: urlOf('p-explore'), company: COMPANY, title: 'Hardware Lab Intern' });
  insertReview(db, { postingId: 'p-explore', stage: 'deliver', state: 'done', decision: 'not_eligible', lane: 'out_of_direction', nextDue: null });
  db.prepare("UPDATE reviews SET code = 'out_of_direction', evidence_json = ? WHERE posting_id = 'p-explore'").run(JSON.stringify({ function: 'engineering' }));
  const explore = JSON.stringify(reviewOf(db, 'p-explore'));
  const preparedRow = JSON.stringify(db.prepare('SELECT * FROM applications WHERE id = ?').get(prepared));

  const flagged = listQueue(db, null, { direction: rules });
  assert.deepEqual(flagged.filter((row) => row.directionOk === false).map((row) => row.id).sort(), [swe, tools].sort(), 'the queue flags the software-labelled leads');

  const { runReview } = await workerModule();
  const run = (direction, now) => offline(() => runReview({ db, runId: `review-software-${seq += 1}`, owner: 'worker-a', now, budget: 0, deadlineMs: 600_000,
    attemptDir: null, sleep: async () => {}, fetcher: fakeFetcher({}), judges: { primary: fakeJudge({ tier: 'primary' }), escalation: fakeJudge({ tier: 'escalation' }) },
    inputs: () => reviewInputs({ policy: REVIEW_POLICY, direction }), hooks: {} }));
  await run(rules, T0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attempts').get().n, 0, 'no paid attempt');
  const wrong = [];
  for (const [id, appId] of [['p-swe-lead', swe], ['p-tools-lead', tools]]) {
    const row = reviewOf(db, id);
    if (row.decision !== 'not_eligible' || row.code !== 'out_of_direction' || row.state !== 'done') wrong.push(`${id}: ${row.state} ${row.decision}/${row.code}`);
    if (evidenceOf(db, id).roleDirection?.software !== true || evidenceOf(db, id).provenance !== 'automated') wrong.push(`${id}: evidence ${JSON.stringify(evidenceOf(db, id).roleDirection)}`);
    if (db.prepare('SELECT status FROM applications WHERE id = ?').get(appId).status !== 'withdrawn') wrong.push(`${id}: not withdrawn`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
  assert.deepEqual(listQueue(db, null).map((row) => row.id).sort(), [ml, unlabelled].sort(), 'the LLM-labelled and the unlabelled leads stay');
  assert.equal(JSON.stringify(reviewOf(db, 'p-explore')), explore, 'the exploration settlement is untouched');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM applications WHERE id = ?').get(prepared)), preparedRow, 'the prepared lead is untouched');

  // A second run with the same rules changes nothing; without a rules file the software leads come back.
  const settled = JSON.stringify(db.prepare('SELECT posting_id, state, decision, code FROM reviews ORDER BY posting_id').all());
  await run(rules, at(1));
  assert.equal(JSON.stringify(db.prepare('SELECT posting_id, state, decision, code FROM reviews ORDER BY posting_id').all()), settled);
  await run(null, at(2));
  assert.deepEqual(listQueue(db, null).map((row) => row.id).sort(), [ml, swe, tools, unlabelled].sort(), 'restored without the rules');
  assert.equal(JSON.stringify(reviewOf(db, 'p-explore')), explore);
});

test('[B] redecide replays an escalation reached by a second-opinion disagreement, so the replayed fit stays the lower one (FD1)', async () => {
  const { redecideReviews } = await load('B', './src/review/redecide.mjs', ['redecideReviews']);
  const policy = { ...REVIEW_POLICY, judge: { secondOpinion: { runner: 'jev', model: 'jev-test', threshold: 0.1, eligibleThreshold: 0.7 } } };
  const db = freshDb();
  const { pages, answers } = setup(db, { 'p-jev': { primary: sure(fitOf('high', 'Primary high strength')), escalation: sure(fitOf('low', 'Escalation low strength')) } });
  const judges = {
    primary: fakeJudge({ tier: 'primary', answers: (request) => answers.primary[request.postingId] }),
    escalation: fakeJudge({ tier: 'escalation', answers: (request) => answers.escalation[request.postingId] }),
  };
  const secondOpinion = { id: 'fake-jev', runner: 'jev', model: 'jev-test', async ask() { return { probability: 0.3, usage: {} }; } };
  const { runReview } = await workerModule();
  await offline(() => runReview({ db, runId: `review-fit-jev-${seq += 1}`, owner: 'worker-a', now: T0, budget: 20, deadlineMs: 600_000, attemptDir: null,
    sleep: async () => {}, fetcher: fakeFetcher(pages), judges, secondOpinion, inputs: () => reviewInputs({ policy }), hooks: {} }));
  assert.deepEqual(judges.escalation.calls.map((call) => call.request.postingId), ['p-jev'], 'fixture: the disagreement escalates');
  assert.equal(applicationOf(db, 'p-jev').fit, 'low');

  const report = await redecideReviews(db, { inputs: reviewInputs({ policy }), judges, done: true, now: at(1) });
  assert.equal(report.redecided, 1, JSON.stringify(report));
  assert.equal(applicationOf(db, 'p-jev').fit, 'low', 'the replay keeps the escalation and the lower fit');
  assert.ok(applicationOf(db, 'p-jev').fit_note.includes('Escalation low strength'));
});

// ===================================================================== review round 2 (Codex)

test('[B] redecide keeps a delivered forced decision and corrects its inflated fit, never turning it into a hold (FD1)', async () => {
  const { redecideReviews } = await load('B', './src/review/redecide.mjs', ['redecideReviews']);
  const db = freshDb();
  const assumption = 'Assume the candidate can learn Python on the job';
  const { pages, answers } = setup(db, {
    'p-forced-old': { primary: unsure(fitOf('low', 'Primary low strength')), escalation: unsure(fitOf('high', 'Escalation high strength')),
      forced: { decision: 'eligible', assumption } },
  });
  const judges = {
    primary: fakeJudge({ tier: 'primary', answers: (request) => answers.primary[request.postingId] }),
    escalation: fakeJudge({ tier: 'escalation', answers: (request) => (request.forceDecision === true ? answers.forced : answers.escalation)[request.postingId] }),
  };
  const { runReview } = await workerModule();
  await offline(() => runReview({ db, runId: `review-forced-old-${seq += 1}`, owner: 'worker-a', now: T0, budget: 20, deadlineMs: 600_000, attemptDir: null,
    sleep: async () => {}, fetcher: fakeFetcher(pages), judges, inputs: () => reviewInputs({ policy: REVIEW_POLICY }), hooks: {} }));
  // Emulate a delivery made before the fix: the escalation's high fit was taken wholesale.
  const app = applicationOf(db, 'p-forced-old');
  db.prepare("UPDATE applications SET fit = 'high', fit_note = 'Strengths: Escalation high strength' WHERE id = ?").run(app.id);
  const before = reviewOf(db, 'p-forced-old');
  assert.equal(before.decision, 'eligible', 'fixture: the forced decision was delivered');

  const report = await redecideReviews(db, { inputs: reviewInputs({ policy: REVIEW_POLICY }), judges, done: true, now: at(1) });
  assert.equal(report.redecided, 1, JSON.stringify(report));
  const after = reviewOf(db, 'p-forced-old');
  assert.deepEqual([after.state, after.decision, after.code, after.hold_owner], ['done', 'eligible', before.code, null], 'the forced decision stays');
  assert.ok(JSON.parse(after.flags_json).includes('model_decided'));
  assert.equal(evidenceOf(db, 'p-forced-old').modelDecision?.assumption, assumption);
  const fixed = applicationOf(db, 'p-forced-old');
  assert.equal(fixed.fit, 'low');
  assert.ok(fixed.fit_note.includes('Primary low strength') && fixed.fit_note.includes(assumption), fixed.fit_note);

  // The forced answer was given to another question (decision code changed what is asked): it is not reused.
  const evidence = evidenceOf(db, 'p-forced-old');
  db.prepare('UPDATE reviews SET evidence_json = ? WHERE posting_id = ?')
    .run(JSON.stringify({ ...evidence, modelDecision: { ...evidence.modelDecision, question: 'Does the candidate operate Kubernetes clusters?' } }), 'p-forced-old');
  const unchanged = JSON.stringify(reviewOf(db, 'p-forced-old'));
  const again = await redecideReviews(db, { inputs: reviewInputs({ policy: REVIEW_POLICY }), judges, done: true, now: at(2) });
  assert.equal(again.redecided, 0, JSON.stringify(again));
  assert.equal(JSON.stringify(reviewOf(db, 'p-forced-old')), unchanged, 'left as it is');
});

test('[B] the startup pass re-judges an invalidated software settlement instead of restoring it, and withdraws a lead a freshness refresh re-queued (FD2)', async () => {
  const { applyRoleDirection } = await load('RD', './src/review/direction-pass.mjs', ['applyRoleDirection']);
  const { deliver, claimItem } = await delivery();
  const { directionRules } = await directionModule();
  const rules = directionRules({ allow: ['\\bdata\\b'] });
  const db = freshDb();
  insertPosting(db, { id: 'p-stale', url: urlOf('p-stale'), company: COMPANY, title: 'Software Engineer Intern' });
  insertReview(db, { postingId: 'p-stale', stage: 'deliver' });
  deliver(db, { postingId: 'p-stale', verdict: { ...ELIGIBLE, functionValue: 'engineering' }, fence: claimItem(db, 'p-stale', { owner: 'worker-a', now: T0 }), now: T0,
    policy: { ...SCREENING_POLICY, direction: rules } });
  assert.equal(reviewOf(db, 'p-stale').code, 'out_of_direction', 'fixture');
  db.prepare('UPDATE reviews SET dep_hashes_json = ? WHERE posting_id = ?').run(JSON.stringify({ invalidated: true }), 'p-stale');
  applyRoleDirection(db, { now: at(1), policy: { ...SCREENING_POLICY, direction: null } });
  const stale = reviewOf(db, 'p-stale');
  assert.deepEqual([stale.state, stale.stage, stale.decision], ['due', 'judge', 'not_eligible'], 'queued for judgment, not restored as eligible');
  assert.equal(applicationOf(db, 'p-stale'), undefined, 'no lead appears');

  // A scan drop later replaces a software settlement but keeps its old evidence marker: the drop wins.
  insertPosting(db, { id: 'p-dropped', url: urlOf('p-dropped'), company: COMPANY, title: 'Software Engineer Intern' });
  insertReview(db, { postingId: 'p-dropped', stage: 'deliver' });
  deliver(db, { postingId: 'p-dropped', verdict: { ...ELIGIBLE, functionValue: 'engineering' }, fence: claimItem(db, 'p-dropped', { owner: 'worker-a', now: T0 }), now: T0,
    policy: { ...SCREENING_POLICY, direction: rules } });
  db.prepare("UPDATE reviews SET decision = 'dropped' WHERE posting_id = 'p-dropped'").run();
  const dropped = JSON.stringify(reviewOf(db, 'p-dropped'));
  applyRoleDirection(db, { now: at(1), policy: { ...SCREENING_POLICY, direction: null } });
  assert.equal(JSON.stringify(reviewOf(db, 'p-dropped')), dropped, 'the dropped review is untouched');
  assert.equal(applicationOf(db, 'p-dropped'), undefined, 'no lead appears');

  const lead = deliveredLead(db, 'p-refresh', { title: 'Software Engineer Intern', functionLabel: 'engineering' });
  db.prepare("UPDATE reviews SET state = 'due', stage = 'fetch', next_due = ? WHERE posting_id = 'p-refresh'").run(T0);
  applyRoleDirection(db, { now: at(1), policy: { ...SCREENING_POLICY, direction: rules } });
  const refreshed = reviewOf(db, 'p-refresh');
  assert.deepEqual([refreshed.state, refreshed.decision, refreshed.code], ['done', 'not_eligible', 'out_of_direction']);
  assert.equal(db.prepare('SELECT status FROM applications WHERE id = ?').get(lead).status, 'withdrawn');
});

test('[RD] the queue reads the stored function label: a requireAllow title with a non-allowed label is flagged, an unlabelled or allowed one is not (FD2)', async () => {
  const { directionRules } = await directionModule();
  const { listQueue } = await import('../../src/commands/queue.mjs');
  const direction = directionRules({ allow: ['\\bdata\\b'], requireAllow: ['software'], allowFunctions: ['data', '(?:^|_)ai(?:_|$)'] });
  const db = freshDb();
  const labelledLead = deliveredLead(db, 'p-q-eng', { title: 'Software Engineer Intern', functionLabel: 'engineering' });
  const allowedLead = deliveredLead(db, 'p-q-ai', { title: 'Software Engineer Intern', functionLabel: 'ai_platform' });
  const unlabelledLead = deliveredLead(db, 'p-q-none', { title: 'Software Engineer Intern' });
  const rows = Object.fromEntries(listQueue(db, null, { direction }).map((row) => [row.id, row.directionOk]));
  assert.deepEqual(rows, { [allowedLead]: true, [unlabelledLead]: true, [labelledLead]: false });
});
