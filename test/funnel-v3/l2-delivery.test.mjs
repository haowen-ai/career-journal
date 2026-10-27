// Lane L2 — R4 delivery for every verdict, user precedence, company rules, mail (spec section 6.4; review-v3 F4, §5.2; plan 7.1 #11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, seedApplication, seedCheckerWithdrawal, insertPosting, insertReview, application, applicationsCount, reviewOf, eventsOf, T0, at } from '../../test-utils/funnel-v3.mjs';
import { SCREENING_POLICY } from '../../test-utils/funnel-v3-fixtures.mjs';
import { verifyQueuedRole } from '../../src/commands/queue.mjs';

const modules = async () => ({
  ...(await load('L2', './src/review/deliver.mjs', ['deliver', 'annotateMail', 'unhide'])),
  ...(await load('L2', './src/review/lease.mjs', ['claimItem'])),
});

const ELIGIBLE = { decision: 'eligible', code: null, fit: { level: 'medium', note: 'SQL and Python match' }, deadline: { kind: 'none' }, location: { offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' }], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' } };
const UNCLEAR = { decision: 'unclear', code: 'user_review', question: 'Is the junior-standing bullet mandatory?', nextAction: 'user_review' };
const NOT_ELIGIBLE = { decision: 'not_eligible', code: 'requirement_conflict', evidence: [{ confirmed: true, section: 'required', clause: 'Be enrolled as a junior undergraduate student.', factIds: ['degree'] }] };

function posting(db, { id = 'p-1', company = 'Example Corp', applicationId = null, aliases = [] } = {}) {
  insertPosting(db, { id, company, applicationId, aliases });
  insertReview(db, { postingId: id, stage: 'deliver' });
  return id;
}

async function deliverAs(db, postingId, verdict, now = T0) {
  const { deliver, claimItem } = await modules();
  const fence = claimItem(db, postingId, { owner: 'worker-a', now });
  return deliver(db, { postingId, verdict, fence, now, policy: SCREENING_POLICY });
}

test('[L2] eligible with no application creates one visible lead and closes the review in the same transaction', async () => {
  const db = freshDb();
  const id = posting(db);
  const result = await deliverAs(db, id, ELIGIBLE);
  assert.equal(result.action, 'created');
  const app = application(db, result.applicationId);
  assert.equal(app.status, 'lead');
  assert.equal(app.skip_reason, null);
  assert.equal(app.external_id, `posting:${id}`);
  assert.equal(app.fit, 'medium');
  assert.equal(db.prepare('SELECT application_id FROM postings WHERE id = ?').get(id).application_id, app.id);
  assert.equal(reviewOf(db, id).state, 'done');
  assert.equal(reviewOf(db, id).decision, 'eligible');
  assert.ok(eventsOf(db, app.id).some((event) => event.type === 'review_delivered'));
});

test('[L2] a visible lead goes hidden → withdrawn → restored as verdicts change, with one application and full history', async () => {
  const db = freshDb();
  const lead = seedApplication(db, { company: 'Example Corp', role: 'Data Intern' });
  const id = posting(db, { applicationId: lead.id });
  const before = applicationsCount(db);

  assert.equal((await deliverAs(db, id, UNCLEAR)).action, 'hidden');
  let app = application(db, lead.id);
  assert.equal(app.status, 'lead');
  assert.match(app.skip_reason, /^待核/);
  assert.equal(app.skip_owner, 'review');

  db.prepare("UPDATE reviews SET state='due', stage='deliver' WHERE posting_id = ?").run(id);
  assert.equal((await deliverAs(db, id, NOT_ELIGIBLE, at(1))).action, 'withdrawn');
  app = application(db, lead.id);
  assert.equal(app.status, 'withdrawn');
  const withdrawal = eventsOf(db, lead.id).find((event) => event.type === 'review_withdrawn');
  assert.equal(withdrawal.source.actor, 'review-worker');

  db.prepare("UPDATE reviews SET state='due', stage='deliver' WHERE posting_id = ?").run(id);
  assert.equal((await deliverAs(db, id, ELIGIBLE, at(2))).action, 'restored');
  app = application(db, lead.id);
  assert.equal(app.status, 'lead');
  assert.equal(app.skip_reason, null);
  assert.equal(applicationsCount(db), before);
  const types = eventsOf(db, lead.id).map((event) => event.type);
  assert.ok(types.includes('review_withdrawn') && types.includes('review_restored'), types.join(','));
});

test('[L2] closed and unavailable verdicts change visibility of an existing lead', async () => {
  const db = freshDb();
  const a = seedApplication(db, { company: 'Example Corp', role: 'Closed Intern' });
  const b = seedApplication(db, { company: 'Example Corp', role: 'Gone Intern' });
  const closedId = posting(db, { id: 'p-closed', applicationId: a.id });
  const goneId = posting(db, { id: 'p-gone', applicationId: b.id });
  assert.equal((await deliverAs(db, closedId, { decision: 'not_eligible', code: 'closed_verified' })).action, 'withdrawn');
  assert.equal((await deliverAs(db, goneId, { decision: 'unclear', code: 'unavailable', nextAction: 'recheck' })).action, 'hidden');
  assert.equal(application(db, a.id).status, 'withdrawn');
  assert.equal(application(db, b.id).status, 'lead');
  assert.notEqual(application(db, b.id).skip_reason, null);
});

