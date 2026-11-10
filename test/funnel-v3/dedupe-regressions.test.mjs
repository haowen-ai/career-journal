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
// Amended 2026-11-10 (plan intern-scan/plans/2026-11-10-dedup-fix.md, root cause 5): the D2 auto-settlement is
// withdrawn. Live shapes 6 (Greenhouse 8257369 vs 8222414) and 7 (1425208900 vs 1425207700), and the "&"/"and" case
// (4410077 vs 4410012), carry different requisition ids on both sides; the title is the only link, and a title (often
// Simplify-shortened) cannot tell a re-post from another level, team or office (PIMCO PhD vs Masters, Nissan Smyrna vs
// Franklin were withdrawn wrongly this way). Their assertions change from already_submitted to "reviewed and visible,
// flagged suspected_duplicate:<applied application id>"; the coordinator compares flagged leads before an apply batch.
// The 2026-09-30 rule (never apply twice to one program) is now kept by that flag plus the body rule (official titles
// equal and official text >= 0.9 → duplicate_submitted). D1 (same requisition) is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, insertPosting, insertReview, reviewOf, eventsOf, applicationsCount, fakeJudge, seedApplication, T0, at } from '../../test-utils/funnel-v3.mjs';
import { record, page, snapshotTitle, reviewInputs, SNAPSHOTS, JUDGMENTS, REVIEW_POLICY, SCREENING_POLICY, PROFILE, PROVENANCE } from '../../test-utils/funnel-v3-fixtures.mjs';
import { listQueue, rescreenLeads, programSiblings } from '../../src/commands/queue.mjs';
import { withOverrides, emptyOverrides, loadUserOverrides } from '../../src/review/overrides.mjs';
import { aliasesFor, resolvePosting } from '../../src/funnel/identity.mjs';
import { companySizes } from '../../src/review/company-size.mjs';

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

// Amended 2026-11-10 (root cause 5): was "not reviewed, already_submitted"; now reviewed and flagged.
test('[A] a new posting with the same company and normalized title as a submitted application but a different requisition is reviewed and flagged suspected_duplicate, never already_submitted (dedupe D2, amended 2026-11-10)', async () => {
  const problems = [];
  for (const [index, pair] of SAME_PROGRAM.entries()) {
    const result = await newListingWith(pair, 100 + index, dupPolicy());
    if (result.review?.state !== 'due') problems.push(`${pair.name}: state ${result.review?.state} code ${result.review?.code}, expected due`);
    if (result.review?.code === 'already_submitted') problems.push(`${pair.name}: settled already_submitted on a title alone`);
    if (!suspectedOf(result.db, result.postingId).includes(`suspected_duplicate:${result.appliedId}`)) problems.push(`${pair.name}: not flagged suspected_duplicate:${result.appliedId}: ${JSON.stringify(flagsOf(result.db, result.postingId))}`);
    if (appliedState(result.db, result.appliedId) !== result.before) problems.push(`${pair.name}: the submitted application changed`);
  }
  assert.deepEqual(problems, [], `D2 (amended): a title-only hit is flagged, not settled:\n${problems.join('\n')}`);
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

  // An existing visible legacy lead with the title of a submitted application but another requisition (live 6).
  // Amended 2026-11-10 (root cause 5): it stays visible, flagged suspected_duplicate, instead of already_submitted.
  legacyApplication(db, { id: 'lead-program', company: program.company, role: program.lead.role, url: program.lead.url, status: 'lead', created: '2026-09-01T00:00:00.000Z' });
  insertPosting(db, { id: 'p-lead-dup', company: program.company, title: program.lead.role, url: program.lead.url, applicationId: 'lead-program' });
  insertReview(db, { postingId: 'p-lead-dup', stage: 'deliver' });
  assert.ok(queued(db).includes('lead-program'), 'fixture: the legacy lead starts visible in the queue');
  const fence = claimItem(db, 'p-lead-dup', { owner: 'worker-a', now: at(0.1) });
  deliver(db, { postingId: 'p-lead-dup', verdict: ELIGIBLE, fence, now: at(0.1), policy: dupPolicy() });
  assert.ok(queued(db).includes('lead-program'), 'a title-only hit keeps the lead visible (D2 amended)');
  assert.notEqual(reviewOf(db, 'p-lead-dup').code, 'already_submitted');
  assert.deepEqual(suspectedOf(db, 'p-lead-dup'), ['suspected_duplicate:applied-program'], 'flagged with the applied application');

  // The requisition duplicate stays settled: a later eligible verdict (redecide, refresh) must not restore it.
  db.prepare("UPDATE reviews SET state='due', stage='deliver' WHERE posting_id = 'p-new-dup'").run();
  const again = deliverAs(db, 'p-new-dup', ELIGIBLE, at(1));
  assert.notEqual(again.action, 'restored', 'the duplicate guard is rechecked on every delivery');
  assert.equal(reviewOf(db, 'p-new-dup').code, 'already_submitted');
  assert.equal(applicationsCount(db), count + 1, 'still no application for the requisition duplicate (only the legacy lead was added)');
  assert.equal(appliedState(db, 'applied-req'), before.req, 'the submitted applications are untouched');
  assert.equal(appliedState(db, 'applied-program'), before.program);
});

