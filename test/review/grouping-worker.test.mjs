// Same-title grouping in the review worker (user, 2026-11-09), worker-level cases: representative first, copy only
// for the same role text, location codes never copied, user actions kept, window. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insertPosting, insertReview, reviewOf, seedApplication, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, SUMMER_CHICAGO, judgment, page, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runReview, inputState } from '../../src/review/worker.mjs';
import { sameRoleText } from '../../src/review/grouping.mjs';
import { nightlySummary } from '../../src/review/summary.mjs';

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
const at$ = (text, place) => text.replaceAll('Chicago, IL', place);

function add(db, pages, id, { text, place, title = 'Analytics Intern', company = 'Example Corp', stage = 'fetch', state = 'due', holdOwner = null, decision = null, code = null } = {}) {
  insertPosting(db, { id, url: urlOf(id), company, title });
  insertReview(db, { postingId: id, stage, state, holdOwner, decision, code });
  pages[urlOf(id)] = page(urlOf(id), at$(text, place), { locations: [place] });
}
const judges = (answer) => ({ primary: fakeJudge({ tier: 'primary', answers: answer }), escalation: fakeJudge({ tier: 'escalation', answers: answer }) });
const calledFor = (j) => [...new Set([...j.primary.calls, ...j.escalation.calls].map((call) => call.request.postingId))].sort();
const run = (db, pages, { j, policy = REVIEW_POLICY, now = T0, concurrency = 4, fetcher = fakeFetcher(pages) }) => runReview({ db, runId: `review-gw-${now}`, owner: 'worker-g',
  now, budget: 60, concurrency, deadlineMs: 600_000, attemptDir: null, sleep: async () => {}, fetcher, judges: j,
  inputs: () => reviewInputs({ policy }), hooks: {} });
const flags = (db, id) => JSON.parse(reviewOf(db, id).flags_json);
const groupCopy = (db, id) => JSON.parse(reviewOf(db, id).evidence_json).groupCopy;

test('[GW1] identity check: each text uses only its own places and req ids, and only whole location lines are removed', () => {
  // A hard skill change.
  const python = { text: SNAPSHOTS.eligible, places: ['Chicago, IL'], requisitions: [] };
  const scala = { text: SNAPSHOTS.eligible.replace('Chicago, IL', 'Dallas, TX').replace('Proficiency in Python or R for data analysis.', 'Proficiency in Scala for data analysis.'), places: ['Dallas, TX'], requisitions: [] };
  assert.deepEqual(sameRoleText(scala, python), { same: false, reason: 'text_differs' });
  // Codex round 2 (a): a whole-state location must not erase the state inside a requirement sentence.
  const caLicense = { text: 'Claims Intern\nCalifornia\n\nRequirements\n• Requires a California license.\n', places: ['California'], requisitions: [] };
  const ilLicense = { text: 'Claims Intern\nIllinois\n\nRequirements\n• Requires an Illinois license.\n', places: ['Illinois'], requisitions: [] };
  assert.deepEqual(sameRoleText(caLicense, ilLicense), { same: false, reason: 'text_differs' });
  const caVsIl = { text: 'Claims Intern\nIllinois\n\nRequirements\n• Requires a California license.\n', places: ['Illinois'], requisitions: [] };
  assert.deepEqual(sameRoleText(caLicense, caVsIl), { same: true, reason: 'identical' }, 'the header line alone differs: same role');
  // Codex round 2 (b): one posting's city is never removed from the other posting's text.
  const dallasCert = { text: `${SNAPSHOTS.eligible.replace('Chicago, IL', 'Dallas, TX')}\n• Holds a Dallas certification.\n`, places: ['Dallas, TX'], requisitions: [] };
  const chicagoCert = { text: `${SNAPSHOTS.eligible}\n• Holds a Chicago certification.\n`, places: ['Chicago, IL'], requisitions: [] };
  assert.deepEqual(sameRoleText(dallasCert, chicagoCert), { same: false, reason: 'text_differs' });
  // No compatibility folding: "10² hours" is not "102 hours" (only case and whitespace are unified).
  const squared = { text: 'Analytics Intern\nRequires 10² hours of lab work.\n', places: [], requisitions: [] };
  const hundred = { text: 'Analytics Intern\nRequires 102 hours of lab work.\n', places: [], requisitions: [] };
  assert.deepEqual(sameRoleText(squared, hundred), { same: false, reason: 'text_differs' });
  assert.deepEqual(sameRoleText(squared, { ...squared, text: 'ANALYTICS   Intern\nrequires 10² HOURS of lab work.' }), { same: true, reason: 'identical' });
  // The positive case: the same body, a different location header line and requisition id.
  const chicago = { text: `${SNAPSHOTS.eligible}\nReq ID: R123456\n`, places: ['Chicago, IL'], requisitions: ['R123456'] };
  const dallas = { text: `${SNAPSHOTS.eligible.replace('Location: Chicago, IL', 'Locations: Dallas, TX; Austin, TX')}\nReq ID: R777777\n`, places: ['Dallas, TX', 'Austin, TX'], requisitions: ['R777777'] };
  assert.deepEqual(sameRoleText(dallas, chicago), { same: true, reason: 'identical' });
  const bareLine = { text: `${SNAPSHOTS.eligible.replace('Location: Chicago, IL', 'Dallas, Texas')}\nReq ID: R777777\n`, places: ['Dallas, TX'], requisitions: ['R777777'] };
  assert.deepEqual(sameRoleText(bareLine, chicago), { same: true, reason: 'identical' }, 'a whole line in City, State form is a location line');
});

