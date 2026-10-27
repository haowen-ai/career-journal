// Red tests for holds found by a read-only diagnosis of the live review drain (feat/funnel-v3-fix at 7136b47).
// Each title names its coordinator ruling as "(live L<n>)". Judgment shapes follow captured escalation-tier
// outputs; every employer, place, requisition, URL and candidate fact below is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { schemaMigrations } from '../../src/storage/database.mjs';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { dependencyHash } from '../../src/review/inputs.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { load, fakeJudge, fakeFetcher, insertPosting, insertReview } from '../../test-utils/funnel-v3.mjs';
import { FACTS, REVIEW_POLICY, PROFILE, SCREENING_POLICY, SNAPSHOTS, JUDGMENTS, judgment, page, record, snapshotTitle, writeReviewHome } from '../../test-utils/funnel-v3-fixtures.mjs';

const decideModule = () => load('B2', './src/review/decide.mjs', ['decide']);
const clausesModule = () => load('B2', './src/review/clauses.mjs', ['validateCriterion']);
const classifyModule = () => load('A3', './src/funnel/classify.mjs', ['classifyRole']);

async function decideWith({ text, judged, tier = 'escalation', policy = REVIEW_POLICY, facts = FACTS, ...rest }) {
  const { decide } = await decideModule();
  return decide({ snapshotText: text, judgment: judged, facts, policy, tier, ...rest });
}