// ===================================================================== D4 — legacy leads in the queue

// Amended 2026-11-10 (root cause 5): live shapes 6 and 7 (SAME_PROGRAM 0 and 1) moved from the withdrawn set to the
// kept set: different requisition ids on both sides, title only → they stay in the queue (flagged when duplicateCheck is set).
test('[B] bootstrap plus the review worker withdraw every legacy lead that duplicates a submitted requisition (four live shapes), keep title-only matches and the separate ones, and never touch the submitted application (dedupe D4)', async () => {
  const { bootstrapExisting } = await bootstrap();
  const db = freshDb();
  const duplicates = [...SAME_REQUISITION.slice(0, 4)];
  const cases = [...duplicates, ...SAME_PROGRAM.slice(0, 2), ...SEPARATE.slice(0, 4)].map((pair, index) => ({ pair, name: pair.name, leadId: `lead-${index}`, appliedId: `applied-${index}`, duplicate: index < duplicates.length }));
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
  // Amended 2026-11-10 (root cause 5): SAME_PROGRAM[1] (live 7, title only, different ids) now stays visible.
  const cases = [SAME_REQUISITION[0], SAME_PROGRAM[1]].map((pair, index) => ({ pair, name: pair.name, leadId: `lead-old-${index}`, appliedId: `applied-old-${index}`, titleOnly: index === 1 }));
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
  const problems = cases.filter((item) => !item.titleOnly).flatMap((item) => withdrawnProblems(db, item));
  assert.deepEqual(problems, [], `D4: an already-delivered duplicate lead must be withdrawn:\n${problems.join('\n')}`);
  const kept = cases.filter((item) => item.titleOnly).flatMap((item) => separateProblems(db, item));
  assert.deepEqual(kept, [], `a title-only match stays visible:\n${kept.join('\n')}`);
});

// ===================================================================== 2026-11-10 dedup fix (D5–D7, D2-scope, F2–F5)
// Plan intern-scan/plans/2026-11-10-dedup-fix.md v4. Six of ten high-fit leads of the 11/09 apply batch were duplicates:
// a legal-entity company spelling (ICE, Constellation), a job id the identity code could not read from the URL (Google
// "<id>-<slug>", Qualcomm "?pid="), a cross-ATS repost compared on a shortened title (PayPal) and a brand subsidiary
// (HP IQ). In the other direction, a same-company same-title hit was auto-settled already_submitted although the two
// requisitions differ (PIMCO PhD vs Masters, Nissan Smyrna vs Franklin): a title-only hit is now only flagged
// suspected_duplicate:<application id>, whatever ids either side carries. Every name below is synthetic; hosts the
// verified job-id URL formats name (google.com, careers.qualcomm.com, *.eightfold.ai) keep their real shape.

const DUPLICATE_CHECK = Object.freeze({
  jobIdUrlFormats: [
    { host: 'google.com', path: '^/about/careers/applications/jobs/results/(\\d{6,})(?:-[a-z0-9-]+)?$' },
    { host: 'careers.qualcomm.com', path: '^/careers/job$', param: 'pid', id: '^\\d{6,}$' },
    { hostSuffix: '.eightfold.ai', path: '^/careers/job/(\\d{6,})$' },
  ],
  flagTitleNoiseWords: ['intern', 'internship', 'coop', 'co-op', 'summer', 'fall', 'winter', 'spring', 'autumn', 'program', 'programme'],
  flagSimilarity: 0.6,
  leadFlagSimilarity: 1,
  distinctCompanies: [['Example Apple', 'Example Apple Bank']],
});
const dupPolicy = ({ aliases = {}, duplicateCheck = DUPLICATE_CHECK, base = SCREENING_POLICY } = {}) =>
  withOverrides(base, { ...emptyOverrides(), aliases, ...(duplicateCheck ? { duplicateCheck } : {}) });
const identityOf = (policy) => ({ companyAliases: policy.companyAliases, ...(policy.identityOptions ?? {}) });
const effectiveId = (db, id) => { let row = db.prepare('SELECT id, merged_into FROM postings WHERE id = ?').get(id); while (row?.merged_into) row = db.prepare('SELECT id, merged_into FROM postings WHERE id = ?').get(row.merged_into); return row?.id; };
const flagsOf = (db, postingId) => JSON.parse(reviewOf(db, postingId)?.flags_json ?? '[]');
const suspectedOf = (db, postingId) => flagsOf(db, postingId).filter((flag) => flag.startsWith('suspected_duplicate:'));
const GOOGLE = (id, slugText = '') => `https://www.google.com/about/careers/applications/jobs/results/${id}${slugText ? `-${slugText}` : ''}`;

