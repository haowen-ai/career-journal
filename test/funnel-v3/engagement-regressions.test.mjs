// Contract, fixed-term, temporary, practicum and part-time roles under a student search (review-policy.json
// engagementSignals). Such a title carries no intern/student word, so the scan dropped it as no_student_signal.
// With the setting, a matching title that is also in direction (role-direction.json) is kept for review; its term
// is never inferred from the internship heuristic, and `review rejudge --reclassified` reopens only the stored
// drops that today's scan rules would review. Every employer, title, place and date below is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, reviewOf, T0, at } from '../../test-utils/funnel-v3.mjs';
import { FACTS, REVIEW_POLICY, PROFILE, SCREENING_POLICY, judgment, record } from '../../test-utils/funnel-v3-fixtures.mjs';
import { classifyRole, engagementRules } from '../../src/funnel/classify.mjs';
import { directionRules } from '../../src/review/direction.mjs';
import { decide } from '../../src/review/decide.mjs';
import { ingestBatch } from '../../src/funnel/ingest.mjs';
import { rejudgeReviews, scanReviewable } from '../../src/review/backlog.mjs';
import { scanPolicy } from '../../src/commands/scan.mjs';

const SIGNALS = ['[(\\[][^)\\]]*\\bcontract(?:or)?\\b[^)\\]]*[)\\]]', '\\bfixed[- ]term\\b', '\\btemporary\\b', '\\bpart[- ]time\\b', '\\bpracticum\\b', '^contract$'];
const DIRECTION = directionRules({ allow: ['\\bdata\\b', 'machine learning', '\\banaly'], block: ['recruit', 'merchandis'], requireAllow: ['software engineer'], neutral: 'deny' });
const POLICY = Object.freeze({ ...SCREENING_POLICY, direction: DIRECTION, engagement: engagementRules(SIGNALS) });
const PLAIN = 'Build forecasting models and weekly dashboards for the finance team. '.repeat(10);
const classify = (overrides, { policy = POLICY, profile = PROFILE } = {}) => classifyRole(record({ description: PLAIN, ...overrides }), { policy, profile });

test('[E1] a contract/fixed-term/temporary/part-time/practicum title in direction is kept for review under a student search', () => {
  for (const title of ['Machine Learning and Data Science Practicum', 'Data Analyst (Contract)', 'Data Scientist - Fixed Term', 'Temporary Data Analyst',
    'Part-Time Analytics Associate', 'Software Engineer (Contract)']) {
    const result = classify({ title });
    assert.deepEqual([result.kind, result.lane], ['review', 'new'], `${title}: ${JSON.stringify(result.flags)}`);
    assert.ok(result.flags.includes('engagement_signal'), title);
    assert.ok(!result.flags.includes('no_student_signal'), title);
  }
  const typed = classify({ title: 'Data Analyst', employmentType: 'Contract' });
  assert.equal(typed.kind, 'review', 'an explicit employment type counts like the title');
});

test('[E2] an out-of-direction or non-engagement title stays a no_student_signal drop; no setting means no change', () => {
  for (const title of ['Recruiting Coordinator (Contract)', 'Part-Time Merchandiser', 'Contract Program Coordinator (Fixed Term)', 'Data Analyst', 'Contract Management Analyst']) {
    const result = classify({ title });
    assert.deepEqual([result.kind, result.code], ['drop', 'no_student_signal'], `${title}: ${JSON.stringify(result.flags)}`);
  }
  for (const policy of [SCREENING_POLICY, { ...SCREENING_POLICY, direction: DIRECTION }]) {
    assert.deepEqual([classify({ title: 'Data Analyst (Contract)' }, { policy }).code], ['no_student_signal'], 'without engagementSignals the scan is unchanged');
  }
  const noRules = classify({ title: 'Part-Time Merchandiser' }, { policy: { ...SCREENING_POLICY, engagement: engagementRules(SIGNALS) } });
  assert.equal(noRules.kind, 'review', 'without role-direction rules every matching title counts');
  const fullTime = classify({ title: 'Recruiting Coordinator (Contract)' }, { profile: { search: { jobType: 'full-time', countries: ['US'] } } });
  assert.ok(!fullTime.flags.includes('engagement_signal'), 'only a student search uses the setting');
});

