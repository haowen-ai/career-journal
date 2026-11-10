// Screening redesign amendment G (user, 2026-11-09): pre-fetch title and location gates on due reviews, their
// provenance and re-plan on a config change, and the escalation routing of quoted primary rejections. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, judgment, page, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runReview, reviewPrimaryVerdict, inputState } from '../../src/review/worker.mjs';
import { titleScreenRules } from '../../src/funnel/classify.mjs';
import { directionRules } from '../../src/review/direction.mjs';
import { locationGate, groupSources, groupKey, sourceOf } from '../../src/review/grouping.mjs';
import { titleGate, escalationRouting, escalationSampled, rejectionQuote, DEFAULT_FINAL_REJECTION_CODES, DEFAULT_ESCALATION_SAMPLE } from '../../src/review/gates.mjs';
import { decide } from '../../src/review/decide.mjs';
import { nightlySummary } from '../../src/review/summary.mjs';

const HARDWARE = ['\\bfirmware\\b', '\\bembedded\\b', '\\bFPGAs?\\b', '\\bsilicon\\b(?!\\s+valley)',
  '^(?=.*\\b(?:hardware|silicon|chips?|ASICs?|FPGAs?|SoCs?|firmware|embedded|RF|analog|semiconductors?|PCBs?|circuits?)\\b).*\\b(?:validation|test|verification) engineer(?:s|ing)?\\b'];
const SCREEN = titleScreenRules({ function: HARDWARE, level: ['\\bPh\\.?D\\b'], term: true, language: { maxNonLatinShare: 0.5 } });
const DIRECTION = directionRules({ allow: ['\\bsignal processing analytics\\b'], anyFunctionCompanies: ['Chip Everything Inc'] });
const POLICY = REVIEW_POLICY; // allowedStates CA, IL, NY, WA
const EXEMPT = { locationExempt: { brands: ['Famous Burger'], windows: null } };
const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;

test('[RG1] title gate: the function list with every scan guard, and nothing but the function list', () => {
  const gate = (title, company = 'Example Corp') => titleGate({ title, company }, { titleScreen: SCREEN, direction: DIRECTION });
  assert.deepEqual(gate('Firmware Engineer Intern'), { rule: 'title_function', pattern: '\\bfirmware\\b', matchedText: 'Firmware' });
  assert.equal(gate('Machine Learning Firmware Data Intern'), null, 'a direction word (data / machine learning) guards the title');
  assert.equal(gate('Firmware Signal Processing Analytics Intern'), null, 'a role-direction allow pattern guards the title');
  assert.equal(gate('Firmware Engineer Intern', 'Chip Everything Inc'), null, 'an any-function company is never dropped');
  assert.equal(gate('PhD Research Intern'), null, 'the level list is scan-only');
  assert.equal(gate('Summer 2025 Marketing Intern'), null, 'the term rule is scan-only');
  assert.equal(gate('Marketing Intern - Silicon Valley'), null, 'bounded: Silicon Valley is a place');
  assert.equal(gate('Test Engineer Intern'), null, 'test engineer alone is not hardware');
  assert.equal(gate('Hardware Validation Engineer Intern')?.rule, 'title_function');
  assert.equal(titleGate({ title: 'Firmware Engineer Intern' }, { titleScreen: null }), null, 'no title-screen.json, no gate');
});