async function newListingWith(pair, index, policy, { appliedUrl = pair.applied.url } = {}) {
  const { bootstrapExisting } = await bootstrap();
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const appliedId = `applied-${index}`;
  legacyApplication(db, { id: appliedId, company: pair.appliedCompany ?? pair.company, role: pair.applied.role, url: appliedUrl });
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0, policy });
  const before = appliedState(db, appliedId);
  const count = applicationsCount(db);
  const item = record({ source: 'simplify', sourceId: `s-dedupe-${index}`, partition: 'simplify:list', company: pair.company, title: pair.lead.role, url: pair.lead.url, completeness: SIMPLIFY_PARTIAL });
  const counts = ingestBatch(db, { runId: `run-dedupe-${index}`, source: 'simplify', partition: 'simplify:list', records: [item], now: T0, policy, profile: PROFILE });
  const postingId = postingFor(db, `source:simplify:${item.sourceId}`);
  return { db, appliedId, before, count, counts, postingId, review: postingId ? reviewOf(db, postingId) : null };
}
const deliverWith = async (db, postingId, policy, { verdict = ELIGIBLE, now = T0, text = null } = {}) => {
  const { deliver, claimItem } = await delivery();
  const fence = claimItem(db, postingId, { owner: 'worker-a', now });
  return deliver(db, { postingId, verdict, fence, now, policy, text });
};

test('[A] a legal-entity spelling in the alias table is the same company: a careers-site /jobs/<id> listing of an applied iCIMS requisition is already_submitted (dedupe D5)', async () => {
  const pair = { company: 'Example Exchange Holdings, Inc.', appliedCompany: 'Example Exchange',
    lead: { role: 'Summer Internship Program 2027 - Data Science Intern', url: 'https://careers.exampleexchange.test/jobs/14113' },
    applied: { role: 'Data Science Intern', url: 'https://careers-exex.icims.com/jobs/14113/job?mode=view' } };
  const aliased = await newListingWith(pair, 500, dupPolicy({ aliases: { 'Example Exchange Holdings, Inc.': 'Example Exchange' } }));
  assert.deepEqual(duplicateProblems(aliased.db, { name: 'alias', ...aliased }, { evidence: true }), []);
  const plain = await newListingWith(pair, 501, dupPolicy());
  assert.equal(plain.review?.state, 'due', 'without the alias the two spellings are two companies');
});

test('[A] no submitted row: the same Google job from two sources, as /results/<id> and /results/<id>-<slug>, becomes one posting and one lead (dedupe D6)', async () => {
  const policy = dupPolicy();
  const db = freshDb();
  const slugged = record({ source: 'careerops', sourceId: '75665705386549958', partition: 'careerops:examplesearch', company: 'Example Search', title: 'Forward Deployed Engineering Intern, BS/MS, Summer 2027',
    url: GOOGLE('75665705386549958', 'forward-deployed-engineering-intern-bs-ms-summer-2027') });
  const bare = record({ source: 'simplify', sourceId: 's-google-fde', partition: 'simplify:list', company: 'Example Search', title: 'Forward Deployed Engineer Intern', url: GOOGLE('75665705386549958') });
  const first = resolvePosting(db, slugged, { now: T0, ...identityOf(policy) });
  const second = resolvePosting(db, bare, { now: T0, ...identityOf(policy) });
  assert.equal(effectiveId(db, second.postingId), effectiveId(db, first.postingId), 'one posting for both URLs');
  assert.equal(second.matchedBy, 'company_req');
  // Through ingest and delivery: two sources, one lead.
  const { ingestBatch } = await ingest();
  const fresh = freshDb();
  ingestBatch(fresh, { runId: 'run-d6-a', source: 'careerops', partition: 'careerops:examplesearch', records: [slugged], now: T0, policy, profile: PROFILE });
  ingestBatch(fresh, { runId: 'run-d6-b', source: 'simplify', partition: 'simplify:list', records: [bare], now: at(0.01), policy, profile: PROFILE });
  const due = fresh.prepare("SELECT r.posting_id FROM reviews r JOIN postings p ON p.id = r.posting_id WHERE r.state = 'due' AND p.merged_into IS NULL").all().map((row) => row.posting_id);
  assert.equal(due.length, 1, `one review is due: ${due.join(', ')}`);
  for (const id of due) await deliverWith(fresh, id, policy);
  assert.equal(fresh.prepare("SELECT COUNT(*) n FROM applications WHERE status = 'lead'").get().n, 1, 'one lead');
});

