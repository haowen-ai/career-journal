// Identity volume regressions from the 2026-10-27 real-data rehearsal of the screening funnel (rulings I1–I6).
// The rehearsal held 1,814 postings as user-owned `identity_conflict` and wrote 375,272 `maybe_same` links over
// 22,255 postings. Root causes, read-only from the rehearsal database:
//   - 1,131 conflicts: the Workday "-N posting suffix" rule stripped the body of letter-prefixed ids
//     (R-060024 -> R, MFS-231468 -> MFS, REQ-1178 -> REQ), so every such posting of a company shared one
//     company requisition alias with the first one;
//   - 110: the same rule cut year-numbered ids into year buckets (2026-19993 -> 2026, R2026-0831 -> R2026);
//   - 554: genuine Workday posting suffixes (_10142310-1 / _10142310-2, _2603848 / _2603848-1) and Greenhouse
//     jobs sharing one explicit requisitionId are distinct ATS postings of one requisition, but different ids
//     in the same tenant were treated as a contradiction;
//   - 17: duplicate legacy application rows for one requisition; 2: legacy applications whose job_url is a
//     careers landing page (bare host, /en-us/careers) shared by distinct postings;
//   - 1,430 of the conflicts were on postings that do not matter (no_student_signal, out_of_direction,
//     unlisted-only), yet each was held for the user.
//   - maybe_same: 341,062 links touched a no_student_signal/out_of_direction posting and 27,109 an
//     unlisted-only posting; only 7,101 joined two postings that are reviewed. Titles such as
//     "Software Engineer Intern" or "Full-stack Engineer 4" linked every same-company posting to every other.
// Rulings:
//   I1 A Workday posting suffix is only a trailing -N of one or two digits after a requisition body with at
//      least three digits; the body of a prefixed id and a longer tail are never stripped.
//   I2 Two postings with different ATS ids in the same provider tenant are distinct postings even when they
//      share a company requisition (explicit requisitionId or Workday base). Both are reviewed; they are
//      linked maybe_same, never `conflict`, never held. A record with no ATS id of its own still binds to the
//      requisition through the base. (A posting that would hold two different ids in one scope, such as a
//      fetched page giving requisition R1002 to a posting already carrying R1001, stays a contradiction: I5.)
//   I3 A URL with no provider requisition whose path is only a careers landing page is not an identity alias.
//   I4 Two application rows for one requisition are duplicates, resolved by the system: the most decisive
//      status (submitted) wins for every posting of that requisition; no identity_conflict, no conflict link,
//      no application deleted.
//   I5 A genuine contradiction (one posting with two different ids in one scope, or a source/URL hit whose
//      ids from different providers share no requisition) keeps its conflict link; only a posting that matters
//      (listed, not dropped, not no_student_signal/out_of_direction) is held for the user.
//   I6 maybe_same links stay within one company key, are never made for no_student_signal, out_of_direction
//      or unlisted-only postings, and are capped at 5 per posting among postings without an application;
//      a link to a posting bound to an application is always made.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, seedApplication, reviewOf, applicationsCount, T0 } from '../../test-utils/funnel-v3.mjs';
import { record, SCREENING_POLICY, PROFILE, PROVENANCE } from '../../test-utils/funnel-v3-fixtures.mjs';

const identity = () => load('L1', './src/funnel/identity.mjs', ['aliasesFor', 'duplicateGroups']);
const ingest = () => load('L1', './src/funnel/ingest.mjs', ['ingestBatch']);
const bootstrap = () => load('L1', './src/funnel/bootstrap.mjs', ['bootstrapExisting']);

