// Explicit maintenance commands (redesign B2, B6, B8, B12, B13). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, insertPosting, insertReview, reviewOf, seedApplication, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SCREENING_POLICY, PROFILE, SNAPSHOTS, JUDGMENTS, page, record, snapshotTitle, reviewInputs, writeReviewHome } from '../../test-utils/funnel-v3-fixtures.mjs';
import { ingestBatch } from '../../src/funnel/ingest.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { rejudgeReviews, settleBacklog, holdReview, reopenAuthorizationOf } from '../../src/review/backlog.mjs';
import { runReview } from '../../src/review/worker.mjs';
import { acquireRunLease, claimItem } from '../../src/review/lease.mjs';

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
function settled(db, id, { decision = 'not_eligible', code = 'outside_area', state = 'done', lane = 'new', company = 'Example Corp', evidence = {}, snapshot = true, firstSeen = T0 } = {}) {
  insertPosting(db, { id, url: urlOf(id), company, firstSeen });
  insertReview(db, { postingId: id, state, lane, decision, code, firstSeen, stage: 'deliver' });
  db.prepare('UPDATE reviews SET evidence_json=?,dep_hashes_json=? WHERE posting_id=?').run(JSON.stringify(evidence), JSON.stringify({ inputs: { rules: 'r1' }, invalidated: true }), id);
  if (snapshot) db.prepare(`INSERT INTO snapshots(id,posting_id,content_hash,fetched_at,final_url,http_status,method,identity_ok,fields_json,sections_json,text)
    VALUES (?,?,?,?,?,200,'html',1,'{}','[]',?)`).run(`s-${id}`, id, `h-${id}`, T0, urlOf(id), SNAPSHOTS.eligible);
}
const withApp = (db, id, status, extra = {}) => {
  const app = seedApplication(db, { company: 'Example Corp', role: `Role ${id}`, status, ...extra });
  db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, id);
  return app;
};

test('[B2] rejudge --code is a dry run by default, counts by code, and never touches user-owned or submitted rows', () => {
  const db = freshDb();
  settled(db, 'p-area');
  settled(db, 'p-area-2', { company: 'Other Example Co' });
  settled(db, 'p-degree', { code: 'degree' });
  settled(db, 'p-user'); withApp(db, 'p-user', 'withdrawn', { skipOwner: 'user', skipReason: 'not interested' });
  settled(db, 'p-applied'); withApp(db, 'p-applied', 'applied');
  settled(db, 'p-logged');
  db.prepare("INSERT INTO review_log(posting_id,at,stage,kind,payload_json) VALUES ('p-logged',?,'deliver','user','{}')").run(T0);
  const before = JSON.stringify(db.prepare('SELECT * FROM reviews ORDER BY posting_id').all());
  const dry = rejudgeReviews(db, { codes: ['outside_area'], now: at(1) });
  assert.deepEqual([dry.dryRun, dry.selected, dry.byCode, dry.skipped], [true, 2, { outside_area: 2 }, { user_owned: 3 }]);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM reviews ORDER BY posting_id').all()), before, 'a dry run writes nothing');
  const scoped = rejudgeReviews(db, { codes: ['outside_area'], company: 'other example co', now: at(1), apply: true });
  assert.equal(scoped.requeued, 1);
  const row = reviewOf(db, 'p-area-2');
  assert.deepEqual([row.state, row.stage], ['due', 'fetch']);
  assert.deepEqual(reopenAuthorizationOf(row), { authorization: 'rejudge', at: at(1), selector: 'code', fresh: true, codes: ['outside_area'], company: 'other example co' });
  assert.equal(row.dep_hashes_json, JSON.stringify({ inputs: { rules: 'r1' }, invalidated: true }), 'hashes untouched');
  assert.equal(reviewOf(db, 'p-area').state, 'done');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM review_log WHERE posting_id='p-area-2' AND kind='replan'").get().n, 1);
  assert.equal(rejudgeReviews(db, { codes: ['outside_area'], since: at(5), now: at(1) }).selected, 0, '--since filters by first sighting');
});

