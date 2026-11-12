// Term + location gate (user, 2026-11-12): a title that states only a non-summer term of one configured window and
// complete, specific US places all outside that window's states is settled term_or_area before any fetch; held
// browser_review rows produced by the worker's fetch-failure path are taken over, nothing else. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, JUDGMENTS, SNAPSHOTS, page, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runReview, inputState } from '../../src/review/worker.mjs';
import { offseasonTitleTerm, termLocationGate, termLocationGateSettings, ruleGateHashes } from '../../src/review/gates.mjs';
import { holdReview } from '../../src/review/backlog.mjs';
import { dependencyComparison } from '../../src/review/dependency-compat.mjs';
import { dependencyHash, judgeDependencies } from '../../src/review/inputs.mjs';
import { termPairs } from '../../src/funnel/classify.mjs';
import { sourceOf } from '../../src/review/grouping.mjs';
import { nightlySummary } from '../../src/review/summary.mjs';

const POLICY = REVIEW_POLICY; // windows: summer 2027 (all areas), off_season winter/spring/fall/co-op 2027 (chicago, us_remote); homeStates IL
const OFF = { ...POLICY, termLocationGate: { enabled: false } };
const NO_EXEMPT = { locationExempt: { brands: [], windows: null } };

test('[TL1] title proof: only a non-summer term of one window, every season paired, no months, no other years, no cohort wording', () => {
  const window = (title) => offseasonTitleTerm(title, POLICY)?.window.id ?? null;
  const terms = (title) => offseasonTitleTerm(title, POLICY)?.terms ?? null;
  assert.equal(window('Data Analyst Intern, Winter 2027'), 'off_season');
  assert.deepEqual(terms('Business Analyst Intern, Winter/Spring 2027'), ['winter 2027', 'spring 2027'], 'both seasons of a pair count');
  assert.equal(window('Fall 2027 Operations Intern'), 'off_season');
  assert.equal(window('Spring 2027 Co-op - Supply Chain'), 'off_season');
  assert.equal(window('Strategy Intern (Spring 2027)'), 'off_season');
  // Counter-examples (Codex plan review, 2026-11-12): each goes to the fetch and the judge.
  for (const title of ['Data Intern - Spring 2027 Graduates', 'Data Intern, Spring 2027 / June-August 2027', 'Summer 2026 / Summer 2027',
    'Fall 2027 Start', 'Winter 2026', 'Co-op (6 months)', 'Summer 2027 Data Intern', 'Winter 2027 / Summer 2027 Intern',
    'Spring 2027 New Grad Analyst', 'Class of 2027 Spring Intern', 'Spring 2027 Intern Cohort', 'Fall 2027 Hire - Analyst',
    'Spring Intern 2028', 'Spring 2027 - 2028 Co-op', 'Fall 2027-28 Co-op', 'Spring 2027 Intern (Jan - May)', 'Winter-Spring 2027 Intern',
    'Spring Intern, Fall 2027', 'Spring Data Intern', 'Off-season Analyst Intern', 'Data Intern 2027', 'Intern', '']) {
    assert.equal(window(title), null, title);
  }
  // A window that names the season but covers every in-person area is the location gate's job.
  const wide = { ...POLICY, windows: [{ id: 'all', termKinds: ['spring'], year: 2027, areas: [...POLICY.areas.keys] }] };
  assert.equal(offseasonTitleTerm('Spring 2027 Intern', wide), null);
  // A season of no configured window, or of two windows, proves nothing.
  assert.equal(offseasonTitleTerm('Autumn 2027 Intern', POLICY), null, 'the test policy has no autumn kind');
  const twice = { ...POLICY, windows: [...POLICY.windows, { id: 'other', termKinds: ['fall'], year: 2027, areas: ['nyc'] }] };
  assert.equal(offseasonTitleTerm('Fall 2027 Intern', twice), null);
  // classify.mjs pairing is shared and unchanged.
  assert.deepEqual(termPairs('Summer 2026 / Summer 2027'), [{ season: 'summer', year: 2026 }, { season: 'summer', year: 2027 }]);
});

