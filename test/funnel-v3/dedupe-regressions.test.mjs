// Duplicate-application regressions from the 2026-10-27 live queue (rulings D1–D4). Eight queued "eligible" leads
// were roles the user had already applied to: a legacy lead and the submitted application were never recognized as
// the same posting or program, so the lead stayed visible (status lead, no skip_reason) and the worker re-delivered
// it as eligible. Live shapes (queued lead URL vs applied URL; every name, host and id below is synthetic but keeps
// the URL shape and the id relation of the live pair):
//   1 /global/en/job/59703                      vs /global/en/job/59703/Forward-Deployed-AI-Scientist-Intern   (slug added)
//   2 Workday …/Careers/…_2603846-1             vs …/Careers2/…_2603846                                         (repost suffix, other site)
//   3 /en-us/details/200673612                  vs /en-us/details/200673612-0836                                (location suffix)
//   4 bare host /en/jobs/10564586/<slug>        vs www. host /en/jobs/10564586                                  (www, slug)
//   6 Greenhouse 8257369 "Data Scientist Intern - 2027" vs 8222414 with the identical title                     (re-post)
//   7 …(PomonaRosemead)-1-CA-91770/1425208900 "Data Analytics Intern - Data Science/Applied Math"
//     vs …(PomonaRosemead)-CA-91770/1425207700 "Data Analytics Intern - Data Science - Applied Math"            (same program)
// Must stay separate: different titles sharing a zip code or a location id in the URL (Kirkland …-WA-98033/1449176233
// vs …-WA-98033/1449176033; /mountain-view/<slug>/27595/100620927632 vs …/27595/100620927664), and program levels
// ("Campus Graduate I" vs "Campus Graduate II", Oracle 26013190 vs 26013191 and 26013265 vs 26013266; live pair 5
// was corrected by the coordinator to this must-stay-separate case).
// User rule (2026-09-30): another location's posting of the same program is a duplicate; never apply twice.
// Rulings:
//   D1 Same requisition: postings of one company whose ATS job/req id is equal after stripping repost/location
//      suffixes ("-1", Apple-style "-0836", Workday "_R123-1") and ignoring URL slugs, www., query strings and the
//      Workday site path are the same posting. A lead matching an application with a submitted status
//      (applied/assessment/interview/rejected/offer …) is never delivered as a new eligible lead and never re-queued.
//   D2 Same program: same company + same normalized title (case, punctuation and whitespace-insensitive; "-", "/",
//      "&" and "and" alike) + a submitted application → not delivered; code 'already_submitted' with evidence naming
//      the applied application id. Titles differing in a program-level word (I/II, Undergraduate/Graduate,
//      Masters/PhD) are different programs.
//   D3 Different titles never match on shared numeric tokens that are zip codes or location ids.
//   D4 The check covers new postings and legacy leads already in the queue (bootstrap/redecide): a visible lead
//      matching a submitted application under D1/D2 is withdrawn by the review worker (actor review-worker,
//      skip_owner 'review') and never touches the submitted application's id, status, applied_at or events.
// Contract fixed here (observable behavior only; no new export is required):
//   new posting (ingestBatch): the posting's review is not due/leased, not user-held, code 'already_submitted';
//                    no application is created; D2 hits carry the applied application id in reviews.evidence_json.
//   delivery (deliver): an eligible verdict for a duplicate posting creates no visible lead, keeps an existing lead
//                    out of `queue list`, sets code 'already_submitted', and a later eligible verdict never restores it.
//   legacy lead (bootstrapExisting + runReview): afterwards the lead is out of `queue list`, its application is
//                    status 'withdrawn' with skip_owner 'review' via an event whose source.actor is 'review-worker';
//                    the lead review is code 'already_submitted' and the review evidence or the withdrawal event names
//                    the applied application id. The submitted application row and its events are byte-identical.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, insertPosting, insertReview, reviewOf, eventsOf, applicationsCount, fakeJudge, T0, at } from '../../test-utils/funnel-v3.mjs';
import { record, page, snapshotTitle, reviewInputs, SNAPSHOTS, JUDGMENTS, REVIEW_POLICY, SCREENING_POLICY, PROFILE, PROVENANCE } from '../../test-utils/funnel-v3-fixtures.mjs';
import { listQueue } from '../../src/commands/queue.mjs';