test('[A] negative: a different job number with a slug, or the same path shape on a host not in jobIdUrlFormats, creates a separate posting (dedupe D6-neg)', () => {
  const policy = dupPolicy();
  const db = freshDb();
  const one = resolvePosting(db, record({ source: 'simplify', sourceId: 's-g-1', company: 'Example Search', title: 'Data Science Intern', url: GOOGLE('75665705386549958') }), { now: T0, ...identityOf(policy) });
  const other = resolvePosting(db, record({ source: 'simplify', sourceId: 's-g-2', company: 'Example Search', title: 'Data Science Intern', url: GOOGLE('75665705386549959', 'data-science-intern') }), { now: T0, ...identityOf(policy) });
  assert.notEqual(effectiveId(db, other.postingId), effectiveId(db, one.postingId), 'a different job number is another posting');
  const kinds = aliasesFor({ company: 'Example Search', url: 'https://other.example.com/about/careers/applications/jobs/results/75665705386549958' }, identityOf(policy)).map((item) => item.kind);
  assert.ok(!kinds.includes('company_req'), `a host outside jobIdUrlFormats yields no company_req: ${kinds}`);
  const google = aliasesFor({ company: 'Example Search', url: GOOGLE('75665705386549958', 'x') }, identityOf(policy)).map((item) => item.alias);
  assert.ok(google.includes('company_req:examplesearch:75665705386549958'), `the configured format yields company_req: ${google}`);
});

test('[A] no submitted row: an Eightfold job and the careers-site link carrying the same id in ?pid= become one posting and one lead (dedupe D7)', () => {
  const policy = dupPolicy();
  const db = freshDb();
  const eightfold = record({ source: 'careerops', sourceId: '446720741706', partition: 'careerops:examplechips', company: 'Example Chips', title: 'Data Science Intern', url: 'https://examplechips.eightfold.ai/careers/job/446720741706' });
  const careers = record({ source: 'simplify', sourceId: 's-chips-pid', partition: 'simplify:list', company: 'Example Chips', title: 'Data Science Intern - Summer 2027', url: 'https://careers.qualcomm.com/careers/job?domain=examplechips.com&pid=446720741706' });
  const first = resolvePosting(db, eightfold, { now: T0, ...identityOf(policy) });
  const second = resolvePosting(db, careers, { now: T0, ...identityOf(policy) });
  assert.equal(effectiveId(db, second.postingId), effectiveId(db, first.postingId), 'one posting for the Eightfold job and its ?pid= link');
  assert.equal(second.matchedBy, 'company_req');
  const third = resolvePosting(db, { ...careers, sourceId: 's-chips-pid-2', url: 'https://careers.qualcomm.com/careers/job?domain=examplechips.com&pid=446720741799' }, { now: T0, ...identityOf(policy) });
  assert.notEqual(effectiveId(db, third.postingId), effectiveId(db, first.postingId), 'a different pid is another posting');
  const kinds = aliasesFor({ company: 'Example Chips', url: 'https://careers.examplechips.test/careers/job?pid=446720741706' }, identityOf(policy)).map((item) => item.kind);
  assert.ok(!kinds.includes('company_req'), `pid on a host outside jobIdUrlFormats yields no company_req: ${kinds}`);
});

test('[A] a title hit where both sides carry different requisition ids is only flagged, not already_submitted: PIMCO PhD R106815 vs applied Masters R106816 with the shortened shared title (dedupe D2-scope)', async () => {
  const title = 'Quant Research Analyst Intern - Client Solutions & Analytics';
  const pair = { company: 'Example Asset Management',
    lead: { role: title, url: 'https://exampleasset.wd1.myworkdayjobs.com/External/job/Newport-Beach-CA/2027-Summer-Intern---PhD-Quant-Research-Analyst--Client-Solutions---Analytics--US_R106815' },
    applied: { role: title, url: 'https://exampleasset.wd1.myworkdayjobs.com/External/job/Newport-Beach-CA/2027-Summer-Intern---Masters-Quant-Research-Analyst--Client-Solutions---Analytics--US_R106816' } };
  const result = await newListingWith(pair, 510, dupPolicy());
  assert.equal(result.review?.state, 'due', `reviewed normally (code ${result.review?.code})`);
  assert.notEqual(result.review?.code, 'already_submitted');
  assert.deepEqual(suspectedOf(result.db, result.postingId), [`suspected_duplicate:${result.appliedId}`]);
  assert.equal(appliedState(result.db, result.appliedId), result.before, 'the submitted application is untouched');
});

test('[A] same: Nissan "Data Science Intern" Smyrna R00215331 vs applied Franklin R00214250 is flagged, not already_submitted (dedupe D2-scope)', async () => {
  const pair = { company: 'Example Motors Global',
    lead: { role: 'Data Science Intern', url: 'https://examplemotorsglobal.wd1.myworkdayjobs.com/External/job/Smyrna-TN/Data-Science-Intern---Summer-2027---Smyrna--TN_R00215331' },
    applied: { role: 'Data Science Intern', url: 'https://examplemotorsglobal.wd1.myworkdayjobs.com/External/job/Franklin-TN/Data-Science-Intern---Summer-2027---Franklin--TN_R00214250' } };
  const result = await newListingWith(pair, 520, dupPolicy());
  assert.equal(result.review?.state, 'due', `reviewed normally (code ${result.review?.code})`);
  assert.notEqual(result.review?.code, 'already_submitted');
  assert.deepEqual(suspectedOf(result.db, result.postingId), [`suspected_duplicate:${result.appliedId}`]);
  assert.equal(appliedState(result.db, result.appliedId), result.before);
});