const why = (verdict) => `${verdict.decision} ${verdict.code ?? ''} ${verdict.question ?? ''}`;
const none = Object.freeze({ scope: 'none', quote: null });
const summer2027 = Object.freeze({ label: 'summer', year: 2027, quote: 'Join our analytics team for the summer of 2027' });
const chicago = Object.freeze({ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' });
const DEGREE_BULLET = "Currently pursuing a Bachelor's or Master's degree in Statistics, Computer Science, or a related field.";

// The eval-regressions page shape: configurable title, location line, term sentence and qualification bullets.
const posting = ({ title = 'Data Science Intern', location = 'Location: Chicago, IL', term = 'Join our analytics team for the summer of 2027.', extra = '', heading = 'Required Qualifications', bullets = [DEGREE_BULLET] } = {}) =>
  `${title}\n${location}\n\nAbout the role\n${term} You will build dashboards, write SQL and Python, and present findings to product leaders. This internship runs ten to twelve weeks and pays an hourly rate.${extra ? `\n${extra}` : ''}\n\nResponsibilities\n• Build and maintain data pipelines for weekly reporting.\n• Analyse experiments and explain results to partner teams.\n\n${heading}\n${bullets.map((line) => `• ${line}`).join('\n')}\n`;

const DATA_FUNCTION = Object.freeze({ value: 'data', quote: 'You will build dashboards, write SQL and Python, and present findings to product leaders.' });
const decided = (alternatives, criteria = [], fn = DATA_FUNCTION) => judgment({ alternatives, criteria, function: fn });
const conflict = (quote, factIds, key = 'requirement') => ({ key, status: 'conflicts', quote, clause_alternatives: [], fact_ids: factIds });

// ===================================================================== L1

test('[B] at the escalation tier an out-of-scope function rejects before unresolved criteria; function-key criteria never hold; software engineering is in scope with low fit (live L1)', async () => {
  // Captured shape: the model files its function doubt as a criterion with key "function", status "conflicts" and
  // no cited fact, quoting a whole responsibilities sentence. That became a missing_fact hold before the
  // out-of-scope check ran, so out-of-scope roles and in-scope generic engineering roles both waited for the user.
  const duties = 'You will write backend services in Go and review pull requests for the platform team.';
  const kubernetes = 'Hands-on experience operating Kubernetes clusters.';
  const text = posting({ extra: duties, bullets: [DEGREE_BULLET, kubernetes] });
  const alternatives = [{ term: summer2027, offices: [chicago], remote: none }];
  const functionDoubt = conflict(duties, [], 'function');
  const missingFact = conflict(kubernetes, ['kubernetes']);
  const hardware = { value: 'hardware', quote: duties };
  const engineering = { value: 'software_engineering', quote: duties };
  // Low fit for generic software engineering comes from the policy's fit adjustments, never from a hold.
  const policy = { ...REVIEW_POLICY, fit: { adjust: [...REVIEW_POLICY.fit.adjust, { function: 'software_engineering', set: 'low' }] } };

  for (const [name, criteria] of [['a missing-fact criterion', [missingFact]], ['a function-key criterion', [functionDoubt]], ['both', [functionDoubt, missingFact]]]) {
    const verdict = await decideWith({ text, policy, judged: decided(alternatives, criteria, hardware) });
    assert.deepEqual([verdict.decision, verdict.code], ['not_eligible', 'function_out_of_scope'], `hardware is out of scope, decided before ${name}: ${why(verdict)}`);
  }

  const inScope = await decideWith({ text, policy, judged: decided(alternatives, [functionDoubt], engineering) });
  assert.equal(inScope.decision, 'eligible', `generic software engineering is in scope; a function-key criterion never holds: ${why(inScope)}`);
  assert.equal(inScope.fit.level, 'low', `software engineering is a low-fit function: ${JSON.stringify(inScope.fit)}`);

  // Guards: a non-function unresolved criterion still holds for an in-scope function, and the primary tier
  // only proposes the out-of-scope rejection.
  const held = await decideWith({ text, policy, judged: decided(alternatives, [functionDoubt, missingFact], engineering) });
  assert.deepEqual([held.decision, held.code], ['unclear', 'missing_fact'], `the Kubernetes requirement still needs a fact: ${why(held)}`);
  const primary = await decideWith({ text, policy, tier: 'primary', judged: decided(alternatives, [missingFact], hardware) });
  assert.deepEqual([primary.decision, primary.escalate], ['unclear', true], why(primary));
});

// ===================================================================== L2

test('[B] when every alternative\'s offices are all outside the policy areas and no allowed remote scope is quoted, the decision is outside_area even without a known term (live L2)', async () => {
  // Captured shape: no work window on the page (term null or a dateless quote), offices quoted and outside.
  const twoPlaces = 'Locations: Riverton, NJ; Mill Creek, TX; Elm Harbor, CA';
  const text = posting({ location: twoPlaces, term: 'Interns join one product team for twelve weeks.', extra: 'Remote work is possible for Texas residents. Remote work within the United States is also possible.' });
  const riverton = { place: 'Riverton, NJ', area: 'outside', quote: twoPlaces };
  const millCreek = { place: 'Mill Creek, TX', area: 'outside', quote: twoPlaces };
  const dateless = { label: 'internship; dates unspecified', year: null, kind: null, quote: 'Interns join one product team for twelve weeks.' };

  for (const [name, alternatives] of [
    ['no term, one outside office', [{ term: null, offices: [riverton], remote: none }]],
    ['a dateless term, two outside offices in two alternatives', [{ term: dateless, offices: [riverton], remote: none }, { term: dateless, offices: [millCreek], remote: none }]],
    ['an outside office with a remote scope the policy does not allow', [{ term: null, offices: [millCreek], remote: { scope: 'state:TX', quote: 'Remote work is possible for Texas residents.' } }]],
  ]) {
    const verdict = await decideWith({ text, judged: decided(alternatives) });
    assert.deepEqual([verdict.decision, verdict.code], ['not_eligible', 'outside_area'], `${name}: ${why(verdict)}`);
  }

  // Guards: an allowed office, an allowed (US) remote scope, or an unknown-area office keeps term_or_area;
  // the primary tier still escalates.
  const chicagoText = posting({ location: 'Location: Chicago, IL', term: 'Interns join one product team for twelve weeks.' });
  for (const [name, body, alternatives] of [
    ['an allowed office in one alternative', chicagoText, [{ term: null, offices: [chicago], remote: none }]],
    ['a quoted US remote scope', text, [{ term: null, offices: [riverton], remote: { scope: 'us', quote: 'Remote work within the United States is also possible.' } }]],
    ['an office of unknown area in an allowed state', text, [{ term: null, offices: [riverton, { place: 'Elm Harbor, CA', area: 'unknown', quote: twoPlaces }], remote: none }]],
  ]) {
    const verdict = await decideWith({ text: body, judged: decided(alternatives) });
    assert.deepEqual([verdict.decision, verdict.code], ['unclear', 'term_or_area'], `${name}: ${why(verdict)}`);
  }
  const primary = await decideWith({ text, tier: 'primary', judged: decided([{ term: null, offices: [riverton], remote: none }]) });
  assert.deepEqual([primary.decision, primary.escalate], ['unclear', true], why(primary));
});

// ===================================================================== L3

test('[B] a bullet clause ends at the next non-continuation line, lines split sentences, whole-line quotes are accepted and TITLE:/Eligibility: prefixes are ignored (live L3)', async () => {
  const { validateCriterion } = await clausesModule();
  const head = 'Research Intern\nLocation: Chicago, IL\n\nAbout the role\nJoin our research team for the summer of 2027. You will design experiments and analyse results.\n\n';
  const phd = 'Currently enrolled in a PhD program in Statistics or Computer Science.';
  const cases = [
    ['a "We prefer:" line after the bullet', `${head}Requirements\n• ${phd}\nWe prefer:\n• Experience with Spark.\n`, phd],
    ['a "To apply, please submit the following:" line after the bullet', `${head}Requirements\n• Proficiency in Python.\n• ${phd}\nTo apply, please submit the following:\n• A resume.\n• An unofficial transcript.\n`, phd],
    ['an "Education" heading line after the bullet', `${head}Requirements\n• Proficiency in Python.\n• ${phd}\nEducation\n• Coursework in probability.\n`, phd],
    ['a prose line right after a bullet list', `${head}Requirements\n• Proficiency in Python.\nAll applicants must be enrolled in a PhD program.\n`, 'All applicants must be enrolled in a PhD program.'],
    ['unpunctuated prose lines under a heading', `${head}Eligibility\nCurrently enrolled in a PhD program in a quantitative field\nAvailable to work full time for twelve weeks\n`, 'Currently enrolled in a PhD program in a quantitative field'],
    ['a quote covering a whole line of two sentences', `${head}Who can apply\nApplicants must be enrolled in a PhD program. Graduation is expected after May 2028.\nInterns are placed on one research team.\n`, 'Applicants must be enrolled in a PhD program. Graduation is expected after May 2028.'],
    ['a TITLE: line quoted without its prefix', `URL: https://jobs.example.test/research-intern\nTITLE: 2027 Internship - Quantitative Researcher (PhD)\n\n${head}`, '2027 Internship - Quantitative Researcher (PhD)'],
    ['a TITLE: line quoted with its prefix', `URL: https://jobs.example.test/research-intern\nTITLE: 2027 Internship - Quantitative Researcher (PhD)\n\n${head}`, 'TITLE: 2027 Internship - Quantitative Researcher (PhD)'],
    ['an Eligibility: line quoted without its prefix', `${head}About the program\nEligibility: Current PhD students in Statistics, Mathematics or Computer Science\nInterns are placed on one research team.\n`, 'Current PhD students in Statistics, Mathematics or Computer Science'],
  ];
  for (const [name, text, quote] of cases) {
    assert.ok(text.includes(quote), `${name}: the quote is verbatim`);
    const validation = validateCriterion(text, conflict(quote, ['degree'], 'degree'), FACTS);
    assert.deepEqual([validation.valid, validation.reason, validation.confirmedConflict], [true, null, true], `${name}: the whole clause is quoted with a constraint fact (clause: ${JSON.stringify(validation.clause?.text)})`);
  }
  // One end-to-end decision: the confirmed degree conflict rejects instead of holding as requirement_unclear.
  const [, text, quote] = cases[0];
  const verdict = await decideWith({ text, judged: decided([{ term: summer2027, offices: [chicago], remote: none }], [conflict(quote, ['degree'], 'degree')]) });
  assert.deepEqual([verdict.decision, verdict.code], ['not_eligible', 'degree'], why(verdict));

  // Guards: a fragment of a bullet or of a sentence is still partial; a wrapped bullet quoted whole stays one clause.
  const partialBullet = validateCriterion(SNAPSHOTS.undergradOnly, conflict('junior undergraduate student', ['degree'], 'degree'), FACTS);
  assert.equal(partialBullet.reason, 'partial_clause');
  const prose = `${head}Who can apply\nApplicants must be enrolled in a PhD program. Graduation is expected after May 2028.\n`;
  assert.equal(validateCriterion(prose, conflict('enrolled in a PhD program', ['degree'], 'degree'), FACTS).reason, 'partial_clause');
  const wrapped = `${head}Requirements\n• Currently enrolled in a PhD program in Statistics,\n  Mathematics or Computer Science.\n• Proficiency in Python.\n`;
  const whole = validateCriterion(wrapped, conflict('Currently enrolled in a PhD program in Statistics,\n  Mathematics or Computer Science.', ['degree'], 'degree'), FACTS);
  assert.equal(whole.confirmedConflict, true, `a wrapped bullet is one clause: ${JSON.stringify(whole.clause?.text)}`);
});

// ===================================================================== L4

test('[B] a conflict citing a lacks or constraint fact ignores extra cited has facts (live L4)', async () => {
  const { validateCriterion } = await clausesModule();
  const gis = 'Hands-on experience with geographic information systems.';
  const text = posting({ bullets: [DEGREE_BULLET, gis] });
  for (const factIds of [['gis', 'python'], ['python', 'gis', 'sql']]) {
    const validation = validateCriterion(text, conflict(gis, factIds), FACTS);
    assert.deepEqual([validation.reason, validation.confirmedConflict], [null, true], `${factIds.join(', ')}: the lacks fact confirms the conflict`);
    const verdict = await decideWith({ text, judged: decided([{ term: summer2027, offices: [chicago], remote: none }], [conflict(gis, factIds)]) });
    assert.deepEqual([verdict.decision, verdict.code], ['not_eligible', 'requirement'], `${factIds.join(', ')}: ${why(verdict)}`);
  }
  // Guard: has facts alone never confirm a conflict.
  const onlyHas = validateCriterion(text, conflict(gis, ['python', 'sql']), FACTS);
  assert.equal(onlyHas.confirmedConflict, false);
  assert.equal(onlyHas.reason, 'contradictory_fact');
});

// ===================================================================== L5

test('[B] degree abbreviations after a comma in a title ("Intern, MS/PhD") are never parsed as City, ST (live L5)', async () => {
  for (const title of ['2027 Summer Intern, MS/PhD', 'Quantitative Research Intern, MS, MBA or PhD - Summer 2027']) {
    const text = posting({ title, term: 'Interns join one product team for twelve weeks.' });
    const verdict = await decideWith({ text, judged: decided([{ term: { label: 'summer', year: 2027, kind: 'summer', quote: title }, offices: [chicago], remote: none }]) });
    assert.equal(verdict.decision, 'eligible', `"${title}" names no place; the Chicago office qualifies: ${why(verdict)}`);
  }
  // Guard: a real "City, MS" place in the term quote still disagrees with a Chicago office.
  const real = 'Join our Summer 2027 internship based in Jackson, MS.';
  const verdict = await decideWith({ text: posting({ term: real }), judged: decided([{ term: { label: 'summer', year: 2027, quote: real }, offices: [chicago], remote: none }]) });
  assert.notEqual(verdict.decision, 'eligible', `"Jackson, MS" is a place and is not the Chicago office: ${why(verdict)}`);
});

// ===================================================================== L6

test('[B] "could include", "could be required" and "depending on the role" are non-mandatory wording (live L6)', async () => {
  const { validateCriterion } = await clausesModule();
  const alternatives = [{ term: summer2027, offices: [chicago], remote: none }];
  for (const quote of [
    'Experience with geographic information systems could be required.',
    'Additional requirements could include hands-on work with geographic information systems.',
    'Hands-on experience with geographic information systems, depending on the role.',
    'Depending on the role, hands-on experience with geographic information systems.',
  ]) {
    const text = posting({ bullets: [DEGREE_BULLET, quote] });
    const validation = validateCriterion(text, conflict(quote, ['gis']), FACTS);
    assert.equal(validation.reason, 'non_mandatory', quote);
    assert.equal(validation.confirmedConflict, false, quote);
    const verdict = await decideWith({ text, judged: decided(alternatives, [conflict(quote, ['gis'])]) });
    assert.equal(verdict.decision, 'eligible', `${quote}: ${why(verdict)}`);
  }
  // Guard: plain mandatory wording still confirms the conflict.
  const required = 'Hands-on experience with geographic information systems is required.';
  const text = posting({ bullets: [DEGREE_BULLET, required] });
  assert.equal(validateCriterion(text, conflict(required, ['gis']), FACTS).confirmedConflict, true);
});

// ===================================================================== L7

test('[B] plain "internships" in requirement prose is no student signal; explicit program phrases and titles are (live L7)', async () => {
  const { classifyRole } = await classifyModule();
  const lane = (title, description) => classifyRole(record({ title, description, categories: [], department: null }), { policy: SCREENING_POLICY, profile: PROFILE });
  const body = 'Analyse sales data and build weekly dashboards for regional managers. ';
  for (const prose of [
    'Qualifications: relevant experience through coursework, research, internships, or personal projects.',
    'Prior experience through internships or research projects is a plus.',
  ]) {
    const result = lane('Data Analyst', `${body.repeat(6)}${prose}`);
    assert.equal(result.lane, 'no_student_signal', `${prose}: ${JSON.stringify(result.flags)}`);
    assert.ok(result.flags.includes('no_student_signal'), prose);
  }
  for (const phrase of [
    'This role is part of our internship program.',
    'This summer internship is based in our Chicago office.',
    'Our intern program places students on one product team.',
    'Our co-op program runs for six months.',
    'Apply for this internship by submitting a resume.',
  ]) {
    const result = lane('Data Analyst', `${body.repeat(6)}${phrase}`);
    assert.equal(result.lane, 'new', `${phrase}: ${JSON.stringify(result.flags)}`);
    assert.ok(!result.flags.includes('no_student_signal'), phrase);
  }
  const titled = lane('Data Analyst Intern', `${body.repeat(6)}Qualifications: relevant experience through coursework, research, internships, or personal projects.`);
  assert.equal(titled.lane, 'new', 'a student title keeps its signal');
});

// ===================================================================== L8

test('[B] an internship page naming no season and no year, first seen Aug–Dec of the prior year in an allowed area, is treated as summer with term_inferred (live L8)', async () => {
  // Captured shapes: term null, or a dateless term quote with kind "internship"; one allowed office.
  const text = posting({ term: 'Interns join one product team for twelve weeks.' });
  const dateless = { label: 'Internship; dates unspecified', year: null, kind: 'internship', quote: 'Interns join one product team for twelve weeks.' };
  const shapes = [['term null', null], ['a dateless term', dateless]];
  const seen = { firstSeen: '2026-09-15T00:00:00.000Z', jobType: 'internship' };
  for (const [name, term] of shapes) {
    const verdict = await decideWith({ text, judged: decided([{ term, offices: [chicago], remote: none }]), ...seen });
    assert.equal(verdict.decision, 'eligible', `${name}: first seen Sept 2026, treated as Summer 2027: ${why(verdict)}`);
    assert.ok(verdict.flags.includes('term_inferred'), `${name}: the inference is flagged: ${JSON.stringify(verdict.flags)}`);
    const inferred = verdict.location.alternatives[0]?.term;
    assert.equal(inferred?.year, 2027, name);
    assert.match(String(inferred?.kind ?? inferred?.label), /summer/i, name);
  }

  // Guards: no inference outside Aug–Dec, for another job type, or when the page names a season; the inferred
  // year follows first seen; an outside office is not rescued.
  const seasonText = posting({ term: 'Interns join one product team for twelve weeks.', extra: 'Interns may also join the fall cohort.' });
  const outsideText = posting({ location: 'Location: Riverton, NJ', term: 'Interns join one product team for twelve weeks.' });
  const riverton = { place: 'Riverton, NJ', area: 'outside', quote: 'Location: Riverton, NJ' };
  for (const [name, term] of shapes) {
    for (const [guard, body, offices, options] of [
      ['first seen in June', text, [chicago], { firstSeen: '2026-06-20T00:00:00.000Z', jobType: 'internship' }],
      ['a full-time search', text, [chicago], { firstSeen: '2026-09-15T00:00:00.000Z', jobType: 'full-time' }],
      ['a season named on the page', seasonText, [chicago], seen],
      ['first seen Sept 2027 (summer 2028 is outside the windows)', text, [chicago], { firstSeen: '2027-09-15T00:00:00.000Z', jobType: 'internship' }],
      ['an outside office', outsideText, [riverton], seen],
    ]) {
      const verdict = await decideWith({ text: body, judged: decided([{ term, offices, remote: none }]), ...options });
      assert.notEqual(verdict.decision, 'eligible', `${name} / ${guard}: ${why(verdict)}`);
    }
    for (const [guard, options, body] of [['first seen in June', { firstSeen: '2026-06-20T00:00:00.000Z', jobType: 'internship' }, text], ['a season named on the page', seen, seasonText]]) {
      const verdict = await decideWith({ text: body, judged: decided([{ term, offices: [chicago], remote: none }]), ...options });
      assert.ok(!verdict.flags.includes('term_inferred'), `${name} / ${guard}: no inference`);
    }
  }
});

// ===================================================================== L9

const NOW = '2026-10-20T12:00:00.000Z';
const SEEN = '2026-09-01T00:00:00.000Z';

async function withHome(run) {
  if (!schemaMigrations.some((item) => item.version === 6)) throw new Error('NOT IMPLEMENTED [L1]: migration 006-funnel is not registered in schemaMigrations');
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-live-redecide-'));
  let context;
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    await writeReviewHome(home);
    context = await openHomeDatabase(home);
    await run({ home, db: context.db });
  } finally {
    try { context?.db.close(); } catch { /* closed */ }
    await rm(home, { recursive: true, force: true });
  }
}

async function cli(args, runtimeExtra = {}) {
  const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
  const { runCli } = await import('../../src/cli/main.mjs');
  const io = memoryIO();
  const code = await runCli(args, io, { ...createRuntime({ root: process.cwd(), version: 'test' }), ...runtimeExtra });
  return { code, stdout: io.stdout, stderr: io.stderr };
}

// Judges and a fetcher with the same identities as the ones that judged, which throw if anything calls them.
function throwingJudges() {
  const calls = [];
  const judge = (tier) => ({ ...fakeJudge({ tier }), calls, async judge() { calls.push(tier); throw new Error(`redecide must not call the ${tier} judge`); } });
  return { calls, judges: { primary: judge('primary'), escalation: judge('escalation') } };
}
function throwingFetcher() {
  const calls = [];
  return { calls, async fetch(request) { calls.push(request.url); throw new Error('redecide must not fetch'); } };
}

const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const reviewRow = (db, id) => db.prepare('SELECT state, decision, code, evidence_json, deadline_json, flags_json, hold_owner, updated_at FROM reviews WHERE posting_id = ?').get(id);
const applicationRow = (db, id) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(id);
const logCount = (db, id) => db.prepare('SELECT COUNT(*) n FROM review_log WHERE posting_id = ?').get(id).n;
const deliveries = (db, id) => db.prepare("SELECT COUNT(*) n FROM review_log WHERE posting_id = ? AND kind = 'delivery'").get(id).n;

// Rewrites one tier's stored judge dependencies as if they had been different when the judgment was made:
// the per-tier runtime parts, the cached envelope and the raw log all carry the same (rewritten) hash.
function rewriteJudgeDeps(db, postingId, tier, change, { inputsCode = null } = {}) {
  const row = db.prepare('SELECT dep_hashes_json, evidence_json FROM reviews WHERE posting_id = ?').get(postingId);
  const deps = parse(row.dep_hashes_json);
  const evidence = parse(row.evidence_json);
  assert.ok(deps.runtime?.[tier] && evidence.judgments?.[tier], `${postingId}: a ${tier} judgment and its runtime dependencies were stored`);
  const oldHash = evidence.judgments[tier].depsHash;
  assert.equal(dependencyHash(deps.runtime[tier]), oldHash, `${postingId}: the stored runtime parts produced the cached ${tier} hash`);
  deps.runtime[tier] = { ...deps.runtime[tier], ...change };
  if (inputsCode) deps.inputs = { ...deps.inputs, code: inputsCode };
  const newHash = dependencyHash(deps.runtime[tier]);
  evidence.judgments[tier] = { ...evidence.judgments[tier], depsHash: newHash };
  db.prepare('UPDATE reviews SET dep_hashes_json = ?, evidence_json = ? WHERE posting_id = ?').run(JSON.stringify(deps), JSON.stringify(evidence), postingId);
  for (const log of db.prepare("SELECT id, payload_json FROM review_log WHERE posting_id = ? AND kind = 'llm_raw'").all(postingId)) {
    const payload = parse(log.payload_json);
    if (payload.tier === tier && payload.depsHash === oldHash) db.prepare('UPDATE review_log SET payload_json = ? WHERE id = ?').run(JSON.stringify({ ...payload, depsHash: newHash }), log.id);
  }
}
// An older decide release: only the decide code differed when the judgment was made.
const olderDecide = (db, postingId) => rewriteJudgeDeps(db, postingId, 'primary', { decide: 'sha256:older-decide-release' }, { inputsCode: 'sha256:older-code-release' });

// The hold an older decide release delivered for this posting (review row and application, as deliver writes them).
function heldByOlderDecide(db, postingId, { question = 'Proficiency in Python or R for data analysis.', holdFactIds = ['python'] } = {}) {
  const row = db.prepare('SELECT evidence_json FROM reviews WHERE posting_id = ?').get(postingId);
  const evidence = { ...parse(row.evidence_json), question, holdFactIds };
  db.prepare("UPDATE reviews SET state = 'held', decision = 'unclear', code = 'missing_fact', hold_owner = 'user', hold_since = ?, evidence_json = ?, updated_at = ? WHERE posting_id = ?")
    .run(NOW, JSON.stringify(evidence), NOW, postingId);
  const app = applicationRow(db, postingId);
  db.prepare("UPDATE applications SET skip_reason = ?, skip_owner = 'review' WHERE id = ?").run(`待核: missing_fact — ${question}`, app.id);
}

test('[B] review redecide --held re-decides held reviews from stored judgments without judging or fetching, through normal delivery (live L9)', async () => {
  await withHome(async ({ home, db }) => {
    const pages = {};
    const answers = {};
    const add = (id, snapshot, judged) => {
      const text = SNAPSHOTS[snapshot];
      const url = `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
      insertPosting(db, { id, url, title: snapshotTitle(text), firstSeen: SEEN });
      insertReview(db, { postingId: id, stage: 'fetch', firstSeen: SEEN, nextDue: SEEN });
      pages[url] = page(url, text);
      answers[id] = { output: judged };
    };
    add('p-stale-hold', 'eligible', JUDGMENTS.eligible); // held by an older decide; now eligible
    add('p-real-hold', 'missingFact', JUDGMENTS.missingFact); // a genuine missing-fact hold
    add('p-user-resolved', 'eligible', JUDGMENTS.eligible); // the user already resolved it
    add('p-submitted', 'eligible', JUDGMENTS.eligible); // already submitted
    add('p-new-snapshot', 'eligible', JUDGMENTS.eligible); // the page changed since the judgment
    add('p-new-model', 'eligible', JUDGMENTS.eligible); // judged by another model
    add('p-done', 'eligible', JUDGMENTS.eligible); // done, not held: --held leaves it alone
    // Amended for model-decides H1 (2026-10-27): a run no longer holds p-real-hold for the user; its forced decision
    // is scripted, and the genuine hold is then written as an older release delivered it (like the stale hold).
    const escalationAnswers = (request) => (request.forceDecision === true
      ? { output: { decision: 'eligible', assumption: 'Assumed Kubernetes experience can be learned on the job' } }
      : answers[request.postingId]);
    const judges = { primary: fakeJudge({ tier: 'primary', answers }), escalation: fakeJudge({ tier: 'escalation', answers: escalationAnswers }) };
    const run = await cli(['review', 'run', '--home', home, '--budget', '20'], { now: () => NOW, review: { judges, fetcher: fakeFetcher(pages) } });
    assert.equal(run.code, 0, `${run.stderr}${run.stdout}`);
    for (const id of Object.keys(answers)) {
      const row = reviewRow(db, id);
      assert.deepEqual([row.state, row.decision], ['done', 'eligible'], `${id} after the judging run`);
    }
    heldByOlderDecide(db, 'p-real-hold', { question: '• Hands-on experience operating Kubernetes clusters.', holdFactIds: ['kubernetes'] });

    // Emulate the live data home: holds and a rejection delivered by an older decide release from unchanged judgments.
    for (const id of ['p-stale-hold', 'p-user-resolved', 'p-submitted', 'p-new-snapshot']) { olderDecide(db, id); heldByOlderDecide(db, id); }
    heldByOlderDecide(db, 'p-new-model');
    rewriteJudgeDeps(db, 'p-new-model', 'primary', { model: 'sha256:another-model' });
    olderDecide(db, 'p-done');
    db.prepare("UPDATE reviews SET decision = 'not_eligible', code = 'degree', updated_at = ? WHERE posting_id = 'p-done'").run(NOW);
    db.prepare("INSERT INTO review_log (posting_id, at, stage, kind, attempt_id, payload_json) VALUES ('p-user-resolved', ?, 'deliver', 'user', NULL, ?)")
      .run(NOW, JSON.stringify({ decision: 'not_eligible', reason: 'not interested', actor: 'user' }));
    db.prepare('UPDATE applications SET applied_at = ? WHERE id = ?').run(NOW, applicationRow(db, 'p-submitted').id);
    const newer = page('https://job-boards.greenhouse.io/examplecorp/jobs/p-new-snapshot', `${SNAPSHOTS.eligible}\nThe team now also supports pricing analysis.\n`);
    db.prepare(`INSERT INTO snapshots (id, posting_id, content_hash, fetched_at, final_url, http_status, method, identity_ok, fields_json, sections_json, text)
      VALUES ('snap-newer', 'p-new-snapshot', 'sha256:newer-page', ?, ?, 200, 'ats_api', 1, '{}', '[]', ?)`).run('2026-10-21T00:00:00.000Z', newer.finalUrl, newer.text);

    const untouched = ['p-user-resolved', 'p-submitted', 'p-new-snapshot', 'p-new-model', 'p-done'];
    const before = Object.fromEntries(untouched.map((id) => [id, { review: reviewRow(db, id), application: applicationRow(db, id), logs: logCount(db, id) }]));
    const staleDeliveries = deliveries(db, 'p-stale-hold');

    const guarded = throwingJudges();
    const fetcher = throwingFetcher();
    const result = await cli(['review', 'redecide', '--home', home, '--held', '--json'], { now: () => '2026-10-21T12:00:00.000Z', review: { judges: guarded.judges, fetcher } });
    assert.equal(result.code, 0, `review redecide --held exists and succeeds: ${result.stderr}${result.stdout}`);
    assert.deepEqual([guarded.calls, fetcher.calls], [[], []], 'no judge and no fetcher is called');
    const report = parse(result.stdout, null);
    assert.ok(report, `--json prints one JSON report: ${result.stdout}`);
    assert.equal(report.redecided, 2, `the stale hold and the genuine hold are re-decided: ${result.stdout}`);
    assert.equal(report.changed, 1, `only the stale hold changes: ${result.stdout}`);
    assert.equal(report.by_decision?.eligible, 1, `the new verdicts are counted by decision: ${result.stdout}`);

    const stale = reviewRow(db, 'p-stale-hold');
    assert.deepEqual([stale.state, stale.decision, stale.code, stale.hold_owner], ['done', 'eligible', null, null], 'the stale hold is delivered as eligible');
    assert.equal(deliveries(db, 'p-stale-hold'), staleDeliveries + 1, 'through the normal delivery path (one delivery log entry)');
    const app = applicationRow(db, 'p-stale-hold');
    assert.deepEqual([app.skip_reason, app.skip_owner], [null, null], 'the application is no longer hidden');
    const real = reviewRow(db, 'p-real-hold');
    assert.deepEqual([real.state, real.decision, real.code], ['held', 'unclear', 'missing_fact'], 'the genuine hold stays held');
    for (const id of untouched) {
      assert.deepEqual({ review: reviewRow(db, id), application: applicationRow(db, id), logs: logCount(db, id) }, before[id], `${id} is untouched`);
    }
  });
});

// ===================================================================== T7

// A release whose code differs from the one that judged: every tier's stored runtime parts carry `change`
// (cached envelopes and raw logs follow, as in rewriteJudgeDeps) and the stored inputs carry another `code` hash.
function olderRelease(db, postingId, change, inputsCode) {
  for (const tier of ['primary', 'escalation']) {
    if (parse(reviewRow(db, postingId).evidence_json).judgments?.[tier]) { rewriteJudgeDeps(db, postingId, tier, change, { inputsCode }); continue; }
    const deps = parse(db.prepare('SELECT dep_hashes_json FROM reviews WHERE posting_id = ?').get(postingId).dep_hashes_json);
    assert.ok(deps.runtime?.[tier], `${postingId}: ${tier} runtime dependencies were stored`);
    deps.runtime[tier] = { ...deps.runtime[tier], ...change };
    deps.inputs = { ...deps.inputs, code: inputsCode };
    db.prepare('UPDATE reviews SET dep_hashes_json = ? WHERE posting_id = ?').run(JSON.stringify(deps), postingId);
  }
}

test('[B] a decision-code-only change re-decides from cached judgments with zero judge calls; a prompt/schema change still re-judges (live T7)', async () => {
  await withHome(async ({ home, db }) => {
    const pages = {};
    const answers = {};
    const add = (id, snapshot, judged) => {
      const url = `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
      insertPosting(db, { id, url, title: snapshotTitle(SNAPSHOTS[snapshot]), firstSeen: SEEN });
      insertReview(db, { postingId: id, stage: 'fetch', firstSeen: SEEN, nextDue: SEEN });
      pages[url] = page(url, SNAPSHOTS[snapshot]);
      answers[id] = { output: judged };
    };
    add('p-decide-rejected', 'undergradOnly', JUDGMENTS.undergradOnly);
    add('p-decide-hold', 'missingFact', JUDGMENTS.missingFact);
    add('p-decide-stale-hold', 'eligible', JUDGMENTS.eligible);
    add('p-prompt', 'undergradOnly', JUDGMENTS.undergradOnly);
    add('p-schema', 'undergradOnly', JUDGMENTS.undergradOnly);
    // Amended for model-decides H1 (2026-10-27): p-decide-hold's escalation-tier hold goes to a forced decision.
    const escalationAnswers = (request) => (request.forceDecision === true
      ? { output: { decision: 'eligible', assumption: 'Assumed Kubernetes experience can be learned on the job' } }
      : answers[request.postingId]);
    const judgesWith = () => ({ primary: fakeJudge({ tier: 'primary', answers }), escalation: fakeJudge({ tier: 'escalation', answers: escalationAnswers }) });
    const calledFor = (judges) => [...judges.primary.calls, ...judges.escalation.calls].map((call) => call.request.postingId);
    const reviewRun = (judges, now) => cli(['review', 'run', '--home', home, '--budget', '20'], { now: () => now, review: { judges, fetcher: fakeFetcher(pages) } });

    const first = await reviewRun(judgesWith(), NOW);
    assert.equal(first.code, 0, `${first.stderr}${first.stdout}`);
    const expected = {
      'p-decide-rejected': ['done', 'not_eligible', 'degree'],
      'p-decide-hold': ['done', 'eligible', 'missing_fact'], // model-decides H1: forced eligible, hold code kept
      'p-decide-stale-hold': ['done', 'eligible', null],
      'p-prompt': ['done', 'not_eligible', 'degree'],
      'p-schema': ['done', 'not_eligible', 'degree'],
    };
    for (const [id, outcome] of Object.entries(expected)) {
      const row = reviewRow(db, id);
      assert.deepEqual([row.state, row.decision, row.code], outcome, `${id} after the judging run`);
    }

    // The live deploy: only post-model decision code (decide/clauses/deadline) differs from the release that judged.
    const decisionOnly = ['p-decide-rejected', 'p-decide-hold', 'p-decide-stale-hold'];
    for (const id of decisionOnly) olderRelease(db, id, { decide: 'sha256:older-decide-release' }, 'sha256:older-code-release');
    heldByOlderDecide(db, 'p-decide-stale-hold'); // the older decision code delivered a hold the current one does not
    // Model inputs differ: the prompt renderer, or the judgment schema.
    olderRelease(db, 'p-prompt', { prompt: 'sha256:older-prompt-release' }, 'sha256:older-prompt-code');
    olderRelease(db, 'p-schema', { schema: 'sha256:older-schema-release' }, 'sha256:older-schema-code');

    const judges = judgesWith();
    const second = await reviewRun(judges, '2026-10-21T12:00:00.000Z');
    assert.equal(second.code, 0, `${second.stderr}${second.stdout}`);
    const called = calledFor(judges);
    assert.deepEqual(called.filter((id) => decisionOnly.includes(id)), [],
      `a decision-code-only change never re-judges (no paid calls); it re-decides from the cached judgment: called ${JSON.stringify(called)}`);
    for (const id of ['p-prompt', 'p-schema']) assert.ok(called.includes(id), `${id}: a model-input change still re-judges: called ${JSON.stringify(called)}`);
    for (const [id, outcome] of Object.entries(expected)) {
      const row = reviewRow(db, id);
      assert.deepEqual([row.state, row.decision, row.code], outcome, `${id} after the run following the deploy`);
    }
    const app = applicationRow(db, 'p-decide-stale-hold');
    assert.deepEqual([app.skip_reason, app.skip_owner], [null, null], 'the stale hold is re-decided and delivered (application no longer hidden)');

    // Settled: a further run judges nothing.
    const idle = judgesWith();
    const third = await reviewRun(idle, '2026-10-21T13:00:00.000Z');
    assert.equal(third.code, 0, `${third.stderr}${third.stdout}`);
    assert.deepEqual(calledFor(idle), [], 'after re-deciding and re-judging, the stored dependencies are current');
  });
});
