// User decision 2026-10-30: under a student search a role with no student signal is dropped at scan, and queued
// rows are settled by `review reclassify`. 691 such roles had been judged and none was eligible. Drops stay in
// postings for identity and dedupe, are never sent to the judge, and reopen only by `review rejudge` or when the
// posting is relisted. Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, load, insertPosting, insertReview, reviewOf, seedApplication, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { record, PROFILE, SCREENING_POLICY, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs, writeReviewHome } from '../../test-utils/funnel-v3-fixtures.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { runCli } from '../../src/cli/main.mjs';
import { createRuntime } from '../../src/runtime/create-runtime.mjs';

const classify = () => load('DNS', './src/funnel/classify.mjs', ['classifyRole']);
const ingest = () => load('DNS', './src/funnel/ingest.mjs', ['ingestBatch']);
const worker = () => load('DNS', './src/review/worker.mjs', ['runReview', 'replan', 'inputState', 'scheduleRefresh']);
const reclassifyModule = () => load('DNS', './src/review/reclassify.mjs', ['reclassifyReviews']);
const redecideModule = () => load('DNS', './src/review/redecide.mjs', ['redecideReviews']);

const FULL_TIME = Object.freeze({ search: { jobType: 'full-time', countries: ['US'] } });
const LONG = (text) => `${text} `.repeat(12);
const NO_SIGNAL = Object.freeze({ title: 'Senior Data Engineer', description: LONG('Build pipelines for our platform.') });
const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
const roleRecord = (id, overrides = {}) => record({ sourceId: String(id), url: urlOf(id), ...overrides });
const postingOf = (db, id) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(`url:${urlOf(id).replace('https://', '')}`).posting_id;
const outcome = (db, id) => { const row = reviewOf(db, id); return [row.state, row.decision, row.code]; };
const DROPPED = ['done', 'dropped', 'no_student_signal'];

function scanner(ingestBatch, db) {
  let run = 0;
  return (records, { now = T0, profile = PROFILE, policy = SCREENING_POLICY, source = 'greenhouse', partition = 'greenhouse:examplecorp' } = {}) =>
    ingestBatch(db, { runId: `scan-${run += 1}`, source, partition, records, now, policy, profile });
}
// A row queued before the change: a non-student profile leaves no-signal records due, as the old classifier did.
// Certain drops of unknown records are counted only since the 2026-11-05 redesign, so a queued fixture lifts the
// company exclusion and the country filter too: it stands for a row stored before either rule existed.
const QUEUED_POLICY = Object.freeze({ ...SCREENING_POLICY, userExcludedCompanies: [] });
const OPEN_PROFILE = Object.freeze({ search: { jobType: 'full-time', countries: [] } });
const queued = (scan, records, options = {}) => scan(records, { profile: FULL_TIME, policy: QUEUED_POLICY, ...options });
// A drop settled before count-only ingest: its posting and every alias exist and its review is done.
function settledDrop(scan, db, n, rec, code, options = {}) {
  queued(scan, [rec], { profile: OPEN_PROFILE, ...options });
  const id = postingOf(db, n);
  db.prepare(`UPDATE reviews SET state = 'done', decision = 'dropped', code = ?, lane = ?, next_due = NULL WHERE posting_id = ?`)
    .run(code, ['no_student_signal', 'out_of_direction'].includes(code) ? code : 'new', id);
  return id;
}
const reclassify = (reclassifyReviews, db, options = {}) => reclassifyReviews(db, { policy: SCREENING_POLICY, profile: PROFILE, now: at(1), ...options });
const eligibleJudges = () => ({
  primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) }),
  escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }),
});
const review = async (db, { now, runId, budget = 10, pages = {}, judges = eligibleJudges(), fetcher = fakeFetcher(pages), inputs = reviewInputs() }) => {
  const { runReview } = await worker();
  return runReview({ db, runId, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {}, fetcher, judges, inputs: () => inputs, hooks: {} });
};
function judgedPosting(db, id) {
  const url = urlOf(id);
  insertPosting(db, { id, url, title: snapshotTitle(SNAPSHOTS.eligible) });
  insertReview(db, { postingId: id, stage: 'fetch', firstSeen: T0, nextDue: T0 });
  return { [url]: page(url, SNAPSHOTS.eligible) };
}

// ===================================================================== classification

test('[A] an Intern, Internship or Co-op employment type is a student signal with no other evidence', async () => {
  const { classifyRole } = await classify();
  for (const employmentType of ['Intern', 'Internship', 'Co-op', 'co-op / internship']) {
    const result = classifyRole(record({ title: 'Data Analyst', employmentType, description: '' }), { policy: SCREENING_POLICY, profile: PROFILE });
    assert.deepEqual([result.kind, result.lane], ['review', 'new'], employmentType);
  }
  const fullTime = classifyRole(record({ title: 'Data Analyst', employmentType: 'Full-time', description: '' }), { policy: SCREENING_POLICY, profile: PROFILE });
  assert.equal(fullTime.code, 'no_student_signal', 'another employment type is no signal');
});

test('[A] a season term tag and a winternship are student signals', async () => {
  const { classifyRole } = await classify();
  const options = { policy: SCREENING_POLICY, profile: PROFILE };
  const tagged = (terms) => classifyRole(record({ source: 'simplify', title: 'Software Engineer', description: '', terms }), options);
  assert.equal(tagged(['Summer 2027']).kind, 'review');
  assert.equal(tagged(['Fall 2026', 'Spring 2027']).kind, 'review');
  assert.equal(tagged(['N/A']).code, 'no_student_signal', 'Simplify\'s unknown term is no signal');
  assert.equal(classifyRole(record({ title: 'Women\'s Winternship', description: '' }), options).kind, 'review');
});

