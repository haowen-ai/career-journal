// Same-title grouping (user, 2026-11-09): one posting published at many locations is judged once. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insertPosting, insertReview, reviewOf, seedApplication, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, judgment, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runReview } from '../../src/review/worker.mjs';
import { groupTitle, groupKey, groupWindowDays, groupTextSimilarity, normalizePostingText, sameRoleText, locationRule, groupVerdict, COPYABLE_CODES, LOCATION_CODES } from '../../src/review/grouping.mjs';
import { nightlySummary } from '../../src/review/summary.mjs';

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
const ANSWERS = { 'Analytics Intern': JUDGMENTS.undergradOnly, 'Data Science Intern': JUDGMENTS.eligible };
const judges = (answer = (request) => ({ output: Object.entries(ANSWERS).find(([title]) => request.prompt.includes(`${title}\n`))?.[1] ?? JUDGMENTS.undergradOnly })) =>
  ({ primary: fakeJudge({ tier: 'primary', answers: answer }), escalation: fakeJudge({ tier: 'escalation', answers: answer }) });
const judgedIds = (j) => new Set([...j.primary.calls, ...j.escalation.calls].map((call) => call.request.postingId));
// A member of a same-title group: the snapshot text of `base` relocated to `place`.
function add(db, pages, id, { base = SNAPSHOTS.undergradOnly, place = 'Chicago, IL', title, text, company = 'Example Corp', lane = 'new', stage = 'fetch' } = {}) {
  const body = text ?? base.replace('Chicago, IL', place);
  insertPosting(db, { id, url: urlOf(id), company, title: title ?? snapshotTitle(body) });
  insertReview(db, { postingId: id, stage, lane });
  pages[urlOf(id)] = page(urlOf(id), body, { locations: [place] });
}
const run = (db, pages, { j = judges(), policy = REVIEW_POLICY, now = T0, runId = 'review-group', budget = 50, maxFetches } = {}) => runReview({ db, runId, owner: 'worker-a',
  now, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {}, fetcher: fakeFetcher(pages), judges: j, concurrency: 4, ...(maxFetches ? { maxFetches } : {}),
  inputs: () => reviewInputs({ policy }), hooks: {} });

test('[G1] the group title drops trailing places and requisition ids, keeps role words and years', () => {
  assert.equal(groupTitle('Claims Representative Internship - Chicago, IL'), 'claims representative internship');
  assert.equal(groupTitle('Summer 2027 Safety Intern - Dallas, TX - R12345'), 'summer 2027 safety intern');
  assert.equal(groupTitle('Intern (Boise, ID)'), 'intern');
  assert.equal(groupTitle('Intern - New York, NY / Jersey City, NJ'), 'intern');
  assert.equal(groupTitle('Student Worker - REQ381198'), 'student worker');
  assert.equal(groupTitle('Business Analyst Intern | JR-12345'), 'business analyst intern');
  assert.equal(groupTitle('Data Science Intern - Remote US'), 'data science intern');
  assert.equal(groupTitle('Analyst - Boston', { locations: ['Boston, MA'] }), 'analyst');
  // Not a place: the suffix stays, so two roles do not merge.
  assert.equal(groupTitle('Analyst - Operations', { locations: ['Boston, MA'] }), 'analyst - operations');
  assert.equal(groupTitle('Software Engineer, Intern (Summer 2027)'), 'software engineer, intern (summer 2027)');
  assert.equal(groupTitle('Intern 2027'), 'intern 2027');
  assert.equal(groupKey('The Example Corp, Inc.', 'Intern - Austin, TX'), groupKey('Example Corp', 'INTERN'));
  assert.equal(groupKey('Example Corp', 'Intern'), 'example::intern');
  assert.equal(groupKey('', 'Intern'), null);
  assert.deepEqual([groupWindowDays({}), groupWindowDays({ grouping: { windowDays: 7 } }), groupWindowDays({ grouping: { windowDays: 0 } })], [30, 7, 0]);
  assert.throws(() => groupWindowDays({ grouping: { windowDays: -1 } }), /grouping.windowDays/);
  // grouping.textSimilarity is obsolete (identical text only): a policy that still sets it is refused.
  assert.equal(groupTextSimilarity({}), null);
  assert.throws(() => groupTextSimilarity({ grouping: { textSimilarity: 0.95 } }), /grouping.textSimilarity is no longer used/);
  assert.ok(!COPYABLE_CODES.some((code) => LOCATION_CODES.includes(code)));
});