const CAP = 5;
const SIMPLIFY_PARTIAL = Object.freeze({ locations: 'partial', arrangement: 'unknown', description: 'tags', employment_type: 'absent' });
const SENIOR = Object.freeze({ description: 'Design, build and operate our platform services with a small team. '.repeat(20) });
const workday = (tenant, site, slug, id) => `https://${tenant}.wd5.myworkdayjobs.com/${site}/job/Orlando-FL/${slug}_${id}`;
async function batch(db, records, { runId = 'run-1', now = T0 } = {}) {
  const { ingestBatch } = await ingest();
  return ingestBatch(db, { runId, source: records[0].source, partition: records[0].partition, records, now, policy: SCREENING_POLICY, profile: PROFILE });
}
const postingFor = (db, alias) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(alias)?.posting_id;
const conflictLinks = (db) => db.prepare("SELECT COUNT(*) n FROM posting_links WHERE kind = 'conflict'").get().n;
const identityHolds = (db) => db.prepare("SELECT COUNT(*) n FROM reviews WHERE code = 'identity_conflict'").get().n;
const userHolds = (db) => db.prepare("SELECT COUNT(*) n FROM reviews WHERE state = 'held' AND hold_owner = 'user'").get().n;
const linked = (db, a, b) => Boolean(db.prepare(`SELECT 1 FROM posting_links WHERE kind = 'maybe_same'
  AND ((left_id = ? AND right_id = ?) OR (left_id = ? AND right_id = ?))`).get(a, b, b, a));
const linksOf = (db, id) => db.prepare(`SELECT CASE WHEN left_id = ? THEN right_id ELSE left_id END other FROM posting_links
  WHERE kind = 'maybe_same' AND (left_id = ? OR right_id = ?)`).all(id, id, id).map((row) => row.other);