test('[RG2] location gate: complete specific US places all outside the wanted states settle; every unsafe case goes to the model', () => {
  const gate = (locations, extra = {}) => locationGate({ locations, policy: POLICY, company: 'Example Corp', overrides: EXEMPT, ...extra });
  assert.deepEqual(gate(['Dallas, TX', 'Austin, Texas, United States']), { rule: 'location_outside_area', matchedText: 'Dallas, TX; Austin, Texas, United States',
    places: ['Dallas, TX', 'Austin, Texas, United States'], states: ['TX'] });
  assert.equal(gate(['Dallas, TX'], { record: { remote: true } }), null, 'record marked remote');
  assert.equal(gate(['Dallas, TX'], { record: [{}, { workplaceType: 'Hybrid' }] }), null, 'hybrid workplace type');
  assert.equal(gate(['Dallas, TX'], { title: 'Analytics Intern (Remote)' }), null, 'remote wording in the title');
  assert.equal(gate(['Dallas, TX (Hybrid)']), null, 'hybrid wording in a place');
  assert.equal(gate(['Dallas, TX', '3 Locations']), null, 'summary wording: N Locations');
  assert.equal(gate(['Multiple Locations']), null, 'summary wording: Multiple Locations');
  assert.equal(gate(['Dallas, TX', 'Various']), null, 'summary wording: Various');
  assert.equal(gate(['Dallas, TX'], { company: 'Famous Burger' }), null, 'location-exempt brand');
  assert.equal(gate(['Dallas, TX'], { company: 'FB Holdings', aliases: { 'FB Holdings': 'Famous Burger' } }), null, 'exempt through an alias');
  assert.equal(gate(['Springfield']), null, 'unresolved city');
  assert.equal(gate(['Dallas, TX', 'Chicago, IL']), null, 'one place in a wanted state');
  assert.equal(gate(['Buffalo, NY']), null, 'an allowed state with an uncertain area is for the model');
  assert.equal(gate(['Texas']), null, 'state only');
  assert.equal(gate(['Toronto, ON, Canada']), null, 'outside the US: not this gate');
  assert.equal(gate(['Dallas, TX', 'London, United Kingdom']), null, 'a foreign place in the list: not this gate');
  assert.equal(gate([]), null, 'no places');
  assert.equal(locationGate({ locations: ['Dallas, TX'], policy: { areas: { allowedStates: [] } } }), null, 'no wanted states configured');
  // One string naming several places: each part is its own place; every part must resolve and be outside.
  assert.equal(gate(['Chicago, IL / Dallas, TX']), null, 'compound with an in-area part (slash)');
  assert.equal(gate(['Chicago, IL; Dallas, TX']), null, 'compound with an in-area part (semicolon)');
  assert.equal(gate(['Dallas, TX | Chicago, IL']), null, 'compound with an in-area part (bar)');
  assert.equal(gate(['Dallas, TX & Springfield']), null, 'a part that does not resolve');
  assert.equal(gate(['Chicago, IL/Dallas, TX']), null, 'slash without spaces splits');
  assert.equal(gate(['Chicago, IL, Dallas, TX']), null, 'extra comma segments are unparseable');
  assert.equal(gate(['Dallas, TX, Austin, TX']), null, 'extra comma segments are unparseable even when all outside');
  assert.equal(gate(['Dallas, TX, USA'])?.rule, 'location_outside_area', 'a US country suffix is allowed');
  assert.equal(gate(['Dallas, TX/Austin, TX'])?.rule, 'location_outside_area');
  assert.equal(gate(['Dallas, TX / Austin, TX'])?.rule, 'location_outside_area', 'every part outside: settles');
  assert.deepEqual(gate(['Dallas, TX / Austin, TX'])?.places, ['Dallas, TX / Austin, TX']);
});