const ingest = () => load('L1', './src/funnel/ingest.mjs', ['ingestBatch']);
const bootstrap = () => load('L1', './src/funnel/bootstrap.mjs', ['bootstrapExisting']);
const delivery = async () => ({
  ...(await load('L2', './src/review/deliver.mjs', ['deliver'])),
  ...(await load('L2', './src/review/lease.mjs', ['claimItem'])),
});
const workerModule = () => load('B6', './src/review/worker.mjs', ['runReview']);

const SIMPLIFY_PARTIAL = Object.freeze({ locations: 'partial', arrangement: 'unknown', description: 'tags', employment_type: 'absent' });
const ELIGIBLE = { decision: 'eligible', code: null, fit: { level: 'medium', note: 'SQL and Python match' }, deadline: { kind: 'none' }, location: { offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' }], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' } };

// ------------------------------------------------------------------ live shapes (synthetic names)

const workday = (site, place, slug, id) => `https://examplesemi.wd1.myworkdayjobs.com/${site}/job/${place}/${slug}_${id}`;
const oracle = (id) => `https://examplebank.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/${id}`;

// D1: one requisition, two URLs. `lead` is the queued legacy lead / new listing, `applied` the submitted application.
const SAME_REQUISITION = Object.freeze([
  { name: 'slug added (live 1)', company: 'Example Consulting Group',
    lead: { role: 'AI Scientist Intern', url: 'https://careers.exampleconsulting.test/global/en/job/59703' },
    applied: { role: 'Forward Deployed AI Scientist Intern', url: 'https://careers.exampleconsulting.test/global/en/job/59703/Forward-Deployed-AI-Scientist-Intern' } },
  { name: 'Workday repost suffix on another site (live 2)', company: 'Example Semiconductor',
    lead: { role: 'AI Data Science Intern (MS) - Summer 2027', url: workday('ExampleCareers', 'Santa-Clara-CA', 'AI-Data-Science-Intern--MS---Summer-2027', '2603846-1') },
    applied: { role: 'AI Data Science Intern (MS) - Summer 2027', url: workday('ExampleCareers2', 'Santa-Clara-CA', 'AI-Data-Science-Intern--MS---Summer-2027', '2603846') } },
  { name: 'numeric location suffix (live 3)', company: 'Example Devices',
    lead: { role: 'Machine Learning Data Science Intern', url: 'https://jobs.exampledevices.test/en-us/details/200673612' },
    applied: { role: 'Machine Learning Data Science Intern', url: 'https://jobs.exampledevices.test/en-us/details/200673612-0836' } },
  { name: 'www and slug (live 4)', company: 'Example Retail',
    lead: { role: '2027 Applied Science Internship - Machine Learning', url: 'https://exampleretail.jobs/en/jobs/10564586/2027-applied-science-internship-machine-learning' },
    applied: { role: '2027 Applied Science Internship - Machine Learning', url: 'https://www.exampleretail.jobs/en/jobs/10564586' } },
  { name: 'Workday letter-prefixed requisition with -1 on another site', company: 'Example Semiconductor West',
    lead: { role: 'Data Analyst Intern', url: 'https://examplewest.wd5.myworkdayjobs.com/External/job/Remote-USA/Data-Analyst-Intern_R900123-1' },
    applied: { role: 'Data Analyst Intern', url: 'https://examplewest.wd5.myworkdayjobs.com/Careers/job/Chicago-IL/Data-Analyst-Intern_R900123' } },
]);

