// Lane L1 — collector boundary, deterministic drops, conservation (spec section 4; review-v3 F1 and §5.1; plan 7.1 #1, #2, #9, #10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGreenhouse, parseAshby } from '../../src/scan/sources/ats-boards.mjs';
import { parseSimplify } from '../../src/scan/sources/simplify.mjs';
import { freshDb, load, reviewOf, T0 } from '../../test-utils/funnel-v3.mjs';
import { record, SCREENING_POLICY } from '../../test-utils/funnel-v3-fixtures.mjs';

const classify = () => load('L1', './src/funnel/classify.mjs', ['classifyRole']);
const ingest = () => load('L1', './src/funnel/ingest.mjs', ['ingestBatch', 'recordSourceStatus']);
const postingFor = (db, alias) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(alias)?.posting_id;
const LONG = (text) => `${text} `.repeat(30);

// ---------------------------------------------------------------- parsers

test('[L1] Greenhouse unions the primary location with every office', () => {
  const [role] = parseGreenhouse({ jobs: [{ id: 1, title: 'Data Intern', absolute_url: 'https://job-boards.greenhouse.io/examplecorp/jobs/1', location: { name: 'London, UK' }, offices: [{ name: 'Seattle', location: 'Seattle, WA' }], content: '' }] }, { board: 'examplecorp' });
  assert.deepEqual(role.locations, ['London, UK', 'Seattle, WA']);
  assert.deepEqual(role.completeness?.locations, 'complete');
});

test('[L1] Simplify keeps inactive and hidden listings as unlisted records with partial completeness', () => {
  const roles = parseSimplify([
    { id: 'a', company_name: 'Example Corp', title: 'Data Intern', url: 'https://example.com/a', active: false, locations: ['Chicago, IL'] },
    { id: 'b', company_name: 'Example Corp', title: 'ML Intern', url: 'https://example.com/b', is_visible: false, locations: ['Remote in USA'] },
  ]);
  assert.equal(roles.length, 2);
  assert.deepEqual(roles.map((role) => role.listed), [false, false]);
  assert.equal(roles[0].completeness.locations, 'partial');
  assert.equal(roles[0].completeness.description, 'tags');
});

test('[L1] Ashby keeps isListed=false postings as unlisted records', () => {
  const roles = parseAshby({ jobs: [{ id: 'x', title: 'Analytics Intern', jobUrl: 'https://jobs.ashbyhq.com/example/x', isListed: false, location: 'New York, NY', employmentType: 'Intern' }] }, { board: 'example' });
  assert.equal(roles.length, 1);
  assert.equal(roles[0].listed, false);
  assert.equal(roles[0].employmentType, 'Intern');
});

// ---------------------------------------------------------- classifyRole

test('[L1] the four certain drop/reuse codes fire only on certain facts', async () => {
  const { classifyRole } = await classify();
  const policy = SCREENING_POLICY;
  assert.equal(classifyRole(record({ company: 'Excluded Example Co' }), { policy }).code, 'company_excluded');
  assert.equal(classifyRole(record({ locations: ['London, United Kingdom', 'Berlin, Germany'], workplaceType: 'onsite', remote: false,
    completeness: { locations: 'complete', arrangement: 'known', description: 'full', employment_type: 'absent' } }), { policy }).code, 'non_us_only');
  assert.equal(classifyRole(record({ title: 'Senior Data Engineer', employmentType: 'Full-time', description: LONG('Build pipelines for our analytics platform with Spark.'),
    completeness: { locations: 'complete', arrangement: 'known', description: 'full', employment_type: 'explicit' } }), { policy }).code, 'full_time_only');
  const reuse = classifyRole(record(), { policy, identity: { submitted: true } });
  assert.deepEqual([reuse.kind, reuse.code], ['reuse', 'already_submitted']);
  const declined = classifyRole(record(), { policy, identity: { userDeclined: true } });
  assert.deepEqual([declined.kind, declined.code], ['reuse', 'user_declined']);
});

