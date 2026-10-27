// Red tests for the screening funnel's real-model evaluation failures (feat/funnel-v3 at 6d98f53). Each title names
// its coordinator ruling as "(eval R<n>)". The shapes of the judgments follow captured escalation-tier outputs; every
// employer, place, requisition and candidate fact below is invented. Lane B logic only: decide, clauses and eval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, fakeJudge } from '../../test-utils/funnel-v3.mjs';
import { FACTS, REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, SUMMER_CHICAGO, judgment, page, writeReviewFiles } from '../../test-utils/funnel-v3-fixtures.mjs';

const decideModule = () => load('B2', './src/review/decide.mjs', ['decide']);
const clausesModule = () => load('B2', './src/review/clauses.mjs', ['validateCriterion', 'segmentSections']);
const evalModule = () => load('B8', './src/review/eval.mjs', ['runEval']);

async function decideWith({ text, judged, tier = 'escalation', policy = REVIEW_POLICY, facts = FACTS, ...rest }) {
  const { decide } = await decideModule();
  return decide({ snapshotText: text, judgment: judged, facts, policy, tier, ...rest });
}

const why = (verdict) => `${verdict.decision} ${verdict.code ?? ''} ${verdict.question ?? ''}`;
const none = Object.freeze({ scope: 'none', quote: null });
const summer2027 = Object.freeze({ label: 'summer', year: 2027, quote: 'Join our analytics team for the summer of 2027' });
const chicago = Object.freeze({ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' });

// A page in the SNAPSHOTS style with a configurable title, location line, term sentence and qualification bullets.
const posting = ({ title = 'Data Science Intern', location = 'Location: Chicago, IL', term = 'Join our analytics team for the summer of 2027.', extra = '', heading = 'Required Qualifications', bullets = ["Currently pursuing a Bachelor's or Master's degree in Statistics, Computer Science, or a related field."] } = {}) =>
  `${title}\n${location}\n\nAbout the role\n${term} You will build dashboards, write SQL and Python, and present findings to product leaders. This internship runs ten to twelve weeks and pays an hourly rate.${extra ? `\n${extra}` : ''}\n\nResponsibilities\n• Build and maintain data pipelines for weekly reporting.\n• Analyse experiments and explain results to partner teams.\n\n${heading}\n${bullets.map((line) => `• ${line}`).join('\n')}\n`;

const DATA_FUNCTION = Object.freeze({ value: 'data', quote: 'You will build dashboards, write SQL and Python, and present findings to product leaders.' });
const decided = (alternatives, criteria = []) => judgment({ alternatives, criteria, function: DATA_FUNCTION });

// ===================================================================== R1

test('[B] an office place whose city part is in its quote is accepted; a city absent from the quote is still rejected (eval R1)', async () => {
  // Captured shape: the model expands "CA" to "California" in office.place while the quote keeps the abbreviation.
  const header = 'Elm Harbor, CA · Research · Internship · Summer 2027 · On site';
  const text = posting({ title: 'Applied Research Intern', location: header, term: 'Interns join one product team for twelve weeks.', extra: 'This position is fully on site in Elm Harbor, CA.\nFinal interviews are held in Pine Ridge, CA.' });
  const expanded = { place: 'Elm Harbor, California', area: 'california', quote: 'This position is fully on site in Elm Harbor, CA.' };

  const plain = await decideWith({ text, judged: decided([{ term: { label: 'summer', year: 2027, kind: 'summer', quote: 'Summer 2027' }, offices: [expanded], remote: none }]) });
  assert.equal(plain.decision, 'eligible', `"Elm Harbor" (the city part of the place) occurs in the office quote: ${why(plain)}`);

  // Same tolerance in the term/office place agreement: the term quote names "Elm Harbor, CA", the office "Elm Harbor, California".
  const sameLine = await decideWith({ text, judged: decided([{ term: { label: 'summer', year: 2027, kind: 'summer', quote: header }, offices: [expanded], remote: none }]) });
  assert.equal(sameLine.decision, 'eligible', `the term quote's "Elm Harbor, CA" agrees with the office "Elm Harbor, California": ${why(sameLine)}`);

  // Guard: a place whose city part is absent from its quote stays unvalidated.
  const elsewhere = { place: 'Elm Harbor, California', area: 'california', quote: 'Final interviews are held in Pine Ridge, CA.' };
  const rejected = await decideWith({ text, judged: decided([{ term: { label: 'summer', year: 2027, kind: 'summer', quote: 'Summer 2027' }, offices: [elsewhere], remote: none }]) });
  assert.equal(rejected.decision, 'unclear', `the quote does not name Elm Harbor: ${why(rejected)}`);
  assert.equal(rejected.code, 'term_or_area');
});

// ===================================================================== R2

test('[B] the "City, ST" place detector counts only real US state and territory codes (eval R2)', async () => {
  // "Technology, AI" and "Master's, AI" are title fragments, not places; they must not contradict the offices.
  const remoteTitle = 'Graduate Intern – Platform – Technology, AI & Data (Summer 2027)';
  const remoteText = posting({ title: remoteTitle, location: 'LOCATIONS: United States - Remote', term: 'Interns join one product team for twelve weeks.' });
  const remote = await decideWith({ text: remoteText, judged: decided([{ term: { label: 'Summer 2027', year: 2027, kind: 'summer', quote: remoteTitle }, offices: [], remote: { scope: 'us', quote: 'LOCATIONS: United States - Remote' } }]) });
  assert.equal(remote.decision, 'eligible', `"Technology, AI" is not a place: ${why(remote)}`);

  const programTitle = "Current Master's, AI Research Internship Program - Summer 2027";
  const programText = posting({ title: programTitle, location: 'LOCATIONS: New York, NY; Elm Harbor, CA', term: 'Interns join one product team for twelve weeks.' });
  const program = await decideWith({ text: programText, judged: decided([{ term: { label: 'Summer 2027', year: 2027, kind: 'summer', quote: programTitle }, offices: [{ place: 'New York, NY', area: 'nyc', quote: 'LOCATIONS: New York, NY; Elm Harbor, CA' }], remote: none }]) });
  assert.equal(program.decision, 'eligible', `"Master's, AI" is not a place: ${why(program)}`);

  // Guard: a real "City, ST" place in the term quote that names a different city still disagrees with the office.
  const realText = posting({ term: 'Join our Summer 2027 internship based in Springfield, IL.' });
  const real = await decideWith({ text: realText, judged: decided([{ term: { label: 'summer', year: 2027, quote: 'Join our Summer 2027 internship based in Springfield, IL.' }, offices: [chicago], remote: none }]) });
  assert.notEqual(real.decision, 'eligible', `"Springfield, IL" is a place and is not the Chicago office: ${why(real)}`);
});

// ===================================================================== R3

test('[B] remote.scope "unknown" with a quote is no remote evidence, not a contradiction (eval R3)', async () => {
  const hybrid = 'Interns follow a hybrid schedule, splitting each week between the office and home.';
  const text = posting({ extra: hybrid });
  const verdict = await decideWith({ text, judged: decided([{ term: summer2027, offices: [chicago], remote: { scope: 'unknown', quote: hybrid } }]) });
  assert.equal(verdict.decision, 'eligible', `the Chicago office qualifies; an unknown remote scope adds nothing: ${why(verdict)}`);
  assert.ok([null, 'none'].includes(verdict.location.remote.scope), `no remote scope is delivered: ${JSON.stringify(verdict.location.remote)}`);
});

// ===================================================================== R4

test('[B] the eval passes each case\'s first-seen date into decide, so a season-only page infers the upcoming year (eval R4)', async () => {
  const { runEval } = await evalModule();
  const title = 'Data Science Intern';
  const text = `${posting({ term: 'Join our analytics team for our summer internship program.' })}\nCase marker s1.\n`;
  const output = decided([{ term: { label: 'summer', year: null, kind: 'summer', quote: 'Join our analytics team for our summer internship program.' }, offices: [chicago], remote: none }],
    [{ key: 'degree', status: 'meets', quote: "Currently pursuing a Bachelor's or Master's degree in Statistics, Computer Science, or a related field.", clause_alternatives: [], fact_ids: ['degree'] }]);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cj-eval-r4-'));
  try {
    await writeReviewFiles(path.join(directory, 'profiles', 'a'));
    const url = 'https://job-boards.greenhouse.io/exampleeval/jobs/s1';
    await mkdir(path.join(directory, 'cases', 's1'), { recursive: true });
    await writeFile(path.join(directory, 'cases', 's1', 'fetch.json'), JSON.stringify(page(url, text, { title, company: 'Example Eval Co' })));
    const manifest = {
      setId: 'set-r4', profiles: { a: 'profiles/a' }, gate: { maxFalseAccepts: 0, maxFalseRejects: 0, maxUnexpectedUnclear: 0 },
      cases: [{ id: 's1', profile: 'a', posting: { url, company: 'Example Eval Co', title, requisition: null, firstSeen: '2026-09-15T00:00:00.000Z' }, fetch: 'cases/s1/fetch.json', expected: { decision: 'eligible', acceptable: ['eligible'] }, tags: ['season_only'] }],
    };
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const judges = { primary: fakeJudge({ tier: 'primary', answers: () => ({ output }) }), escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output }) }) };
    const result = await runEval({ setDir: directory, concurrency: 1, judges });
    const [item] = result.cases;
    assert.equal(item.decision, 'eligible', `first seen 2026-09-15, "summer" means Summer 2027, as in the worker: ${item.code} ${item.verdict?.question ?? ''}`);
    assert.ok(item.verdict.flags.includes('term_inferred'), `the inference is flagged: ${JSON.stringify(item.verdict.flags)}`);
    assert.equal(result.pass, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ===================================================================== R5

test('[B] a self-contradictory alternative disqualifies only itself; a term quote need only contain its label\'s season (eval R5)', async () => {
  // One valid allowed alternative plus one whose label contradicts its own quote: eligible via the valid one.
  const contradictory = { term: { label: 'fall', year: 2027, quote: 'Join our analytics team for the summer of 2027' }, offices: [chicago], remote: none };
  const mixed = await decideWith({ text: SNAPSHOTS.eligible, judged: decided([SUMMER_CHICAGO, contradictory], JUDGMENTS.eligible.criteria) });
  assert.equal(mixed.decision, 'eligible', `the Summer 2027 / Chicago alternative stands on its own: ${why(mixed)}`);
  assert.equal(mixed.location.alternatives.length, 1, 'only the valid alternative is delivered as allowed');
  assert.equal(mixed.location.alternatives[0].term.label, 'summer');

  // Captured shape: one quote lists several work windows; the model splits it into one alternative per window.
  const header = 'Elm Harbor, CA · Research · Internship · Semester/quarter or summer 2027 · On site';
  const text = posting({ title: 'Applied Research Intern', location: header, term: 'Interns join one product team.', extra: 'This position is fully on site in Elm Harbor, CA.' });
  const office = { place: 'Elm Harbor, CA', area: 'california', quote: 'This position is fully on site in Elm Harbor, CA.' };
  const window = (label, kind) => ({ term: { label, year: 2027, kind, quote: header }, offices: [office], remote: none });
  const split = await decideWith({ text, judged: decided([window('Summer', 'summer'), window('Semester', 'semester'), window('Quarter', 'quarter')]) });
  assert.equal(split.decision, 'eligible', `the summer alternative qualifies; the semester/quarter ones are simply outside the windows: ${why(split)}`);

  // The semester alternative's own quote names "summer" too; that alone is no contradiction.
  const semesterPolicy = { ...REVIEW_POLICY, windows: [{ id: 'semester', termKinds: ['semester'], year: 2027, areas: ['california'] }] };
  const semester = await decideWith({ text, policy: semesterPolicy, judged: decided([window('Semester', 'semester')]) });
  assert.equal(semester.decision, 'eligible', `"Semester/quarter or summer 2027" is valid evidence for the semester label: ${why(semester)}`);

  // Guard: a quote naming seasons must still contain the label's season.
  const wrongSeason = await decideWith({ text: posting({ term: 'Join our Spring 2027 co-op in Chicago.' }), judged: decided([{ term: { label: 'summer', year: 2027, quote: 'Join our Spring 2027 co-op in Chicago.' }, offices: [chicago], remote: none }]) });
  assert.notEqual(wrongSeason.decision, 'eligible', `a Spring quote is not Summer evidence: ${why(wrongSeason)}`);
});

// ===================================================================== R6

const AVAILABILITY_FACTS = Object.freeze([
  ...FACTS,
  // Availability facts are named by their ids ("availability", "<qualifier>-availability").
  { id: 'availability', statement: 'Available full time from June through August 2027', polarity: 'constraint' },
  { id: 'offseason-availability', statement: 'Available up to 20 hours per week during the academic year', polarity: 'constraint' },
]);

test('[B] "a plus" wording is non-mandatory, and an unclear criterion citing only availability or only has facts is advisory (eval R6)', async () => {
  const { validateCriterion } = await clausesModule();
  const plus = ['Familiarity with Rust is a plus.', 'Prior internship experience, a plus.'];
  const plusText = posting({ bullets: ['Proficiency in Python or R for data analysis.', ...plus] });
  for (const quote of plus) {
    const criterion = { key: 'requirement', status: 'unclear', quote, clause_alternatives: [], fact_ids: ['gis'] };
    assert.equal(validateCriterion(plusText, criterion, AVAILABILITY_FACTS).reason, 'non_mandatory', quote);
    const verdict = await decideWith({ text: plusText, facts: AVAILABILITY_FACTS, judged: decided([{ term: summer2027, offices: [chicago], remote: none }], [criterion]) });
    assert.equal(verdict.decision, 'eligible', `${quote}: ${why(verdict)}`);
  }

  const reasoning = 'Ability to reason about failure modes and engineering tradeoffs.';
  const text = posting({ bullets: ['Proficiency in Python or R for data analysis.', reasoning, 'Hands-on experience with geographic information systems.'] });
  const alternatives = [{ term: summer2027, offices: [chicago], remote: none }];
  const unclear = (quote, factIds) => ({ key: 'requirement', status: 'unclear', quote, clause_alternatives: [], fact_ids: factIds });
  for (const [name, criterion] of [
    ['only availability facts', unclear('Join our analytics team for the summer of 2027.', ['availability', 'offseason-availability'])],
    ['only has facts', unclear(reasoning, ['python', 'sql'])],
  ]) {
    const verdict = await decideWith({ text, facts: AVAILABILITY_FACTS, judged: decided(alternatives, [criterion]) });
    assert.equal(verdict.decision, 'eligible', `${name} is advisory, no hold: ${why(verdict)}`);
  }

  // Guards: an unclear criterion citing a lacks fact or a non-availability constraint still holds.
  for (const [name, criterion] of [
    ['a lacks fact', unclear('Hands-on experience with geographic information systems.', ['gis'])],
    ['a non-availability constraint', unclear(reasoning, ['degree'])],
  ]) {
    const verdict = await decideWith({ text, facts: AVAILABILITY_FACTS, judged: decided(alternatives, [criterion]) });
    assert.equal(verdict.decision, 'unclear', `${name} still holds: ${why(verdict)}`);
  }
});

// ===================================================================== R7

test('[B] at the escalation tier a validated confirmed conflict rejects before term/area and missing-fact holds (eval R7)', async () => {
  const undergrad = "Be enrolled as a junior undergraduate student pursuing a Bachelor's degree.";
  const kubernetes = 'Hands-on experience operating Kubernetes clusters.';
  const text = posting({ heading: 'Minimum Qualifications', bullets: [undergrad, kubernetes] });
  const confirmed = { key: 'degree', status: 'conflicts', quote: undergrad, clause_alternatives: [], fact_ids: ['degree'] };
  const missingFact = { key: 'requirement', status: 'conflicts', quote: kubernetes, clause_alternatives: [], fact_ids: ['kubernetes'] };
  const valid = { term: summer2027, offices: [chicago], remote: none };
  const invalid = { term: summer2027, offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, Illinois' }], remote: none };

  const withMissing = await decideWith({ text, judged: decided([valid], [missingFact, confirmed]) });
  assert.deepEqual([withMissing.decision, withMissing.code], ['not_eligible', 'degree'], `the confirmed conflict decides before the missing fact: ${why(withMissing)}`);

  const withBadAlternative = await decideWith({ text, judged: decided([invalid], [confirmed]) });
  assert.deepEqual([withBadAlternative.decision, withBadAlternative.code], ['not_eligible', 'degree'], `the confirmed conflict decides before term/area: ${why(withBadAlternative)}`);

  // The primary tier still only proposes the rejection.
  for (const judged of [decided([valid], [missingFact, confirmed]), decided([invalid], [confirmed])]) {
    const primary = await decideWith({ text, judged, tier: 'primary' });
    assert.deepEqual([primary.decision, primary.escalate], ['unclear', true], why(primary));
  }
});

// ===================================================================== R8

test('[B] at the escalation tier, validated alternatives that all fall outside the policy reject as outside_window or outside_area (eval R8)', async () => {
  const outsideText = posting({ location: 'Location: Riverton, NJ' });
  const riverton = { term: summer2027, offices: [{ place: 'Riverton, NJ', area: 'outside', quote: 'Location: Riverton, NJ' }], remote: none };
  const area = await decideWith({ text: outsideText, judged: decided([riverton]) });
  assert.deepEqual([area.decision, area.code], ['not_eligible', 'outside_area'], `Summer 2027 in Riverton, NJ is quoted and outside every area: ${why(area)}`);

  const laterText = posting({ term: 'Join our analytics team for the summer of 2028.' });
  const later = { term: { label: 'summer', year: 2028, quote: 'Join our analytics team for the summer of 2028' }, offices: [chicago], remote: none };
  const window = await decideWith({ text: laterText, judged: decided([later]) });
  assert.deepEqual([window.decision, window.code], ['not_eligible', 'outside_window'], `Summer 2028 is quoted and outside every window: ${why(window)}`);

  // Guards: one unvalidated alternative keeps the posting unclear; the primary tier still escalates.
  const unvalidated = { term: summer2027, offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, Illinois' }], remote: none };
  const mixed = await decideWith({ text: outsideText, judged: decided([riverton, unvalidated]) });
  assert.deepEqual([mixed.decision, mixed.code], ['unclear', 'term_or_area'], why(mixed));
  const primary = await decideWith({ text: outsideText, judged: decided([riverton]), tier: 'primary' });
  assert.deepEqual([primary.decision, primary.escalate], ['unclear', true], why(primary));
});

// ===================================================================== R9

test('[B] a year-only internship page first seen Aug–Dec of the prior year is treated as summer of that year (eval R9)', async () => {
  // Captured shape: the page names only "2027"; the model labels the term without a season.
  const title = '2027 Intern - Data Platform';
  const text = posting({ title, location: 'LOCATIONS: Chicago, IL', term: 'Interns join one product team for twelve weeks.' });
  const yearOnly = decided([{ term: { label: '2027 internship; season unspecified', year: 2027, kind: null, quote: title }, offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'LOCATIONS: Chicago, IL' }], remote: none }]);
  const verdict = await decideWith({ text, judged: yearOnly, firstSeen: '2026-09-15T00:00:00.000Z', jobType: 'internship' });
  assert.equal(verdict.decision, 'eligible', `treated as Summer 2027: ${why(verdict)}`);
  assert.ok(verdict.flags.includes('term_inferred'), `the inference is flagged: ${JSON.stringify(verdict.flags)}`);
  assert.equal(verdict.location.alternatives[0]?.term?.year, 2027);

  // Guards: normal rules apply outside Aug–Dec, for another job type, or when the page names a season anywhere.
  const seasonText = posting({ title, location: 'LOCATIONS: Chicago, IL', term: 'Interns join one product team for twelve weeks.', extra: 'Interns may start in the fall 2027 cohort.' });
  for (const [name, body, options] of [
    ['first seen in June', text, { firstSeen: '2026-06-20T00:00:00.000Z', jobType: 'internship' }],
    ['a full-time search', text, { firstSeen: '2026-09-15T00:00:00.000Z', jobType: 'full-time' }],
    ['a season named on the page', seasonText, { firstSeen: '2026-09-15T00:00:00.000Z', jobType: 'internship' }],
  ]) {
    const guarded = await decideWith({ text: body, judged: yearOnly, ...options });
    assert.notEqual(guarded.decision, 'eligible', `${name}: ${why(guarded)}`);
    assert.ok(!guarded.flags.includes('term_inferred'), `${name}: no inference`);
  }
});

// ===================================================================== R10

test('[B] "What You Need to Succeed" and "Required Knowledge, Skills and Experience" headings parse as required (eval R10)', async () => {
  const { segmentSections, validateCriterion } = await clausesModule();
  const bullet = 'Must be enrolled in a degree program.';
  // A preferred section first, so an unrecognized heading would leave the bullet filed as preferred.
  const textUnder = (heading) => `Data Intern\n\nAbout the role\nYou will analyse data for partner teams.\n\nNice to Have\n• Familiarity with dashboards.\n\n${heading}\n• ${bullet}\n`;
  for (const heading of ['What You Need to Succeed', 'What You Need to Succeed:', 'Required Knowledge, Skills and Experience', '## Required Knowledge, Skills and Experience']) {
    const text = textUnder(heading);
    const offset = text.indexOf(`• ${bullet}`);
    assert.equal(segmentSections(text).find((section) => section.start <= offset && offset < section.end)?.kind, 'required', heading);
    const validation = validateCriterion(text, { key: 'requirement', status: 'unclear', quote: bullet, clause_alternatives: [], fact_ids: [] }, FACTS);
    assert.equal(validation.section, 'required', heading);
    assert.notEqual(validation.reason, 'non_mandatory', `${heading}: the bullet is mandatory`);
  }
  assert.equal(segmentSections(textUnder('Preferred Knowledge, Skills and Experience')).at(-1).kind, 'preferred', 'the preferred variant stays preferred');
});

// ===================================================================== R11

test('[B] at the escalation tier, out-of-policy alternatives and confirmed conflicts reject before unclear-criterion holds (eval R11)', async () => {
  // Captured shape: the only office is quoted and outside every area, and the model also marks an unrelated
  // logistics requirement "unclear" with no fact to cite. The quoted location already decides the posting.
  const commute = 'Reliable transportation is required to reach the plant each work day.';
  const undergrad = "Be enrolled as a junior undergraduate student pursuing a Bachelor's degree.";
  const outsideText = posting({ location: 'Location: Riverton, NJ', heading: 'Minimum Qualifications', bullets: [undergrad, commute] });
  const insideText = posting({ heading: 'Minimum Qualifications', bullets: [undergrad, commute] });
  const unclearCommute = { key: 'requirement', status: 'unclear', quote: commute, clause_alternatives: [], fact_ids: [] };
  const unclearDegree = { key: 'degree', status: 'unclear', quote: undergrad, clause_alternatives: [], fact_ids: ['degree'] };
  const confirmed = { key: 'degree', status: 'conflicts', quote: undergrad, clause_alternatives: [], fact_ids: ['degree'] };
  const riverton = { term: summer2027, offices: [{ place: 'Riverton, NJ', area: 'outside', quote: 'Location: Riverton, NJ' }], remote: none };
  const valid = { term: summer2027, offices: [chicago], remote: none };

  // Validated alternatives, all outside the policy areas: an unclear criterion does not turn the rejection into a hold.
  for (const [name, criteria] of [['an unclear commute requirement', [unclearCommute]], ['an unclear criterion citing a constraint', [unclearDegree, unclearCommute]]]) {
    const verdict = await decideWith({ text: outsideText, judged: decided([riverton], criteria) });
    assert.deepEqual([verdict.decision, verdict.code], ['not_eligible', 'outside_area'], `${name}: Riverton, NJ is quoted and outside every area: ${why(verdict)}`);
  }

  // A confirmed conflict rejects even when an unrelated unclear criterion is listed before it.
  const conflict = await decideWith({ text: insideText, judged: decided([valid], [unclearCommute, confirmed]) });
  assert.deepEqual([conflict.decision, conflict.code], ['not_eligible', 'degree'], `the confirmed degree conflict decides before the commute question: ${why(conflict)}`);

  // Guards: an in-policy alternative with an unclear mandatory criterion still holds; one unvalidated alternative
  // keeps the posting unclear; the primary tier still only proposes the rejection.
  const held = await decideWith({ text: insideText, judged: decided([valid], [unclearCommute]) });
  assert.deepEqual([held.decision, held.code], ['unclear', 'missing_fact'], `Chicago qualifies, so the commute question holds: ${why(held)}`);
  const unvalidated = { term: summer2027, offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, Illinois' }], remote: none };
  const mixed = await decideWith({ text: outsideText, judged: decided([riverton, unvalidated], [unclearCommute]) });
  assert.equal(mixed.decision, 'unclear', `an unvalidated alternative may still be allowed: ${why(mixed)}`);
  const primary = await decideWith({ text: outsideText, judged: decided([riverton], [unclearCommute]), tier: 'primary' });
  assert.deepEqual([primary.decision, primary.escalate], ['unclear', true], why(primary));
});

// ===================================================================== R12

test('[B] optional wording inside a parenthetical or attached to another attribute does not soften the main requirement (eval R12)', async () => {
  // Captured shape: "Be enrolled as a junior undergraduate (Preferred Graduation Date: …)". The parenthetical
  // qualifies the graduation date, not the enrolment requirement; the model's confirmed conflict must stand.
  const { validateCriterion } = await clausesModule();
  const valid = { term: summer2027, offices: [chicago], remote: none };
  const conflict = (quote, factIds = ['degree']) => ({ key: 'degree', status: 'conflicts', quote, clause_alternatives: [], fact_ids: factIds });
  for (const quote of [
    'Be enrolled as a junior undergraduate student (Preferred Graduation Date: Spring 2029)',
    'Be enrolled as a junior undergraduate student in a quantitative major (preferred: Statistics or Economics).',
  ]) {
    const text = posting({ heading: 'Minimum Qualifications', bullets: [quote, 'Proficiency in Python or R for data analysis.'] });
    const validation = validateCriterion(text, conflict(quote), FACTS);
    assert.notEqual(validation.reason, 'non_mandatory', `${quote}: the optional wording belongs to another attribute`);
    assert.equal(validation.confirmedConflict, true, `${quote}: the whole-clause conflict with a constraint fact is confirmed`);
    const verdict = await decideWith({ text, judged: decided([valid], [conflict(quote)]) });
    assert.deepEqual([verdict.decision, verdict.code], ['not_eligible', 'degree'], `${quote}: ${why(verdict)}`);
  }

  // Guards: "X preferred." as the clause's own predicate is still non-mandatory and never blocks (merged #4).
  for (const [quote, factIds] of [['Scala experience preferred.', ['scala']], ["A Master's degree in Statistics is preferred.", ['degree']]]) {
    const text = posting({ heading: 'Minimum Qualifications', bullets: ['Proficiency in Python or R for data analysis.', quote] });
    const validation = validateCriterion(text, conflict(quote, factIds), FACTS);
    assert.equal(validation.reason, 'non_mandatory', quote);
    assert.equal(validation.confirmedConflict, false, quote);
    const verdict = await decideWith({ text, judged: decided([valid], [conflict(quote, factIds)]) });
    assert.notEqual(verdict.decision, 'not_eligible', `${quote}: preferred wording never blocks: ${why(verdict)}`);
  }
});

// ===================================================================== R13

test('[B] a term year missing from its quote is taken from the page title, else inferred from first seen; never a contradiction (eval R13)', async () => {
  // Captured shape: the title names "2027", the body only "the summer"; the model's label is free text.
  const quote = 'As our data intern, you will own one problem for the summer.';
  const body = (title) => posting({ title, location: 'Location: Chicago, IL', term: quote });
  const freeText = (label, year = 2027) => decided([{ term: { label, year, kind: 'summer', start: null, end: null, quote }, offices: [chicago], remote: none }]);
  const seen = { firstSeen: '2026-10-15T12:00:00Z', jobType: 'internship' };

  for (const [name, text] of [
    ['a TITLE: line', `URL: https://jobs.example.test/data-intern\nTITLE: 2027 Internship Data Intern\n${body('About Example Robotics')}`],
    ['the first heading', body('# 2027 Internship Data Intern')],
  ]) {
    const verdict = await decideWith({ text, judged: freeText('Summer 2027; year from title, season from body'), ...seen });
    assert.equal(verdict.decision, 'eligible', `${name} carries 2027 and the quote names summer: ${why(verdict)}`);
    assert.equal(verdict.location.alternatives[0]?.term?.year, 2027);
  }

  // Neither quote nor title names a year: the model's year is unknown, so the season-only first-seen rule applies.
  const untitled = body('Data Science Intern');
  const inferred = await decideWith({ text: untitled, judged: freeText('Summer 2027; year assumed'), ...seen });
  assert.equal(inferred.decision, 'eligible', `first seen Oct 2026, "the summer" means Summer 2027: ${why(inferred)}`);
  assert.ok(inferred.flags.includes('term_inferred'), `the inference is flagged: ${JSON.stringify(inferred.flags)}`);
  assert.equal(inferred.location.alternatives[0]?.term?.year, 2027);

  // Guards: an unsupported model year does not survive a later first-seen date, and a title naming another year
  // does not vouch for the model's 2027.
  const later = await decideWith({ text: untitled, judged: freeText('Summer 2027; year assumed'), firstSeen: '2027-10-15T12:00:00Z', jobType: 'internship' });
  assert.notEqual(later.decision, 'eligible', `first seen Oct 2027, "the summer" is Summer 2028: ${why(later)}`);
  const otherYear = await decideWith({ text: body('# 2028 Internship Data Intern'), judged: freeText('Summer 2027; year from title'), ...seen });
  assert.notEqual(otherYear.decision, 'eligible', `the title says 2028, not 2027: ${why(otherYear)}`);
});

// ===================================================================== R14

test('[B] a season-only summer term with a free-text label and unknown remote scope infers the upcoming year (eval R14)', async () => {
  // Captured shape: year null, kind "summer", label "Summer internship; year unspecified", remote scope unknown
  // with a null quote. The season-only rule must read the label's season word (or the kind), not demand a bare label.
  const quote = 'Example Parts has an exciting Customer Analytics summer internship opening at our headquarters in Elm Harbor, WA.';
  const text = posting({ title: 'Summer Internship - Customer Analytics', location: 'Elm Harbor, WA, US, 98000', term: quote });
  const office = { place: 'Elm Harbor, Washington', area: 'seattle', quote: 'Elm Harbor, WA, US, 98000' };
  const seasonOnly = (label) => decided([{ term: { label, year: null, kind: 'summer', start: null, end: null, quote }, offices: [office], remote: { scope: 'unknown', quote: null } }]);

  for (const label of ['Summer internship; year unspecified', 'summer (year not stated)']) {
    const verdict = await decideWith({ text, judged: seasonOnly(label), firstSeen: '2026-10-15T12:00:00Z', jobType: 'internship' });
    assert.equal(verdict.decision, 'eligible', `${label}: first seen Oct 2026, a summer internship is Summer 2027: ${why(verdict)}`);
    assert.ok(verdict.flags.includes('term_inferred'), `${label}: the inference is flagged: ${JSON.stringify(verdict.flags)}`);
    assert.equal(verdict.location.alternatives[0]?.term?.year, 2027, label);
  }

  // Guard: outside Aug–Dec there is no inference, so the posting stays unresolved.
  const spring = await decideWith({ text, judged: seasonOnly('Summer internship; year unspecified'), firstSeen: '2026-05-15T12:00:00Z', jobType: 'internship' });
  assert.notEqual(spring.decision, 'eligible', why(spring));
  assert.ok(!spring.flags.includes('term_inferred'), 'no inference in May');
});

// ===================================================================== R15

test('[B] an unclear criterion that cites no fact and quotes non-requirement prose is advisory; a hold needs an answerable question (eval R15)', async () => {
  // Captured shape: the model marked the program description "unclear" with fact_ids [], producing a hold whose question is the description itself.
  const text = posting();
  const alternatives = [{ term: summer2027, offices: [chicago], remote: none }];
  const prose = 'This internship runs ten to twelve weeks and pays an hourly rate.';
  const vague = { key: 'requirement', status: 'unclear', quote: prose, clause_alternatives: [], fact_ids: [] };
  const verdict = await decideWith({ text, facts: AVAILABILITY_FACTS, judged: decided(alternatives, [vague]) });
  assert.equal(verdict.decision, 'eligible', `no fact cited outside a requirement section is advisory: ${why(verdict)}`);

  // Guard: an unclear criterion without facts inside the required section still holds (the user can answer it).
  const required = "Currently pursuing a Bachelor's or Master's degree in Statistics, Computer Science, or a related field.";
  const held = await decideWith({ text, facts: AVAILABILITY_FACTS, judged: decided(alternatives, [{ ...vague, quote: required }]) });
  assert.equal(held.decision, 'unclear', `a required-section clause still holds: ${why(held)}`);
});

// ===================================================================== R16

test('[B] real-shaped out-of-area postings (month-range terms, bare City, ST office quotes, unknown remote) reject as outside_area (eval R16)', async () => {
  // Captured shapes (run 7): a month-range term quote with a "Summer 2027" label and several bare "City, ST" office quotes;
  // and a month-range label with kind summer, one office, remote scope unknown with a null quote.
  const multiText = posting({ location: 'Locations:\nRiverton, NJ\nMill Creek, TX', term: 'Program Duration: June 2027 – August 2027 (10 weeks)' });
  const months = { label: 'Summer 2027', year: 2027, kind: 'summer', start: '2027-06', end: '2027-08', quote: 'Program Duration: June 2027 – August 2027 (10 weeks)' };
  const multi = await decideWith({ text: multiText, judged: decided([
    { term: months, offices: [{ place: 'Riverton, NJ', area: 'outside', quote: 'Riverton, NJ' }], remote: { scope: 'none', quote: null } },
    { term: months, offices: [{ place: 'Mill Creek, TX', area: 'outside', quote: 'Mill Creek, TX' }], remote: { scope: 'none', quote: null } },
  ]) });
  assert.deepEqual([multi.decision, multi.code], ['not_eligible', 'outside_area'], why(multi));

  const singleText = posting({ location: 'Location: Pine Ridge, CO', term: 'Timing: May – August 2027' });
  const single = await decideWith({ text: singleText, judged: decided([
    { term: { label: 'May – August 2027', year: 2027, kind: 'summer', start: '2027-05', end: '2027-08', quote: 'Timing: May – August 2027' }, offices: [{ place: 'Pine Ridge, Colorado', area: 'outside', quote: 'Location: Pine Ridge, CO' }], remote: { scope: 'unknown', quote: null } },
  ]) });
  assert.deepEqual([single.decision, single.code], ['not_eligible', 'outside_area'], why(single));
});

test('[B] an unclear criterion citing only availability and has facts together is advisory (eval R6b)', async () => {
  const text = posting({ bullets: ['Ability to work fully in person in Chicago. Summer interns should be available full time.'] });
  const criterion = { key: 'requirement', status: 'unclear', quote: 'Ability to work fully in person in Chicago. Summer interns should be available full time.', clause_alternatives: [], fact_ids: ['availability', 'python'] };
  const verdict = await decideWith({ text, facts: AVAILABILITY_FACTS, judged: decided([{ term: summer2027, offices: [chicago], remote: none }], [criterion]) });
  assert.equal(verdict.decision, 'eligible', why(verdict));
});