// D2: one program, two requisitions.
const SAME_PROGRAM = Object.freeze([
  { name: 'Greenhouse re-post, identical title (live 6)', company: 'Example Fintech',
    lead: { role: 'Data Scientist Intern - 2027', url: 'https://job-boards.greenhouse.io/examplefintech/jobs/8257369' },
    applied: { role: 'Data Scientist Intern - 2027', url: 'https://job-boards.greenhouse.io/examplefintech/jobs/8222414' } },
  { name: 'another location, "/" vs " - " (live 7)', company: 'Example Utility',
    lead: { role: 'Data Analytics Intern - Data Science/Applied Math', url: 'https://jobs.exampleutility.test/job/Rosemead-Data-Analytics-Intern-Data-Science-Applied-Math-(PomonaRosemead)-1-CA-91770/1425208900' },
    applied: { role: 'Data Analytics Intern - Data Science - Applied Math', url: 'https://jobs.exampleutility.test/job/Rosemead-Data-Analytics-Intern-Data-Science-Applied-Math-(PomonaRosemead)-CA-91770/1425207700' } },
  { name: 'case, whitespace, "&" vs "and"', company: 'Example Insurance',
    lead: { role: 'risk & analytics intern  -  summer 2027', url: 'https://jobs.exampleinsurance.test/job/Hartford-CT/4410077' },
    applied: { role: 'Risk and Analytics Intern / Summer 2027', url: 'https://jobs.exampleinsurance.test/job/Chicago-IL/4410012' } },
]);

// D2/D3: must stay separate even though the user applied to the other one.
const SEPARATE = Object.freeze([
  { name: 'different titles sharing a zip code (D3)', company: 'Example Motors',
    lead: { role: 'Program Management Intern', url: 'https://jobs.examplemotors.test/job/Kirkland-Program-Management-Intern-WA-98033/1449176233' },
    applied: { role: 'Warranty Data Analyst Intern', url: 'https://jobs.examplemotors.test/job/Kirkland-Warranty-Data-Analyst-Intern-WA-98033/1449176033' } },
  { name: 'different titles sharing a location id (D3)', company: 'Example Software',
    lead: { role: 'Summer 2027 Product Manager Intern', url: 'https://jobs.examplesoftware.test/job/mountain-view/summer-2027-product-manager-intern/27595/100620927632' },
    applied: { role: 'Summer 2027 Technical Program Manager Intern', url: 'https://jobs.examplesoftware.test/job/mountain-view/summer-2027-technical-program-manager-intern/27595/100620927664' } },
  { name: 'Campus Graduate I vs II, consecutive Oracle reqs (live 5, D2 program level)', company: 'Example Bank',
    lead: { role: 'Campus Graduate I - Data Science, Finance', url: oracle('26013190') },
    applied: { role: 'Campus Graduate II - Data Science, Finance', url: oracle('26013191') } },
  { name: 'Campus Graduate I vs II, Global Decision Science (D2 program level)', company: 'Example Bank Decision',
    lead: { role: 'Campus Graduate I - Global Decision Science', url: 'https://exampledecision.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26013265' },
    applied: { role: 'Campus Graduate II - Global Decision Science', url: 'https://exampledecision.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26013266' } },
  { name: 'Undergraduate vs Graduate (D2 program level)', company: 'Example Labs',
    lead: { role: 'Undergraduate Data Science Intern', url: 'https://job-boards.greenhouse.io/examplelabs/jobs/7300101' },
    applied: { role: 'Graduate Data Science Intern', url: 'https://job-boards.greenhouse.io/examplelabs/jobs/7300102' } },
  { name: 'Masters vs PhD (D2 program level)', company: 'Example Research',
    lead: { role: 'Data Science Intern - Masters', url: 'https://job-boards.greenhouse.io/exampleresearch/jobs/7300201' },
    applied: { role: 'Data Science Intern - PhD', url: 'https://job-boards.greenhouse.io/exampleresearch/jobs/7300202' } },
]);

// ------------------------------------------------------------------ helpers