test('[TL2] places: complete specific US places all outside the window states settle; IL, remote, hybrid, incomplete and mixed lists do not', () => {
  const gate = (locations, extra = {}) => termLocationGate({ title: 'Data Analyst Intern, Winter/Spring 2027', locations, policy: POLICY, company: 'Example Motors', overrides: NO_EXEMPT, ...extra });
  assert.deepEqual(gate(['Palo Alto, CA', 'Austin, TX']), { rule: 'term_location', matchedText: 'winter 2027, spring 2027', window: 'off_season',
    places: ['Palo Alto, CA', 'Austin, TX'], states: ['CA', 'TX'] });
  assert.equal(gate(['Seattle, WA'])?.rule, 'term_location', 'a summer-only state is outside the off-season window');
  assert.equal(gate(['Chicago, IL']), null, 'home state');
  assert.equal(gate(['Peoria, IL']), null, 'any place in a home state goes to the judge');
  assert.equal(gate(['Palo Alto, CA', 'Chicago, IL']), null, 'a list with a home-state place');
  assert.equal(gate(['Palo Alto, CA / Chicago, IL']), null, 'a compound place with a home-state part');
  assert.equal(gate(['Remote - US']), null, 'remote');
  assert.equal(gate(['Palo Alto, CA'], { record: { remote: true } }), null, 'record marked remote');
  assert.equal(gate(['Palo Alto, CA (Hybrid)']), null, 'hybrid');
  assert.equal(gate(['Palo Alto, CA'], { title: 'Data Analyst Intern, Winter 2027 (Remote)' }), null, 'remote wording in the title');
  assert.equal(gate(['Palo Alto, CA', '2 Locations']), null, 'summary wording');
  assert.equal(gate(['Palo Alto']), null, 'a city without a state');
  assert.equal(gate(['California']), null, 'a state alone');
  assert.equal(gate(['Toronto, ON, Canada']), null, 'outside the US');
  assert.equal(gate([]), null, 'no places');
  assert.equal(gate(['Palo Alto, CA'], { record: { source: 'simplify', completeness: { locations: 'partial' } } }), null, 'a partial list');
  assert.equal(gate(['Palo Alto, CA'], { url: 'https://www.amazon.jobs/en/jobs/1' }), null, 'an untrusted host');
  assert.equal(gate(['Palo Alto, CA'], { title: 'Data Analyst Intern, Summer 2027' }), null, 'a summer title');
  assert.equal(gate(['Palo Alto, CA'], { policy: { ...POLICY, areas: { ...POLICY.areas, homeStates: [] } } }), null, 'no home states');
  assert.equal(gate(['Palo Alto, CA'], { policy: OFF }), null, 'the switch is off');
});

test('[TL3] exempt brands: exempt here only when the exemption covers the off-season window', () => {
  const gate = (overrides, company = 'Famous Motors') => termLocationGate({ title: 'Spring 2027 Operations Intern', locations: ['Fremont, CA'], policy: POLICY, company, overrides });
  // Default exemption windows: the windows that cover every in-person area (summer), as exemptVerdict applies it.
  assert.equal(gate({ locationExempt: { brands: ['Famous Motors'], windows: null } })?.rule, 'term_location');
  assert.equal(gate({ locationExempt: { brands: ['Famous Motors'], windows: ['off_season'] } }), null, 'exempt for that window');
  assert.equal(gate({ locationExempt: { brands: ['Famous Motors'], windows: ['off_season'] } }, 'Other Co')?.rule, 'term_location');
  assert.equal(termLocationGate({ title: 'Spring 2027 Operations Intern', locations: ['Fremont, CA'], policy: POLICY, company: 'FM Holdings',
    overrides: { locationExempt: { brands: ['Famous Motors'], windows: ['off_season'] } }, aliases: { 'FM Holdings': 'Famous Motors' } }), null, 'through an alias');
});