test('[L2] the guarded restore never reopens a user decline', async () => {
  const db = freshDb();
  const lead = seedApplication(db, { company: 'Example Corp', role: 'Ops Intern' });
  verifyQueuedRole(db, { id: lead.id, result: 'skip', reason: 'not for me' }, '2026-10-20T00:00:00.000Z');
  const id = posting(db, { applicationId: lead.id });
  const result = await deliverAs(db, id, ELIGIBLE);
  assert.equal(result.action, 'superseded_by_user');
  assert.equal(application(db, lead.id).status, 'withdrawn');
});

test('[L2] restore of a pre-release checker withdrawal is allowed only for registry-classified automated provenance', async () => {
  const db = freshDb();
  const auto = seedCheckerWithdrawal(db, { company: 'Example Corp', role: 'Auto Intern', jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/1', note: 'AUTO-CHECK low fit: gaps' });
  const id = posting(db, { applicationId: auto.id });
  db.prepare("UPDATE reviews SET evidence_json = ? WHERE posting_id = ?").run(JSON.stringify({ provenance: 'automated' }), id);
  assert.equal((await deliverAs(db, id, ELIGIBLE)).action, 'restored');
  assert.equal(application(db, auto.id).status, 'lead');
});

test('[L2] user- and legacy-owned hides are never overridden by the worker', async () => {
  const db = freshDb();
  const user = seedApplication(db, { company: 'Example Corp', role: 'Held By User', skipReason: 'waiting for referral', skipOwner: 'user' });
  const legacy = seedApplication(db, { company: 'Example Corp', role: 'Held Legacy', skipReason: 'old note', skipOwner: 'legacy' });
  for (const [app, id] of [[user, 'p-u'], [legacy, 'p-l']]) {
    posting(db, { id, applicationId: app.id });
    assert.equal((await deliverAs(db, id, ELIGIBLE)).action, 'superseded_by_user');
    assert.notEqual(application(db, app.id).skip_reason, null);
  }
});

test('[L2] prepared applications are never withdrawn by a negative verdict', async () => {
  const db = freshDb();
  const prepared = seedApplication(db, { company: 'Example Corp', role: 'Prepared Intern', status: 'prepared' });
  const id = posting(db, { applicationId: prepared.id });
  await deliverAs(db, id, NOT_ELIGIBLE);
  assert.equal(application(db, prepared.id).status, 'prepared');
});

test('[L2] a submission made while the item was being judged wins; R4 rereads current status', async () => {
  const { deliver, claimItem } = await modules();
  const db = freshDb();
  const lead = seedApplication(db, { company: 'Example Corp', role: 'Race Intern' });
  const id = posting(db, { applicationId: lead.id });
  const fence = claimItem(db, id, { owner: 'worker-a', now: T0 });
  db.prepare("INSERT INTO application_events (id, application_id, event_type, observed_at, recorded_at, title, note, source_json, status_after, content_hash) VALUES ('user-submit', ?, 'submitted', ?, ?, 'Submitted', '', '{\"actor\":\"user\"}', 'applied', 'h')").run(lead.id, at(0.01), at(0.01));
  db.prepare("UPDATE applications SET status='applied', applied_at=? WHERE id=?").run(at(0.01), lead.id);
  const result = deliver(db, { postingId: id, verdict: NOT_ELIGIBLE, fence, now: at(0.02), policy: SCREENING_POLICY });
  assert.equal(result.action, 'superseded_by_user');
  assert.equal(application(db, lead.id).status, 'applied');
});

test('[L2] an excluded company never gets a lead', async () => {
  const db = freshDb();
  const id = posting(db, { company: 'Excluded Example Co' });
  await deliverAs(db, id, ELIGIBLE);
  assert.equal(applicationsCount(db), 0);
  assert.equal(reviewOf(db, id).code, 'company_excluded');
});

test('[L2] quota rules: full → hold with recheck at window end; reconciliation → hold not released by time; recount → lead with note; program scope without evidence → quota_unclear', async () => {
  const { recheckHolds } = await load('L2', './src/review/freshness.mjs', ['recheckHolds']);
  const db = freshDb();
  const full = posting(db, { id: 'p-full', company: 'Quota Full Example' });
  const recon = posting(db, { id: 'p-recon', company: 'Recount Example' });
  const recount = posting(db, { id: 'p-recount', company: 'Count Again Example' });
  const program = posting(db, { id: 'p-program', company: 'Program Example' });
  const programMatch = posting(db, { id: 'p-program-match', company: 'Program Match Example' });
  const programOther = posting(db, { id: 'p-program-other', company: 'Program Match Example' });
  await deliverAs(db, full, ELIGIBLE);
  await deliverAs(db, recon, ELIGIBLE);
  const recountResult = await deliverAs(db, recount, ELIGIBLE);
  await deliverAs(db, program, ELIGIBLE);
  await deliverAs(db, programMatch, { ...ELIGIBLE, program: { name: '2027 internship USA/Canada', countryScope: 'USA/Canada', quote: 'Our 2027 internship USA/Canada program' } });
  const otherResult = await deliverAs(db, programOther, { ...ELIGIBLE, program: { name: '2027 Early Insight Week', countryScope: 'UK', quote: 'the 2027 Early Insight Week in the UK' } });
  assert.deepEqual([reviewOf(db, programMatch).state, reviewOf(db, programMatch).code], ['held', 'quota_full'], 'a verdict naming the ruled program is held');
  assert.equal(application(db, otherResult.applicationId).skip_reason, null, 'a different program at the same company is a visible lead');
  assert.deepEqual([reviewOf(db, full).state, reviewOf(db, full).code], ['held', 'quota_full']);
  assert.equal(reviewOf(db, full).next_due, '2026-12-01T00:00:00Z');
  assert.deepEqual([reviewOf(db, recon).state, reviewOf(db, recon).code], ['held', 'quota_reconciliation']);
  assert.equal(application(db, recountResult.applicationId).skip_reason, null);
  assert.match(application(db, recountResult.applicationId).fit_note ?? '', /recount/i);
  assert.deepEqual([reviewOf(db, program).state, reviewOf(db, program).code], ['held', 'quota_unclear']);
  for (const id of [full, recon, program]) {
    const app = db.prepare('SELECT a.skip_reason FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(id);
    assert.ok(app?.skip_reason, `${id} is a hidden lead the dashboard can show`);
  }
  recheckHolds(db, { now: '2027-03-01T00:00:00Z', screeningPolicy: SCREENING_POLICY });
  assert.equal(reviewOf(db, recon).state, 'held', 'reconciliation is never released by window expiry');
  assert.equal(reviewOf(db, full).state, 'due', 'quota_full is rechecked at window end');
});

test('[L2] mail: exact requisition confirmation hides reversibly; company-only mail is a note and the lead stays visible', async () => {
  const { annotateMail, unhide } = await modules();
  const { matchMailHits } = await load('L2', './src/review/mail.mjs', ['matchMailHits']);
  const db = freshDb();
  const exact = posting(db, { id: 'p-mail-exact', aliases: [['company_req:examplecorp:R5001', 'company_req']] });
  const company = posting(db, { id: 'p-mail-company' });
  const a = await deliverAs(db, exact, ELIGIBLE);
  const b = await deliverAs(db, company, ELIGIBLE);
  const hit = (overrides) => ({ messageId: '<m@example.com>', receivedAt: '2026-11-02T03:00:00.000+00:00', sender: 'careers@examplecorp.example', subject: '', mailbox: 'INBOX', excerpt: '', searchedTerm: 'Example Corp', ...overrides });
  const [exactMatch, companyMatch] = matchMailHits(db, [
    hit({ messageId: '<m1@example.com>', subject: 'Application received R5001', excerpt: 'Thank you for applying to Example Corp (requisition R5001).' }),
    hit({ messageId: '<m2@example.com>', subject: 'Thanks for applying', excerpt: 'Thank you for your interest in Example Corp.' }),
  ], { now: T0 });
  assert.deepEqual([exactMatch.match, exactMatch.postingId, exactMatch.token], ['exact', exact, 'R5001']);
  assert.equal(companyMatch.match, 'company');
  annotateMail(db, { postingId: exactMatch.postingId, match: exactMatch.match, messageId: '<m1@example.com>', subject: 'Application received R5001', received: T0, matched: exactMatch.token, now: T0 });
  annotateMail(db, { postingId: company, match: companyMatch.match, messageId: '<m2@example.com>', subject: 'Thanks for applying', received: T0, matched: 'Example Corp', now: T0 });
  assert.match(application(db, a.applicationId).skip_reason, /already_applied_mail|邮件/);
  assert.equal(application(db, b.applicationId).skip_reason, null);
  assert.ok(eventsOf(db, b.applicationId).some((event) => event.type === 'mail_note'));
  unhide(db, { postingId: exact, now: at(1) });
  assert.equal(application(db, a.applicationId).skip_reason, null);
});

test('[L2] queue verify on a held item closes its review as a user decision', async () => {
  const db = freshDb();
  const id = posting(db);
  const result = await deliverAs(db, id, UNCLEAR);
  verifyQueuedRole(db, { id: result.applicationId, result: 'ok', reason: 'checked the posting myself' }, at(1));
  const review = reviewOf(db, id);
  assert.equal(review.state, 'done');
  assert.equal(review.decision, 'eligible');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM review_log WHERE posting_id = ? AND kind = 'user'").get(id).n, 1);
});