test('[A] a partial location list never counts as outside the search countries', async () => {
  const { classifyRole } = await classify();
  const overseas = { title: 'Data Science Intern', locations: ['Berlin, Germany'], remote: false, workplaceType: 'On-site' };
  const known = { locations: 'complete', arrangement: 'known', description: 'full', employment_type: 'absent' };
  const options = { policy: SCREENING_POLICY, profile: PROFILE };
  assert.equal(classifyRole(record({ ...overseas, completeness: known }), options).code, 'outside_countries');
  assert.equal(classifyRole(record({ ...overseas, completeness: { ...known, locations: 'partial' } }), options).kind, 'review', 'a partial list can hide a US office');
});

test('[A] the new drop codes are part of the contract', async () => {
  const { DROP_CODES } = await load('DNS', './src/funnel/contract.mjs', ['DROP_CODES']);
  for (const code of ['no_student_signal', 'out_of_direction', 'delisted']) assert.ok(DROP_CODES.includes(code), code);
});

// ===================================================================== ingest

// Changed on purpose 2026-11-05 (redesign A1): an unknown no-signal record is counted, not stored.
test('[A] a no-signal record is dropped at ingest: an unknown one is only counted, a settled one is never touched again', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const counts = scan([roleRecord(1, NO_SIGNAL), roleRecord(2)]);
  assert.equal(counts.dropped.no_student_signal, 1);
  assert.equal(counts.review, 1);
  assert.equal(counts.observed, 2);
  assert.equal(counts.countedOnly, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM postings').get().n, 1, 'only the student role is stored');
  const id = settledDrop(scan, db, 3, roleRecord(3, NO_SIGNAL), 'no_student_signal');
  const updated = reviewOf(db, id).updated_at;
  scan([roleRecord(3, NO_SIGNAL)], { now: at(1) });
  assert.equal(reviewOf(db, id).updated_at, updated, 'an identical sighting does not touch it');
});

// Review finding 2026-11-05: an ingest reopen is a re-judgment like any other. A rule that is relaxed later (an
// exclusion removed) reopens a settled drop only through an explicit `review rejudge`, never at the next sighting.
test('[A] a settled company_excluded drop stays settled when the exclusion is removed and the same record is seen again', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const id = settledDrop(scan, db, 9, roleRecord(9), 'company_excluded');
  const before = reviewOf(db, id).updated_at;
  scan([roleRecord(9)], { policy: QUEUED_POLICY, now: at(1) });
  assert.deepEqual(outcome(db, id), ['done', 'dropped', 'company_excluded']);
  assert.equal(reviewOf(db, id).updated_at, before, 'no write reopens it');
});

// Decide once is about rule edits, not new posting evidence (review finding 1 follow-up): a system drop reopens with
// the stored authorization evidence_changed when the posting's own evidence changes.
test('[A] a dropped row reopens as due when its content gains a student signal', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const id = settledDrop(scan, db, 1, roleRecord(1, NO_SIGNAL), 'no_student_signal');
  scan([roleRecord(1, { ...NO_SIGNAL, description: LONG('Build pipelines. This is a paid internship.') })], { now: at(1) });
  assert.deepEqual([...outcome(db, id), reviewOf(db, id).lane], ['due', null, null, 'new']);
  assert.equal(reviewOf(db, id).next_due, at(1));
  assert.ok(JSON.parse(reviewOf(db, id).flags_json).includes('authorization:evidence_changed'), 'the authorization is stored');
  const logged = db.prepare("SELECT payload_json FROM review_log WHERE posting_id=? AND kind='outcome'").all(id).map((row) => JSON.parse(row.payload_json));
  assert.ok(logged.some((payload) => payload.authorization === 'evidence_changed' && payload.evidenceHash), 'and logged with its evidence hash');
});

// Decide once is about rule edits, not new posting evidence (review finding 1 follow-up): a system drop reopens with
// the stored authorization evidence_changed when the posting's own evidence changes.
test('[A] a signal in another source reopens a drop, and one source\'s bare listing does not close a student role', async () => {
  const { ingestBatch } = await ingest();
  const bare = (id) => roleRecord(id, { source: 'careerops', sourceId: `co-${id}`, ...NO_SIGNAL, description: '', completeness: { locations: 'partial', arrangement: 'unknown', description: 'none', employment_type: 'absent' } });
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const dropped = settledDrop(scan, db, 1, bare(1), 'no_student_signal', { source: 'careerops', partition: 'all' });
  assert.deepEqual(outcome(db, dropped), DROPPED);
  scan([roleRecord(1, { title: 'Senior Data Engineer Intern' })], { now: at(1) });
  assert.deepEqual([...outcome(db, dropped), reviewOf(db, dropped).lane], ['due', null, null, 'new'], 'an unchanged-source rule must not hide the new source');

  scan([roleRecord(2, { title: 'Senior Data Engineer Intern' })]);
  const open = postingOf(db, 2);
  const counts = scan([bare(2)], { source: 'careerops', partition: 'all', now: at(1) });
  assert.equal(counts.review, 1);
  assert.deepEqual(outcome(db, open), ['due', null, null]);
  scan([{ ...bare(2), description: 'Changed listing text.' }], { source: 'careerops', partition: 'all', now: at(2) });
  assert.deepEqual([...outcome(db, open), reviewOf(db, open).lane], ['due', null, null, 'new'], 'a change in the bare listing does not drop it either');
});

test('[A] a no-signal record never drops a posting with an application or one the user added by hand', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  queued(scan, [roleRecord(1, NO_SIGNAL), roleRecord(2, NO_SIGNAL)]);
  const linked = postingOf(db, 1);
  const manual = postingOf(db, 2);
  const app = seedApplication(db, { company: 'Example Corp', role: 'Senior Data Engineer', jobUrl: urlOf(1) });
  db.prepare('UPDATE postings SET application_id = ? WHERE id = ?').run(app.id, linked);
  db.prepare(`UPDATE reviews SET flags_json = '["manual"]' WHERE posting_id = ?`).run(manual);
  scan([roleRecord(1, { ...NO_SIGNAL, description: 'Changed.' }), roleRecord(2, { ...NO_SIGNAL, description: 'Changed.' })], { now: at(1) });
  assert.deepEqual(outcome(db, linked), ['due', null, null]);
  assert.deepEqual(outcome(db, manual), ['due', null, null]);
});