function legacyApplication(db, { id, role, url, status = 'applied', created = '2026-09-01T00:00:00.000Z', company = 'Example Corp' }) {
  // Applications that predate the funnel have no posting yet; bootstrap binds them.
  db.prepare(`INSERT INTO applications (id, company, role, job_url, status, applied_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, company, role, url, status, ['applied', 'interview'].includes(status) ? created : null, created, created);
}
const postingOfApp = (db, applicationId) => db.prepare('SELECT id FROM postings WHERE application_id = ? AND merged_into IS NULL').get(applicationId)?.id;

// ===================================================================== I1

test('[A] a Workday id keeps its prefixed body; only a one- or two-digit posting suffix yields a base requisition (identity I1)', async () => {
  const { aliasesFor } = await identity();
  const ids = (id) => aliasesFor(record({ source: 'simplify', sourceId: `s-${id}`, partition: 'simplify:list', company: 'Example Health',
    title: '[A] Data Intern (identity I1)', url: workday('examplehealth', 'Careers', 'Data-Intern', id) }))
    .filter((item) => item.kind === 'company_req').map((item) => item.alias.split(':').pop()).sort();
  const cases = {
    'R-060024': ['R-060024'],
    'MFS-231468': ['MFS-231468'],
    'REQ-1178': ['REQ-1178'],
    '2026-19993': ['2026-19993'],
    'R2026-0831': ['R2026-0831'],
    'JR-0087991-1': ['JR-0087991', 'JR-0087991-1'],
    '10142310-2': ['10142310', '10142310-2'],
    '2603848': ['2603848'],
  };
  for (const [id, expected] of Object.entries(cases)) assert.deepEqual(ids(id), expected, `${id}: a letter prefix or a year is part of the requisition, not a posting suffix`);
});

test('[A] one company\'s Workday postings with prefixed or year-numbered ids are distinct postings, all reviewed, none held (identity I1)', async () => {
  const db = freshDb();
  const ids = ['R-0601001', 'R-0601002', 'R-0601003', 'REQ-1178', 'REQ-1194', '2026-19993', '2026-19615', 'R2026-0831', 'R2026-0699'];
  const records = ids.map((id, index) => record({ source: 'simplify', sourceId: `s-i1-${index}`, partition: 'simplify:list', company: 'Example Health',
    title: `[A] ${['Data', 'Quant', 'Analytics', 'Product', 'Insights', 'Strategy', 'Machine Learning', 'BI', 'Program'][index]} Intern (identity I1)`,
    url: workday('examplehealth', 'Careers', `Role-${index}`, id), completeness: SIMPLIFY_PARTIAL }));
  const counts = await batch(db, records);
  assert.equal(counts.newPostings, ids.length, 'each requisition is its own posting');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM postings').get().n, ids.length);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state = 'due' AND lane = 'new'").get().n, ids.length, 'every posting is reviewed in lane new');
  assert.equal(conflictLinks(db), 0, 'distinct requisitions are not a contradiction');
  assert.equal(identityHolds(db), 0);
  for (const bucket of ['R', 'REQ', '2026', 'R2026']) assert.equal(postingFor(db, `company_req:examplehealth:${bucket}`), undefined, `no shared "${bucket}" alias`);
});

// ===================================================================== I2

test('[A] Workday postings of one requisition on two career sites are distinct postings linked maybe_same, never a conflict (identity I2)', async () => {
  const db = freshDb();
  const make = (sourceId, site, slug, id, title) => record({ source: 'simplify', sourceId, partition: 'simplify:list', company: 'Example Co',
    title, url: workday('exampleco', site, slug, id), completeness: SIMPLIFY_PARTIAL });
  const records = [
    make('s-i2-a', 'ExampleCareers', 'Labor-Systems-Intern', '10142310-1', '[A] Labor Systems Intern (identity I2)'),
    make('s-i2-b', 'ExampleCareersDC', 'Labor-Systems-Intern', '10142310-2', '[A] Labor Systems Intern (identity I2)'),
    make('s-i2-c', 'ExampleCareersDC', 'Decision-Science-Product-Intern', '10142055', '[A] Decision Science Product Intern (identity I2)'),
    make('s-i2-d', 'ExampleCareers', 'Decision-Science-Product-Intern', '10142055-1', '[A] Decision Science Product Intern (identity I2)'),
    make('s-i2-e', 'ExampleCareers', 'Power-Systems-Intern', '5054820', '[A] Power Systems Intern (identity I2)'),
    make('s-i2-f', 'ExampleCareers', 'Grid-Foundation-Models-Intern', '5054820-1', '[A] Grid Foundation Models Intern (identity I2)'),
  ];
  await batch(db, records);
  const id = (sourceId) => postingFor(db, `source:simplify:${sourceId}`);
  const all = records.map((item) => id(item.sourceId));
  assert.equal(new Set(all).size, records.length, 'each ATS posting is its own posting');
  for (const postingId of all) {
    const review = reviewOf(db, postingId);
    assert.equal(review.state, 'due', `${postingId}: reviewed, not held`);
    assert.equal(review.lane, 'new');
    assert.equal(review.hold_owner, null);
  }
  assert.equal(conflictLinks(db), 0, 'different ATS ids in one tenant are different postings, not a contradiction');
  assert.equal(identityHolds(db), 0);
  for (const [a, b] of [['s-i2-a', 's-i2-b'], ['s-i2-c', 's-i2-d'], ['s-i2-e', 's-i2-f']]) assert.ok(linked(db, id(a), id(b)), `${a} and ${b} share a requisition: linked maybe_same whatever their titles`);
  // A record that carries the requisition but no ATS id of its own still meets it through the base.
  const counts = await batch(db, [record({ source: 'careerops', sourceId: 'co-i2-1', partition: 'generic:exampleco', company: 'Example Co',
    title: '[A] Labor Systems Intern (identity I2)', url: 'https://careers.example.com/job/labor-systems-intern', requisitionId: '10142310' })], { runId: 'run-2' });
  assert.equal(counts.newPostings, 0, 'the bare requisition binds to the existing posting');
  assert.equal(conflictLinks(db), 0);
});

test('[A] Greenhouse jobs that share an explicit requisition id are distinct postings, reviewed and linked, never held (identity I2)', async () => {
  const db = freshDb();
  const make = (job, title) => record({ sourceId: job, partition: 'greenhouse:examplecorp', url: `https://job-boards.greenhouse.io/examplecorp/jobs/${job}`, requisitionId: 'JR102043', title });
  await batch(db, [make('5833028004', '[A] Finance Analytics Intern (NYC) (identity I2)'), make('6179424004', '[A] Finance Analytics Intern (Chicago) (identity I2)')]);
  const first = postingFor(db, 'source:greenhouse:5833028004');
  const second = postingFor(db, 'source:greenhouse:6179424004');
  assert.ok(first && second && first !== second, 'two Greenhouse jobs are two postings');
  for (const postingId of [first, second]) assert.equal(reviewOf(db, postingId).state, 'due', 'both reviewed');
  assert.equal(conflictLinks(db), 0);
  assert.equal(identityHolds(db), 0);
  assert.ok(linked(db, first, second), 'the shared requisition is recorded as maybe_same');
});