test('[B13] rejudge --posting takes explicit ids with the same protections; --leads selects current leads only', () => {
  const db = freshDb();
  settled(db, 'p-1'); settled(db, 'p-2', { decision: 'dropped', code: 'no_student_signal', snapshot: false });
  settled(db, 'p-user'); withApp(db, 'p-user', 'withdrawn', { skipOwner: 'user' });
  settled(db, 'p-lead', { decision: 'eligible', code: null }); withApp(db, 'p-lead', 'lead');
  settled(db, 'p-gone', { decision: 'eligible', code: null }); withApp(db, 'p-gone', 'withdrawn');
  const explicit = rejudgeReviews(db, { postings: ['p-1', 'p-2', 'p-user', 'p-missing'], now: at(1), apply: true });
  assert.deepEqual([explicit.selected, explicit.requeued, explicit.skipped], [2, 2, { unknown_posting: 1, user_owned: 1 }]);
  assert.equal(reviewOf(db, 'p-user').state, 'done');
  const leads = rejudgeReviews(db, { leads: true, now: at(1) });
  assert.deepEqual([leads.selected, leads.byCode], [1, { lead: 1 }]);
  assert.throws(() => rejudgeReviews(db, { now: at(1) }), /Usage/);
});

test('[B13b] rejudge --posting moves an open exploration-lane row to the normal lane; other open rows stay skipped', () => {
  const db = freshDb();
  insertPosting(db, { id: 'p-x' }); insertReview(db, { postingId: 'p-x', stage: 'judge' });
  db.prepare("UPDATE reviews SET lane='no_student_signal' WHERE posting_id='p-x'").run();
  insertPosting(db, { id: 'p-open' }); insertReview(db, { postingId: 'p-open', stage: 'judge' });
  const report = rejudgeReviews(db, { postings: ['p-x', 'p-open'], now: at(1), apply: true });
  assert.deepEqual([report.requeued, report.skipped], [1, { already_open: 1 }]);
  assert.deepEqual([reviewOf(db, 'p-x').state, reviewOf(db, 'p-x').lane], ['due', 'new']);
});

test('[B2] a rejudged review is judged afresh (cached judgments are not replayed) and the authorization is consumed', async () => {
  const db = freshDb();
  insertPosting(db, { id: 'p-r', url: urlOf('p-r'), title: snapshotTitle(SNAPSHOTS.undergradOnly) });
  insertReview(db, { postingId: 'p-r', stage: 'fetch' });
  const pages = { [urlOf('p-r')]: page(urlOf('p-r'), SNAPSHOTS.undergradOnly) };
  const judges = () => ({ primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.undergradOnly }) }), escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.undergradOnly }) }) });
  const run = (j, now, runId) => runReview({ db, runId, owner: 'w', now, budget: 20, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fakeFetcher(pages), judges: j, inputs: () => reviewInputs({ policy: REVIEW_POLICY }), hooks: {} });
  await run(judges(), T0, 'r1');
  assert.deepEqual([reviewOf(db, 'p-r').state, reviewOf(db, 'p-r').code], ['done', 'degree']);
  rejudgeReviews(db, { postings: ['p-r'], now: at(1), apply: true });
  const second = judges();
  await run(second, at(1), 'r2');
  assert.ok(second.primary.calls.length >= 1, 'same page and dependencies, yet a new judgment is made');
  assert.equal(reopenAuthorizationOf(reviewOf(db, 'p-r')), null, 'single-use');
  assert.equal(reviewOf(db, 'p-r').state, 'done');
});