// Decide once is about rule edits, not new posting evidence (review finding 1 follow-up): a system drop reopens with
// the stored authorization evidence_changed when the posting's own evidence changes.
test('[A] a partial location list does not reopen outside_countries; a complete list that adds a US office does', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const known = { locations: 'complete', arrangement: 'known', description: 'full', employment_type: 'absent' };
  const overseas = roleRecord(1, { locations: ['Berlin, Germany'], remote: false, completeness: known });
  const id = settledDrop(scan, db, 1, overseas, 'outside_countries');
  assert.deepEqual(outcome(db, id), ['done', 'dropped', 'outside_countries']);
  scan([roleRecord(1, { source: 'careerops', sourceId: 'co-1', locations: [], completeness: { ...known, locations: 'partial', arrangement: 'unknown' } })], { source: 'careerops', partition: 'all', now: at(1) });
  assert.deepEqual(outcome(db, id), ['done', 'dropped', 'outside_countries']);
  scan([roleRecord(1, { locations: ['Berlin, Germany', 'Chicago, IL'], remote: false, completeness: known })], { now: at(2) });
  assert.deepEqual(outcome(db, id), ['due', null, null]);
});

// Changed on purpose 2026-11-05 (review finding 1, decide once): a settled drop is not reopened by a sighting;
// `review rejudge` is the explicit way back.
test('[A] a re-allowed company does not reopen a settled drop at its next sighting', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const excluded = roleRecord(1, { company: 'Excluded Example Co' });
  const id = settledDrop(scan, db, 1, excluded, 'company_excluded');
  assert.deepEqual(outcome(db, id), ['done', 'dropped', 'company_excluded']);
  scan([excluded], { now: at(1), policy: { ...SCREENING_POLICY, reallowedCompanies: ['Excluded Example Co'] } });
  assert.deepEqual(outcome(db, id), ['done', 'dropped', 'company_excluded']);
});

// Review finding 1 follow-up: an evidence reopen happens at most once per distinct evidence hash, and never for a
// user-owned row.
test('[A] an evidence reopen happens once per evidence hash and never for a user-owned row', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const gained = roleRecord(1, { ...NO_SIGNAL, description: LONG('Build pipelines. This is a paid internship.') });
  const id = settledDrop(scan, db, 1, roleRecord(1, NO_SIGNAL), 'no_student_signal');
  scan([gained], { now: at(1) });
  assert.deepEqual(outcome(db, id), ['due', null, null], 'fixture: the first evidence change reopens it');
  // The system settles it again (as a judge would); the source flips back and forth between the same two texts.
  db.prepare("UPDATE reviews SET state='done', decision='dropped', code='no_student_signal', next_due=NULL WHERE posting_id=?").run(id);
  scan([roleRecord(1, NO_SIGNAL)], { now: at(2) });
  scan([gained], { now: at(3) });
  assert.deepEqual(outcome(db, id), DROPPED, 'the same evidence hash does not reopen it a second time');

  const user = settledDrop(scan, db, 2, roleRecord(2, NO_SIGNAL), 'no_student_signal');
  const app = seedApplication(db, { company: 'Example Corp', role: 'Senior Data Engineer', jobUrl: urlOf(2), status: 'withdrawn', skipOwner: 'user', skipReason: 'not interested' });
  db.prepare('UPDATE postings SET application_id = ? WHERE id = ?').run(app.id, user);
  scan([roleRecord(2, { ...NO_SIGNAL, description: LONG('Build pipelines. This is a paid internship.') })], { now: at(1) });
  assert.equal(reviewOf(db, user).state, 'done', 'a user-owned row is never reopened by evidence');
  assert.notEqual(reviewOf(db, user).decision, 'eligible');
  const legacy = settledDrop(scan, db, 3, roleRecord(3, NO_SIGNAL), 'no_student_signal');
  const old = seedApplication(db, { company: 'Example Corp', role: 'Senior Data Engineer', jobUrl: urlOf(3), status: 'withdrawn', skipOwner: 'legacy', skipReason: 'skipped long ago' });
  db.prepare('UPDATE postings SET application_id = ? WHERE id = ?').run(old.id, legacy);
  scan([roleRecord(3, { ...NO_SIGNAL, description: LONG('Build pipelines. This is a paid internship.') })], { now: at(1) });
  assert.equal(reviewOf(db, legacy).state, 'done', 'a legacy (user) skip is never reopened by evidence');
  assert.equal(db.prepare('SELECT status FROM applications WHERE id = ?').get(app.id).status, 'withdrawn');
});

test('[A] renewal never overwrites a user decision', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  scan([1, 2, 3, 4, 5].map((n) => roleRecord(n)));
  const [logged, declined, legacy, settled, control] = [1, 2, 3, 4, 5].map((n) => postingOf(db, n));
  const settle = db.prepare(`UPDATE reviews SET state = 'done', decision = ?, code = ?, next_due = NULL WHERE posting_id = ?`);
  for (const id of [logged, settled]) settle.run('not_eligible', 'outside_area', id);
  settle.run('not_eligible', 'user_declined', declined);
  settle.run('eligible', null, legacy);
  db.prepare(`INSERT INTO review_log (posting_id, at, stage, kind, payload_json) VALUES (?, ?, 'deliver', 'user', '{}')`).run(logged, T0);
  const app = seedApplication(db, { company: 'Example Corp', role: 'Data Science Intern', jobUrl: urlOf(3), skipOwner: 'legacy' });
  db.prepare('UPDATE postings SET application_id = ? WHERE id = ?').run(app.id, legacy);

  scan([1, 2, 3, 4, 5].map((n) => roleRecord(n, { description: LONG('Rewritten summer 2027 internship.') })), { now: at(1) });
  assert.deepEqual(outcome(db, logged), ['done', 'not_eligible', 'outside_area'], 'review_log kind user');
  assert.deepEqual(outcome(db, declined), ['done', 'not_eligible', 'user_declined']);
  assert.deepEqual(outcome(db, legacy), ['done', 'eligible', null], 'legacy skip owner');
  // Changed on purpose 2026-11-05 (redesign A2, decide once): a settled automated verdict no longer renews on a content change.
  assert.deepEqual(outcome(db, settled), ['done', 'not_eligible', 'outside_area'], 'decide once: a settled automated verdict stays');
  assert.deepEqual([...outcome(db, control), reviewOf(db, control).next_due], ['due', null, null, at(1)], 'control: open work renews');
});