for (const [name, overrides] of [
  ['Simplify foreign-only list (partial completeness)', { source: 'simplify', locations: ['London, United Kingdom'], completeness: { locations: 'partial', arrangement: 'unknown', description: 'tags', employment_type: 'absent' } }],
  ['Greenhouse primary London plus office Seattle', { locations: ['London, United Kingdom', 'Seattle, WA'] }],
  ['Lever Full-time commitment with summer intern in the description', { employmentType: 'Full-time', title: 'Analyst', description: LONG('Our summer intern program runs June to August 2027.'), completeness: { locations: 'complete', arrangement: 'known', description: 'full', employment_type: 'explicit' } }],
  ['Full-time category with an incomplete description', { employmentType: 'Full-time', title: 'Data Analyst', description: 'Degrees: Master\'s', completeness: { locations: 'partial', arrangement: 'unknown', description: 'tags', employment_type: 'explicit' } }],
  ['Workday timeType Full time intern', { title: 'Data Science Intern', employmentType: null, categories: ['Full time'] }],
  ['PhD tag', { degrees: ['PhD'] }],
  ['term tag conflict', { terms: ['Summer 2026'] }],
  ['empty direction', { title: 'Intern', description: '' , completeness: { locations: 'complete', arrangement: 'unknown', description: 'none', employment_type: 'absent' } }],
  ['EPM/TPM title with no mapped token', { title: 'EPM Intern' }],
  ['generic title with student evidence only in the JD', { title: 'Data Analyst', description: LONG('This is a twelve-week summer 2027 internship for currently enrolled students.') }],
  ['student researcher without the word intern', { title: 'Student Researcher, Applied ML' }],
  ['fellowship / residency / placement titles', { title: 'AI Residency Program' }],
  ['first-seen inactive record', { listed: false }],
  ['state-only remote location', { locations: ['USA - IL - Remote'] }],
]) {
  test(`[L1] stays review, never dropped: ${name}`, async () => {
    const { classifyRole } = await classify();
    const result = classifyRole(record(overrides), { policy: SCREENING_POLICY });
    assert.equal(result.kind, 'review', JSON.stringify(result));
  });
}

test('[L1] a complete JD with no student signal and no employment category goes to the no_student_signal lane (U1 default never drops)', async () => {
  const { classifyRole } = await classify();
  const result = classifyRole(record({ title: 'Data Analyst', description: LONG('Analyse revenue data for our finance team.') }), { policy: SCREENING_POLICY });
  assert.equal(result.kind, 'review');
  assert.ok(result.flags.includes('no_student_signal'));
});

// --------------------------------------------------------- ingestBatch

test('[L1] ingestBatch conserves every record and is idempotent on identical input', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const records = [
    record({ sourceId: '1', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/1' }),
    record({ sourceId: '2', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/2', company: 'Excluded Example Co' }),
    record({ sourceId: '3', url: 'not a url' }),
    record({ sourceId: '4', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/4', listed: false }),
  ];
  const first = ingestBatch(db, { runId: 'run-1', source: 'greenhouse', partition: 'greenhouse:examplecorp', records, now: T0, policy: SCREENING_POLICY });
  assert.equal(first.observed, 4);
  assert.equal(first.reused + Object.values(first.dropped).reduce((sum, n) => sum + n, 0) + first.review + first.quarantined, 4, JSON.stringify(first));
  assert.equal(first.quarantined, 1);
  assert.equal(first.dropped.company_excluded, 1);
  const unlisted = reviewOf(db, postingFor(db, 'source:greenhouse:4'));
  assert.equal(unlisted.state, 'due', 'first-seen inactive/unlisted record gets pending verification, not just retention');
  assert.ok(JSON.parse(unlisted.flags_json).includes('listed_false'));
  const reviews = JSON.stringify(db.prepare('SELECT * FROM reviews ORDER BY posting_id').all());
  const observations = db.prepare('SELECT COUNT(*) n FROM observations').get().n;
  const again = ingestBatch(db, { runId: 'run-1', source: 'greenhouse', partition: 'greenhouse:examplecorp', records, now: T0, policy: SCREENING_POLICY });
  assert.equal(again.newPostings, 0);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM reviews ORDER BY posting_id').all()), reviews);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM observations').get().n, observations);
});

test('[L1] unchanged sightings over successive censuses are recorded per run', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const records = [record()];
  for (const runId of ['run-1', 'run-2', 'run-3']) ingestBatch(db, { runId, source: 'greenhouse', partition: 'greenhouse:examplecorp', records, now: T0, policy: SCREENING_POLICY });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM observations').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM observation_sightings').get().n, 3);
});