// Review finding 2026-11-05: a rejudged exploration-lane row is explicit work. With exploration.share 0 it is
// still scheduled and judged, never left due behind an ok receipt.
test('[B2] a rejudged exploration-lane row is judged even when exploration is off', async () => {
  const db = freshDb();
  for (const lane of ['no_student_signal', 'out_of_direction']) {
    const id = `p-${lane}`;
    insertPosting(db, { id, url: urlOf(id), title: snapshotTitle(SNAPSHOTS.eligible) });
    insertReview(db, { postingId: id, state: 'done', lane, decision: 'dropped', code: lane, stage: 'deliver', nextDue: null });
  }
  const report = rejudgeReviews(db, { codes: ['no_student_signal', 'out_of_direction'], now: at(1), apply: true });
  assert.equal(report.requeued, 2);
  const pages = Object.fromEntries(['p-no_student_signal', 'p-out_of_direction'].map((id) => [urlOf(id), page(urlOf(id), SNAPSHOTS.eligible)]));
  const j = { primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) }), escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }) };
  const receipt = await runReview({ db, runId: 'r-explore-off', owner: 'w', now: at(1), budget: 20, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fakeFetcher(pages), judges: j, inputs: () => reviewInputs({ policy: { ...REVIEW_POLICY, exploration: { share: 0 } } }), hooks: {} });
  for (const id of ['p-no_student_signal', 'p-out_of_direction']) assert.notEqual(reviewOf(db, id).state, 'due', `${id} is judged`);
  assert.ok(j.primary.calls.length >= 2, 'both rows reach the judge');
  assert.equal(receipt.backlog.actionable_due, 0);
});

test('[B8] settle-backlog restores provable settlements, settles exploration rows to their drop, and leaves the rest due', () => {
  const db = freshDb();
  settled(db, 'p-prev', { state: 'due' });
  settled(db, 'p-nosnap', { state: 'due', snapshot: false });
  settled(db, 'p-super', { state: 'due', code: 'superseded_by_user' });
  settled(db, 'p-never', { state: 'due', decision: null, code: null });
  settled(db, 'p-lead', { state: 'due', decision: 'eligible', code: null }); withApp(db, 'p-lead', 'lead');
  settled(db, 'p-auth', { state: 'due', evidence: { reopenAuthorization: { authorization: 'rejudge', fresh: true } } });
  // An exploration-lane row: a posting the scan classifies as a drop, re-queued with its sampled judgment.
  // Changed at integration (redesign A1): an unknown certain drop is counted, not stored, so the posting is first
  // stored under a student title and its latest sighting then classifies as the drop.
  const scan = (title, runId, now) => ingestBatch(db, { runId, source: 'greenhouse', partition: 'greenhouse:examplecorp', now, policy: SCREENING_POLICY, profile: PROFILE,
    records: [record({ sourceId: '9100001', url: urlOf('9100001'), title, description: 'Ten years of accounting experience required. '.repeat(20) })] });
  scan('Accounting Intern', 'scan-0', T0);
  scan('Senior Staff Accountant', 'scan-1', at(0.5));
  const explore = db.prepare("SELECT posting_id FROM posting_aliases WHERE alias='source:greenhouse:9100001'").get().posting_id;
  db.prepare("UPDATE reviews SET state='due',decision='not_eligible',code='no_student_signal',lane='no_student_signal',evidence_json='{}' WHERE posting_id=?").run(explore);
  const hashes = reviewOf(db, 'p-prev').dep_hashes_json;
  const dry = settleBacklog(db, { policy: SCREENING_POLICY, profile: PROFILE, now: at(1) });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.settle, { previous_not_eligible: 1, exploration_drop: 1 });
  assert.deepEqual(dry.stay, { no_snapshot: 1, user_owned: 1, never_decided: 1, open_lead: 1, rejudge_authorized: 1 });
  assert.equal(reviewOf(db, 'p-prev').state, 'due', 'dry run writes nothing');
  const applied = settleBacklog(db, { policy: SCREENING_POLICY, profile: PROFILE, now: at(1), apply: true });
  assert.equal(applied.settled, 2);
  const prev = reviewOf(db, 'p-prev');
  assert.deepEqual([prev.state, prev.decision, prev.code, prev.dep_hashes_json], ['done', 'not_eligible', 'outside_area', hashes]);
  assert.deepEqual([reviewOf(db, explore).state, reviewOf(db, explore).decision], ['done', 'dropped']);
  for (const id of ['p-nosnap', 'p-super', 'p-never', 'p-lead', 'p-auth']) assert.equal(reviewOf(db, id).state, 'due', id);
});