test('[A] a delisted drop waits while unlisted and reopens on relisting', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  scan([roleRecord(1)]);
  const id = postingOf(db, 1);
  scan([roleRecord(1, { listed: false })], { now: at(1) });
  assert.equal(reclassify(reclassifyReviews, db, { now: at(2) }).dropped.delisted, 1);
  assert.deepEqual([...outcome(db, id), reviewOf(db, id).next_due], ['done', 'dropped', 'delisted', null]);
  scan([roleRecord(1, { listed: false, description: LONG('Still closed internship.') })], { now: at(3) });
  assert.deepEqual(outcome(db, id), ['done', 'dropped', 'delisted'], 'a changed unlisted record stays closed');
  scan([roleRecord(1)], { now: at(4) });
  assert.deepEqual(outcome(db, id), ['due', null, null]);
  assert.equal(db.prepare('SELECT listed FROM postings WHERE id = ?').get(id).listed, 1);
});

// ===================================================================== no paid path

// Redesign B1 (decide once): settled negatives are no longer refreshed at all; only queued leads are.
test('[B] refresh leaves drops, judged exploration negatives and every other settled negative alone', async () => {
  const { scheduleRefresh } = await worker();
  const db = freshDb();
  const insert = (id, row) => { insertPosting(db, { id }); insertReview(db, { postingId: id, state: 'done', nextDue: null, ...row }); };
  for (const code of ['no_student_signal', 'out_of_direction', 'delisted', 'company_excluded', 'posting_excluded', 'outside_countries']) insert(`p-${code}`, { decision: 'dropped', code });
  insert('p-judged', { decision: 'not_eligible', code: 'no_student_signal', lane: 'no_student_signal' });
  insert('p-control', { decision: 'not_eligible', code: 'degree' });
  const { requeued } = scheduleRefresh(db, { now: at(30), policy: reviewInputs().policy });
  assert.equal(requeued, 0);
  assert.equal(reviewOf(db, 'p-control').state, 'done');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state = 'done'").get().n, 8);
});

test('[B] replan does not reopen a drop when judgment dependencies change', async () => {
  const { replan, inputState } = await worker();
  const db = freshDb();
  const inputs = reviewInputs();
  const stale = JSON.stringify({ inputs: { ...inputState(inputs), rules: 'older-rules' } });
  for (const [id, decision, code] of [['p-dropped', 'dropped', 'no_student_signal'], ['p-control', 'not_eligible', 'degree']]) {
    insertPosting(db, { id });
    insertReview(db, { postingId: id, state: 'done', nextDue: null, decision, code });
    db.prepare('UPDATE reviews SET dep_hashes_json = ? WHERE posting_id = ?').run(stale, id);
  }
  // Redesign B1: a settled not_eligible review is not re-queued either (only `review rejudge` reopens it).
  assert.equal(replan(db, { inputs, now: at(1) }).requeued, 0);
  assert.deepEqual(outcome(db, 'p-dropped'), DROPPED);
  assert.equal(reviewOf(db, 'p-control').state, 'done');
});

test('[B] redecide --done does not replay a drop', async () => {
  const { redecideReviews } = await redecideModule();
  const db = freshDb();
  const pages = { ...judgedPosting(db, 'p-dropped'), ...judgedPosting(db, 'p-control') };
  await review(db, { now: T0, runId: 'review-1', pages });
  assert.deepEqual(outcome(db, 'p-dropped'), ['done', 'eligible', null], 'fixture: a stored judgment to replay');
  db.prepare(`UPDATE reviews SET decision = 'dropped', code = 'no_student_signal' WHERE posting_id = 'p-dropped'`).run();
  const report = await redecideReviews(db, { inputs: reviewInputs(), judges: eligibleJudges(), held: true, done: true, now: at(1) });
  assert.equal(report.redecided, 1, JSON.stringify(report));
  assert.deepEqual(outcome(db, 'p-dropped'), DROPPED);
});

test('[B] a nightly run neither fetches nor judges a drop, and its backlog and report exclude it', async () => {
  const { ingestBatch } = await ingest();
  const { reviewReport } = await load('DNS', './src/review/report.mjs', ['reviewReport']);
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const id = settledDrop(scan, db, 1, roleRecord(1, NO_SIGNAL), 'no_student_signal');
  const judges = eligibleJudges();
  const fetcher = fakeFetcher({ [urlOf(1)]: page(urlOf(1), SNAPSHOTS.eligible) });
  const receipt = await review(db, { now: at(30), runId: 'review-30', judges, fetcher });
  assert.deepEqual(outcome(db, id), DROPPED);
  assert.equal(judges.primary.calls.length + judges.escalation.calls.length, 0);
  assert.equal(receipt.counts.fetched, 0);
  assert.equal(receipt.backlog.due, 0);
  assert.equal(receipt.backlog.no_student_signal.due, 0);
  assert.ok(!reviewReport(db, { receipt }).includes(urlOf(1).replace('https://', '')), 'a drop is not listed as pending');
});