test('[GW2] five same-title postings with the same text: one representative judged, four copy its degree rejection (fetch, no model call)', async () => {
  const db = freshDb();
  const pages = {};
  const places = ['Chicago, IL', 'Dallas, TX', 'Boston, MA', 'New York, NY', 'Seattle, WA'];
  places.forEach((place, index) => add(db, pages, `p-${index}`, { text: SNAPSHOTS.undergradOnly, place, title: `Analytics Intern - ${place}` }));
  const j = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  const fetcher = fakeFetcher(pages);
  const receipt = await run(db, pages, { j, fetcher });
  const judged = calledFor(j);
  assert.equal(judged.length, 1, `one representative judged: ${judged}`);
  assert.equal(fetcher.calls.length, 5);
  for (let index = 0; index < 5; index += 1) {
    const id = `p-${index}`;
    const row = reviewOf(db, id);
    assert.deepEqual([row.state, row.decision, row.code], ['done', 'not_eligible', 'degree'], id);
    if (id === judged[0]) continue;
    assert.ok(flags(db, id).includes('group_copy'), id);
    assert.deepEqual([groupCopy(db, id).from, groupCopy(db, id).rule], [judged[0], 'copied']);
  }
  assert.deepEqual([receipt.counts.group_copied, receipt.counts.group_text_mismatch], [4, 0]);
  assert.match(nightlySummary(receipt, { lang: 'zh' }), /同岗复用 4（其中按地点规则 0；正文不同另判 0）/);
});

test('[GW3] outside_area is never copied: another outside state gets the location rule, an allowed state is judged', async () => {
  const db = freshDb();
  const pages = {};
  const austin = judgment({ alternatives: [{ ...SUMMER_CHICAGO, offices: [{ place: 'Austin, TX', area: 'outside', quote: 'Location: Austin, TX' }] }] });
  add(db, pages, 'p-austin', { text: SNAPSHOTS.eligible, place: 'Austin, TX' });
  add(db, pages, 'p-dallas', { text: SNAPSHOTS.eligible, place: 'Dallas, TX' });
  add(db, pages, 'p-chicago', { text: SNAPSHOTS.eligible, place: 'Chicago, IL' });
  const j = judges((request) => ({ output: request.postingId === 'p-chicago' ? JUDGMENTS.eligible : austin }));
  const receipt = await run(db, pages, { j, concurrency: 1 });
  const judged = calledFor(j);
  assert.ok(judged.includes('p-chicago'));
  const rep = judged.find((id) => id !== 'p-chicago');
  const other = rep === 'p-austin' ? 'p-dallas' : 'p-austin';
  assert.deepEqual([reviewOf(db, rep).decision, reviewOf(db, rep).code], ['not_eligible', 'outside_area']);
  assert.deepEqual([reviewOf(db, other).decision, reviewOf(db, other).code], ['not_eligible', 'outside_area']);
  assert.ok(flags(db, other).includes('location_rule') && !judged.includes(other));
  assert.equal(reviewOf(db, 'p-chicago').decision, 'eligible');
  assert.equal(receipt.counts.group_location_rule, 1);
});