test('[RG2b] location completeness: distrusted hosts and non-careerops partial lists go to the model; careerops lists rely on the parse rule', () => {
  const gate = (extra = {}) => locationGate({ locations: ['Dallas, TX'], policy: POLICY, company: 'Example Corp', overrides: EXEMPT, ...extra });
  assert.equal(gate({ url: 'amazon.jobs/en/jobs/1/intern' }), null, 'untrusted host (default list)');
  assert.equal(gate({ url: 'https://careers.fedex.com/job/1' }), null, 'untrusted host with a scheme');
  assert.equal(gate({ url: 'https://www.amazon.jobs/en/jobs/1' }), null, 'a subdomain of an untrusted host');
  assert.equal(gate({ url: 'https://notamazon.jobs/1' })?.rule, 'location_outside_area', 'only the host or its subdomains');
  assert.equal(gate({ url: 'amazon.jobs/x', policy: { ...POLICY, locationGate: { untrustedHosts: [] } } })?.rule, 'location_outside_area', 'the list is configurable');
  assert.equal(gate({ url: 'jobs.example.com/1', policy: { ...POLICY, locationGate: { untrustedHosts: ['example.com'] } } }), null);
  assert.throws(() => gate({ policy: { ...POLICY, locationGate: { untrustedHosts: 'amazon.jobs' } } }), /untrustedHosts/);
  assert.equal(gate({ record: { source: 'simplify', completeness: { locations: 'partial' } } }), null, 'a non-careerops partial list');
  assert.equal(gate({ record: { source: 'greenhouse', completeness: { locations: 'complete' } } })?.rule, 'location_outside_area', 'a complete list');
  assert.equal(gate({ record: { source: 'careerops', completeness: { locations: 'partial' } } })?.rule, 'location_outside_area', 'careerops partial with one clean city');
  assert.equal(gate({ record: [{ source: 'careerops', completeness: { locations: 'partial' } }, { locations: ['Dallas, TX'] }] })?.rule, 'location_outside_area', 'a page record without completeness');
});

test('[RG3] routing: a quoted primary rejection with a final code is final; anything else escalates as before', async () => {
  const inputs = reviewInputs({ policy: { ...POLICY, judge: { escalationSample: 0 } } });
  const text = SNAPSHOTS.undergradOnly;
  const route = async (output, { snapshotText = text, policy = inputs.policy, postingId = 'p-route' } = {}) => {
    const verdict = decide({ snapshotText, judgment: output, facts: inputs.facts, policy, tier: 'primary', firstSeen: T0, jobType: 'internship' });
    return reviewPrimaryVerdict({ verdict, inputs: { ...inputs, policy }, snapshotText, firstSeen: T0, counts: {}, judgment: output, postingId });
  };
  const final = await route(JUDGMENTS.undergradOnly);
  assert.deepEqual([final.verdict.decision, final.verdict.code, final.verdict.escalate, final.primaryFinal], ['not_eligible', 'degree', false, true]);
  // The quote must be in the posting: without it the same rejection escalates.
  assert.equal(rejectionQuote({ verdict: { code: 'degree' }, judgment: JUDGMENTS.undergradOnly, snapshotText: 'other text' }), null);
  assert.equal(rejectionQuote({ verdict: { code: 'degree' }, judgment: { ...JUDGMENTS.undergradOnly, criteria: [{ ...JUDGMENTS.undergradOnly.criteria[0], quote: '' }] }, snapshotText: text }), null);
  const verdict = decide({ snapshotText: text, judgment: JUDGMENTS.undergradOnly, facts: inputs.facts, policy: inputs.policy, tier: 'primary', firstSeen: T0, jobType: 'internship' });
  const unquoted = await reviewPrimaryVerdict({ verdict, inputs, snapshotText: text, firstSeen: T0, counts: {}, judgment: { criteria: [] }, postingId: 'p-route' });
  assert.deepEqual([unquoted.verdict.escalate, unquoted.primaryFinal], [true, undefined]);
  // A code outside judge.finalRejectionCodes escalates.
  const narrowed = await route(JUDGMENTS.undergradOnly, { policy: { ...inputs.policy, judge: { finalRejectionCodes: ['outside_area'], escalationSample: 0 } } });
  assert.equal(narrowed.verdict.escalate, true);
  // missing_fact (an unclear verdict) escalates.
  const missing = await route(JUDGMENTS.missingFact, { snapshotText: SNAPSHOTS.missingFact });
  assert.deepEqual([missing.verdict.decision, missing.verdict.code, missing.verdict.escalate], ['unclear', 'missing_fact', true]);
  // An eligible primary verdict is unchanged (no second opinion configured: delivered as eligible).
  const eligible = await route(JUDGMENTS.eligible, { snapshotText: SNAPSHOTS.eligible });
  assert.deepEqual([eligible.verdict.decision, eligible.primaryFinal], ['eligible', undefined]);
  // A configured second opinion keeps its branch: it is asked about the rejection, which escalates when it disagrees.
  const asked = [];
  const secondOpinion = { ask: async (request) => { asked.push(request); return { probability: 0.5 }; } };
  const jevPolicy = { ...inputs.policy, judge: { secondOpinion: { runner: 'jev', threshold: 0.1, eligibleThreshold: 0.7 } } };
  const withJev = await reviewPrimaryVerdict({ verdict, inputs: { ...inputs, policy: jevPolicy }, snapshotText: text, firstSeen: T0, counts: { asked: 0, agreed: 0, errors: 0 }, secondOpinion, judgment: JUDGMENTS.undergradOnly, postingId: 'p-route' });
  assert.deepEqual([asked.length, withJev.verdict.escalate, withJev.primaryFinal], [1, true, undefined]);
});