test('[B] merging a drop into another posting neither reopens nor overwrites it', async () => {
  const { reconcileAliases } = await load('DNS', './src/funnel/identity.mjs', ['reconcileAliases']);
  const db = freshDb();
  const merge = (from, target, targetReview) => {
    insertPosting(db, { id: from });
    insertPosting(db, { id: target, aliases: [[`source:synthetic:${target}`, 'source']] });
    insertReview(db, { postingId: from, state: 'done', nextDue: null, decision: 'dropped', code: 'no_student_signal' });
    if (targetReview) insertReview(db, { postingId: target, firstSeen: at(-1), ...targetReview });
    db.prepare('UPDATE reviews SET updated_at = ? WHERE posting_id = ?').run(at(1), from);
    assert.equal(reconcileAliases(db, from, [{ alias: `source:synthetic:${target}`, kind: 'source' }], { now: at(1) }).action, 'bound');
  };
  merge('p-from-a', 'p-target-a', null);
  assert.deepEqual(outcome(db, 'p-target-a'), DROPPED, 'a target with no review inherits the drop, not a due review');
  merge('p-from-b', 'p-target-b', { state: 'done', nextDue: null, decision: 'not_eligible', code: 'degree' });
  assert.deepEqual(outcome(db, 'p-target-b'), ['done', 'not_eligible', 'degree']);
});

// ===================================================================== review reclassify

test('[B] reclassify settles due no-signal and out-of-direction rows and keeps student roles due', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  queued(scan, [roleRecord(1, NO_SIGNAL), roleRecord(2), roleRecord(3, { company: 'Excluded Example Co' })]);
  const ids = [1, 2, 3].map((n) => postingOf(db, n));
  db.prepare(`UPDATE reviews SET state = 'due', decision = NULL, code = NULL, next_due = ?, lane = 'no_student_signal' WHERE posting_id = ?`).run(T0, ids[2]);
  db.prepare(`UPDATE reviews SET lane = 'no_student_signal' WHERE posting_id = ?`).run(ids[0]);
  const logged = db.prepare('SELECT COUNT(*) n FROM review_log').get().n;

  const preview = reclassify(reclassifyReviews, db, { dryRun: true });
  assert.deepEqual(preview.dropped, { no_student_signal: 1, company_excluded: 1 });
  assert.equal(reviewOf(db, ids[0]).state, 'due', 'a dry run writes nothing');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM review_log').get().n, logged);

  const report = reclassify(reclassifyReviews, db);
  assert.deepEqual(report.dropped, preview.dropped);
  assert.deepEqual(report.kept, { new: 1 });
  assert.deepEqual(report.remainingDue, { new: 1 });
  assert.deepEqual([...outcome(db, ids[0]), reviewOf(db, ids[0]).lane, reviewOf(db, ids[0]).next_due, reviewOf(db, ids[0]).updated_at], [...DROPPED, 'no_student_signal', null, at(1)]);
  assert.deepEqual(outcome(db, ids[1]), ['due', null, null]);
  assert.deepEqual(outcome(db, ids[2]), ['done', 'dropped', 'company_excluded']);
  const log = db.prepare('SELECT * FROM review_log WHERE posting_id = ?').all(ids[0]);
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0].payload_json).action, 'reclassified');
});

test('[B] reclassify reads the latest sighting, not the newest stored observation (A, B, A)', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const intern = (id) => roleRecord(id, { title: 'Data Analyst Intern', description: '' });
  const plain = (id) => roleRecord(id, { title: 'Data Analyst', description: '' });
  for (const [day, make] of [[0, intern], [1, plain], [2, intern]]) queued(scan, [make(1)], { now: at(day) });
  for (const [day, make] of [[0, plain], [1, intern], [2, plain]]) queued(scan, [make(2)], { now: at(day) });
  const [student, generic] = [postingOf(db, 1), postingOf(db, 2)];
  const newest = db.prepare('SELECT fields_json FROM observations WHERE posting_id = ? ORDER BY observed_at DESC LIMIT 1');
  assert.equal(JSON.parse(newest.get(student).fields_json).title, 'Data Analyst', 'fixture: the newest stored observation is the stale one');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM observations WHERE posting_id = ?').get(student).n, 2, 'fixture: A is stored once');

  reclassify(reclassifyReviews, db, { now: at(3) });
  assert.deepEqual(outcome(db, student), ['due', null, null], 'a real internship is not dropped on stale content');
  assert.deepEqual(outcome(db, generic), DROPPED, 'and stale content does not save a no-signal role');
});

test('[B] reclassify calls a posting delisted only when every source shows it closed', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  queued(scan, [roleRecord(1, { source: 'careerops', sourceId: 'co-1' })], { source: 'careerops', partition: 'all' });
  queued(scan, [roleRecord(1, { listed: false })], { now: at(1) });
  const id = postingOf(db, 1);
  assert.equal(db.prepare('SELECT listed FROM postings WHERE id = ?').get(id).listed, 0, 'fixture: the last source ingested says closed');
  assert.deepEqual(reclassify(reclassifyReviews, db, { now: at(2) }).dropped, {});
  assert.deepEqual(outcome(db, id), ['due', null, null], 'another source still lists it');
});

test('[B] reclassify lets the most complete source decide but never drops a signal another source shows', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const bare = (id, overrides) => roleRecord(id, { source: 'careerops', sourceId: `co-${id}`, description: '', completeness: { locations: 'partial', arrangement: 'unknown', description: 'none', employment_type: 'absent' }, ...overrides });
  const overseas = { locations: ['Berlin, Germany'], remote: false, completeness: { locations: 'complete', arrangement: 'known', description: 'full', employment_type: 'absent' } };
  queued(scan, [roleRecord(1, NO_SIGNAL), roleRecord(2, { ...overseas, title: 'Data Science Intern' })], { profile: OPEN_PROFILE });
  queued(scan, [bare(1, { title: 'Senior Data Engineer Intern' }), bare(2, { title: 'Data Science Intern' })], { source: 'careerops', partition: 'all', now: at(1) });
  const [signal, outside] = [postingOf(db, 1), postingOf(db, 2)];
  db.prepare(`UPDATE reviews SET state = 'due', decision = NULL, code = NULL, next_due = ? WHERE posting_id IN (?, ?)`).run(T0, signal, outside);
  reclassify(reclassifyReviews, db, { now: at(2) });
  assert.deepEqual(outcome(db, signal), ['due', null, null], 'the sparse source carries the student signal');
  assert.deepEqual(outcome(db, outside), ['done', 'dropped', 'outside_countries'], 'the complete location list decides over a partial one');
});