test('[TL4] settings: absent or null means on; only a boolean enabled is accepted; the switch is not a screening policy part', () => {
  assert.deepEqual(termLocationGateSettings({}), { enabled: true });
  assert.deepEqual(termLocationGateSettings({ termLocationGate: null }), { enabled: true });
  assert.deepEqual(termLocationGateSettings({ termLocationGate: {} }), { enabled: true });
  assert.deepEqual(termLocationGateSettings(OFF), { enabled: false });
  for (const bad of ['off', [], { enabled: 'no' }, { enable: false }]) assert.throws(() => termLocationGateSettings({ termLocationGate: bad }), /termLocationGate/, JSON.stringify(bad));
  const base = reviewInputs({ policy: POLICY });
  for (const policy of [OFF, { ...POLICY, termLocationGate: { enabled: true } }]) {
    const withKey = reviewInputs({ policy });
    assert.deepEqual(inputState(withKey), inputState(base), 'input state unchanged');
    const adapter = { runner: 'claude', model: 'm', tier: 'primary' };
    assert.equal(judgeDependencies({ inputs: withKey, adapter, skeletonVersion: 'v', schemaHash: 's', decideVersion: 'd' }).hash,
      judgeDependencies({ inputs: base, adapter, skeletonVersion: 'v', schemaHash: 's', decideVersion: 'd' }).hash, 'judge dependencies unchanged');
    assert.deepEqual(ruleGateHashes(withKey), ruleGateHashes(base), 'rule configuration hashes unchanged: the switch never re-queues');
  }
});

test('[TL5] legacy full-policy hashes keep their mapping when the switch is added', () => {
  const db = freshDb();
  const without = reviewInputs({ policy: POLICY });
  const legacy = { input: dependencyHash({ policy: without.policy, jobType: null }),
    judgment: dependencyHash({ policy: without.policy, screeningPolicy: without.screeningPolicy, provenance: without.provenance, jobType: null }) };
  const before = dependencyComparison(db, without);
  assert.ok(before.policyAlias(legacy.judgment));
  for (const policy of [OFF, { ...POLICY, termLocationGate: { enabled: true } }]) {
    const withKey = reviewInputs({ policy });
    const after = dependencyComparison(db, withKey);
    assert.equal(after.policyAlias(legacy.judgment), before.policyAlias(legacy.judgment));
    assert.equal(after.inputPolicyMatches(legacy.input, inputState(withKey).policy), true);
  }
});

// ------------------------------------------------------------------ worker

const urlOf = (id) => `https://job-boards.greenhouse.io/examplemotors/jobs/${id}`;
function observe(db, id, locations, fields = {}) {
  db.prepare(`INSERT INTO observations (id, posting_id, source, source_id, partition, first_run_id, observed_at, fields_json, completeness_json, listed, content_hash)
    VALUES (?, ?, 'careerops', ?, 'p1', 'scan-0', ?, ?, '{}', 1, ?)`).run(`obs-${id}`, id, id, T0, JSON.stringify({ source: 'careerops', completeness: { locations: 'partial' }, locations, ...fields }), `hash-${id}`);
}
function add(db, pages, id, { title, locations = ['Palo Alto, CA'], result = null, state = 'due', decision = null, code = null, holdOwner = null } = {}) {
  insertPosting(db, { id, url: urlOf(id), company: 'Example Motors', title });
  insertReview(db, { postingId: id, state, decision, code, holdOwner });
  observe(db, id, locations);
  pages[urlOf(id)] = result ?? page(urlOf(id), SNAPSHOTS.undergradOnly);
}
const judges = () => ({ primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.undergradOnly }) }),
  escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.undergradOnly }) }) });
const run = (db, pages, { policy = POLICY, now = T0, fetcher = fakeFetcher(pages), j = judges() } = {}) => runReview({ db, runId: `review-tl-${now}`, owner: 'worker-tl',
  now, budget: 40, concurrency: 2, deadlineMs: 600_000, attemptDir: null, sleep: async () => {}, fetcher, judges: j,
  inputs: () => reviewInputs({ policy, overrides: NO_EXEMPT }), hooks: {} });
const outcome = (db, id) => { const row = reviewOf(db, id); return [row.state, row.decision, row.code]; };
const FORBIDDEN = { ok: false, httpStatus: 403, error: 'forbidden' };