test('[G2] the same role at another location matches only when the text is identical apart from its own places and requisition ids', () => {
  const chicago = { text: SNAPSHOTS.undergradOnly, places: ['Chicago, IL'], requisitions: ['R12345'] };
  const dallas = { text: `${SNAPSHOTS.undergradOnly.replace('Chicago, IL', 'Dallas, TX')}\nRequisition: R67890\n`, places: ['Dallas, TX'], requisitions: ['R67890'] };
  assert.ok(!/chicago|dallas|r67890/.test(normalizePostingText(dallas.text, { places: dallas.places, requisitions: dallas.requisitions })));
  // A bare place line is removed only with the posting's own places; "Location: …" header lines always go.
  assert.match(normalizePostingText('Analytics Intern\nDallas, TX\nBody.', { places: chicago.places }), /dallas, tx/, 'another posting\'s places are never removed');
  assert.doesNotMatch(normalizePostingText('Analytics Intern\nDallas, TX\nBody.', { places: dallas.places }), /dallas/);
  assert.equal(sameRoleText({ ...dallas, text: SNAPSHOTS.undergradOnly.replace('Chicago, IL', 'Dallas, TX') }, chicago).reason, 'identical');
  // Any other difference is text_differs, however small.
  const phd = { text: SNAPSHOTS.undergradOnly.replace("Be enrolled as a junior undergraduate student pursuing a Bachelor's degree.", 'PhD required.'), places: ['Chicago, IL'], requisitions: [] };
  const either = { text: SNAPSHOTS.undergradOnly.replace("Be enrolled as a junior undergraduate student pursuing a Bachelor's degree.", "Master's or PhD."), places: ['Chicago, IL'], requisitions: [] };
  assert.deepEqual(sameRoleText(phd, either), { same: false, reason: 'text_differs' });
  assert.deepEqual(sameRoleText(null, chicago), { same: false, reason: 'no_text' });
});

test('[G3] the location rule settles only clear places; it never guesses', () => {
  const policy = REVIEW_POLICY;
  assert.equal(locationRule({ locations: ['Dallas, TX'], policy }), 'outside');
  assert.equal(locationRule({ locations: ['Dallas, TX', 'Toronto, Ontario, Canada'], policy }), 'outside');
  assert.equal(locationRule({ locations: ['Dallas, TX', 'Chicago, IL'], policy }), null);
  assert.equal(locationRule({ locations: ['Remote - US'], policy }), null);
  assert.equal(locationRule({ locations: ['Springfield'], policy }), null);
  assert.equal(locationRule({ locations: [], policy }), null);
  assert.equal(locationRule({ locations: ['Chicago, IL'], policy, allowedPlaces: ['Chicago, IL'] }), 'inside');
  assert.equal(locationRule({ locations: ['Dallas, TX'], policy, company: 'Exempt Co', overrides: { locationExempt: { brands: ['Exempt Co'] } } }), null);
  // groupVerdict: outside_area is never copied; it may only settle a clearly-outside member.
  const text = { text: SNAPSHOTS.undergradOnly, places: ['Chicago, IL'], requisitions: [] };
  const source = { postingId: 's', decision: 'not_eligible', code: 'outside_area', evidence: {}, flags: [], title: 'Analytics Intern', company: 'Example Corp', judgedAt: T0 };
  const sourceText = () => text;
  assert.equal(groupVerdict({ sources: [source], locations: ['New York, NY'], text, sourceText, policy }), null);
  assert.equal(groupVerdict({ sources: [source], locations: ['Dallas, TX'], text, sourceText, policy })?.rule, 'location');
  assert.deepEqual(groupVerdict({ sources: [source], locations: ['Dallas, TX'], text: { ...text, text: 'Other role entirely different words here' }, sourceText, policy }), { mismatch: true, code: 'text_differs', from: source.postingId });
});

test('[G4] five same-title postings: one representative is judged, the others take its decision with a fetch but no model call', async () => {
  const db = freshDb();
  const pages = {};
  const places = ['Chicago, IL', 'Dallas, TX', 'New York, NY', 'Seattle, WA', 'Boise, ID'];
  places.forEach((place, index) => add(db, pages, `p-${index}`, { place, title: index === 4 ? `Analytics Intern - ${place}` : undefined }));
  const j = judges();
  const receipt = await run(db, pages, { j });
  assert.equal(judgedIds(j).size, 1, `one representative judged: ${[...judgedIds(j)]}`);
  assert.equal(receipt.counts.fetched, 5, 'every member page is fetched (HTTP only)');
  assert.deepEqual([receipt.counts.group_copied, receipt.counts.group_location_rule, receipt.counts.group_text_mismatch], [4, 0, 0]);
  assert.equal(receipt.counts.judged, 1);
  const representative = [...judgedIds(j)][0];
  for (let index = 0; index < 5; index += 1) {
    const row = reviewOf(db, `p-${index}`);
    assert.deepEqual([row.state, row.decision, row.code], ['done', 'not_eligible', 'degree'], `p-${index}`);
    const evidence = JSON.parse(row.evidence_json);
    if (`p-${index}` === representative) assert.equal(evidence.groupCopy, undefined);
    else {
      assert.equal(evidence.groupCopy.from, representative, `p-${index} names its source`);
      assert.equal(evidence.groupCopy.rule, 'copied');
      assert.ok(JSON.parse(row.flags_json).includes('group_copy'));
    }
  }
  assert.deepEqual([receipt.status, receipt.backlog.actionable_due], ['ok', 0]);
  // The summary line reports the copies.
  assert.match(nightlySummary(receipt, { lang: 'zh' }), /判定 1，合格 0，同岗复用 4（其中按地点规则 0；正文不同另判 0）/);
  assert.match(nightlySummary(receipt), /group copies 4 \(location rule 0; text differs, judged 0\)/);
  // A later run: the settled source is reused for a new member of the group.
  add(db, pages, 'p-5', { place: 'Austin, TX' });
  const j2 = judges();
  const second = await run(db, pages, { j: j2, runId: 'review-group-2' });
  assert.equal(judgedIds(j2).size, 0);
  assert.deepEqual([second.counts.group_copied, reviewOf(db, 'p-5').code], [1, 'degree']);
});