test('[B12] review hold parks a sign-in wall as a system hold that no automatic pass reopens', async () => {
  const db = freshDb();
  settled(db, 'p-wall', { state: 'held', decision: 'unclear', code: 'browser_review' });
  const lead = withApp(db, 'p-wall', 'lead');
  const result = holdReview(db, { postingId: 'p-wall', code: 'external_signin_wall', reason: urlOf('p-wall'), now: at(1) });
  assert.deepEqual(result, { postingId: 'p-wall', state: 'held', code: 'external_signin_wall' });
  const row = reviewOf(db, 'p-wall');
  assert.deepEqual([row.decision, row.hold_owner], ['unclear', 'system']);
  assert.match(db.prepare('SELECT skip_reason FROM applications WHERE id=?').get(lead.id).skip_reason, /external_signin_wall/, 'hidden from the queue');
  assert.throws(() => holdReview(db, { postingId: 'p-wall', code: 'something_else', reason: 'x', now: at(1) }), /--code/);
  // A rule edit in the next run does not reopen it.
  await runReview({ db, runId: 'r-hold', owner: 'w', now: at(2), budget: 5, deadlineMs: 600_000, attemptDir: null, sleep: async () => {}, fetcher: fakeFetcher({}),
    judges: { primary: fakeJudge({ tier: 'primary' }), escalation: fakeJudge({ tier: 'escalation' }) },
    inputs: () => reviewInputs({ rules: { screening: 'edited', fit: 'edited' } }), hooks: {} });
  assert.deepEqual([reviewOf(db, 'p-wall').state, reviewOf(db, 'p-wall').code], ['held', 'external_signin_wall']);
});

test('[B6][B12] the CLI: attach refuses a posting leased by a live run, hold and rejudge work, and list --held prints JSON', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-lane-b-cli-'));
  try {
    const { setup } = await import('../../src/commands/setup.mjs');
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    await writeReviewHome(home);
    const { openHomeDatabase } = await import('../../src/runtime/home.mjs');
    const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
    const { runCli } = await import('../../src/cli/main.mjs');
    const runtime = createRuntime({ root: process.cwd(), version: 'test' });
    const cli = async (args) => { const io = memoryIO(); const code = await runCli([...args, '--home', home], io, runtime); return { code, out: io.stdout, err: io.stderr }; };
    const now = new Date().toISOString();
    const context = await openHomeDatabase(home);
    settled(context.db, 'p-busy', { state: 'due', decision: null, code: null });
    settled(context.db, 'p-wall', { state: 'held', decision: 'unclear', code: 'browser_review' });
    settled(context.db, 'p-old');
    acquireRunLease(context.db, { kind: 'review', owner: 'live-owner', runId: 'review-live', now });
    claimItem(context.db, 'p-busy', { owner: 'live-owner', now });
    context.db.close();
    const file = path.join(home, 'page.txt');
    await writeFile(file, SNAPSHOTS.eligible);
    const attached = await cli(['review', 'attach', '--posting', 'p-busy', '--file', file]);
    assert.equal(attached.code, 75, attached.out + attached.err);
    assert.match(attached.out, /busy/);
    const held = await cli(['review', 'hold', '--posting', 'p-wall', '--code', 'external_signin_wall', '--reason', urlOf('p-wall')]);
    assert.equal(held.code, 0, held.out + held.err);
    const list = await cli(['review', 'list', '--held', '--json']);
    const rows = JSON.parse(list.out);
    assert.deepEqual(rows.map((row) => [row.posting_id, row.code, row.company, row.url]), [['p-wall', 'external_signin_wall', 'Example Corp', urlOf('p-wall')]]);
    assert.ok('title' in rows[0]);
    const dry = await cli(['review', 'rejudge', '--code', 'outside_area']);
    assert.equal(dry.code, 0, dry.out + dry.err);
    assert.equal(JSON.parse(dry.out).selected, 1);
    const blocked = await cli(['review', 'rejudge', '--code', 'outside_area', '--apply']);
    assert.equal(blocked.code, 75, 'a live run blocks --apply');
  } finally { await rm(home, { recursive: true, force: true }); }
});