test('[TL6] due rows: the term rule settles before any fetch; a summer title, a home-state place and the switch off go the normal way', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-winter', { title: 'Data Analyst Intern, Winter/Spring 2027' });
  add(db, pages, 'p-summer', { title: 'Data Analyst Intern, Summer 2027' });
  add(db, pages, 'p-home', { title: 'Data Analyst Intern, Spring 2027', locations: ['Chicago, IL'] });
  add(db, pages, 'p-grad', { title: 'Data Intern - Spring 2027 Graduates' });
  const fetcher = fakeFetcher(pages);
  const receipt = await run(db, pages, { fetcher });
  assert.deepEqual(outcome(db, 'p-winter'), ['done', 'not_eligible', 'term_or_area']);
  const row = reviewOf(db, 'p-winter');
  assert.deepEqual(JSON.parse(row.flags_json), ['term_location_rule', 'automated']);
  const evidence = JSON.parse(row.evidence_json);
  assert.deepEqual([evidence.ruleGate.rule, evidence.ruleGate.matchedText, evidence.ruleGate.window, evidence.provenance], ['term_location', 'winter 2027, spring 2027', 'off_season', 'automated']);
  assert.equal(JSON.parse(row.dep_hashes_json).ruleGate.rule, 'term_location');
  assert.equal(sourceOf({ ...row, company: 'Example Motors', title: 'x' }), null, 'never a group source');
  assert.deepEqual(fetcher.calls.map((call) => call.postingId).sort(), ['p-grad', 'p-home', 'p-summer']);
  assert.deepEqual([receipt.counts.gate_term, receipt.counts.gate_term_held, receipt.counts.gate_location], [1, 0, 0]);
  assert.match(nightlySummary(receipt, { lang: 'zh' }), /代码门结案 标题 0、地点 0、学期地点 1（/);
  // The same configuration on a later run re-queues nothing.
  const again = await run(db, pages, { now: at(1) });
  assert.deepEqual([again.counts.gate_reopened, again.counts.gate_term], [0, 0]);
  // Switched off: a due row is fetched and judged.
  const db2 = freshDb();
  const pages2 = {};
  add(db2, pages2, 'p-winter', { title: 'Data Analyst Intern, Winter/Spring 2027' });
  const fetcher2 = fakeFetcher(pages2);
  const off = await run(db2, pages2, { policy: OFF, fetcher: fetcher2 });
  assert.deepEqual(fetcher2.calls.map((call) => call.postingId), ['p-winter']);
  assert.equal(off.counts.gate_term, 0);
});