test('[B] reclassify skips user decisions, user holds, applications, manual rows, judged stages and rows with no observation', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  queued(scan, [1, 2, 3, 4, 5, 6, 7].map((n) => roleRecord(n, NO_SIGNAL)));
  const [logged, declined, skipped, held, linked, manual, judge] = [1, 2, 3, 4, 5, 6, 7].map((n) => postingOf(db, n));
  db.prepare(`INSERT INTO review_log (posting_id, at, stage, kind, payload_json) VALUES (?, ?, 'deliver', 'user', '{}')`).run(logged, T0);
  db.prepare(`UPDATE reviews SET code = 'user_declined' WHERE posting_id = ?`).run(declined);
  const legacy = seedApplication(db, { company: 'Example Corp', role: 'Senior Data Engineer', jobUrl: urlOf(3), skipOwner: 'legacy' });
  const lead = seedApplication(db, { company: 'Example Corp', role: 'Senior Data Engineer II', jobUrl: urlOf(5) });
  db.prepare('UPDATE postings SET application_id = ? WHERE id = ?').run(legacy.id, skipped);
  db.prepare('UPDATE postings SET application_id = ? WHERE id = ?').run(lead.id, linked);
  db.prepare(`UPDATE reviews SET hold_owner = 'user', hold_since = ? WHERE posting_id = ?`).run(T0, held);
  db.prepare(`UPDATE reviews SET flags_json = '["manual"]' WHERE posting_id = ?`).run(manual);
  db.prepare(`UPDATE reviews SET stage = 'judge' WHERE posting_id = ?`).run(judge);
  insertPosting(db, { id: 'p-no-observation' });
  insertReview(db, { postingId: 'p-no-observation' });

  const report = reclassify(reclassifyReviews, db);
  assert.deepEqual(report.dropped, {});
  assert.deepEqual(report.skipped, { user_decided: 3, user_held: 1, application: 1, manual: 1, no_observation: 1 });
  assert.equal(report.scanned, 7);
  for (const id of [logged, declined, skipped, held, linked, manual, judge, 'p-no-observation']) assert.equal(reviewOf(db, id).state, 'due', id);
});

