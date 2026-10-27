// Volume regressions from the 2026-10-26 real-data rehearsal of the screening funnel (rulings V1–V3; rulings U1–U2 from the third rehearsal are at the end).
// A census of 22,736 raw CareerOps records (company-wide boards, mostly senior and full-time roles) put
// 8,896 reviews in lane `new` because the no-student-signal lane required a full description and generic
// description words ("students") counted as a signal, and ingest spent 50+ minutes in per-record
// full-table reads. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { freshDb, load, reviewOf, insertPosting, insertReview, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { record, PROFILE, SCREENING_POLICY, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { parseCareerOpsRoles } from '../../src/scan/sources/careerops.mjs';
import { parseSimplify } from '../../src/scan/sources/simplify.mjs';

const classify = () => load('L1', './src/funnel/classify.mjs', ['classifyRole']);
const ingest = () => load('L1', './src/funnel/ingest.mjs', ['ingestBatch']);
const worker = () => load('B6', './src/review/worker.mjs', ['runReview']);
const FULL_TIME = Object.freeze({ search: { jobType: 'full-time', countries: ['US'] } });
const CO_OP = Object.freeze({ search: { jobType: 'co-op', countries: ['US'] } });
const LONG = (text) => `${text} `.repeat(12);
const laneOf = (classifyRole, overrides, profile = PROFILE) => classifyRole(record(overrides), { policy: SCREENING_POLICY, profile });

// A company-wide careers-page boilerplate: it talks about students and graduates without offering a program.
const BOILERPLATE = 'We build reliable infrastructure for millions of customers. We partner with universities and support students, graduates and experienced professionals across our communities. Equal opportunity employer.';
const SENIOR_TITLES = ['Senior System Security Software Engineer', 'Network Engineer', 'Director, Sales Operations', 'Staff Data Platform Engineer'];

// ===================================================================== V1

test('[A] a senior title whose full description mentions students only in boilerplate goes to the no_student_signal lane (volume V1)', async () => {
  const { classifyRole } = await classify();
  for (const title of SENIOR_TITLES) {
    const result = laneOf(classifyRole, { title, description: LONG(BOILERPLATE) });
    assert.equal(result.kind, 'review', `${title}: never dropped`);
    assert.equal(result.lane, 'no_student_signal', `${title}: generic "students"/"graduates" in the description is not a student signal`);
    assert.ok(result.flags.includes('no_student_signal'), title);
  }
  // Full-time searches are unaffected: the lane exists only for internship and co-op searches.
  for (const overrides of [{ title: 'Network Engineer', description: LONG(BOILERPLATE) },
    { title: 'Network Engineer', description: '', completeness: { locations: 'partial', arrangement: 'unknown', description: 'none', employment_type: 'absent' } }]) {
    const fullTime = laneOf(classifyRole, overrides, FULL_TIME);
    assert.equal(fullTime.kind, 'review');
    assert.equal(fullTime.lane, 'new', 'full-time search');
    assert.ok(!fullTime.flags.includes('no_student_signal'), 'full-time search');
  }
});

test('[A] generic student words in the description are not a student signal; each alone leaves the record in no_student_signal (volume V1)', async () => {
  const { classifyRole } = await classify();
  const generic = [
    'Students are welcome to attend our open tech talks.',
    'We sponsor a student hackathon every spring.',
    'A graduate degree in engineering is a plus.',
    'Graduates of coding bootcamps are encouraged to apply.',
    'If you are currently enrolled in a degree program, see our separate careers page.',
    'Our founders are proud members of the class of 2011.',
    'You will collaborate with fellow engineers across time zones.',
    'Applicants must be residents of the United States.',
  ];
  for (const sentence of generic) {
    const result = laneOf(classifyRole, { title: 'Network Engineer', description: LONG(`Design and operate our backbone network. ${sentence}`) });
    assert.equal(result.lane, 'no_student_signal', `"${sentence}" alone must not count as a student signal`);
  }
  for (const profile of [PROFILE, CO_OP]) {
    assert.equal(laneOf(classifyRole, { title: 'Network Engineer', description: LONG(BOILERPLATE) }, profile).lane, 'no_student_signal', profile.search.jobType);
  }
});