test('[A] same official title, the applied side has no URL or id, the new posting is a different job: visible lead with suspected_duplicate, not already_submitted (dedupe D2-noid)', async () => {
  const policy = dupPolicy();
  const pair = { company: 'Example Software',
    lead: { role: 'Summer 2027: Product Manager Intern', url: 'https://jobs.examplesoftware.test/job/mountain-view/summer-2027-product-manager-intern/27595/100620927632' },
    applied: { role: 'Summer 2027: Product Manager Intern', url: null } };
  const result = await newListingWith(pair, 530, policy);
  assert.equal(result.review?.state, 'due', `reviewed normally (code ${result.review?.code})`);
  await deliverWith(result.db, result.postingId, policy);
  const lead = result.db.prepare('SELECT application_id FROM postings WHERE id = ?').get(result.postingId)?.application_id;
  assert.ok(lead && queued(result.db).includes(lead), 'a visible lead');
  assert.notEqual(reviewOf(result.db, result.postingId).code, 'already_submitted');
  assert.deepEqual(suspectedOf(result.db, result.postingId), [`suspected_duplicate:${result.appliedId}`]);
  assert.equal(appliedState(result.db, result.appliedId), result.before);
});

// Official snapshots: fields_json.title is the official page title, text its body.
const OFFICIAL_BODY = 'About the team. Our data science interns join the risk and commerce analytics group to build models that detect payment fraud patterns and forecast merchant growth. You will write SQL and Python, run experiments, and present findings to senior leaders. Summer 2027 internship, twelve weeks, San Jose, CA. Requirements: currently pursuing a graduate degree in statistics, computer science or a related field; experience with machine learning libraries. Benefits include relocation support, mentorship and a final presentation.';
const OTHER_BODY = OFFICIAL_BODY.replace('build models that detect payment fraud patterns and forecast merchant growth', 'design ranking systems for search relevance and marketplace recommendations across regions')
  .replace('run experiments, and present findings to senior leaders', 'ship production pipelines, and partner closely with platform engineers on infrastructure');
function officialSnapshot(db, postingId, { title, text }) {
  db.prepare("INSERT INTO snapshots (id, posting_id, content_hash, fetched_at, final_url, http_status, method, identity_ok, fields_json, sections_json, text) VALUES (?, ?, ?, ?, NULL, 200, 'html', 1, ?, '[]', ?)")
    .run(`s-${postingId}`, postingId, `h-${postingId}`, T0, JSON.stringify({ title }), text);
}