// Applications that predate the funnel: no posting yet, no external id (the legacy-writer fence allows these).
function legacyApplication(db, { id, company, role, url, status = 'applied', created = '2026-09-15T00:00:00.000Z' }) {
  db.prepare('INSERT INTO applications (id, company, role, job_url, status, applied_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, company, role, url, status, status === 'lead' ? null : created, created, created);
}
// The submitted application's row and history; D4 requires both to be unchanged.
const appliedState = (db, id) => JSON.stringify({ row: db.prepare('SELECT * FROM applications WHERE id = ?').get(id), events: eventsOf(db, id) });
const postingOfApp = (db, applicationId) => db.prepare('SELECT id FROM postings WHERE application_id = ? AND merged_into IS NULL').get(applicationId)?.id;
const postingFor = (db, alias) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(alias)?.posting_id;
const queued = (db) => listQueue(db).map((row) => row.id);
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function batch(db, records, { runId = 'run-dedupe', now = T0 } = {}) {
  const { ingestBatch } = await ingest();
  return ingestBatch(db, { runId, source: 'simplify', partition: 'simplify:list', records, now, policy: SCREENING_POLICY, profile: PROFILE });
}
const listing = (pair, index) => record({ source: 'simplify', sourceId: `s-dedupe-${index}-${slug(pair.name)}`, partition: 'simplify:list',
  company: pair.company, title: pair.lead.role, url: pair.lead.url, completeness: SIMPLIFY_PARTIAL });

// A submitted application bound by bootstrap, then the lead's URL arrives as a new listing.
async function newListingAfterApplied(pair, index) {
  const { bootstrapExisting } = await bootstrap();
  const db = freshDb();
  const appliedId = `applied-${index}`;
  legacyApplication(db, { id: appliedId, company: pair.company, role: pair.applied.role, url: pair.applied.url });
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  const before = appliedState(db, appliedId);
  const count = applicationsCount(db);
  const item = listing(pair, index);
  await batch(db, [item]);
  const postingId = postingFor(db, `source:simplify:${item.sourceId}`);
  return { db, appliedId, before, count, postingId, review: postingId ? reviewOf(db, postingId) : null };
}

// Problems with a new listing that duplicates a submitted application (empty when D1/D2 hold).
function duplicateProblems(db, { name, appliedId, before, count, postingId, review }, { evidence = false } = {}) {
  const problems = [];
  if (!postingId || !review) return [`${name}: the new listing has no posting/review`];
  if (['due', 'leased'].includes(review.state)) problems.push(`${name}: queued for review (state ${review.state}, lane ${review.lane}) although already submitted as ${appliedId}`);
  if (review.hold_owner === 'user') problems.push(`${name}: held for the user`);
  if (review.code !== 'already_submitted') problems.push(`${name}: code ${review.code} (decision ${review.decision}), expected already_submitted`);
  if (evidence && !String(review.evidence_json ?? '').includes(appliedId)) problems.push(`${name}: review evidence does not name the applied application ${appliedId}: ${review.evidence_json}`);
  if (applicationsCount(db) !== count) problems.push(`${name}: an application was created`);
  if (appliedState(db, appliedId) !== before) problems.push(`${name}: the submitted application ${appliedId} changed`);
  return problems;
}

// Fake fetch: every posting serves an eligible page titled like the posting, so a missed duplicate is delivered eligible.
function eligibleFetcher() {
  const calls = [];
  return {
    calls,
    async fetch(request) {
      calls.push(request);
      const title = request.known?.title ?? 'Data Science Intern';
      return page(request.url, SNAPSHOTS.eligible.replace(snapshotTitle(SNAPSHOTS.eligible), title), { title });
    },
  };
}
async function offline(run) {
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => { attempts.push(String(url)); throw new Error(`network access in a test: ${url}`); };
  try { return await run(); } finally {
    globalThis.fetch = original;
    assert.deepEqual(attempts, [], 'no network request is made');
  }
}
async function runWorker(db, { now = T0, runId = 'review-dedupe' } = {}) {
  const { runReview } = await workerModule();
  const answer = () => ({ output: JUDGMENTS.eligible });
  const judges = { primary: fakeJudge({ tier: 'primary', answers: answer }), escalation: fakeJudge({ tier: 'escalation', answers: answer }) };
  return offline(() => runReview({ db, runId, owner: 'worker-a', now, budget: 40, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: eligibleFetcher(), judges, inputs: () => reviewInputs({ policy: REVIEW_POLICY }), hooks: {} }));
}

// Problems with a legacy lead that duplicates a submitted application after bootstrap + worker (empty when D4 holds).
function withdrawnProblems(db, { name, leadId, appliedId, before }) {
  const problems = [];
  const lead = db.prepare('SELECT * FROM applications WHERE id = ?').get(leadId);
  if (!lead) return [`${name}: the lead application ${leadId} was deleted`];
  if (queued(db).includes(leadId)) problems.push(`${name}: lead ${leadId} is still in the queue (status ${lead.status}, skip_reason ${lead.skip_reason}) although ${appliedId} was submitted`);
  if (lead.status !== 'withdrawn') problems.push(`${name}: lead status ${lead.status}, expected withdrawn`);
  if (lead.skip_owner !== 'review') problems.push(`${name}: lead skip_owner ${lead.skip_owner}, expected review`);
  const events = eventsOf(db, leadId);
  const withdrawal = [...events].reverse().find((event) => event.statusAfter);
  if (withdrawal?.statusAfter !== 'withdrawn' || withdrawal.source?.actor !== 'review-worker') {
    problems.push(`${name}: last status event ${withdrawal?.type}/${withdrawal?.statusAfter} by ${withdrawal?.source?.actor}, expected a review-worker withdrawal`);
  }
  const postingId = postingOfApp(db, leadId);
  const review = postingId ? reviewOf(db, postingId) : null;
  if (review?.code !== 'already_submitted') problems.push(`${name}: lead review code ${review?.code} (decision ${review?.decision}, state ${review?.state}), expected already_submitted`);
  if (review && ['due', 'leased'].includes(review.state)) problems.push(`${name}: lead review is queued again (${review.state})`);
  if (!`${review?.evidence_json ?? ''}${JSON.stringify(withdrawal?.source ?? {})}`.includes(appliedId)) problems.push(`${name}: neither the review evidence nor the withdrawal names ${appliedId}`);
  if (appliedState(db, appliedId) !== before) problems.push(`${name}: the submitted application ${appliedId} changed`);
  return problems;
}

// Sanity of the separate cases (they hold today): the lead stays queued and is reviewed normally.
function separateProblems(db, { name, leadId }) {
  const problems = [];
  if (!queued(db).includes(leadId)) problems.push(`${name}: lead ${leadId} left the queue although it is a different posting and program`);
  const review = reviewOf(db, postingOfApp(db, leadId));
  if (review?.code === 'already_submitted') problems.push(`${name}: wrongly marked already_submitted`);
  return problems;
}

// ===================================================================== D1 — new postings

test('[A] a new listing of a requisition the user already applied to is not reviewed: already_submitted whatever slug, www, location or repost suffix, or Workday site (dedupe D1)', async () => {
  const problems = [];
  for (const [index, pair] of SAME_REQUISITION.entries()) {
    const result = await newListingAfterApplied(pair, index);
    problems.push(...duplicateProblems(result.db, { name: pair.name, ...result }));
  }
  assert.deepEqual(problems, [], `D1: a listing of a submitted requisition must not be queued:\n${problems.join('\n')}`);
});

// ===================================================================== D2 — new postings

test('[A] a new posting of a program the user already applied to (same company, same normalized title) is not reviewed, and the evidence names the applied application (dedupe D2)', async () => {
  const problems = [];
  for (const [index, pair] of SAME_PROGRAM.entries()) {
    const result = await newListingAfterApplied(pair, 100 + index);
    problems.push(...duplicateProblems(result.db, { name: pair.name, ...result }, { evidence: true }));
  }
  assert.deepEqual(problems, [], `D2: another posting of a submitted program must not be queued:\n${problems.join('\n')}`);
});

// ===================================================================== D2/D3 — must stay separate

test('[A] program-level words and shared zip codes or location ids keep postings separate, while a re-listing of the applied requisition is still caught (dedupe D2/D3)', async () => {
  // Separate cases first: each new listing is reviewed normally (lane new, due), never already_submitted.
  for (const [index, pair] of SEPARATE.entries()) {
    const { db, appliedId, before, count, review } = await newListingAfterApplied(pair, 200 + index);
    assert.equal(review?.state, 'due', `${pair.name}: a different posting and program is reviewed`);
    assert.equal(review?.lane, 'new', pair.name);
    assert.notEqual(review?.code, 'already_submitted', pair.name);
    assert.equal(applicationsCount(db), count);
    assert.equal(appliedState(db, appliedId), before, `${pair.name}: the submitted application is untouched`);
  }
  // The same company's applied requisition re-listed under a shorter URL (slug dropped) is the same posting (D1).
  const motors = SEPARATE[0];
  const relisted = { name: 'Example Motors re-listing without slug (D1)', company: motors.company,
    lead: { role: motors.applied.role, url: 'https://jobs.examplemotors.test/job/1449176033' }, applied: motors.applied };
  const result = await newListingAfterApplied(relisted, 299);
  const problems = duplicateProblems(result.db, { name: relisted.name, ...result });
  assert.deepEqual(problems, [], `D1: the applied requisition re-listed must not be queued:\n${problems.join('\n')}`);
});

// ===================================================================== D1/D2/D4 — delivery guard

test('[L2] delivery never creates or keeps a visible lead for a posting that duplicates a submitted application, and a later eligible verdict never restores it (dedupe D1/D2/D4)', async () => {
  const { deliver, claimItem } = await delivery();
  const { bootstrapExisting } = await bootstrap();
  const deliverAs = (db, postingId, verdict, now) => {
    const fence = claimItem(db, postingId, { owner: 'worker-a', now });
    return deliver(db, { postingId, verdict, fence, now, policy: SCREENING_POLICY });
  };
  const db = freshDb();
  const req = SAME_REQUISITION[2]; // location suffix
  const program = SAME_PROGRAM[0]; // Greenhouse re-post
  legacyApplication(db, { id: 'applied-req', company: req.company, role: req.applied.role, url: req.applied.url });
  legacyApplication(db, { id: 'applied-program', company: program.company, role: program.applied.role, url: program.applied.url });
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  const before = { req: appliedState(db, 'applied-req'), program: appliedState(db, 'applied-program') };

  // A queued posting with no application yet (a legacy review row still at the deliver stage).
  insertPosting(db, { id: 'p-new-dup', company: req.company, title: req.lead.role, url: req.lead.url });
  insertReview(db, { postingId: 'p-new-dup', stage: 'deliver' });
  const count = applicationsCount(db);
  const created = deliverAs(db, 'p-new-dup', ELIGIBLE, T0);
  assert.notEqual(created.action, 'created', 'no lead is created for a submitted requisition (D1)');
  assert.equal(applicationsCount(db), count, 'no application is created');
  assert.equal(reviewOf(db, 'p-new-dup').code, 'already_submitted');
  assert.notEqual(reviewOf(db, 'p-new-dup').decision, 'eligible');

  // An existing visible legacy lead bound to a re-posted program.
  legacyApplication(db, { id: 'lead-program', company: program.company, role: program.lead.role, url: program.lead.url, status: 'lead', created: '2026-09-01T00:00:00.000Z' });
  insertPosting(db, { id: 'p-lead-dup', company: program.company, title: program.lead.role, url: program.lead.url, applicationId: 'lead-program' });
  insertReview(db, { postingId: 'p-lead-dup', stage: 'deliver' });
  assert.ok(queued(db).includes('lead-program'), 'fixture: the legacy lead starts visible in the queue');
  deliverAs(db, 'p-lead-dup', ELIGIBLE, at(0.1));
  assert.ok(!queued(db).includes('lead-program'), 'an eligible verdict does not keep a duplicate of a submitted program in the queue (D2)');
  assert.equal(reviewOf(db, 'p-lead-dup').code, 'already_submitted');
  assert.ok(String(reviewOf(db, 'p-lead-dup').evidence_json).includes('applied-program'), 'the evidence names the applied application');

  // A later eligible verdict (redecide, refresh) must not restore it.
  db.prepare("UPDATE reviews SET state='due', stage='deliver' WHERE posting_id = 'p-lead-dup'").run();
  const again = deliverAs(db, 'p-lead-dup', ELIGIBLE, at(1));
  assert.notEqual(again.action, 'restored', 'the duplicate guard is rechecked on every delivery');
  assert.ok(!queued(db).includes('lead-program'), 'never re-queued');
  assert.equal(appliedState(db, 'applied-req'), before.req, 'the submitted applications are untouched');
  assert.equal(appliedState(db, 'applied-program'), before.program);
});

// ===================================================================== D4 — legacy leads in the queue

test('[B] bootstrap plus the review worker withdraw every legacy lead that duplicates a submitted application (six live shapes), keep the separate ones, and never touch the submitted application (dedupe D4)', async () => {
  const { bootstrapExisting } = await bootstrap();
  const db = freshDb();
  const duplicates = [...SAME_REQUISITION.slice(0, 4), ...SAME_PROGRAM.slice(0, 2)];
  const cases = [...duplicates, ...SEPARATE.slice(0, 4)].map((pair, index) => ({ pair, name: pair.name, leadId: `lead-${index}`, appliedId: `applied-${index}`, duplicate: index < duplicates.length }));
  for (const item of cases) {
    legacyApplication(db, { id: item.leadId, company: item.pair.company, role: item.pair.lead.role, url: item.pair.lead.url, status: 'lead', created: '2026-09-01T00:00:00.000Z' });
    legacyApplication(db, { id: item.appliedId, company: item.pair.company, role: item.pair.applied.role, url: item.pair.applied.url });
  }
  for (const item of cases) item.before = appliedState(db, item.appliedId);
  const count = applicationsCount(db);
  assert.deepEqual(queued(db).sort(), cases.map((item) => item.leadId).sort(), 'fixture: every legacy lead starts in the queue');

  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  const receipt = await runWorker(db);
  assert.notEqual(receipt.status, 'busy');
  assert.equal(applicationsCount(db), count, 'no application is created or deleted');

  const separate = cases.filter((item) => !item.duplicate).flatMap((item) => separateProblems(db, item));
  assert.deepEqual(separate, [], `the separate leads stay in the queue:\n${separate.join('\n')}`);
  for (const item of cases.filter((entry) => !entry.duplicate)) assert.equal(appliedState(db, item.appliedId), item.before, `${item.name}: the submitted application is untouched`);
  const problems = cases.filter((item) => item.duplicate).flatMap((item) => withdrawnProblems(db, item));
  assert.deepEqual(problems, [], `D4: legacy leads of submitted requisitions/programs must leave the queue:\n${problems.join('\n')}`);
});

test('[B] a lead the worker already delivered as eligible is withdrawn on the next run once it matches a submitted application (dedupe D4)', async () => {
  const { bootstrapExisting } = await bootstrap();
  const db = freshDb();
  const cases = [SAME_REQUISITION[0], SAME_PROGRAM[1]].map((pair, index) => ({ pair, name: pair.name, leadId: `lead-old-${index}`, appliedId: `applied-old-${index}` }));
  for (const item of cases) {
    legacyApplication(db, { id: item.leadId, company: item.pair.company, role: item.pair.lead.role, url: item.pair.lead.url, status: 'lead', created: '2026-09-01T00:00:00.000Z' });
    legacyApplication(db, { id: item.appliedId, company: item.pair.company, role: item.pair.applied.role, url: item.pair.applied.url });
  }
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  // The state a pre-fix run left behind: the lead review delivered eligible, the lead visible.
  for (const item of cases) {
    const postingId = postingOfApp(db, item.leadId);
    assert.ok(postingId, `fixture: ${item.leadId} is bound`);
    db.prepare("UPDATE reviews SET state='done', stage='deliver', decision='eligible', code=NULL, next_due=NULL, updated_at=? WHERE posting_id = ?").run(T0, postingId);
    db.prepare(`INSERT INTO application_events (id, application_id, event_type, observed_at, recorded_at, title, note, source_json, status_after, content_hash)
      VALUES (?, ?, 'review_delivered', ?, ?, 'review_delivered', '', ?, NULL, ?)`).run(`old-delivery-${item.leadId}`, item.leadId, T0, T0,
      JSON.stringify({ actor: 'review-worker', postingId }), `h-${item.leadId}`);
    item.before = appliedState(db, item.appliedId);
  }
  assert.deepEqual(queued(db).sort(), cases.map((item) => item.leadId).sort(), 'fixture: the delivered leads are visible');

  bootstrapExisting(db, { provenance: PROVENANCE, now: at(1) });
  await runWorker(db, { now: at(1), runId: 'review-dedupe-next' });
  const problems = cases.flatMap((item) => withdrawnProblems(db, item));
  assert.deepEqual(problems, [], `D4: an already-delivered duplicate lead must be withdrawn:\n${problems.join('\n')}`);
});