test('[A] a record with no student signal goes to no_student_signal whatever its description completeness; student titles stay new (volume V1)', async () => {
  const { classifyRole } = await classify();
  const cases = [
    ['absent description (raw CareerOps)', { source: 'careerops', description: '', completeness: { locations: 'partial', arrangement: 'unknown', description: 'none', employment_type: 'absent' } }],
    ['missing description field', { description: undefined, completeness: { locations: 'partial', arrangement: 'unknown', employment_type: 'absent' } }],
    ['truncated description', { description: 'Design and operate our backbone network. We partner with', completeness: { locations: 'complete', arrangement: 'unknown', description: 'partial', employment_type: 'absent' } }],
    ['tag-only description', { source: 'simplify', description: 'Sponsorship: Offers Sponsorship', completeness: { locations: 'partial', arrangement: 'unknown', description: 'tags', employment_type: 'absent' } }],
    ['full boilerplate description', { description: LONG(BOILERPLATE) }],
  ];
  for (const title of SENIOR_TITLES) {
    for (const [name, overrides] of cases) {
      const result = laneOf(classifyRole, { title, ...overrides });
      assert.equal(result.kind, 'review', `${title} / ${name}: never dropped`);
      assert.equal(result.lane, 'no_student_signal', `${title} / ${name}`);
      assert.ok(result.flags.includes('no_student_signal'), `${title} / ${name}`);
    }
  }
  // The student signal is read from the title and categories/department: those records stay in lane new.
  const signals = [
    { title: 'Software Engineering Intern' },
    { title: 'Data Science Internship, Summer 2027' },
    { title: 'Mechanical Engineering Co-op' },
    { title: 'Apprentice Network Technician' },
    { title: 'Software Engineer', categories: ['Internships'] },
    { title: 'Software Engineer', categories: ['Early Career', 'Engineering'] },
  ];
  for (const overrides of signals) {
    for (const [name, description] of cases) {
      const result = laneOf(classifyRole, { ...description, ...overrides });
      assert.equal(result.lane, 'new', `${overrides.title} ${JSON.stringify(overrides.categories ?? [])} / ${name}`);
      assert.ok(!result.flags.includes('no_student_signal'), `${overrides.title} / ${name}`);
    }
  }
});

test('[A] explicit program phrases in the description are a student signal (volume V1)', async () => {
  const { classifyRole } = await classify();
  const phrases = [
    'You will mentor an intern each summer.',
    'You will work alongside our interns.',
    'This is a paid internship.',
    'This is a six-month co-op placement.',
    'This is a coop term in our Chicago office.',
    'You will join as an apprentice.',
    'This two-year apprenticeship pairs you with a mentor.',
    'Join us as a Summer 2027 Intern.',
    'Join us as a summer 2027 analyst.',
    'Join us as a Summer 2028 Associate.',
    'Our summer 2027 program runs ten weeks.',
    'This role is part of our graduate program.',
    'This role is part of our early career program.',
    'Apply through our university program.',
    'Apply through our campus program.',
  ];
  for (const sentence of phrases) {
    const result = laneOf(classifyRole, { title: 'Data Analyst', description: LONG(`Analyse revenue data for our finance team. ${sentence}`) });
    assert.equal(result.lane, 'new', `"${sentence}" is an explicit program phrase`);
  }
});

test('[A] a raw CareerOps company-board batch puts senior roles in no_student_signal and student titles in new (volume V1)', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const titles = [...SENIOR_TITLES, 'Software Engineering Intern', 'Data Science Co-op'];
  const records = parseCareerOpsRoles({ roles: titles.map((title, index) => ({
    id: `https://boards.greenhouse.io/syntheticco/jobs/${7100 + index}`, company: 'Synthetic Co', title,
    url: `https://boards.greenhouse.io/syntheticco/jobs/${7100 + index}`, locations: ['Chicago, IL'], description: '' })) });
  const counts = ingestBatch(db, { runId: 'scan-v1', source: 'careerops', partition: 'all', records, now: T0, policy: SCREENING_POLICY, profile: PROFILE });
  assert.equal(counts.review, titles.length, 'every record is reviewed, none dropped');
  const lanes = Object.fromEntries(db.prepare('SELECT p.title, r.lane FROM reviews r JOIN postings p ON p.id = r.posting_id').all().map((row) => [row.title, row.lane]));
  for (const title of SENIOR_TITLES) assert.equal(lanes[title], 'no_student_signal', title);
  assert.equal(lanes['Software Engineering Intern'], 'new');
  assert.equal(lanes['Data Science Co-op'], 'new');
});

// ===================================================================== V2