test('[L2] delivery settles a cross-ATS repost as duplicate_submitted when both official snapshot titles are equal and texts are >= 0.9, even though the applied row\'s role is a shortened title (dedupe F2)', async () => {
  const policy = dupPolicy();
  const setup = (text) => {
    const db = freshDb();
    db.prepare("INSERT INTO applications (id, company, role, job_url, status, applied_at, created_at, updated_at) VALUES ('applied-pay', 'Example Pay', 'Data Scientist Intern', ?, 'applied', ?, ?, ?)")
      .run('https://examplepay.eightfold.ai/careers/job/274922982821', at(-10), at(-10), at(-10));
    insertPosting(db, { id: 'p-pay-applied', company: 'Example Pay', title: 'Data Scientist Intern', url: 'https://examplepay.eightfold.ai/careers/job/274922982821', applicationId: 'applied-pay' });
    officialSnapshot(db, 'p-pay-applied', { title: 'Data Scientist Intern - Summer 2027', text: OFFICIAL_BODY });
    insertPosting(db, { id: 'p-pay-new', company: 'Example Pay', title: 'Data Scientist Intern - Summer 2027', url: 'https://examplepay.wd1.myworkdayjobs.com/jobs/job/San-Jose-CA/Data-Scientist-Intern---Summer-2027_R0138582' });
    insertReview(db, { postingId: 'p-pay-new', stage: 'deliver' });
    officialSnapshot(db, 'p-pay-new', { title: 'Data Scientist Intern - Summer 2027', text });
    return db;
  };
  const db = setup(OFFICIAL_BODY);
  await deliverWith(db, 'p-pay-new', policy);
  assert.deepEqual([reviewOf(db, 'p-pay-new').decision, reviewOf(db, 'p-pay-new').code], ['not_eligible', 'duplicate_submitted']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM applications WHERE status = 'lead' AND skip_reason IS NULL").get().n, 0, 'no visible lead');
  const different = setup(OTHER_BODY);
  const result = await deliverWith(different, 'p-pay-new', policy);
  assert.equal(result.action, 'created', `a different body (similarity well below 0.9) is delivered normally: ${reviewOf(different, 'p-pay-new').code}`);
});

test('[A] an alias-table subsidiary with a similar title (Jaccard >= flagSimilarity) is flagged and still reviewed, never withdrawn (dedupe F3)', async () => {
  const aliases = { 'Example Devices IQ': 'Example Devices Inc.' };
  const pair = { company: 'Example Devices', appliedCompany: 'Example Devices IQ',
    lead: { role: 'Software Engineering Intern, AIML Platform - Example Devices IQ', url: 'https://exampledevices.eightfold.ai/careers/job/43322371' },
    applied: { role: 'Software Engineer Intern - AML Platform', url: 'https://job-boards.greenhouse.io/exampledevicesiq/jobs/6114781004' } };
  const flagged = await newListingWith(pair, 540, dupPolicy({ aliases }));
  assert.equal(flagged.review?.state, 'due', `still reviewed (code ${flagged.review?.code})`);
  assert.deepEqual(suspectedOf(flagged.db, flagged.postingId), [`suspected_duplicate:${flagged.appliedId}`]);
  assert.equal(appliedState(flagged.db, flagged.appliedId), flagged.before);
  const strict = await newListingWith(pair, 541, dupPolicy({ aliases, duplicateCheck: { ...DUPLICATE_CHECK, flagSimilarity: 0.7 } }));
  assert.deepEqual(suspectedOf(strict.db, strict.postingId), [], 'below a 0.7 threshold nothing is flagged');
  const missing = await newListingWith(pair, 542, dupPolicy({ aliases, duplicateCheck: null }));
  assert.equal(missing.review?.state, 'due');
  assert.deepEqual(suspectedOf(missing.db, missing.postingId), [], 'without duplicateCheck nothing is flagged');
  assert.ok((missing.counts.warnings ?? []).some((warning) => /duplicateCheck/.test(warning)), `the scan reports the missing block: ${JSON.stringify(missing.counts.warnings)}`);
});

test('[A] company-overrides.json duplicateCheck is validated: a regex that does not compile or a threshold outside 0..1 stops loading (dedupe F3)', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cj-dupcheck-'));
  try {
    const write = (duplicateCheck) => writeFile(path.join(dir, 'company-overrides.json'), JSON.stringify({ duplicateCheck }));
    await write(DUPLICATE_CHECK);
    const loaded = await loadUserOverrides(dir, { sizes: false });
    assert.equal(loaded.duplicateCheck.flagSimilarity, 0.6);
    assert.equal(withOverrides(SCREENING_POLICY, loaded).identityOptions.jobIdFormats.length, 3);
    await write({ ...DUPLICATE_CHECK, jobIdUrlFormats: [{ host: 'google.com', path: '^(unclosed' }] });
    await assert.rejects(loadUserOverrides(dir, { sizes: false }), /duplicateCheck/);
    await write({ ...DUPLICATE_CHECK, flagSimilarity: 1.5 });
    await assert.rejects(loadUserOverrides(dir, { sizes: false }), /duplicateCheck/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Code review 2026-11-10: a title made only of noise words and a year ("Summer Internship Program 2027") filters to an
// empty word set. An identical normalised title always flags; when either filtered set is empty, the unfiltered
// normalised titles are compared against the same threshold.
test('[A] an identical title made only of noise words is still flagged suspected_duplicate; two different all-noise titles are not (dedupe F3-empty)', async () => {
  const policy = dupPolicy();
  const pair = { company: 'Example Logistics',
    lead: { role: 'Summer Internship Program 2027', url: 'https://job-boards.greenhouse.io/examplelogistics/jobs/7700002' },
    applied: { role: 'Summer Internship Program 2027', url: 'https://job-boards.greenhouse.io/examplelogistics/jobs/7700001' } };
  const result = await newListingWith(pair, 550, policy);
  assert.equal(result.review?.state, 'due', `reviewed (code ${result.review?.code})`);
  await deliverWith(result.db, result.postingId, policy);
  const lead = result.db.prepare('SELECT application_id FROM postings WHERE id = ?').get(result.postingId)?.application_id;
  assert.ok(lead && queued(result.db).includes(lead), 'a visible lead');
  assert.deepEqual(suspectedOf(result.db, result.postingId), [`suspected_duplicate:${result.appliedId}`], 'flagged although the filtered titles are empty');
  assert.deepEqual(listQueue(result.db).find((item) => item.id === lead)?.suspectedDuplicateOf, [result.appliedId]);
  // Control: two different titles that are both empty after filtering; unfiltered similarity 1/7 < 0.6.
  const control = await newListingWith({ ...pair, applied: { ...pair.applied, role: 'Fall Co-op Program 2026' } }, 551, policy);
  await deliverWith(control.db, control.postingId, policy);
  assert.deepEqual(suspectedOf(control.db, control.postingId), [], 'different all-noise titles below the threshold are not flagged');
  // The same pair passes when the threshold admits the unfiltered similarity.
  const loose = await newListingWith({ ...pair, applied: { ...pair.applied, role: 'Fall Co-op Program 2026' } }, 552, dupPolicy({ duplicateCheck: { ...DUPLICATE_CHECK, flagSimilarity: 0.1 } }));
  assert.deepEqual(suspectedOf(loose.db, loose.postingId), [`suspected_duplicate:${loose.appliedId}`], 'the unfiltered fallback uses the same threshold');
});

test('[L2] two leads delivered in the same run with the same title and different ids: the second is flagged at delivery (dedupe F4)', async () => {
  const policy = dupPolicy();
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const url = (slugText, id) => `https://examplefarm.wd1.myworkdayjobs.com/External/job/Franklin-TN/${slugText}_R${id}`;
  const records = [
    record({ source: 'simplify', sourceId: 's-farm-1', partition: 'simplify:list', company: 'Example Farm Supply', title: 'Distribution Center Operations Intern', url: url('Distribution-Center-Operations-Intern', '25001') }),
    record({ source: 'simplify', sourceId: 's-farm-2', partition: 'simplify:list', company: 'Example Farm Supply', title: 'Distribution Center Operations Intern', url: url('Distribution-Center-Operations-Intern', '25002') }),
    record({ source: 'simplify', sourceId: 's-farm-3', partition: 'simplify:list', company: 'Example Farm Supply', title: 'Distribution Center HR Intern', url: url('Distribution-Center-HR-Intern', '25003') }),
  ];
  ingestBatch(db, { runId: 'run-f4', source: 'simplify', partition: 'simplify:list', records, now: T0, policy, profile: PROFILE });
  const ids = records.map((item) => postingFor(db, `source:simplify:${item.sourceId}`));
  for (const id of ids) assert.equal(reviewOf(db, id)?.state, 'due', `fixture: ${id} is due`);
  for (const [index, id] of ids.entries()) await deliverWith(db, id, policy, { now: at(index * 0.001) });
  const firstLead = db.prepare('SELECT application_id FROM postings WHERE id = ?').get(ids[0]).application_id;
  assert.ok(firstLead);
  assert.deepEqual(suspectedOf(db, ids[1]), [`suspected_duplicate:${firstLead}`], 'the second lead is flagged at delivery');
  assert.deepEqual(suspectedOf(db, ids[2]), [], 'HR vs Operations is not flagged between leads');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM applications WHERE status = 'lead' AND skip_reason IS NULL").get().n, 3, 'flagged leads stay visible');
});

test('[B] queue rescreen --only dedup --apply withdraws only dedup cases with their own reason, never through delivery; flags suspects; queue list shows and sorts them; programSiblings uses aliases (dedupe F5)', () => {
  const aliases = { 'Example Bank Holdings, Inc.': 'Example Bank' };
  const policy = dupPolicy({ aliases, base: { ...SCREENING_POLICY, companyCap: { max: 1, windowDays: 90 }, companySizes: companySizes({ large: ['Example Bank', 'Excluded Example Co', 'Capped Example Co', 'Flag Example Co'], small: ['Tiny Example Co'] }) } });
  const db = freshDb();
  let n = 0;
  const applied = (company, role, url, { title = role, text = null } = {}) => {
    const id = `applied-f5-${n += 1}`;
    db.prepare("INSERT INTO applications (id, company, role, job_url, status, applied_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'applied', ?, ?, ?)").run(id, company, role, url, at(-10), at(-10), at(-10));
    insertPosting(db, { id: `p-${id}`, company, title: role, url, applicationId: id });
    insertReview(db, { postingId: `p-${id}`, state: 'done', decision: 'reused', code: 'already_submitted', stage: 'deliver' });
    if (text) officialSnapshot(db, `p-${id}`, { title, text });
    return id;
  };
  const lead = (company, role, url, { title = role, text = null } = {}) => {
    const app = seedApplication(db, { company, role });
    db.prepare('UPDATE applications SET job_url = ? WHERE id = ?').run(url, app.id);
    const id = `p-lead-${n += 1}`;
    insertPosting(db, { id, company, title: role, url, applicationId: app.id });
    insertReview(db, { postingId: id, state: 'done', decision: 'eligible', stage: 'deliver' });
    db.prepare('UPDATE reviews SET evidence_json = ? WHERE posting_id = ?').run(JSON.stringify({ fit: ELIGIBLE.fit, location: ELIGIBLE.location }), id);
    if (text) officialSnapshot(db, id, { title, text });
    return { appId: app.id, postingId: id };
  };
  const bankApplied = applied('Example Bank', 'Data Analyst Intern', 'https://careers-exbank.icims.com/jobs/9100001/job');
  const excludedApplied = applied('Excluded Example Co', 'Risk Intern', 'https://excludedexample.eightfold.ai/careers/job/274900000001', { title: 'Risk Intern - Summer 2027', text: OFFICIAL_BODY });
  applied('Capped Example Co', 'Earlier Intern', 'https://job-boards.greenhouse.io/cappedexample/jobs/9100009');
  const flagApplied = applied('Flag Example Co', 'Data Science Intern', 'https://job-boards.greenhouse.io/flagexample/jobs/9100100');
  const sameReq = lead('Example Bank Holdings, Inc.', 'Data Analyst Intern', 'https://careers.examplebank.test/jobs/9100001');
  const bodyDup = lead('Excluded Example Co', 'Risk Intern - Summer 2027', 'https://excludedexample.wd1.myworkdayjobs.com/External/job/Chicago-IL/Risk-Intern---Summer-2027_R0900001', { text: OFFICIAL_BODY });
  const excludedOnly = lead('Excluded Example Co', 'Treasury Intern', 'https://job-boards.greenhouse.io/excludedexample/jobs/9100201');
  const small = lead('Tiny Example Co', 'Data Intern', 'https://job-boards.greenhouse.io/tinyexample/jobs/9100301');
  const capped = lead('Capped Example Co', 'Analytics Intern', 'https://job-boards.greenhouse.io/cappedexample/jobs/9100302');
  const suspect = lead('Flag Example Co', 'Data Science Intern', 'https://job-boards.greenhouse.io/flagexample/jobs/9100101');
  const clean = lead('Flag Example Co', 'Supply Chain Intern', 'https://job-boards.greenhouse.io/flagexample/jobs/9100102');
  const snapshot = () => JSON.stringify({ apps: db.prepare('SELECT * FROM applications ORDER BY id').all(), reviews: db.prepare('SELECT * FROM reviews ORDER BY posting_id').all(),
    events: db.prepare('SELECT * FROM application_events ORDER BY id').all() });
  const before = snapshot();
  const dry = rescreenLeads(db, { policy, now: T0, only: 'dedup' });
  assert.equal(snapshot(), before, 'a dry run writes nothing');
  const byApp = (summary) => Object.fromEntries(summary.results.map((item) => [item.applicationId, item]));
  const planned = byApp(dry);
  assert.equal(planned[sameReq.appId]?.code, 'already_submitted');
  assert.equal(planned[bodyDup.appId]?.code, 'duplicate_submitted');
  assert.equal(planned[suspect.appId]?.code, 'suspected_duplicate');
  for (const other of [excludedOnly, small, capped, clean]) assert.equal(planned[other.appId], undefined, `${other.appId}: no gate other than dedup is applied`);
  const eventsBefore = { excluded: eventsOf(db, excludedOnly.appId).length };
  const applied_ = rescreenLeads(db, { policy, now: T0, only: 'dedup', apply: true });
  const app = (id) => ({ ...db.prepare('SELECT status, skip_reason, skip_owner FROM applications WHERE id = ?').get(id) });
  assert.deepEqual(app(sameReq.appId), { status: 'withdrawn', skip_reason: 'already_submitted', skip_owner: 'review' });
  assert.deepEqual(app(bodyDup.appId), { status: 'withdrawn', skip_reason: 'duplicate_submitted', skip_owner: 'review' }, 'the dedup reason wins over the company exclusion');
  assert.deepEqual([reviewOf(db, bodyDup.postingId).decision, reviewOf(db, bodyDup.postingId).code, reviewOf(db, bodyDup.postingId).state], ['not_eligible', 'duplicate_submitted', 'done']);
  assert.ok(reviewOf(db, bodyDup.postingId).evidence_json.includes(excludedApplied), 'the evidence names the submitted application');
  assert.equal(reviewOf(db, bodyDup.postingId).lease_owner, null, 'the lease is cleared');
  assert.ok(reviewOf(db, sameReq.postingId).evidence_json.includes(bankApplied));
  const withdrawal = db.prepare('SELECT event_type, status_after, note, source_json FROM application_events WHERE application_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1').get(bodyDup.appId);
  const source = JSON.parse(withdrawal.source_json);
  assert.deepEqual([withdrawal.event_type, withdrawal.status_after, withdrawal.note, source.actor, source.kind], ['review_withdrawn', 'withdrawn', 'duplicate_submitted', 'review-worker', 'queue-rescreen-dedup']);
  for (const other of [excludedOnly, small, capped, suspect, clean]) assert.deepEqual(app(other.appId), { status: 'lead', skip_reason: null, skip_owner: null }, `${other.appId} stays a lead`);
  assert.equal(eventsOf(db, excludedOnly.appId).length, eventsBefore.excluded, 'no event for the excluded-only lead');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM review_log WHERE kind = 'delivery'").get().n, 0, '--only dedup never calls deliver');
  assert.ok(applied_.results.every((item) => ['already_submitted', 'duplicate_submitted', 'suspected_duplicate', 'duplicate_lead'].includes(item.code)), JSON.stringify(applied_.results));
  assert.deepEqual(suspectedOf(db, suspect.postingId), [`suspected_duplicate:${flagApplied}`], 'the suspect is flagged, not withdrawn');
  const list = listQueue(db);
  const flaggedItem = list.find((item) => item.id === suspect.appId);
  assert.deepEqual(flaggedItem?.suspectedDuplicateOf, [flagApplied]);
  assert.equal(list.at(-1).id, suspect.appId, `flagged leads sort last: ${list.map((item) => item.id)}`);
  const view = programSiblings(db, { id: sameReq.appId }, null, { companyAliases: policy.companyAliases });
  assert.ok(view.members.some((member) => member.id === bankApplied), 'programSiblings groups the alias spelling with the company');
});