test('[RG4] the escalation sample is a deterministic share of the posting ids; settings are checked', async () => {
  assert.deepEqual(escalationRouting({}), { finalCodes: new Set(DEFAULT_FINAL_REJECTION_CODES), sample: DEFAULT_ESCALATION_SAMPLE });
  assert.deepEqual(DEFAULT_FINAL_REJECTION_CODES, ['outside_area', 'function_out_of_scope', 'degree', 'graduation', 'authorization', 'term_or_area']);
  assert.equal(DEFAULT_ESCALATION_SAMPLE, 0.05);
  assert.throws(() => escalationRouting({ judge: { escalationSample: 2 } }), /escalationSample/);
  assert.throws(() => escalationRouting({ judge: { finalRejectionCodes: 'degree' } }), /finalRejectionCodes/);
  const ids = Array.from({ length: 4000 }, (_, index) => `posting-${index}`);
  const first = ids.filter((id) => escalationSampled(id, 0.05));
  assert.deepEqual(ids.filter((id) => escalationSampled(id, 0.05)), first, 'same ids, same sample');
  assert.ok(first.length > 120 && first.length < 280, `about 5%: ${first.length}`);
  assert.equal(ids.some((id) => escalationSampled(id, 0)), false);
  assert.equal(ids.every((id) => escalationSampled(id, 1)), true);
  // In routing: a sampled final rejection escalates and is reported as sampled.
  const inputs = reviewInputs({ policy: { ...POLICY, judge: { escalationSample: 1 } } });
  const verdict = decide({ snapshotText: SNAPSHOTS.undergradOnly, judgment: JUDGMENTS.undergradOnly, facts: inputs.facts, policy: inputs.policy, tier: 'primary', firstSeen: T0, jobType: 'internship' });
  const sampled = await reviewPrimaryVerdict({ verdict, inputs, snapshotText: SNAPSHOTS.undergradOnly, firstSeen: T0, counts: {}, judgment: JUDGMENTS.undergradOnly, postingId: 'p-any' });
  assert.deepEqual([sampled.verdict.escalate, sampled.sampled], [true, true]);
});

// ------------------------------------------------------------------ worker