test('[TL7] held rows: a worker fetch-failure browser_review is taken over; manual, user-acted, other-origin, other-code and done rows are untouched', async () => {
  const db = freshDb();
  const pages = {};
  const title = 'Business Analyst Intern, Spring 2027';
  // Produced by the worker's fetch-failure path while the switch is off (a 403 goes to the browser at once).
  add(db, pages, 'p-worker', { title, result: FORBIDDEN });
  add(db, pages, 'p-worker-user', { title, result: FORBIDDEN });
  add(db, pages, 'p-worker-summer', { title: 'Business Analyst Intern, Summer 2027', result: FORBIDDEN });
  await run(db, pages, { policy: OFF });
  for (const id of ['p-worker', 'p-worker-user', 'p-worker-summer']) assert.deepEqual(outcome(db, id), ['held', 'unclear', 'browser_review'], id);
  assert.equal(reviewOf(db, 'p-worker').hold_owner, 'user', 'the worker hold is user-owned (l2-liveness-budget)');
  const log = db.prepare("SELECT payload_json FROM review_log WHERE posting_id='p-worker' AND kind='delivery'").get();
  assert.equal(JSON.parse(log.payload_json).verdict.holdOrigin, 'fetch_failure');
  // The user acted on one of them.
  db.prepare("INSERT INTO review_log (posting_id, at, stage, kind, payload_json) VALUES ('p-worker-user', ?, 'deliver', 'user', '{}')").run(at(1));
  // A browser hold from before the origin marker: only the question it was written with.
  add(db, pages, 'p-legacy', { title, state: 'held', decision: 'unclear', code: 'browser_review', holdOwner: 'user' });
  db.prepare("INSERT INTO review_log (posting_id, at, stage, kind, payload_json) VALUES ('p-legacy', ?, 'deliver', 'delivery', ?)")
    .run(T0, JSON.stringify({ action: 'hidden', verdict: { decision: 'unclear', code: 'browser_review', question: `Open the official posting: ${urlOf('p-legacy')}` } }));
  // A browser hold with no fetch-failure delivery (an identity conflict writes the row directly).
  add(db, pages, 'p-identity', { title, state: 'held', decision: 'unclear', code: 'browser_review', holdOwner: 'user' });
  // A manual sign-in-wall hold from `review hold`.
  add(db, pages, 'p-manual', { title });
  holdReview(db, { postingId: 'p-manual', code: 'external_signin_wall', reason: 'login page', now: T0, policy: {} });
  // A browser_review hold relabelled by hand after a fetch-failure delivery: the CLI marker keeps it.
  add(db, pages, 'p-manual-browser', { title, state: 'held', decision: 'unclear', code: 'browser_review', holdOwner: 'system' });
  db.prepare("INSERT INTO review_log (posting_id, at, stage, kind, payload_json) VALUES ('p-manual-browser', ?, 'deliver', 'delivery', ?)")
    .run(T0, JSON.stringify({ verdict: { decision: 'unclear', code: 'browser_review', question: 'Open the official posting: x', holdOrigin: 'fetch_failure' } }));
  db.prepare("INSERT INTO review_log (posting_id, at, stage, kind, payload_json) VALUES ('p-manual-browser', ?, 'deliver', 'outcome', ?)").run(T0, JSON.stringify({ action: 'manual_hold' }));
  // Other held codes and settled rows.
  add(db, pages, 'p-question', { title, state: 'held', decision: 'unclear', code: 'missing_fact', holdOwner: 'user' });
  add(db, pages, 'p-done', { title, state: 'done', decision: 'not_eligible', code: 'degree' });
  const done = db.prepare("SELECT * FROM reviews WHERE posting_id='p-done'").get();
  const fetcher = fakeFetcher(pages);
  const receipt = await run(db, pages, { now: at(2), fetcher });
  assert.deepEqual(outcome(db, 'p-worker'), ['done', 'not_eligible', 'term_or_area']);
  assert.deepEqual(outcome(db, 'p-legacy'), ['done', 'not_eligible', 'term_or_area']);
  assert.equal(JSON.parse(reviewOf(db, 'p-worker').evidence_json).ruleGate.rule, 'term_location');
  assert.equal(reviewOf(db, 'p-worker').hold_owner, null);
  assert.deepEqual(outcome(db, 'p-worker-user'), ['held', 'unclear', 'browser_review']);
  assert.deepEqual(outcome(db, 'p-worker-summer'), ['held', 'unclear', 'browser_review']);
  assert.deepEqual(outcome(db, 'p-identity'), ['held', 'unclear', 'browser_review']);
  assert.deepEqual(outcome(db, 'p-manual'), ['held', 'unclear', 'external_signin_wall']);
  assert.deepEqual(outcome(db, 'p-manual-browser'), ['held', 'unclear', 'browser_review']);
  assert.deepEqual(outcome(db, 'p-question'), ['held', 'unclear', 'missing_fact']);
  assert.deepEqual(db.prepare("SELECT * FROM reviews WHERE posting_id='p-done'").get(), done, 'a done row is byte-for-byte unchanged');
  assert.deepEqual([receipt.counts.gate_term, receipt.counts.gate_term_held], [2, 2]);
  assert.deepEqual(fetcher.calls, [], 'no held row was fetched');
  const takeover = db.prepare("SELECT payload_json FROM review_log WHERE posting_id='p-worker' AND kind='outcome' ORDER BY id DESC").get();
  assert.equal(JSON.parse(takeover.payload_json).takenOver, 'browser_review');
});

test('[TL8] a changed window configuration re-queues a term settlement; the gate settles it again when it still holds', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-winter', { title: 'Data Analyst Intern, Winter 2027' });
  await run(db, pages);
  assert.equal(reviewOf(db, 'p-winter').code, 'term_or_area');
  // The off-season window now also takes California: the configuration hash changes, the gate no longer holds.
  const wider = { ...POLICY, areas: { ...POLICY.areas, homeStates: ['IL', 'CA'] } };
  const fetcher = fakeFetcher(pages);
  const receipt = await run(db, pages, { policy: wider, now: at(1), fetcher });
  assert.equal(receipt.counts.gate_reopened, 1);
  assert.deepEqual(fetcher.calls.map((call) => call.postingId), ['p-winter']);
  assert.equal(reviewOf(db, 'p-winter').code, 'degree');
});