test('[G5] same title, different text: judged separately and counted as a text mismatch', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-a', { place: 'Chicago, IL' });
  add(db, pages, 'p-b', { place: 'Dallas, TX', text: SNAPSHOTS.undergradOnly.replace('Chicago, IL', 'Dallas, TX').replace("Be enrolled as a junior undergraduate student pursuing a Bachelor's degree.", 'PhD required in Statistics or a related field.') });
  const j = judges((request) => ({ output: /PhD required/.test(request.prompt) ? JUDGMENTS.missingFact : JUDGMENTS.undergradOnly }));
  const receipt = await run(db, pages, { j });
  assert.equal(judgedIds(j).size, 2, 'both requisitions are judged');
  assert.deepEqual([receipt.counts.group_copied, receipt.counts.group_text_mismatch], [0, 1]);
  assert.equal(JSON.parse(reviewOf(db, 'p-b').evidence_json).groupCopy, undefined);
  assert.match(nightlySummary(receipt), /text differs, judged 1/);
});

test('[G6] an outside_area decision is not copied: each location gets the location rule or its own judgment', async () => {
  const db = freshDb();
  const pages = {};
  // The representative's offices are outside the policy areas (Austin, TX): not_eligible outside_area.
  const outside = judgment({ alternatives: [{ term: { label: 'summer', year: 2027, quote: 'Join our analytics team for the summer of 2027' },
    offices: [{ place: 'Austin, TX', area: 'outside', quote: 'Location: Austin, TX' }], remote: { scope: 'none', quote: null } }] });
  add(db, pages, 'p-austin', { base: SNAPSHOTS.eligible, place: 'Austin, TX' });
  const j = judges(() => ({ output: outside }));
  await run(db, pages, { j });
  assert.deepEqual([reviewOf(db, 'p-austin').decision, reviewOf(db, 'p-austin').code], ['not_eligible', 'outside_area']);
  // Dallas is clearly outside: the location rule settles it, no model call. Chicago is in area: judged on its own.
  add(db, pages, 'p-dallas', { base: SNAPSHOTS.eligible, place: 'Dallas, TX' });
  add(db, pages, 'p-chicago', { base: SNAPSHOTS.eligible, place: 'Chicago, IL' });
  const j2 = judges(() => ({ output: JUDGMENTS.eligible }));
  const receipt = await run(db, pages, { j: j2, runId: 'review-group-2' });
  assert.deepEqual([...judgedIds(j2)], ['p-chicago']);
  const dallas = reviewOf(db, 'p-dallas');
  assert.deepEqual([dallas.state, dallas.decision, dallas.code, JSON.parse(dallas.evidence_json).groupCopy.rule], ['done', 'not_eligible', 'outside_area', 'location']);
  assert.deepEqual([reviewOf(db, 'p-chicago').decision, reviewOf(db, 'p-chicago').code], ['eligible', null]);
  assert.deepEqual([receipt.counts.group_copied, receipt.counts.group_location_rule], [1, 1]);
});