function observe(db, id, fields) {
  db.prepare(`INSERT INTO observations (id, posting_id, source, source_id, partition, first_run_id, observed_at, fields_json, completeness_json, listed, content_hash)
    VALUES (?, ?, 'careerops', ?, 'p1', 'scan-0', ?, ?, '{}', 1, ?)`).run(`obs-${id}`, id, id, T0, JSON.stringify(fields), `hash-${id}`);
}
function add(db, pages, id, { title = 'Analytics Intern', company = 'Example Corp', locations = null, text = SNAPSHOTS.undergradOnly, state = 'due', stage = 'fetch', holdOwner = null, decision = null, code = null, fields = {}, url = urlOf(id) } = {}) {
  insertPosting(db, { id, url, company, title });
  insertReview(db, { postingId: id, stage, state, holdOwner, decision, code });
  if (locations) observe(db, id, { source: 'careerops', completeness: { locations: 'partial' }, locations, remote: null, workplaceType: null, ...fields });
  pages[url] = page(url, text);
}
const judges = (primary, escalation = primary) => ({ primary: fakeJudge({ tier: 'primary', answers: primary }), escalation: fakeJudge({ tier: 'escalation', answers: escalation }) });
const called = (j) => [...new Set([...j.primary.calls, ...j.escalation.calls].map((call) => call.request.postingId))].sort();
const run = (db, pages, { j, policy = POLICY, titleScreen = SCREEN, now = T0, overrides = EXEMPT, fetcher = fakeFetcher(pages), runId = `review-rg-${now}` }) => runReview({ db, runId, owner: 'worker-rg',
  now, budget: 40, concurrency: 2, deadlineMs: 600_000, attemptDir: null, sleep: async () => {}, fetcher, judges: j,
  inputs: () => reviewInputs({ policy, titleScreen, direction: DIRECTION, overrides }), hooks: {} });
const evidence = (db, id) => JSON.parse(reviewOf(db, id).evidence_json);
const flags = (db, id) => JSON.parse(reviewOf(db, id).flags_json);
const deps = (db, id) => JSON.parse(reviewOf(db, id).dep_hashes_json);

test('[RG5] the worker settles due rows by the title and location rules before any fetch or model call; held and user rows are untouched', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-firmware', { title: 'Firmware Engineer Intern' });
  add(db, pages, 'p-dallas', { locations: ['Dallas, TX'] });
  add(db, pages, 'p-chicago', { locations: ['Chicago, IL'], text: SNAPSHOTS.eligible, title: 'Data Science Intern' });
  add(db, pages, 'p-remote', { locations: ['Dallas, TX'], fields: { remote: true }, title: 'Operations Intern' });
  add(db, pages, 'p-amazon', { locations: ['Austin, TX'], title: 'Logistics Intern', url: 'https://amazon.jobs/en/jobs/77/operations-intern' });
  add(db, pages, 'p-held', { title: 'Firmware Engineer Intern II', locations: ['Dallas, TX'], state: 'held', holdOwner: 'user', decision: 'unclear', code: 'missing_fact' });
  add(db, pages, 'p-browser', { title: 'Embedded Systems Intern', locations: ['Austin, TX'], state: 'held', holdOwner: 'system', decision: 'unclear', code: 'browser_review' });
  // A due row the user acted on (a user log entry) is the user's: no rule settles it.
  add(db, pages, 'p-user', { title: 'FPGA Design Intern', locations: ['Austin, TX'] });
  db.prepare("INSERT INTO review_log (posting_id, at, stage, kind, payload_json) VALUES ('p-user', ?, 'deliver', 'user', '{}')").run(T0);
  const answer = (request) => ({ output: request.postingId === 'p-chicago' ? JUDGMENTS.eligible : JUDGMENTS.undergradOnly });
  const j = judges(answer);
  const fetcher = fakeFetcher(pages);
  const receipt = await run(db, pages, { j, fetcher });
  const outcome = (id) => { const row = reviewOf(db, id); return [row.state, row.decision, row.code]; };
  assert.deepEqual(outcome('p-firmware'), ['done', 'not_eligible', 'function_out_of_scope']);
  assert.deepEqual(outcome('p-dallas'), ['done', 'not_eligible', 'outside_area']);
  assert.deepEqual(flags(db, 'p-firmware'), ['title_rule', 'automated']);
  assert.deepEqual(flags(db, 'p-dallas'), ['location_rule', 'automated']);
  const titleRule = evidence(db, 'p-firmware').ruleGate;
  assert.deepEqual([titleRule.rule, titleRule.matchedText, titleRule.pattern], ['title_function', 'Firmware', '\\bfirmware\\b']);
  assert.match(titleRule.configHash, /^sha256:/);
  assert.equal(evidence(db, 'p-firmware').provenance, 'automated');
  assert.deepEqual([evidence(db, 'p-dallas').ruleGate.rule, evidence(db, 'p-dallas').ruleGate.matchedText], ['location_outside_area', 'Dallas, TX']);
  assert.deepEqual(deps(db, 'p-firmware').ruleGate, { rule: 'title_function', configHash: titleRule.configHash });
  // Neither rule-settled row was fetched or judged; the remote-marked and in-area rows went the normal way.
  assert.deepEqual(fetcher.calls.map((call) => call.postingId).sort(), ['p-amazon', 'p-chicago', 'p-remote']);
  assert.deepEqual(called(j), ['p-amazon', 'p-chicago', 'p-remote'], 'an untrusted host goes to the model');
  assert.deepEqual(outcome('p-chicago'), ['done', 'eligible', null]);
  // Held rows (a user question, a browser review) keep their state although both rules would match them.
  assert.deepEqual(outcome('p-held'), ['held', 'unclear', 'missing_fact']);
  assert.deepEqual(outcome('p-browser'), ['held', 'unclear', 'browser_review']);
  assert.deepEqual(outcome('p-user'), ['due', null, null]);
  assert.deepEqual([receipt.counts.gate_title, receipt.counts.gate_location, receipt.counts.gate_reopened], [1, 1, 0]);
  assert.match(nightlySummary(receipt, { lang: 'zh' }), /代码门结案 标题 1、地点 1（规则变更重排 0），初审拒绝直接定案 2，抽检升级 0（推翻 0）/);
  assert.match(nightlySummary(receipt), /rule gates title 1, location 1/);
});