test('[E3] engagementSignals must be a list of valid patterns', () => {
  assert.deepEqual(engagementRules(undefined), []);
  assert.throws(() => engagementRules('contract'), /engagementSignals must be a list/);
  assert.throws(() => engagementRules(['(']), /invalid pattern/);
});

test('[E4] the scan policy reads review-policy.json engagementSignals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cj-engagement-'));
  try {
    const profileDir = path.join(root, '.career-journal', 'profile');
    await mkdir(profileDir, { recursive: true });
    const context = { root, config: { data: { database: '.career-journal/career-journal.db' } } };
    assert.deepEqual((await scanPolicy(context)).engagement, [], 'no review policy: no extra engagement types');
    await writeFile(path.join(profileDir, 'review-policy.json'), JSON.stringify({ engagementSignals: ['\\bpracticum\\b'] }));
    const policy = await scanPolicy(context);
    assert.equal(policy.engagement.length, 1);
    assert.ok(policy.engagement[0].test('Data Science Practicum'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A contract page without internship wording.
const DUTIES = 'You will build forecasting models and present findings to finance leaders.';
const contractPage = ({ location = 'Location: Chicago, IL', term }) => `Data Analyst (Contract)\n${location}\n\nAbout the role\n${term} ${DUTIES} This is a contract position paid hourly.\n\nResponsibilities\n• Maintain weekly reporting.\n`;
const chicago = { place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' };
const nyc = { place: 'New York, NY', area: 'nyc', quote: 'Location: New York, NY' };
const none = { scope: 'none', quote: null };
const decideOn = (text, alternatives, firstSeen = '2026-11-05T00:00:00.000Z') => decide({ snapshotText: text, facts: FACTS, policy: REVIEW_POLICY, tier: 'escalation', firstSeen, jobType: 'internship',
  judgment: judgment({ alternatives, criteria: [], function: { value: 'data', quote: DUTIES } }) });
const why = (verdict) => `${verdict.decision} ${verdict.code ?? ''} ${JSON.stringify(verdict.flags)}`;

test('[E5] a contract term is never inferred: an ASAP or unstated start stays unclear, never eligible', () => {
  for (const [name, term, page] of [
    ['ASAP', { label: 'contract, start ASAP', year: null, kind: 'contract', quote: 'Start date: ASAP, six-month contract.' }, contractPage({ term: 'Start date: ASAP, six-month contract.' })],
    ['term null', null, contractPage({ term: 'Six-month contract.' })],
    ['a dateless season', { label: 'spring', year: null, kind: 'spring', quote: 'The contract runs through the spring.' }, contractPage({ term: 'The contract runs through the spring.' })],
  ]) {
    const verdict = decideOn(page, [{ term, offices: [chicago], remote: none }]);
    assert.notEqual(verdict.decision, 'eligible', `${name}: ${why(verdict)}`);
    assert.ok(!verdict.flags.includes('term_inferred'), `${name}: no inferred term`);
  }
});

test('[E6] a dated contract follows the same windows and areas as an internship', () => {
  const spring = contractPage({ term: 'The contract runs January 2027 through May 2027.' });
  const springTerm = { label: 'spring', year: 2027, kind: 'spring', quote: 'The contract runs January 2027 through May 2027.' };
  assert.equal(decideOn(spring, [{ term: springTerm, offices: [chicago], remote: none }]).decision, 'eligible', 'spring 2027 in Chicago');
  const springNyc = decideOn(spring.replace('Chicago, IL', 'New York, NY'), [{ term: springTerm, offices: [nyc], remote: none }]);
  assert.deepEqual([springNyc.decision, springNyc.code], ['not_eligible', 'outside_area'], `spring 2027 outside Chicago/remote: ${why(springNyc)}`);
  const summer = contractPage({ location: 'Location: New York, NY', term: 'The contract runs from June 2027 to August 2027 over the summer.' });
  const summerTerm = { label: 'summer', year: 2027, kind: 'summer', quote: 'The contract runs from June 2027 to August 2027 over the summer.' };
  assert.equal(decideOn(summer, [{ term: summerTerm, offices: [nyc], remote: none }]).decision, 'eligible', 'summer 2027 follows the summer areas');
  const started = contractPage({ term: 'The contract starts in October 2026.' });
  const fallTerm = { label: 'fall', year: 2026, kind: 'fall', quote: 'The contract starts in October 2026.' };
  assert.deepEqual(decideOn(started, [{ term: fallTerm, offices: [chicago], remote: none }]).code, 'outside_window', 'a 2026 start is outside the windows');
});

test('[E7] an internship page keeps the term inference (guard)', () => {
  const page = 'Data Science Intern\nLocation: Chicago, IL\n\nAbout the role\nInterns join one team for twelve weeks. You will build forecasting models and present findings to finance leaders.\n';
  const verdict = decide({ snapshotText: page, facts: FACTS, policy: REVIEW_POLICY, tier: 'escalation', firstSeen: '2026-09-15T00:00:00.000Z', jobType: 'internship',
    judgment: judgment({ alternatives: [{ term: null, offices: [chicago], remote: none }], criteria: [], function: { value: 'data', quote: 'You will build forecasting models and present findings to finance leaders.' } }) });
  assert.equal(verdict.decision, 'eligible', why(verdict));
  assert.ok(verdict.flags.includes('term_inferred'));
});

test('[E8] rejudge --reclassified reopens only stored signal drops that today\'s scan rules would review', () => {
  const db = freshDb();
  const records = [['9100001', 'Data Analyst (Contract)'], ['9100002', 'Recruiting Coordinator (Contract)'], ['9100003', 'Senior Network Engineer']]
    .map(([id, title]) => record({ sourceId: id, url: `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`, title, description: PLAIN }));
  // Stored as they were before the setting existed: every row a settled no_student_signal drop.
  ingestBatch(db, { runId: 'scan-1', source: 'greenhouse', partition: 'greenhouse:examplecorp', records, now: T0, policy: SCREENING_POLICY, profile: { search: { jobType: 'full-time', countries: ['US'] } } });
  db.prepare("UPDATE reviews SET state='done',decision='dropped',code='no_student_signal',lane='no_student_signal',next_due=NULL").run();
  const idOf = (title) => db.prepare('SELECT id FROM postings WHERE title=?').get(title).id;

  const before = rejudgeReviews(db, { codes: ['no_student_signal'], now: at(1), reviewable: scanReviewable(db, { policy: { ...POLICY, engagement: [] }, profile: PROFILE }) });
  assert.deepEqual([before.selected, before.skipped], [0, { still_dropped: 3 }], 'without the setting nothing reopens');

  const flagged = rejudgeReviews(db, { codes: ['no_student_signal'], now: at(1), reviewable: scanReviewable(db, { policy: POLICY, profile: PROFILE, flag: 'term_tag_conflict' }) });
  assert.equal(flagged.selected, 0, '--flag keeps only reviews whose new classification carries that flag');
  assert.equal(rejudgeReviews(db, { codes: ['no_student_signal'], now: at(1), reviewable: scanReviewable(db, { policy: POLICY, profile: PROFILE, flag: 'engagement_signal' }) }).selected, 1);
  const reviewable = scanReviewable(db, { policy: POLICY, profile: PROFILE });
  const dry = rejudgeReviews(db, { codes: ['no_student_signal'], now: at(1), reviewable });
  assert.deepEqual([dry.dryRun, dry.selected, dry.skipped], [true, 1, { still_dropped: 2 }]);
  const applied = rejudgeReviews(db, { codes: ['no_student_signal'], now: at(1), reviewable, apply: true });
  assert.equal(applied.requeued, 1);
  assert.deepEqual([reviewOf(db, idOf('Data Analyst (Contract)')).state, reviewOf(db, idOf('Data Analyst (Contract)')).lane], ['due', 'new']);
  assert.equal(reviewOf(db, idOf('Recruiting Coordinator (Contract)')).state, 'done');
  assert.throws(() => rejudgeReviews(db, { codes: ['outside_area'], now: at(1), reviewable }), /--reclassified needs --code/);
  assert.throws(() => rejudgeReviews(db, { leads: true, now: at(1), reviewable }), /--reclassified needs --code/);
});