test('[GW4] same title, "undergraduate only" vs "Master\'s or PhD": both judged, counted as a text mismatch', async () => {
  const db = freshDb();
  const pages = {};
  const either = SNAPSHOTS.undergradOnly.replace("Be enrolled as a junior undergraduate student pursuing a Bachelor's degree.", "Be enrolled in a Master's or PhD program in a quantitative field.");
  add(db, pages, 'p-a', { text: SNAPSHOTS.undergradOnly, place: 'Chicago, IL' });
  add(db, pages, 'p-b', { text: either, place: 'New York, NY' });
  const j = judges((request) => ({ output: request.postingId === 'p-a' ? JUDGMENTS.undergradOnly
    : judgment({ alternatives: [{ ...SUMMER_CHICAGO, offices: [{ place: 'New York, NY', area: 'nyc', quote: 'Location: New York, NY' }] }], criteria: [] }) }));
  const receipt = await run(db, pages, { j, concurrency: 1 });
  assert.deepEqual(calledFor(j), ['p-a', 'p-b']);
  assert.deepEqual([receipt.counts.group_copied, receipt.counts.group_text_mismatch], [0, 1]);
  assert.equal(Object.values(receipt.counts.group_text_mismatch_reasons).reduce((a, b) => a + b, 0), 1);
  const logged = db.prepare("SELECT payload_json FROM review_log WHERE posting_id IN ('p-a','p-b') AND payload_json LIKE '%groupMismatch%'").all().map((row) => JSON.parse(row.payload_json).groupMismatch);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].code, 'text_differs');
  assert.match(nightlySummary(receipt), /group copies 0 \(location rule 0; text differs, judged 1\)/);
});

test('[GW5] a member the user holds or declined is never touched by a group copy', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-rep', { text: SNAPSHOTS.undergradOnly, place: 'Chicago, IL' });
  add(db, pages, 'p-held', { text: SNAPSHOTS.undergradOnly, place: 'Dallas, TX', stage: 'judge', state: 'held', holdOwner: 'user', decision: 'unclear', code: 'user_review' });
  add(db, pages, 'p-declined', { text: SNAPSHOTS.undergradOnly, place: 'Boston, MA' });
  const app = seedApplication(db, { company: 'Example Corp', role: 'Analytics Intern', status: 'withdrawn', skipOwner: 'user', skipReason: 'USER declined', jobUrl: urlOf('p-declined') });
  db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, 'p-declined');
  const before = { held: reviewOf(db, 'p-held'), declined: reviewOf(db, 'p-declined') };
  const j = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  const receipt = await run(db, pages, { j });
  assert.deepEqual(calledFor(j), ['p-rep']);
  assert.deepEqual(reviewOf(db, 'p-held'), before.held);
  assert.deepEqual(reviewOf(db, 'p-declined'), before.declined);
  assert.equal(receipt.counts.group_copied, 0);
});

async function earlierSource(updatedDaysAgo, policy = REVIEW_POLICY) {
  const db = freshDb();
  const pages = {};
  insertPosting(db, { id: 'p-old', url: urlOf('p-old'), title: 'Analytics Intern' });
  const updated = at(-updatedDaysAgo);
  db.prepare(`INSERT INTO reviews (posting_id, stage, state, decision, code, lane, flags_json, attempts, paid_attempts, lost_attempts, next_due,
      lease_generation, evidence_json, dep_hashes_json, deadline_json, first_seen, updated_at)
    VALUES ('p-old','deliver','done','not_eligible','degree','new','[]',1,1,0,NULL,0,?,?, '{}',?,?)`)
    .run(JSON.stringify({ evidence: [{ confirmed: true, quote: 'junior undergraduate' }], factsUsed: ['degree'] }),
      JSON.stringify({ inputs: inputState(reviewInputs({ policy })) }), updated, updated);
  db.prepare(`INSERT INTO snapshots (id, posting_id, content_hash, fetched_at, final_url, http_status, method, identity_ok, fields_json, sections_json, text)
    VALUES ('s-old','p-old','h-old',?,?,200,'ats_api',1,?, '[]', ?)`).run(updated, urlOf('p-old'), JSON.stringify({ locations: ['Chicago, IL'] }), SNAPSHOTS.undergradOnly);
  add(db, pages, 'p-new', { text: SNAPSHOTS.undergradOnly, place: 'Dallas, TX' });
  const j = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  await run(db, pages, { j, policy });
  return { db, j };
}

test('[GW6] window: a source judged 10 days ago is copied; 40 days ago, or grouping off, is judged again', async () => {
  const recent = await earlierSource(10);
  assert.deepEqual(calledFor(recent.j), []);
  assert.equal(groupCopy(recent.db, 'p-new').from, 'p-old');
  const expired = await earlierSource(40);
  assert.deepEqual(calledFor(expired.j), ['p-new']);
  const off = await earlierSource(10, { ...REVIEW_POLICY, grouping: { windowDays: 0 } });
  assert.deepEqual(calledFor(off.j), ['p-new']);
});