test('[G7] an eligible decision is copied only where the location passes, and then follows the delivery path to a lead', async () => {
  const db = freshDb();
  const pages = {};
  // Due order is first_seen, posting id: p-a-rep is the representative.
  add(db, pages, 'p-a-rep', { base: SNAPSHOTS.eligible, place: 'Chicago, IL' });
  add(db, pages, 'p-b-chicago', { base: SNAPSHOTS.eligible, place: 'Chicago, IL' });
  add(db, pages, 'p-c-dallas', { base: SNAPSHOTS.eligible, place: 'Dallas, TX' });
  add(db, pages, 'p-d-seattle', { base: SNAPSHOTS.eligible, place: 'Seattle, WA' });
  const j = judges(() => ({ output: JUDGMENTS.eligible }));
  const receipt = await run(db, pages, { j });
  assert.deepEqual([...judgedIds(j)].sort(), ['p-a-rep', 'p-d-seattle'], 'the representative and the in-area member whose city the source did not quote');
  const copied = reviewOf(db, 'p-b-chicago');
  assert.deepEqual([copied.decision, copied.code, JSON.parse(copied.evidence_json).groupCopy.rule], ['eligible', null, 'copied']);
  const app = db.prepare('SELECT a.status FROM postings p JOIN applications a ON a.id=p.application_id WHERE p.id=?').get('p-b-chicago');
  assert.equal(app?.status, 'lead', 'the copied eligible decision is delivered as a lead');
  assert.deepEqual([reviewOf(db, 'p-c-dallas').code, reviewOf(db, 'p-c-dallas').decision], ['outside_area', 'not_eligible']);
  // Seattle is judged on its own; the fake judgment quotes a Chicago office, so it is not eligible there.
  assert.equal(receipt.counts.eligible, 2);
  assert.deepEqual([receipt.counts.group_copied, receipt.counts.group_location_rule], [2, 1]);
});

test('[G8] a user action is never overwritten by a group copy', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-rep', { place: 'Chicago, IL' });
  add(db, pages, 'p-skipped', { place: 'Dallas, TX' });
  add(db, pages, 'p-user-hold', { place: 'Boise, ID', stage: 'judge' });
  // The user skipped this lead themselves (skip owner user, a user log entry): the review is the user's.
  const skipped = seedApplication(db, { company: 'Example Corp', role: 'Analytics Intern', status: 'lead', jobUrl: urlOf('p-skipped'), skipReason: 'not for me', skipOwner: 'user' });
  db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(skipped.id, 'p-skipped');
  db.prepare("INSERT INTO review_log(posting_id,at,stage,kind,payload_json) VALUES (?,?,'deliver','user','{}')").run('p-skipped', T0);
  db.prepare("UPDATE reviews SET state='held',hold_owner='user',hold_since=?,decision='unclear',code='user_review' WHERE posting_id=?").run(T0, 'p-user-hold');
  const j = judges();
  const receipt = await run(db, pages, { j });
  assert.deepEqual([...judgedIds(j)], ['p-rep']);
  assert.equal(receipt.counts.group_copied, 0);
  assert.deepEqual([reviewOf(db, 'p-skipped').state, reviewOf(db, 'p-skipped').decision], ['due', null], 'the user-skipped posting is left alone');
  const after = db.prepare('SELECT status,skip_owner FROM applications WHERE id=?').get(skipped.id);
  assert.deepEqual([after.status, after.skip_owner], ['lead', 'user']);
  const hold = reviewOf(db, 'p-user-hold');
  assert.deepEqual([hold.state, hold.hold_owner, hold.code], ['held', 'user', 'user_review']);
});

test('[G9] a source outside the configured window is not reused; windowDays 0 turns grouping off', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-old', { place: 'Chicago, IL' });
  db.prepare('UPDATE reviews SET next_due=?,first_seen=? WHERE posting_id=?').run(at(-10), at(-10), 'p-old');
  await run(db, pages, { now: at(-10), runId: 'review-old' });
  assert.equal(reviewOf(db, 'p-old').code, 'degree');
  add(db, pages, 'p-new', { place: 'Dallas, TX' });
  const narrow = judges();
  await run(db, pages, { j: narrow, runId: 'review-narrow', policy: { ...REVIEW_POLICY, grouping: { windowDays: 5 } } });
  assert.deepEqual([...judgedIds(narrow)], ['p-new'], 'a 10-day-old decision is outside a 5-day window');
  add(db, pages, 'p-newer', { place: 'Boise, ID' });
  const wide = judges();
  const receipt = await run(db, pages, { j: wide, runId: 'review-wide', policy: { ...REVIEW_POLICY, grouping: { windowDays: 30 } } });
  assert.equal(wide.primary.calls.length + wide.escalation.calls.length, 0);
  assert.deepEqual([receipt.counts.group_copied, reviewOf(db, 'p-newer').code], [1, 'degree']);
  add(db, pages, 'p-off', { place: 'Austin, TX' });
  const off = judges();
  const offReceipt = await run(db, pages, { j: off, runId: 'review-off', policy: { ...REVIEW_POLICY, grouping: { windowDays: 0 } } });
  assert.deepEqual([[...judgedIds(off)], offReceipt.counts.group_copied], [['p-off'], 0]);
  const bad = await run(db, pages, { runId: 'review-bad', policy: { ...REVIEW_POLICY, grouping: { windowDays: 'x' } } });
  assert.deepEqual([bad.status, bad.stop_reason], ['partial', 'invalid_config']);
});