test('[A] legacy applications on a Workday requisition and its -1 posting bind to their own postings without an identity hold (identity I2)', async () => {
  const { bootstrapExisting } = await bootstrap();
  const db = freshDb();
  legacyApplication(db, { id: 'sib-1', role: '[A] AI Platform Engineer Intern (identity I2)', status: 'withdrawn',
    url: workday('examplemarvel', 'Careers', 'AI-Platform-Engineer-Intern', '2603848-1'), created: '2026-09-01T00:00:00.000Z' });
  legacyApplication(db, { id: 'sib-2', role: '[A] AI Platform Engineer Intern (identity I2)', status: 'lead',
    url: workday('examplemarvel', 'Careers2', 'AI-Platform-Engineer-Intern', '2603848'), created: '2026-09-15T00:00:00.000Z' });
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  const one = postingOfApp(db, 'sib-1');
  const two = postingOfApp(db, 'sib-2');
  assert.ok(one && two && one !== two, 'each application keeps its own posting');
  assert.equal(identityHolds(db), 0, 'two ATS postings of one requisition are not an identity conflict');
  assert.equal(conflictLinks(db), 0);
  // Amended for model-decides H2 (2026-10-27): the withdrawal of unknown provenance is re-queued as system work.
  assert.equal(userHolds(db), 0, 'nothing waits for the user (model-decides H2)');
  assert.equal(reviewOf(db, two).state, 'due', 'the lead is refreshed');
  assert.ok(linked(db, one, two));
});

// ===================================================================== I3

test('[A] a careers landing-page URL is not identity: distinct applications sharing it stay apart without a hold (identity I3)', async () => {
  const { aliasesFor } = await identity();
  const { bootstrapExisting } = await bootstrap();
  const db = freshDb();
  const apps = [
    ['land-1', '[A] Data Engineer Intern (identity I3)', 'https://careers.example.com'],
    ['land-2', '[A] Data Scientist Intern (identity I3)', 'https://careers.example.com/'],
    ['land-3', '[A] Masters Data Analytics Program (identity I3)', 'https://www.example.com/en-us/careers'],
    ['land-4', '[A] Decision Science Graduate Program (identity I3)', 'https://www.example.com/en-us/careers/'],
  ];
  apps.forEach(([id, role, url], index) => legacyApplication(db, { id, role, url, created: `2026-09-0${index + 1}T00:00:00.000Z` }));
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  const postings = apps.map(([id]) => postingOfApp(db, id));
  assert.equal(new Set(postings.filter(Boolean)).size, apps.length, 'each application keeps its own posting');
  for (const postingId of postings) {
    const review = reviewOf(db, postingId);
    assert.equal(review.decision, 'reused');
    assert.equal(review.code, 'already_submitted', 'a submitted application stays visible as submitted');
  }
  assert.equal(identityHolds(db), 0);
  assert.equal(conflictLinks(db), 0);
  assert.equal(postingFor(db, 'url:careers.example.com'), undefined, 'a bare host is not an alias');
  assert.equal(postingFor(db, 'url:example.com/en-us/careers'), undefined, 'a careers landing path is not an alias');
  // A job page on the same host remains identity.
  assert.ok(aliasesFor(record({ url: 'https://careers.example.com/job/data-engineer-intern-2027' })).some((item) => item.alias === 'url:careers.example.com/job/data-engineer-intern-2027'));
  assert.ok(aliasesFor(record({ url: 'https://example.com/careers#/jobs/123' })).some((item) => item.alias === 'url:example.com/careers#/jobs/123'));
});

// ===================================================================== I4