test('[L1] a failure inside a source batch leaves no partial rows', async () => {
  const { ingestBatch } = await ingest();
  const db = freshDb();
  const bad = record({ sourceId: '2', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/2' });
  Object.defineProperty(bad, 'title', { get() { throw new Error('boom mid-batch'); }, enumerable: true });
  assert.throws(() => ingestBatch(db, { runId: 'run-1', source: 'greenhouse', partition: 'greenhouse:examplecorp', records: [record({ sourceId: '1' }), bad], now: T0, policy: SCREENING_POLICY }), /boom mid-batch/);
  for (const table of ['postings', 'posting_aliases', 'observations', 'observation_sightings', 'reviews']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
});

// ------------------------------------------------- CareerOps raw emission

function fakeCareerOps({ jobsByEntry, failing = [] }) {
  const providers = new Map([['workday', { id: 'workday', async fetch(entry) {
    if (failing.includes(entry.name)) throw new Error(`HTTP 503 for ${entry.name}`);
    return jobsByEntry[entry.name] ?? [];
  } }]]);
  return {
    providers,
    resolveProvider: (entry, map) => ({ provider: map.get('workday') }),
    makeHttpCtx: () => ({}),
  };
}

test('[L1] CareerOps raw emission keeps same-title records with different requisitions, URL case and pipes', async () => {
  const { collectCareerOpsRaw } = await load('L1', './src/integrations/careerops-scan-bridge.mjs', ['collectCareerOpsRaw']);
  const jobs = [
    { title: 'Data Science Intern', company: 'Acme | Labs', url: 'https://acme.wd5.myworkdayjobs.com/ext/job/Austin-TX/Data-Science-Intern_R1001', location: 'Austin, TX' },
    { title: 'Data Science Intern', company: 'Acme | Labs', url: 'https://acme.wd5.myworkdayjobs.com/ext/job/Chicago-IL/Data-Science-Intern_R1002', location: 'Chicago, IL' },
    { title: 'Senior Accountant | Tax', company: 'Acme | Labs', url: 'https://acme.wd5.myworkdayjobs.com/ext/job/Chicago-IL/Senior-Accountant_R1003', location: 'Chicago, IL' },
  ];
  const result = await collectCareerOpsRaw({ portals: { tracked_companies: [{ name: 'Acme', careers_url: 'https://acme.wd5.myworkdayjobs.com/ext' }] }, ...fakeCareerOps({ jobsByEntry: { Acme: jobs } }) });
  assert.equal(result.roles.length, 3, 'no title filter and no company+title dedupe before CJ');
  assert.deepEqual(result.roles.map((role) => role.url), jobs.map((job) => job.url), 'URL path case preserved');
  assert.equal(result.roles[2].title, 'Senior Accountant | Tax');
  assert.equal(result.roles[0].company, 'Acme | Labs');
});

test('[L1] CareerOps raw emission reports failed and truncated partitions instead of dropping them', async () => {
  const { collectCareerOpsRaw } = await load('L1', './src/integrations/careerops-scan-bridge.mjs', ['collectCareerOpsRaw']);
  const truncated = [{ title: 'Data Intern', company: 'Bigco', url: 'https://bigco.wd1.myworkdayjobs.com/ext/job/X/Data-Intern_R1' }];
  truncated.workdayTruncated = true;
  const result = await collectCareerOpsRaw({ portals: { tracked_companies: [{ name: 'Bigco' }, { name: 'Downco' }, { name: 'Okco' }] }, ...fakeCareerOps({ jobsByEntry: { Bigco: truncated, Okco: [] }, failing: ['Downco'] }) });
  const status = Object.fromEntries(result.partitions.map((item) => [item.partition.split(':').at(-1), item.status]));
  assert.deepEqual(status, { Bigco: 'partial', Downco: 'error', Okco: 'ok' });
  assert.match(result.partitions.find((item) => item.status === 'error').error, /HTTP 503/);
});

test('[L1] the raw bridge runs CareerOps under a temporary data root so its user data cannot suppress roles', async () => {
  const { scanCareerOpsRaw } = await load('L1', './src/integrations/careerops-scan-bridge.mjs', ['scanCareerOpsRaw']);
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cj-co-root-'));
  try {
    await writeFile(path.join(root, 'portals.yml'), 'tracked_companies:\n  - name: Acme\n');
    let seen;
    await scanCareerOpsRaw(root, { env: {}, execute: async (command, args, options) => { seen = { args, options }; return { exitCode: 0, stdout: JSON.stringify({ ok: true, roles: [], partitions: [] }), stderr: '' }; } });
    assert.ok(seen.args.includes('scan-raw'));
    assert.equal(seen.options.cwd, root);
    assert.ok(seen.options.env.CAREER_OPS_ROOT && seen.options.env.CAREER_OPS_ROOT !== root, 'temporary CAREER_OPS_ROOT');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('[L1] the CareerOps source becomes partial when any partition is partial or errored', async () => {
  const { parseCareerOpsRaw } = await load('L1', './src/scan/sources/careerops.mjs', ['parseCareerOpsRaw']);
  const parsed = parseCareerOpsRaw({ ok: true, roles: [{ company: 'Acme', title: 'Data Intern', url: 'https://acme.example.com/jobs/1', partition: 'workday:Acme' }], partitions: [{ partition: 'workday:Acme', status: 'ok', count: 1 }, { partition: 'workday:Downco', status: 'error', count: 0, error: 'HTTP 503' }] });
  assert.equal(parsed.roles.length, 1);
  assert.equal(parsed.status, 'partial');
  assert.equal(parsed.sources.find((item) => item.partition === 'workday:Downco').status, 'error');
});

// --------------------------------------------------------- scan run + exit

async function scanWith(sources) {
  const { runScan } = await load('L1', './src/scan/run.mjs', ['runScan']);
  const { scanExitCode } = await load('L1', './src/commands/scan.mjs', ['scanExitCode']);
  const db = freshDb();
  const profile = { search: { exclusions: [] }, sources: { atsBoards: [], careerOps: true, simplify: { enabled: false }, expected: ['careerops', 'simplify'] } };
  const summary = await runScan({ db, profile, runId: 'run-x', now: T0, collect: async () => sources, policy: SCREENING_POLICY });
  return { db, summary, exit: scanExitCode(summary) };
}

test('[L1] scan run no longer creates leads and no longer prints held/queued', async () => {
  const { db, summary } = await scanWith({ sources: [{ source: 'careerops', partition: 'workday:Acme', status: 'ok', count: 1 }, { source: 'simplify', partition: 'simplify:list', status: 'ok', count: 0 }], batches: [{ source: 'careerops', partition: 'workday:Acme', records: [record({ source: 'careerops', partition: 'workday:Acme' })] }] });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM applications').get().n, 0);
  assert.equal('held' in summary, false);
  assert.equal('queued' in summary, false);
  assert.equal(summary.counts.observed, 1);
});

test('[L1] an expected source that is disabled makes the scan partial (exit 2)', async () => {
  const { summary, exit } = await scanWith({ sources: [{ source: 'careerops', partition: 'all', status: 'ok', count: 0 }, { source: 'simplify', partition: 'all', status: 'skipped', count: 0, detail: 'opt-in source is not enabled' }], batches: [] });
  assert.equal(summary.status, 'partial');
  assert.equal(exit, 2);
});

test('[L1] all sources erroring is failed (exit 1); a genuine empty census is ok (exit 0)', async () => {
  const failed = await scanWith({ sources: [{ source: 'careerops', partition: 'all', status: 'error', count: 0 }, { source: 'simplify', partition: 'all', status: 'error', count: 0 }], batches: [] });
  assert.equal(failed.summary.status, 'failed');
  assert.equal(failed.exit, 1);
  const empty = await scanWith({ sources: [{ source: 'careerops', partition: 'all', status: 'ok', count: 0 }, { source: 'simplify', partition: 'all', status: 'ok', count: 0 }], batches: [] });
  assert.equal(empty.summary.status, 'ok');
  assert.equal(empty.exit, 0);
});