test('[B] reclassify re-checks ownership at commit: a decision made after the read wins', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  queued(scan, [roleRecord(1, NO_SIGNAL), roleRecord(2, NO_SIGNAL)]);
  const [late, open] = [postingOf(db, 1), postingOf(db, 2)];
  // A user decision lands between the batch's reads and its transaction.
  const batches = [];
  const racing = new Proxy(db, { get(target, name) {
    if (name === 'exec') return (sql) => {
      if (sql.startsWith('BEGIN') && !batches.length) {
        batches.push(sql);
        target.prepare(`INSERT INTO review_log (posting_id, at, stage, kind, payload_json) VALUES (?, ?, 'deliver', 'user', '{}')`).run(late, T0);
      }
      return target.exec(sql);
    };
    const value = target[name];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const report = reclassify(reclassifyReviews, racing);
  assert.equal(batches.length, 1);
  assert.deepEqual(report.skipped, { changed: 1 });
  assert.equal(reviewOf(db, late).state, 'due');
  assert.deepEqual(outcome(db, open), DROPPED);
});

test('[B] reclassify is resumable: an interrupted run keeps whole batches and a rerun finishes the rest once', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  queued(scan, [1, 2, 3, 4, 5].map((n) => roleRecord(n, NO_SIGNAL)));
  db.exec(`CREATE TEMP TRIGGER interrupt BEFORE INSERT ON review_log
    WHEN (SELECT COUNT(*) FROM review_log) >= 3 BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
  assert.throws(() => reclassify(reclassifyReviews, db, { batch: 2 }), /interrupted/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state = 'done'").get().n, 2, 'the finished batch stays; the broken one rolled back');
  db.exec('DROP TRIGGER interrupt');
  const report = reclassify(reclassifyReviews, db, { batch: 2 });
  assert.deepEqual(report.dropped, { no_student_signal: 3 });
  assert.equal(report.batches, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state = 'done'").get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM review_log').get().n, 5, 'each row is logged once');
  assert.deepEqual(reclassify(reclassifyReviews, db).dropped, {}, 'a further run finds nothing');
});

// ===================================================================== review of bdf5754 (R1-R5)

// Runs onBegin(target, n) before the n-th transaction the code under test opens (1-based).
const onTransaction = (db, onBegin) => {
  let n = 0;
  return new Proxy(db, { get(target, name) {
    if (name === 'exec') return (sql) => { if (/^BEGIN/.test(sql)) onBegin(target, n += 1); return target.exec(sql); };
    const value = target[name];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
};
const DIRECTION_RULES = () => load('DNS', './src/review/direction.mjs', ['directionRules']).then(({ directionRules }) => directionRules({ allow: ['computer vision', 'deep learning', 'MLOps', '\\bdata\\b'] }));

test('[A] R1 explicit program or employment-type phrases in the description are a student signal, plural forms included', async () => {
  const { classifyRole } = await classify();
  const options = { policy: SCREENING_POLICY, profile: PROFILE };
  for (const description of ['Employment type: internships', 'Employment type: Internship', 'This is a paid student placement.',
    'We offer industrial placements for undergraduates.', 'Co-ops welcome for the spring term.', 'Open to placement students.']) {
    assert.equal(classifyRole(record({ title: 'Analyst', description }), options).kind, 'review', description);
  }
  for (const description of ['We work with a job placement agency.', 'Product placement for retail partners.', 'Prior experience through internships is a plus.']) {
    assert.equal(classifyRole(record({ title: 'Analyst', description }), options).code, 'no_student_signal', description);
  }
});

test('[A] R2 a Simplify hardware-only title matching a role-direction allow pattern stays in review; pure software still drops', async () => {
  const { classifyRole } = await classify();
  const direction = await DIRECTION_RULES();
  const hardware = (title) => record({ source: 'simplify', title, categories: ['Hardware'], description: '', terms: ['Summer 2027'] });
  const options = { policy: { ...SCREENING_POLICY, direction }, profile: PROFILE };
  for (const title of ['Computer Vision Intern', 'Deep Learning Intern', 'MLOps Intern']) {
    assert.equal(classifyRole(hardware(title), options).kind, 'review', title);
    assert.equal(classifyRole(hardware(title), { policy: SCREENING_POLICY, profile: PROFILE }).code, 'out_of_direction', `${title}: without the rules`);
  }
  for (const title of ['Software Engineer Intern', 'Firmware Validation Intern']) assert.equal(classifyRole(hardware(title), options).code, 'out_of_direction', title);

  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  queued(scan, [roleRecord(1, { source: 'simplify', title: 'Computer Vision Intern', categories: ['Hardware'] }),
    roleRecord(2, { source: 'simplify', title: 'Software Engineer Intern', categories: ['Hardware'] })], { source: 'simplify', partition: 'simplify:1' });
  const report = reclassify(reclassifyReviews, db, { policy: { ...SCREENING_POLICY, direction } });
  assert.deepEqual(report.dropped, { out_of_direction: 1 });
  assert.deepEqual(outcome(db, postingOf(db, 1)), ['due', null, null]);
});

test('[A] R3 an older student-signal observation does not reopen a drop when every source now shows no signal', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  scan([roleRecord(1, { title: 'Data Analyst Intern', description: '' })]);
  const id = postingOf(db, 1);
  scan([roleRecord(1, { title: 'Data Analyst', description: '' })], { now: at(1) });
  assert.deepEqual(outcome(db, id), DROPPED, 'fixture: the greenhouse listing lost its signal');
  const bare = (description) => roleRecord(1, { source: 'careerops', sourceId: 'co-1', title: 'Data Analyst', description, completeness: { locations: 'partial', arrangement: 'unknown', description: 'none', employment_type: 'absent' } });
  scan([bare('')], { source: 'careerops', partition: 'all', now: at(2) });
  scan([bare('Changed.')], { source: 'careerops', partition: 'all', now: at(3) });
  assert.deepEqual(outcome(db, id), DROPPED, 'the stored Intern observation is not what greenhouse shows now');
  scan([roleRecord(1, { title: 'Data Analyst Intern', description: '' })], { now: at(4) });
  assert.deepEqual(outcome(db, id), ['due', null, null], 'control: a current signal reopens it');
});

test('[A] R4 ingest and reclassify follow a merge chain A to B to C and keep the internship a member shows', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const build = () => {
    const db = freshDb();
    const scan = scanner(ingestBatch, db);
    queued(scan, [roleRecord(1, { title: 'Data Analyst Intern', description: '' }), roleRecord(2, NO_SIGNAL), roleRecord(3, NO_SIGNAL)]);
    const [a, b, c] = [1, 2, 3].map((n) => postingOf(db, n));
    db.prepare('UPDATE postings SET merged_into = ? WHERE id = ?').run(b, a);
    db.prepare('UPDATE postings SET merged_into = ? WHERE id = ?').run(c, b);
    db.prepare(`UPDATE reviews SET state = 'done', decision = 'reused', code = 'bound', next_due = NULL WHERE posting_id IN (?, ?)`).run(a, b);
    return { db, scan, c };
  };
  {
    const { db, scan, c } = build();
    scan([roleRecord(3, { ...NO_SIGNAL, description: 'Changed.' })], { now: at(1) });
    assert.deepEqual(outcome(db, c), ['due', null, null], 'ingest: member A two merges away is a student role');
  }
  {
    const { db, c } = build();
    const report = reclassify(reclassifyReviews, db);
    assert.deepEqual(report.dropped, {}, JSON.stringify(report));
    assert.deepEqual(outcome(db, c), ['due', null, null], 'reclassify: member A two merges away is a student role');
  }
});

test('[B] R5 reclassify refuses to start during a scan or review run, and a batch that finds one rolls back', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  queued(scan, [roleRecord(1, NO_SIGNAL), roleRecord(2, NO_SIGNAL)]);
  const running = (target, runId, kind, heartbeat) => target.prepare(`INSERT INTO runs (run_id, kind, owner, started_at, heartbeat_at, status) VALUES (?, ?, 'other', ?, ?, 'running')`).run(runId, kind, heartbeat, heartbeat);
  running(db, 'scan-live', 'scan', at(1));
  assert.throws(() => reclassify(reclassifyReviews, db), /scan run is active/);
  assert.equal(reclassify(reclassifyReviews, db, { dryRun: true }).dropped.no_student_signal, 2, 'a dry run writes nothing and may run');
  db.prepare(`UPDATE runs SET heartbeat_at = ? WHERE run_id = 'scan-live'`).run(at(-1));
  assert.deepEqual(outcome(db, postingOf(db, 1)), ['due', null, null]);
  // A stale running row (a crashed scan) does not block; a review starting before the second batch aborts it.
  const racing = onTransaction(db, (target, n) => { if (n === 2) running(target, 'review-live', 'review', at(1)); });
  assert.throws(() => reclassify(reclassifyReviews, racing, { batch: 1 }), /review run is active/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state = 'done'").get().n, 1, 'the first batch stays, the second rolled back');
});

test('[B] R5 a sighting written between the read and the commit keeps the row due', async () => {
  const { ingestBatch } = await ingest();
  const { reclassifyReviews } = await reclassifyModule();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  queued(scan, [roleRecord(1, NO_SIGNAL), roleRecord(2, NO_SIGNAL)]);
  const [late, open] = [postingOf(db, 1), postingOf(db, 2)];
  const racing = onTransaction(db, (target, n) => {
    if (n !== 1) return;
    const { id } = target.prepare('SELECT id FROM observations WHERE posting_id = ?').get(late);
    target.prepare(`INSERT INTO observation_sightings (run_id, posting_id, observation_id, source, partition, seen_at) VALUES ('scan-late', ?, ?, 'careerops', 'all', ?)`).run(late, id, at(1));
  });
  const report = reclassify(reclassifyReviews, racing);
  assert.deepEqual(report.skipped, { changed: 1 });
  assert.equal(reviewOf(db, late).state, 'due', 'its updated_at did not change, its latest sighting did');
  assert.deepEqual(outcome(db, open), DROPPED);
});

// ===================================================================== review of f023e47 (R6-R7)

test('[A] R6 plural internships or co-ops that the posting offers are a student signal; past experience with them is not', async () => {
  const { classifyRole } = await classify();
  const options = { policy: SCREENING_POLICY, profile: PROFILE };
  for (const description of ['We offer summer internships to undergraduates.', 'Our engineering internships run twelve weeks.',
    'Join our co-ops this spring.', 'Paid internships are available in Chicago.', 'We are hiring analytics co-ops for the fall.']) {
    assert.equal(classifyRole(record({ title: 'Analyst', description }), options).kind, 'review', description);
  }
  for (const description of ['Relevant experience through internships or research.', 'Previous internships in analytics are a plus.',
    'Experience from summer internships is welcome.', 'Prior experience through internships or research projects is a plus.']) {
    assert.equal(classifyRole(record({ title: 'Analyst', description }), options).code, 'no_student_signal', description);
  }
});

test('[A] R7 history from a partition whose sightings were pruned keeps a due row in review but never reopens a drop', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const scan = scanner(ingestBatch, db);
  const bare = (description) => roleRecord(1, { source: 'careerops', sourceId: 'co-1', title: 'Data Analyst', description, completeness: { locations: 'partial', arrangement: 'unknown', description: 'none', employment_type: 'absent' } });
  scan([roleRecord(1, { title: 'Data Analyst Intern', description: '' })]);
  const id = postingOf(db, 1);
  scan([bare('')], { source: 'careerops', partition: 'all', now: at(1) });
  scan([roleRecord(1, { title: 'Data Analyst', description: '' })], { now: at(2) });
  assert.deepEqual(outcome(db, id), DROPPED, 'fixture: no current record has a signal');
  db.prepare("DELETE FROM observation_sightings WHERE source = 'greenhouse'").run(); // sighting retention
  assert.equal(db.prepare("SELECT COUNT(*) n FROM observations WHERE source = 'greenhouse' AND posting_id = ?").get(id).n, 2, 'fixture: the Intern observation is kept');
  scan([bare('Changed.')], { source: 'careerops', partition: 'all', now: at(3) });
  assert.deepEqual(outcome(db, id), DROPPED, 'an old Intern observation does not reopen it');
  db.prepare(`UPDATE reviews SET state = 'due', decision = NULL, code = NULL, next_due = ? WHERE posting_id = ?`).run(at(3), id);
  scan([bare('Changed again.')], { source: 'careerops', partition: 'all', now: at(4) });
  assert.deepEqual(outcome(db, id), ['due', null, null], 'control: a row already due stays in review');
});

test('[A] migration 009 creates the per-posting review_log and sighting indexes', async () => {
  const db = freshDb();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('review_log', 'observation_sightings')").all().map((row) => row.name);
  for (const name of ['review_log_posting_kind_idx', 'review_log_kind_idx', 'observation_sightings_posting_idx']) assert.ok(indexes.includes(name), name);
  const { migrate } = await import('../../src/storage/database.mjs');
  db.exec('DELETE FROM schema_migrations WHERE version = 9');
  assert.deepEqual(migrate(db).applied, [9], 'a data home that already has the indexes migrates as a no-op');
});

test('[A] review reclassify runs from the CLI with the scan policy and profile', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-reclassify-'));
  const { setup } = await import('../../src/commands/setup.mjs');
  const { openHomeDatabase } = await import('../../src/runtime/home.mjs');
  const { ingestBatch } = await ingest();
  const cli = async (...args) => {
    const io = memoryIO();
    const code = await runCli(['review', 'reclassify', '--home', home, ...args], io, createRuntime({ root: process.cwd() }));
    return { code, report: JSON.parse(io.stdout) };
  };
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    await writeReviewHome(home);
    await mkdir(path.join(home, '.career-journal', 'profile'), { recursive: true });
    await writeFile(path.join(home, '.career-journal', 'profile', 'profile.json'), JSON.stringify({ schemaVersion: 1, ...PROFILE, sources: { atsBoards: [] } }));
    const context = await openHomeDatabase(home);
    const scan = scanner(ingestBatch, context.db);
    queued(scan, [roleRecord(1, NO_SIGNAL), roleRecord(2), roleRecord(3, { company: 'Excluded Example Co' })], { policy: SCREENING_POLICY });
    queued(scan, [roleRecord(4, { source: 'simplify', title: 'Computer Vision Intern', categories: ['Hardware'] })], { source: 'simplify', partition: 'simplify:1' });
    context.db.close();
    await writeFile(path.join(home, '.career-journal', 'profile', 'role-direction.json'), JSON.stringify({ rule: 'synthetic', allow: ['computer vision'] }));
    const preview = await cli('--dry-run', '--json');
    assert.equal(preview.code, 0);
    assert.deepEqual(preview.report.dropped, { no_student_signal: 1 });
    assert.equal(preview.report.dryRun, true);
    const real = await cli('--batch', '1', '--json');
    assert.deepEqual(real.report.dropped, { no_student_signal: 1 });
    assert.equal(real.report.batches, 3);
    assert.deepEqual(real.report.remainingDue, { new: 2 }, 'the scan policy carries the role-direction allow patterns');
    const invalid = memoryIO();
    assert.notEqual(await runCli(['review', 'reclassify', '--home', home, '--batch', '0'], invalid, createRuntime({ root: process.cwd() })), 0);
    assert.match(invalid.stderr, /--batch requires a positive integer/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