test('[GW7] a moved posting uses only its current record: old Chicago observation, page now in Dallas -> not copied as eligible', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-a-rep', { text: SNAPSHOTS.eligible, place: 'Chicago, IL' });
  add(db, pages, 'p-b-moved', { text: SNAPSHOTS.eligible, place: 'Dallas, TX' });
  // An older scan saw p-moved in Chicago; the page fetched now says Dallas.
  db.prepare(`INSERT INTO observations (id, posting_id, source, source_id, partition, first_run_id, observed_at, fields_json, completeness_json, listed, content_hash)
    VALUES ('o-old','p-b-moved','greenhouse','1','greenhouse:examplecorp','run-old',?,?,'{}',1,'h1')`).run(at(-20), JSON.stringify({ locations: ['Chicago, IL'] }));
  // Schedule order is first_seen, then posting id: p-a-rep is the representative.
  const j = judges(() => ({ output: JUDGMENTS.eligible }));
  const receipt = await run(db, pages, { j, concurrency: 1 });
  const moved = reviewOf(db, 'p-b-moved');
  assert.deepEqual([moved.decision, moved.code], ['not_eligible', 'outside_area'], 'Dallas is outside; an old Chicago observation does not make it inside');
  assert.equal(groupCopy(db, 'p-b-moved').rule, 'location');
  assert.equal(receipt.counts.eligible, 1);
});

test('[GW8] a group copy saves the input dependencies, so a later facts change re-plans it', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-a', { text: SNAPSHOTS.undergradOnly, place: 'Chicago, IL' });
  add(db, pages, 'p-b', { text: SNAPSHOTS.undergradOnly, place: 'Dallas, TX' });
  const j = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  await run(db, pages, { j, concurrency: 1 });
  const copy = ['p-a', 'p-b'].find((id) => groupCopy(db, id));
  const deps = JSON.parse(reviewOf(db, copy).dep_hashes_json);
  assert.deepEqual(deps.inputs, inputState(reviewInputs()), 'the copy carries today\'s input state');
  assert.ok(deps.snapshot && deps.decisionRuntime, 'snapshot hash and the source\'s decision runtime are saved');
  // A facts change used by the decision re-plans every not_eligible review that recorded its inputs.
  const { replan } = await import('../../src/review/worker.mjs');
  const facts = reviewInputs().facts.map((fact) => (fact.id === 'degree' ? { ...fact, statement: 'Pursuing a Bachelor of Science; graduation May 2027' } : fact));
  // Only open work is re-planned; mark the copy open as a held question would be, to exercise its dependencies.
  db.prepare("UPDATE reviews SET state='held' WHERE posting_id=?").run(copy);
  const { requeued } = replan(db, { inputs: reviewInputs({ facts }), now: at(1) });
  assert.ok(requeued >= 1);
  assert.equal(reviewOf(db, copy).state, 'due');
});

test('[GW9] a source whose stored inputs no longer match today\'s is refused at copy time, and the member is judged', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-a', { text: SNAPSHOTS.undergradOnly, place: 'Chicago, IL' });
  const first = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  await run(db, pages, { j: first, concurrency: 1 });
  // The source was settled under rules that are no longer today's (its stored inputs differ), yet it is inside the
  // window and was listed as a source at run start.
  const deps = JSON.parse(reviewOf(db, 'p-a').dep_hashes_json);
  db.prepare('UPDATE reviews SET dep_hashes_json=? WHERE posting_id=?').run(JSON.stringify({ ...deps, inputs: { ...deps.inputs, rules: 'sha256:older-rules' } }), 'p-a');
  const { groupSources } = await import('../../src/review/grouping.mjs');
  const sources = groupSources(db, { now: T0, windowDays: 30, state: null });
  assert.equal(sources.current('p-a', inputState(reviewInputs())), null, 'the copy-time recheck refuses the stale source');
  add(db, pages, 'p-b', { text: SNAPSHOTS.undergradOnly, place: 'Dallas, TX' });
  const second = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  await run(db, pages, { j: second, concurrency: 1, now: at(0.01) });
  assert.deepEqual(calledFor(second), ['p-b'], 'judged normally');
  assert.equal(groupCopy(db, 'p-b'), undefined);
});

test('[GW10] the obsolete grouping.textSimilarity setting stops the run with invalid_config', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-a', { text: SNAPSHOTS.undergradOnly, place: 'Chicago, IL' });
  const j = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  const receipt = await run(db, pages, { j, policy: { ...REVIEW_POLICY, grouping: { windowDays: 30, textSimilarity: 0.95 } } });
  assert.equal(receipt.stop_reason, 'invalid_config');
  assert.match(receipt.errors.join(' '), /grouping.textSimilarity is no longer used/);
  assert.deepEqual(calledFor(j), []);
});