test('[A] two application rows for one requisition are resolved by the system: submitted wins, no identity hold, nothing deleted (identity I4)', async () => {
  const { bootstrapExisting } = await bootstrap();
  const { duplicateGroups } = await identity();
  const db = freshDb();
  const url = 'https://job-boards.greenhouse.io/examplecorp/jobs/9000901';
  legacyApplication(db, { id: 'dup-lead', role: '[A] Product Analytics Intern (identity I4)', url, status: 'lead', created: '2026-09-01T00:00:00.000Z' });
  legacyApplication(db, { id: 'dup-applied', role: '[A] Product Analytics Intern - Winter 2027 (identity I4)', url: `${url}?gh_src=board`, status: 'applied', created: '2026-09-15T00:00:00.000Z' });
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  assert.equal(identityHolds(db), 0, 'identical identity is not a contradiction');
  assert.equal(conflictLinks(db), 0);
  assert.equal(applicationsCount(db), 2, 'no application is deleted');
  const postings = new Set([postingOfApp(db, 'dup-lead'), postingOfApp(db, 'dup-applied'), postingFor(db, 'req:greenhouse:examplecorp:9000901')].filter(Boolean));
  assert.ok(postings.size >= 1);
  for (const postingId of postings) {
    const review = reviewOf(db, postingId);
    assert.ok(review, `${postingId} has a review`);
    assert.equal(review.decision, 'reused', `${postingId}: the requisition was already submitted`);
    assert.equal(review.code, 'already_submitted');
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state IN ('due','leased','held')").get().n, 0, 'no work and no question for a submitted requisition');
  const group = duplicateGroups(db).find((item) => item.applicationIds.includes('dup-lead'));
  assert.deepEqual(group?.applicationIds, ['dup-applied', 'dup-lead'], 'the duplicate rows are reported for the tracker');
});

// ===================================================================== I5

test('[A] a genuine identity contradiction is held for the user only when the posting matters (identity I5)', async () => {
  const db = freshDb();
  // Each Simplify listing was first seen on a Greenhouse job, then re-pointed to a Workday requisition.
  const cases = [
    ['matters', '[A] Data Science Intern (identity I5)', {}, true],
    ['no_student_signal', '[A] Network Engineer (identity I5)', SENIOR, false],
    ['out_of_direction', '[A] Chip Layout Intern (identity I5)', { categories: ['Hardware'] }, false],
    ['unlisted-only', '[A] Analytics Intern (identity I5)', { listed: false }, false],
  ];
  let run = 0;
  for (const [name, title, extra, userOwned] of cases) {
    const sourceId = `s-i5-${name}`;
    const job = 9500000 + run;
    await batch(db, [record({ source: 'simplify', sourceId, partition: 'simplify:list', title, url: `https://job-boards.greenhouse.io/examplecorp/jobs/${job}`, completeness: SIMPLIFY_PARTIAL, ...extra })], { runId: `run-${run += 1}` });
    await batch(db, [record({ source: 'simplify', sourceId, partition: 'simplify:list', title, url: workday('examplecorp', 'Careers', 'Role', `R95${job}`), completeness: SIMPLIFY_PARTIAL, ...extra })], { runId: `run-${run += 1}` });
    const fresh = postingFor(db, `req:workday:examplecorp:R95${job}`);
    assert.ok(fresh, `${name}: the re-pointed requisition is its own posting`);
    assert.notEqual(fresh, postingFor(db, `source:simplify:${sourceId}`), `${name}: never merged into the Greenhouse posting`);
    const review = reviewOf(db, fresh);
    if (userOwned) {
      assert.equal(review.state, 'held', name);
      assert.equal(review.code, 'identity_conflict', name);
      assert.equal(review.hold_owner, 'user', `${name}: a posting that matters asks the user`);
    } else {
      assert.notEqual(review?.hold_owner, 'user', `${name}: a posting that does not matter never asks the user`);
    }
  }
  assert.equal(conflictLinks(db), cases.length, 'every contradiction keeps its conflict link for audit');
  assert.equal(userHolds(db), 1);
});

// ===================================================================== I6

test('[A] maybe_same links are capped per posting, and a posting bound to an application is always linked (identity I6)', async () => {
  const { bootstrapExisting } = await bootstrap();
  const db = freshDb();
  const applied = seedApplication(db, { company: 'Example Corp', role: '[A] Software Engineer Intern (identity I6)', status: 'applied',
    jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/9400000', appliedAt: '2026-09-29T00:00:00Z' });
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  const appPosting = postingOfApp(db, applied.id);
  const teams = 'ABCDEFGHIJKLMNOPQRSTUVWXY'.split('');
  await batch(db, teams.map((team, index) => record({ sourceId: `${9400001 + index}`, url: `https://job-boards.greenhouse.io/examplecorp/jobs/${9400001 + index}`,
    title: `[A] Software Engineer Intern - Team ${team} (identity I6)` })));
  const fresh = teams.map((team, index) => postingFor(db, `source:greenhouse:${9400001 + index}`));
  for (const postingId of fresh) {
    const others = linksOf(db, postingId);
    assert.ok(others.includes(appPosting), `${postingId}: a possible duplicate of a submitted posting is always flagged`);
    assert.ok(others.filter((other) => other !== appPosting).length <= CAP, `${postingId}: ${others.length - 1} links to postings without an application (cap ${CAP})`);
  }
  const total = db.prepare("SELECT COUNT(*) n FROM posting_links WHERE kind = 'maybe_same'").get().n;
  assert.ok(total <= teams.length * (CAP + 1), `links grow linearly, not quadratically: ${total}`);
});

test('[A] no maybe_same links for no_student_signal, out_of_direction or unlisted-only postings, nor across companies (identity I6)', async () => {
  const db = freshDb();
  const gh = (job, title, extra = {}) => record({ sourceId: `${job}`, url: `https://job-boards.greenhouse.io/examplecorp/jobs/${job}`, title, ...extra });
  const quiet = [];
  for (let n = 0; n < 6; n += 1) quiet.push(gh(9600000 + n, `[A] Full-stack Engineer 4 - Group ${n} (identity I6)`, SENIOR));          // no_student_signal
  for (let n = 0; n < 4; n += 1) quiet.push(gh(9600100 + n, `[A] Data Science Intern - Lab ${n} (identity I6)`, { listed: false })); // unlisted-only
  const loud = [
    gh(9600200, '[A] Data Science Intern - Team A (identity I6)'),
    gh(9600201, '[A] Data Science Intern - Team B (identity I6)'),
    gh(9600202, '[A] Full-stack Engineer 4 Intern (identity I6)'),
    gh(9600203, '[A] Data Science Intern - Team C (identity I6)', { company: 'Other Example LLC', partition: 'greenhouse:otherexample' }),
  ];
  await batch(db, [...quiet, ...loud]);
  const hardware = [0, 1, 2, 3].map((n) => record({ source: 'simplify', sourceId: `s-i6-hw-${n}`, partition: 'simplify:list', categories: ['Hardware'],
    title: `[A] Chip Layout Intern - Site ${n} (identity I6)`, url: `https://job-boards.greenhouse.io/examplecorp/jobs/${9600300 + n}`, completeness: SIMPLIFY_PARTIAL })); // out_of_direction
  await batch(db, hardware, { runId: 'run-2' });
  const id = (item) => postingFor(db, `source:${item.source}:${item.sourceId}`);
  assert.equal(reviewOf(db, id(quiet[0])).lane, 'no_student_signal', 'fixture: senior titles are no_student_signal');
  assert.equal(reviewOf(db, id(hardware[0])).lane, 'out_of_direction', 'fixture: hardware-only Simplify records are out_of_direction');
  assert.equal(reviewOf(db, id(quiet[6])), undefined, 'fixture: unlisted-only postings open no review');
  for (const item of [...quiet, ...hardware]) assert.deepEqual(linksOf(db, id(item)), [], `${item.title}: no maybe_same links`);
  assert.ok(linked(db, id(loud[0]), id(loud[1])), 'two reviewed postings with similar titles are still linked');
  assert.ok(!linked(db, id(loud[0]), id(loud[3])) && !linked(db, id(loud[1]), id(loud[3])), 'never across company keys');
  for (const review of db.prepare('SELECT flags_json FROM reviews').all()) {
    const flagged = JSON.parse(review.flags_json).filter((flag) => String(flag).startsWith('maybe_same:')).map((flag) => flag.slice('maybe_same:'.length));
    for (const item of [...quiet, ...hardware]) assert.ok(!flagged.includes(id(item)), 'no review flag points at a quiet posting');
  }
});