test('[RG6] a rule settlement is never a same-title group source', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-dallas', { locations: ['Dallas, TX'], title: 'Analytics Intern' });
  const j = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  await run(db, pages, { j });
  assert.equal(reviewOf(db, 'p-dallas').code, 'outside_area');
  const row = db.prepare('SELECT r.*,p.company,p.title FROM reviews r JOIN postings p ON p.id=r.posting_id WHERE r.posting_id=?').get('p-dallas');
  assert.equal(sourceOf(row), null);
  // Even without the automated provenance, the rule marker alone keeps it out.
  assert.equal(sourceOf({ ...row, evidence_json: JSON.stringify({ ruleGate: { rule: 'location_outside_area' } }) }), null);
  assert.equal(sourceOf({ ...row, evidence_json: '{}' }), null, 'the location_rule flag alone keeps it out');
  const sources = groupSources(db, { now: T0, windowDays: 30, state: null });
  assert.deepEqual(sources.find(groupKey('Example Corp', 'Analytics Intern')), []);
});

test('[RG7] a changed rule configuration re-plans a rule-settled row; an unchanged one does not', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-firmware', { title: 'Firmware Engineer Intern' });
  add(db, pages, 'p-dallas', { locations: ['Dallas, TX'] });
  const j = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  await run(db, pages, { j });
  assert.deepEqual(called(j), []);
  // Same configuration: nothing is re-queued.
  const again = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  const same = await run(db, pages, { j: again, now: at(1) });
  assert.deepEqual([same.counts.gate_reopened, same.counts.gate_title, same.counts.gate_location], [0, 0, 0]);
  assert.deepEqual(called(again), []);
  // The function list no longer names firmware: the title settlement is re-queued, fetched and judged by the model.
  const changed = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  const screen = titleScreenRules({ function: HARDWARE.filter((pattern) => !pattern.includes('firmware')) });
  const receipt = await run(db, pages, { j: changed, now: at(2), titleScreen: screen });
  assert.equal(receipt.counts.gate_reopened, 1);
  assert.deepEqual(called(changed), ['p-firmware']);
  assert.deepEqual([reviewOf(db, 'p-firmware').state, reviewOf(db, 'p-firmware').code], ['done', 'degree']);
  assert.equal(evidence(db, 'p-firmware').ruleGate, undefined, 'the model delivery drops the rule marker');
  assert.equal(flags(db, 'p-firmware').includes('title_rule'), false);
  assert.equal(deps(db, 'p-firmware').ruleGate, undefined);
  assert.equal(reviewOf(db, 'p-dallas').code, 'outside_area', 'the location settlement depends on other settings');
  // The areas change (TX becomes wanted): the location settlement is re-queued and judged.
  const areas = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  const wider = { ...POLICY, areas: { ...POLICY.areas, allowedStates: [...POLICY.areas.allowedStates, 'TX'] } };
  const widened = await run(db, pages, { j: areas, now: at(3), titleScreen: screen, policy: wider });
  assert.equal(widened.counts.gate_reopened, 1);
  assert.deepEqual(called(areas), ['p-dallas']);
  // The exemption list changes: a rule-settled row of that brand is re-queued too.
  const db2 = freshDb();
  const pages2 = {};
  add(db2, pages2, 'p-brand', { locations: ['Dallas, TX'], company: 'New Brand Co' });
  await run(db2, pages2, { j: judges(() => ({ output: JUDGMENTS.undergradOnly })) });
  assert.equal(reviewOf(db2, 'p-brand').code, 'outside_area');
  const exempted = await run(db2, pages2, { j: judges(() => ({ output: JUDGMENTS.undergradOnly })), now: at(1), overrides: { locationExempt: { brands: ['Famous Burger', 'New Brand Co'], windows: null } } });
  assert.equal(exempted.counts.gate_reopened, 1);
  assert.equal(reviewOf(db2, 'p-brand').code, 'degree');
  void inputState;
});