function queue(db) {
  const pages = {};
  return {
    pages,
    add({ id, now = T0, lane = 'new', flags = [] }) {
      const url = `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
      insertPosting(db, { id, url, title: snapshotTitle(SNAPSHOTS.eligible), firstSeen: now });
      insertReview(db, { postingId: id, stage: 'fetch', firstSeen: now, nextDue: now, lane, flags });
      pages[url] = page(url, SNAPSHOTS.eligible);
      return id;
    },
  };
}
const eligibleJudges = () => ({
  primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) }),
  escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }),
});
const runOptions = (db, { now, runId, budget, pages, judges = eligibleJudges() }) => ({
  db, runId, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
  fetcher: fakeFetcher(pages), judges, inputs: () => reviewInputs(), hooks: {},
});
const judged = (judges, id) => [...judges.primary.calls, ...judges.escalation.calls].some((call) => call.request.postingId === id);

test('[B] lane no_student_signal is never promoted by age, however old (volume V2)', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  const q = queue(db);
  const id = q.add({ id: 'p-nosignal', lane: 'no_student_signal', flags: ['no_student_signal'] });
  for (const day of [15, 30, 60]) {
    await runReview(runOptions(db, { now: at(day), runId: `review-${day}`, budget: 0, pages: q.pages }));
    assert.equal(reviewOf(db, id).lane, 'no_student_signal', `day ${day}: no aged promotion for this lane`);
    assert.equal(reviewOf(db, id).state, 'due', `day ${day}: still waiting, never dropped`);
  }
});

test('[B] exploration samples no_student_signal oldest-first, other lanes still age, and the receipt reports the lane backlog (volume V2)', async () => {
  const { runReview } = await worker();
  const db = freshDb();
  const q = queue(db);
  const now = at(30);
  // Three no-signal items far past any age threshold, an aged item from another lane, and fresh arrivals.
  const oldest = q.add({ id: 'p-ns-30', now: at(0), lane: 'no_student_signal', flags: ['no_student_signal'] });
  const middle = q.add({ id: 'p-ns-20', now: at(10), lane: 'no_student_signal', flags: ['no_student_signal'] });
  const newest = q.add({ id: 'p-ns-16', now: at(14), lane: 'no_student_signal', flags: ['no_student_signal'] });
  const agedNew = q.add({ id: 'p-new-aged', now: at(27) });
  for (let i = 0; i < 12; i += 1) q.add({ id: `p-new-${String(i).padStart(2, '0')}`, now });
  const judges = eligibleJudges();
  // Budget 10: the exploration share is max(1, ceil(10 * 10%)) = 1 attempt for the no-signal lane.
  const receipt = await runReview(runOptions(db, { now, runId: 'review-30', budget: 10, pages: q.pages, judges }));
  assert.ok(judged(judges, oldest), 'the oldest no-signal item receives the exploration attempt');
  assert.ok(!judged(judges, middle) && !judged(judges, newest), 'only the exploration share is spent on the no-signal lane; age gives it no aged priority');
  assert.ok(judged(judges, agedNew), 'other lanes keep their aged reserve');
  for (const id of [middle, newest]) {
    assert.equal(reviewOf(db, id).lane, 'no_student_signal', `${id} keeps its lane`);
    assert.equal(reviewOf(db, id).state, 'due', `${id} waits for a later exploration`);
  }
  const backlog = receipt.backlog?.no_student_signal;
  assert.equal(backlog?.due, 2, `the receipt counts the waiting no-signal items: ${JSON.stringify(receipt.backlog)}`);
  assert.equal(Math.round(backlog?.oldest_days), 20, 'the receipt reports the oldest waiting no-signal age in days');
});

// ===================================================================== V3

const BIG_TABLES = ['postings', 'applications', 'posting_aliases', 'posting_links', 'observations', 'observation_sightings', 'reviews', 'review_log', 'posting_partitions'];
const COMPANIES = 500;
const TITLES = ['Software Engineer', 'Senior Software Engineer', 'Data Analyst', 'Network Engineer', 'Product Manager', 'Director, Sales',
  'Security Engineer', 'Site Reliability Engineer', 'Data Science Intern', 'Software Engineering Intern', 'Account Executive', 'Recruiter'];
const company = (i) => `Synthetic Co ${String(i % COMPANIES).padStart(3, '0')}`;
const board = (i) => `syntheticco${String(i % COMPANIES).padStart(3, '0')}`;
const jobUrl = (i) => `https://job-boards.greenhouse.io/${board(i)}/jobs/${8_000_000 + i}`;
const jobTitle = (i) => `${TITLES[i % TITLES.length]}${i % 3 ? `, Team ${i % 97}` : ''}`;

function seedVolume(db, { postings, applications }) {
  const insertPostingRow = db.prepare(`INSERT INTO postings (id, company, title, canonical_url, first_seen, last_seen, listed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  const insertAlias = db.prepare("INSERT INTO posting_aliases (alias, posting_id, kind, created_at) VALUES (?, ?, 'url', ?)");
  const insertReviewRow = db.prepare(`INSERT INTO reviews (posting_id, stage, state, lane, flags_json, attempts, paid_attempts, lost_attempts, next_due,
      lease_generation, evidence_json, dep_hashes_json, deadline_json, first_seen, updated_at) VALUES (?, 'fetch', 'due', 'new', '[]', 0, 0, 0, ?, 0, '{}', '{}', '{}', ?, ?)`);
  const insertApplication = db.prepare(`INSERT INTO applications (id, company, role, external_id, job_url, status, applied_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const bind = db.prepare('UPDATE postings SET application_id = ? WHERE id = ?');
  const seenAt = at(-5);
  db.exec('BEGIN');
  for (let i = 0; i < postings; i += 1) {
    const id = `seed-${i}`;
    const url = jobUrl(i);
    insertPostingRow.run(id, company(i), jobTitle(i), url.replace(/^https:\/\//, ''), seenAt, seenAt, seenAt, seenAt);
    insertAlias.run(`url:${url.replace(/^https:\/\//, '')}`, id, seenAt);
    insertReviewRow.run(id, seenAt, seenAt, seenAt);
  }
  for (let i = 0; i < applications; i += 1) {
    const postingIndex = i * Math.floor(postings / applications);
    const applied = i % 5 === 0;
    insertApplication.run(`app-${i}`, company(postingIndex), jobTitle(postingIndex), `posting:seed-${postingIndex}`, jobUrl(postingIndex),
      applied ? 'applied' : 'lead', applied ? seenAt : null, seenAt, seenAt);
    bind.run(`app-${i}`, `seed-${postingIndex}`);
  }
  db.exec('COMMIT');
}

// Wraps db.prepare: counts every statement execution and the rows it returns, and asks SQLite for each distinct
// statement's query plan. A plan that scans a large table (or builds an automatic index over one) is a full-table read.
function instrument(db, { startedAt, wallLimitMs, rowBudget, scanLimit }) {
  const original = db.prepare;
  const tables = new Set(original.call(db, "SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const plans = new Map();
  const stats = { executions: 0, rows: 0, scans: new Map() };
  const fullReads = (sql) => {
    if (plans.has(sql)) return plans.get(sql);
    const aliases = new Map();
    for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][\w]*)(?:\s+(?:AS\s+)?([A-Za-z_][\w]*))?/gi)) {
      if (match[2] && !/^(?:WHERE|JOIN|ON|LEFT|INNER|CROSS|GROUP|ORDER|LIMIT|UNION|SET|VALUES)$/i.test(match[2])) aliases.set(match[2], match[1]);
    }
    let detail = [];
    try { detail = original.call(db, `EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail); } catch { detail = []; }
    const big = (name) => { const table = tables.has(name) ? name : aliases.get(name); return table && BIG_TABLES.includes(table) ? table : null; };
    const hits = detail.filter((line) => {
      const scan = /^SCAN (\S+)/.exec(line);
      if (scan && big(scan[1])) return true;
      const automatic = /^SEARCH (\S+) USING AUTOMATIC/.exec(line);
      return Boolean(automatic && big(automatic[1]));
    });
    plans.set(sql, hits);
    return hits;
  };
  const guard = (sql) => {
    stats.executions += 1;
    if (performance.now() - startedAt > wallLimitMs) throw new Error(`VOLUME ABORT: ingest exceeded ${wallLimitMs} ms`);
    const hits = fullReads(sql);
    if (hits.length) {
      const seen = (stats.scans.get(sql)?.count ?? 0) + 1;
      stats.scans.set(sql, { count: seen, plan: hits });
      if (seen > scanLimit) throw new Error(`VOLUME ABORT: a full-table read ran more than ${scanLimit} times: ${sql.replace(/\s+/g, ' ').trim()} -> ${hits.join(' | ')}`);
    }
  };
  const count = (rows) => {
    stats.rows += rows;
    if (stats.rows > rowBudget) throw new Error(`VOLUME ABORT: ingest read more than ${rowBudget} rows`);
  };
  db.prepare = function prepare(sql, ...rest) {
    const statement = original.call(db, sql, ...rest);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property === 'all') return (...args) => { guard(sql); const rows = value.apply(target, args); count(rows.length); return rows; };
        if (property === 'get') return (...args) => { guard(sql); const row = value.apply(target, args); count(row ? 1 : 0); return row; };
        if (property === 'run') return (...args) => { guard(sql); return value.apply(target, args); };
        if (property === 'iterate') return (...args) => { guard(sql); const iterator = value.apply(target, args); return (function* rows() { for (const row of iterator) { count(1); yield row; } })(); };
        return value.bind(target);
      },
    });
  };
  return { stats, restore: () => { db.prepare = original; } };
}

test('[A] ingestBatch of 5,000 records into 5,000 postings and 1,000 applications finishes under 20 s with no per-record full-table read (volume V3)', { timeout: 60_000 }, async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const EXISTING = 5_000;
  seedVolume(db, { postings: EXISTING, applications: 1_000 });
  // 1,000 re-sightings of existing postings bound to applications (a fifth submitted), then 4,000 new company-board roles.
  const raw = [];
  for (let i = 0; i < 1_000; i += 1) raw.push(i * 5);
  for (let i = 0; i < 4_000; i += 1) raw.push(EXISTING + i);
  const records = parseCareerOpsRoles({ roles: raw.map((i) => ({ id: jobUrl(i), company: company(i), title: jobTitle(i), url: jobUrl(i),
    locations: ['Chicago, IL'], description: i % 4 ? '' : LONG(`${jobTitle(i)} at ${company(i)}. ${BOILERPLATE}`) })) });
  assert.equal(records.length, 5_000);
  const startedAt = performance.now();
  // A linear read budget: 200 rows per record on average. One full read of postings per record would be ~37 million.
  const probe = instrument(db, { startedAt, wallLimitMs: 20_000, rowBudget: 200 * records.length, scanLimit: 3 });
  let counts;
  let failure;
  try {
    counts = ingestBatch(db, { runId: 'scan-volume', source: 'careerops', partition: 'all', records, now: T0, policy: SCREENING_POLICY, profile: PROFILE });
  } catch (error) { failure = error; } finally { probe.restore(); }
  const elapsed = performance.now() - startedAt;
  const scans = [...probe.stats.scans].map(([sql, { count, plan }]) => `${count}x ${sql.replace(/\s+/g, ' ').trim()} -> ${plan.join(' | ')}`);
  assert.equal(failure, undefined, `${failure?.message}\nfull-table reads so far:\n${scans.join('\n')}`);
  assert.ok(elapsed < 20_000, `ingest took ${Math.round(elapsed)} ms (limit 20,000 ms)`);
  assert.equal(counts.observed, 5_000);
  assert.equal(counts.newPostings, 4_000, 'every re-sighting resolves to its existing posting');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM postings').get().n, EXISTING + 4_000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reviews').get().n, EXISTING + 4_000, 'every posting has exactly one review');
  assert.ok(counts.reused >= 200, 'postings bound to submitted applications are reused');
});

// ===================================================================== U1
// Rulings U1–U2 come from the third real-data rehearsal census (2026-10-27): of 14,201 due reviews in lane `new`,
// 10,016 belonged to postings whose only observations were unlisted (Simplify `active: false` / `is_visible: false`),
// and 1,047 listed Simplify records were category Hardware. Synthetic data only.

const postingFor = (db, alias) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(alias)?.posting_id;
const PENDING = ['due', 'leased', 'held', 'failed'];
const simplifyListing = (id, overrides = {}) => ({ id, company_name: 'Synthetic Devices', title: 'Data Science Intern', url: `https://careers.synthetic.test/jobs/${id}`,
  locations: ['Chicago, IL'], terms: ['Summer 2027'], active: true, is_visible: true, date_posted: 1793000000, ...overrides });
const census = (ingestBatch, db, { runId, partition = 'simplify:1', listings, now = T0, profile = PROFILE }) =>
  ingestBatch(db, { runId, source: 'simplify', partition, records: parseSimplify(listings, { partition }), now, policy: SCREENING_POLICY, profile });

test('[A] a first-seen unlisted record keeps its posting and observation but opens no due review until a later census lists it (volume U1)', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const unlisted = [
    simplifyListing('u-inactive', { title: 'Machine Learning Intern', active: false }),
    simplifyListing('u-hidden', { title: 'Data Analyst Intern', is_visible: false }),
    simplifyListing('u-both', { title: 'Product Analytics Co-op', active: false, is_visible: false }),
  ];
  const listed = simplifyListing('l-open', { title: 'Data Engineering Intern' });
  const first = census(ingestBatch, db, { runId: 'scan-1', listings: [...unlisted, listed] });
  assert.equal(first.observed, 4);
  assert.equal(first.quarantined, 0);
  // Any source: an Ashby isListed=false (or Greenhouse inactive) record follows the same rule.
  ingestBatch(db, { runId: 'scan-1', source: 'ashby', partition: 'ashby:examplecorp', now: T0, policy: SCREENING_POLICY, profile: PROFILE,
    records: [record({ source: 'ashby', sourceId: 'a-hidden', url: 'https://jobs.ashbyhq.com/examplecorp/a-hidden', partition: 'ashby:examplecorp', listed: false })] });
  const unlistedIds = [...unlisted.map((item) => postingFor(db, `source:simplify:${item.id}`)), postingFor(db, 'source:ashby:a-hidden')];
  for (const id of unlistedIds) {
    assert.ok(id, 'conservation: the unlisted record still resolves to a posting');
    assert.equal(db.prepare('SELECT listed FROM postings WHERE id = ?').get(id).listed, 0, `${id}: posting kept as unlisted`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM observations WHERE posting_id = ? AND listed = 0').get(id).n, 1, `${id}: observation kept`);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM observation_sightings WHERE posting_id = ? AND run_id = 'scan-1'").get(id).n, 1, `${id}: sighting kept`);
    const review = reviewOf(db, id);
    assert.ok(!review || !PENDING.includes(review.state),
      `${id}: an unlisted-only posting with no prior review never opens a pending review (got ${JSON.stringify(review && { state: review.state, lane: review.lane })})`);
  }
  const open = reviewOf(db, postingFor(db, `source:simplify:${listed.id}`));
  assert.deepEqual([open?.state, open?.lane], ['due', 'new'], 'a listed record in the same census opens its review normally');

  // A later census that lists the same postings opens their due reviews normally.
  census(ingestBatch, db, { runId: 'scan-2', now: at(1), listings: [...unlisted.map((item) => ({ ...item, active: true, is_visible: true })), listed] });
  ingestBatch(db, { runId: 'scan-2', source: 'ashby', partition: 'ashby:examplecorp', now: at(1), policy: SCREENING_POLICY, profile: PROFILE,
    records: [record({ source: 'ashby', sourceId: 'a-hidden', url: 'https://jobs.ashbyhq.com/examplecorp/a-hidden', partition: 'ashby:examplecorp', listed: true })] });
  for (const id of unlistedIds) {
    const review = reviewOf(db, id);
    assert.equal(review?.state, 'due', `${id}: listed=true in a later census opens a due review`);
    assert.equal(review.lane, 'new', `${id}: student title, lane new`);
    assert.ok(review.next_due <= at(1), `${id}: due now`);
    assert.equal(db.prepare('SELECT listed FROM postings WHERE id = ?').get(id).listed, 1);
  }
});

test('[A] a posting listed in any partition of the census opens its review; an existing review keeps today\'s closure rules when later seen unlisted (volume U1)', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  // The same posting in two Simplify lists of one census, unlisted in one and listed in the other, in both orders.
  const shared = (id) => simplifyListing(id, { title: 'Data Science Intern' });
  census(ingestBatch, db, { runId: 'scan-1', partition: 'simplify:1', listings: [{ ...shared('m-unlisted-first'), active: false }, shared('m-listed-first')] });
  census(ingestBatch, db, { runId: 'scan-1', partition: 'simplify:2', listings: [shared('m-unlisted-first'), { ...shared('m-listed-first'), active: false }] });
  for (const sourceId of ['m-unlisted-first', 'm-listed-first']) {
    const review = reviewOf(db, postingFor(db, `source:simplify:${sourceId}`));
    assert.deepEqual([review?.state, review?.lane], ['due', 'new'], `${sourceId}: listed in one partition, so the posting is not unlisted-only`);
  }
  // A posting that already has a review: an unlisted sighting does not close it; only absence from every partition does.
  census(ingestBatch, db, { runId: 'scan-2', partition: 'simplify:1', now: at(1), listings: [shared('e-existing')] });
  assert.equal(reviewOf(db, postingFor(db, 'source:simplify:e-existing'))?.state, 'due');
  census(ingestBatch, db, { runId: 'scan-3', partition: 'simplify:1', now: at(2), listings: [{ ...shared('e-existing'), active: false }] });
  const existing = reviewOf(db, postingFor(db, 'source:simplify:e-existing'));
  assert.equal(existing?.state, 'due', 'an existing review is not closed by an unlisted sighting (closure stays absence-based)');
  // The rule never applies to a first-seen unlisted-only posting: it stays without a pending review.
  census(ingestBatch, db, { runId: 'scan-3', partition: 'simplify:1', now: at(2), listings: [{ ...shared('n-new-unlisted'), is_visible: false }] });
  const fresh = reviewOf(db, postingFor(db, 'source:simplify:n-new-unlisted'));
  assert.ok(!fresh || !PENDING.includes(fresh.state), `first-seen unlisted-only posting: ${JSON.stringify(fresh && fresh.state)}`);
});

test('[B] the worker never fetches or judges an unlisted-only posting, and the receipt backlog does not count it (volume U1)', async () => {
  const { ingestBatch } = await ingest();
  const { runReview } = await worker();
  const db = freshDb();
  const listings = [];
  for (let i = 0; i < 6; i += 1) listings.push(simplifyListing(`w-unlisted-${i}`, { title: `Data Science Intern ${i}`, active: i % 2 === 0 ? false : true, is_visible: i % 2 === 0 }));
  for (let i = 0; i < 3; i += 1) listings.push(simplifyListing(`w-listed-${i}`, { title: `Data Analyst Intern ${i}` }));
  census(ingestBatch, db, { runId: 'scan-1', listings });
  const unlistedIds = new Set(listings.filter((item) => item.id.startsWith('w-unlisted')).map((item) => postingFor(db, `source:simplify:${item.id}`)));
  const listedIds = listings.filter((item) => item.id.startsWith('w-listed')).map((item) => postingFor(db, `source:simplify:${item.id}`));
  assert.equal(unlistedIds.size, 6);
  const fetcher = fakeFetcher({});
  const judges = eligibleJudges();
  const receipt = await runReview({ db, runId: 'review-1', owner: 'worker-a', now: at(1), budget: 20, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher, judges, inputs: () => reviewInputs(), hooks: {} });
  const fetched = new Set(fetcher.calls.map((call) => call.postingId));
  for (const id of listedIds) assert.ok(fetched.has(id), `${id}: listed postings are worked normally`);
  const wasted = [...unlistedIds].filter((id) => fetched.has(id) || judged(judges, id));
  assert.deepEqual(wasted, [], 'no fetch or judgment is spent on an unlisted-only posting');
  assert.equal(receipt.backlog?.due, listedIds.length, `the receipt backlog counts only listed postings: ${JSON.stringify(receipt.backlog)}`);
});

// ===================================================================== U2

const POSITIVE_HARDWARE_TITLES = ['Hardware Data Analyst Intern', 'AI Hardware Physical Design Engineer Intern', 'ML Systems Hardware Intern',
  'Machine Learning Accelerator Intern', 'Hardware Analytics Intern', 'Hardware Product Engineering Intern', 'Program Management Intern - Hardware',
  'Hardware Project Engineer Intern', 'Business Operations Intern, Devices', 'Hardware Insights Intern', 'Market Intelligence Intern - Devices',
  'Hardware Solutions Engineering Intern', 'Hardware Strategy Intern', 'BI Developer Intern - Hardware', 'Quant Hardware Research Intern',
  'hardware data platform co-op'];
// No positive token as a word: "Maintenance" contains "ai", "Reliability" and "Mobility" contain "bi".
const OUT_OF_DIRECTION_TITLES = ['Hardware Engineer Intern', 'Hardware Test Engineering Intern', 'Embedded Systems and Hardware Co-Op',
  'Software Engineer Intern', 'Firmware Validation Intern', 'Hardware Maintenance Technician Intern', 'Hardware Reliability Engineering Intern',
  'Mobility Systems Hardware Intern', 'Electrical Engineering Co-op - Power Electronics'];

test('[A] an internship or co-op Simplify record categorised only Hardware with no positive title token goes to lane out_of_direction; positive titles stay new (volume U2)', async () => {
  const { classifyRole } = await classify();
  const simplify = (title, category, active = true) => parseSimplify([simplifyListing('hw-1', { title, category, active })])[0];
  const laneFor = (title, category, profile = PROFILE) => classifyRole(simplify(title, category), { policy: SCREENING_POLICY, profile });
  for (const profile of [PROFILE, CO_OP]) {
    for (const category of ['Hardware', 'Hardware Engineering']) {
      for (const title of OUT_OF_DIRECTION_TITLES) {
        const result = laneFor(title, category, profile);
        assert.equal(result.kind, 'review', `${title} [${category}]: never dropped`);
        assert.equal(result.lane, 'out_of_direction', `${profile.search.jobType} / ${title} [${category}]: Hardware-only category, no positive direction token`);
      }
      for (const title of POSITIVE_HARDWARE_TITLES) {
        assert.equal(laneFor(title, category, profile).lane, 'new', `${profile.search.jobType} / ${title} [${category}]: a positive title token keeps it in lane new`);
      }
    }
  }
  // Scope: Simplify only, categories only Hardware, internship/co-op searches only.
  assert.equal(laneFor('Hardware Engineer Intern', 'Software').lane, 'new', 'a non-Hardware category is not out of direction');
  assert.equal(laneFor('Hardware Engineer Intern', undefined).lane, 'new', 'no category is not out of direction');
  const mixed = classifyRole({ ...simplify('Hardware Engineer Intern', 'Hardware'), categories: ['Hardware', 'Software'] }, { policy: SCREENING_POLICY, profile: PROFILE });
  assert.equal(mixed.lane, 'new', 'Hardware plus another category is not "only Hardware"');
  const greenhouse = classifyRole(record({ title: 'Hardware Engineer Intern', categories: ['Hardware'] }), { policy: SCREENING_POLICY, profile: PROFILE });
  assert.equal(greenhouse.lane, 'new', 'the rule reads the Simplify category, not other sources\' departments');
  assert.notEqual(laneFor('Hardware Engineer Intern', 'Hardware', FULL_TIME).lane, 'out_of_direction', 'full-time searches have no out_of_direction lane');

  // Ingest keeps every record and stores the lane on a due review that the worker samples.
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const listings = [
    simplifyListing('hw-out', { title: 'Hardware Engineer Intern', category: 'Hardware' }),
    simplifyListing('hw-in', { title: 'Hardware Data Analyst Intern', category: 'Hardware' }),
    simplifyListing('sw-in', { title: 'Software Engineer Intern', category: 'Software' }),
  ];
  const counts = census(ingestBatch, db, { runId: 'scan-u2', listings });
  assert.equal(counts.observed, 3);
  assert.equal(counts.review, 3, 'out_of_direction records are reviewed, never dropped');
  const lane = (id) => reviewOf(db, postingFor(db, `source:simplify:${id}`));
  assert.deepEqual([lane('hw-out')?.state, lane('hw-out')?.lane], ['due', 'out_of_direction']);
  assert.deepEqual([lane('hw-in')?.state, lane('hw-in')?.lane], ['due', 'new']);
  assert.deepEqual([lane('sw-in')?.state, lane('sw-in')?.lane], ['due', 'new']);
});

test('[B] out_of_direction is never promoted by age and shares the no_student_signal exploration reservation oldest-first; the receipt reports its backlog (volume U2)', async () => {
  const { LANES } = await load('L1', './src/funnel/contract.mjs', ['LANES']);
  assert.ok(LANES.includes('out_of_direction'), `the review lane out_of_direction exists: ${JSON.stringify(LANES)}`);
  const { runReview } = await worker();
  const OOD = { lane: 'out_of_direction', flags: [] };
  const NS = { lane: 'no_student_signal', flags: ['no_student_signal'] };

  // Budget 10: one shared exploration attempt; the oldest across both lanes is an out_of_direction item.
  {
    const db = freshDb();
    const q = queue(db);
    const now = at(30);
    const oodOldest = q.add({ id: 'p-ood-30', now: at(0), ...OOD });
    const nsMiddle = q.add({ id: 'p-ns-25', now: at(5), ...NS });
    const oodMiddle = q.add({ id: 'p-ood-20', now: at(10), ...OOD });
    const nsNewest = q.add({ id: 'p-ns-18', now: at(12), ...NS });
    const agedNew = q.add({ id: 'p-new-aged', now: at(27) });
    for (let i = 0; i < 12; i += 1) q.add({ id: `p-new-${String(i).padStart(2, '0')}`, now });
    const judges = eligibleJudges();
    const receipt = await runReview(runOptions(db, { now, runId: 'review-30', budget: 10, pages: q.pages, judges }));
    assert.ok(judged(judges, oodOldest), 'the oldest item across both exploration lanes receives the one exploration attempt');
    for (const id of [nsMiddle, oodMiddle, nsNewest]) assert.ok(!judged(judges, id), `${id}: one shared exploration share per run, and age gives these lanes no aged priority`);
    assert.ok(judged(judges, agedNew), 'other lanes keep their aged reserve');
    assert.deepEqual([reviewOf(db, oodMiddle).lane, reviewOf(db, oodMiddle).state], ['out_of_direction', 'due'], 'kept in its lane, waiting');
    assert.equal(receipt.backlog?.out_of_direction?.due, 1, `the receipt counts the waiting out_of_direction items: ${JSON.stringify(receipt.backlog)}`);
    assert.equal(Math.round(receipt.backlog?.out_of_direction?.oldest_days), 20, 'the receipt reports the oldest waiting out_of_direction age in days');
    assert.equal(receipt.backlog?.no_student_signal?.due, 2);
  }

  // Budget 20: two shared attempts go to the two oldest across both lanes, not two per lane.
  {
    const db = freshDb();
    const q = queue(db);
    const now = at(30);
    const ns0 = q.add({ id: 'p-ns-a', now: at(0), ...NS });
    const ood2 = q.add({ id: 'p-ood-b', now: at(2), ...OOD });
    const ns4 = q.add({ id: 'p-ns-c', now: at(4), ...NS });
    const ood6 = q.add({ id: 'p-ood-d', now: at(6), ...OOD });
    for (let i = 0; i < 25; i += 1) q.add({ id: `p-fresh-${String(i).padStart(2, '0')}`, now });
    const judges = eligibleJudges();
    await runReview(runOptions(db, { now, runId: 'review-30b', budget: 20, pages: q.pages, judges }));
    assert.ok(judged(judges, ns0) && judged(judges, ood2), 'the two oldest across both lanes are sampled');
    assert.ok(!judged(judges, ns4) && !judged(judges, ood6), 'the reservation is shared, not granted per lane');
  }

  // However old, an out_of_direction item is never promoted by age.
  {
    const db = freshDb();
    const q = queue(db);
    const id = q.add({ id: 'p-ood-old', ...OOD });
    for (const day of [15, 30, 60]) {
      await runReview(runOptions(db, { now: at(day), runId: `review-ood-${day}`, budget: 0, pages: q.pages }));
      assert.deepEqual([reviewOf(db, id).lane, reviewOf(db, id).state], ['out_of_direction', 'due'], `day ${day}`);
    }
  }
});