// Review finding 2026-11-05 (goal 5): no quantity or time caps on a normal review run. The attempt, fetch and
// stage-deadline limits are optional; omitted (or 0) means unbounded, so `review run` finishes every due review.
// An explicit value is still kept.
test('[B] review run without attempt, fetch or deadline limits finishes every due review; an explicit limit is kept', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-lane-b-uncapped-'));
  try {
    const { setup } = await import('../../src/commands/setup.mjs');
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const { attempts: _a, fetches: _f, deadlineMin: _d, ...rest } = REVIEW_POLICY.budgets;
    await writeReviewHome(home, { policy: { ...REVIEW_POLICY, budgets: rest } });
    await writeFile(path.join(home, '.career-journal', 'profile', 'company-size.json'), JSON.stringify({ rule: 'synthetic', large: ['Example Corp'] }));
    const { openHomeDatabase } = await import('../../src/runtime/home.mjs');
    const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
    const { runCli } = await import('../../src/cli/main.mjs');
    const ids = ['p-u1', 'p-u2', 'p-u3', 'p-u4'];
    const pages = Object.fromEntries(ids.map((id) => [urlOf(id), page(urlOf(id), SNAPSHOTS.eligible)]));
    const context = await openHomeDatabase(home);
    for (const id of ids) { insertPosting(context.db, { id, url: urlOf(id), title: snapshotTitle(SNAPSHOTS.eligible) }); insertReview(context.db, { postingId: id, stage: 'fetch' }); }
    const due = () => context.db.prepare("SELECT COUNT(*) n FROM reviews WHERE state='due'").get().n;
    const judges = () => ({ primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) }), escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }) });
    let n = 0;
    const cli = async (args) => {
      const io = memoryIO();
      const code = await runCli(['review', 'run', '--home', home, '--run-id', `review-uncapped-${n += 1}`, ...args], io,
        { ...createRuntime({ root: process.cwd(), version: 'test' }), now: () => at(n), review: { judges: judges(), fetcher: fakeFetcher(pages) } });
      return { code, receipt: JSON.parse(io.stdout || '{}'), err: io.stderr };
    };
    const capped = await cli(['--budget', '2']);
    assert.deepEqual([capped.receipt.status, capped.receipt.stop_reason, due()], ['partial', 'budget', 2], `an explicit budget is kept: ${capped.err}`);
    const open = await cli([]);
    assert.equal(open.code, 0, open.err);
    assert.deepEqual([open.receipt.status, open.receipt.stop_reason, due()], ['ok', null, 0], 'omitted limits: every due review is finished');
    context.db.close();
    await writeReviewHome(home, { policy: { ...REVIEW_POLICY, budgets: { ...REVIEW_POLICY.budgets, attempts: 0, fetches: 0, deadlineMin: 0 } } });
    const reopened = await openHomeDatabase(home);
    insertPosting(reopened.db, { id: 'p-u5', url: urlOf('p-u5'), title: snapshotTitle(SNAPSHOTS.eligible) }); insertReview(reopened.db, { postingId: 'p-u5', stage: 'fetch' });
    reopened.db.close();
    pages[urlOf('p-u5')] = page(urlOf('p-u5'), SNAPSHOTS.eligible);
    const zero = await cli(['--budget', '0', '--max-fetches', '0', '--deadline-min', '0']);
    assert.deepEqual([zero.code, zero.receipt.status, zero.receipt.counts?.judged], [0, 'ok', 1], `0 means unbounded: ${zero.err}`);
  } finally { await rm(home, { recursive: true, force: true }); }
});