test('[RG8] worker routing: a sampled final rejection is escalated; the receipt counts the sample and its overturns', async () => {
  const db = freshDb();
  const pages = {};
  add(db, pages, 'p-degree', { locations: ['Chicago, IL'] });
  // The escalation finds the degree clause met: eligible, which overturns the primary's final rejection.
  const met = judgment({ criteria: [{ ...JUDGMENTS.undergradOnly.criteria[0], status: 'meets' }] });
  const j = judges(() => ({ output: JUDGMENTS.undergradOnly }), () => ({ output: met }));
  const receipt = await run(db, pages, { j, policy: { ...POLICY, judge: { escalationSample: 1 } } });
  assert.equal(j.escalation.calls.length, 1);
  assert.deepEqual(receipt.counts.escalation_sample, { asked: 1, overturned: 1 });
  assert.equal(receipt.counts.primary_final, 0);
  assert.equal(reviewOf(db, 'p-degree').decision, 'eligible');
  // Without the sample the same rejection is final at the primary tier.
  const db2 = freshDb();
  const pages2 = {};
  add(db2, pages2, 'p-degree', { locations: ['Chicago, IL'] });
  const j2 = judges(() => ({ output: JUDGMENTS.undergradOnly }), () => ({ output: met }));
  const receipt2 = await run(db2, pages2, { j: j2, policy: { ...POLICY, judge: { escalationSample: 0 } } });
  assert.deepEqual([j2.escalation.calls.length, receipt2.counts.primary_final, receipt2.counts.escalation_sample.asked], [0, 1, 0]);
  assert.deepEqual([reviewOf(db2, 'p-degree').decision, reviewOf(db2, 'p-degree').code], ['not_eligible', 'degree']);
  // An invalid setting stops the run before any dispatch.
  const db3 = freshDb();
  const pages3 = {};
  add(db3, pages3, 'p-degree', { locations: ['Chicago, IL'] });
  const j3 = judges(() => ({ output: JUDGMENTS.undergradOnly }));
  const bad = await run(db3, pages3, { j: j3, policy: { ...POLICY, judge: { escalationSample: -1 } } });
  assert.equal(bad.stop_reason, 'invalid_config');
  assert.equal(j3.primary.calls.length, 0);
});
