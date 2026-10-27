// Lane A — regression tests for the code-review findings on the lane A branch (review of fad8cc2..ad741ae).
// Each test names its finding number. Synthetic data only: every employer, requisition and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../../src/commands/application.mjs';
import { freshDb, load, applicationsCount, T0, at } from '../../test-utils/funnel-v3.mjs';
import { record, SCREENING_POLICY, PROFILE, PROVENANCE } from '../../test-utils/funnel-v3-fixtures.mjs';
import { ATS_URLS, SIMPLIFY_URL, fixtureFetch } from '../../test-utils/scan-fixtures.mjs';

const identityModule = () => load('A2', './src/funnel/identity.mjs', ['aliasesFor', 'resolvePosting', 'reconcileAliases', 'bindApplication']);
const ingestModule = () => load('A4', './src/funnel/ingest.mjs', ['ingestBatch']);
const bridgeModule = (names) => load('A3', './src/integrations/careerops-scan-bridge.mjs', names);
const runModule = () => load('A5', './src/scan/run.mjs', ['runScan']);

const MINUTE = 60_000;
const tempDir = (prefix) => mkdtemp(path.join(os.tmpdir(), prefix));
const postingFor = (db, alias) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(alias)?.posting_id;
function effective(db, id) {
  for (let hops = 0; id && hops < 50; hops += 1) {
    const row = db.prepare('SELECT * FROM postings WHERE id = ?').get(id);
    if (!row?.merged_into) return row ?? null;
    id = row.merged_into;
  }
  return null;
}
function inTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
const ingest = async (db, batch, { policy = SCREENING_POLICY, now = T0, runId = 'scan-1' } = {}) => (await ingestModule())
  .ingestBatch(db, { runId, now, policy, profile: PROFILE, ...batch });
const workdayUrl = (tenant, req, place = 'Chicago-IL') => `https://${tenant}.wd5.myworkdayjobs.com/ext/job/${place}/Data-Intern_${req}`;
const noSources = () => ({ search: { jobType: 'internship', countries: ['US'], exclusions: [] }, sources: { atsBoards: [], careerOps: false, simplify: { enabled: false, url: null }, expected: [] } });
const boardsProfile = (boards) => ({
  search: { jobType: 'internship', countries: ['US'], exclusions: [] },
  sources: { atsBoards: boards.map((board) => ({ ats: 'greenhouse', board })), careerOps: false, simplify: { enabled: false, url: null }, expected: ['atsBoards'] },
});
const health = (summary, partition) => summary.sources.find((item) => item.partition === partition);

// ===================================================================== #1 CareerOps raw bridge arguments

// A CareerOps root with the upstream module layout. The registry and plugin engine keep the upstream signatures:
// loadProviders(dir) returns an empty map for a missing directory, and mergeProviderPlugins(map, { root }) needs a root path.
async function fakeProviderRoot() {
  const root = await tempDir('cj-a-careerops-providers-');
  const files = {
    'package.json': JSON.stringify({ name: 'career-ops', version: '0.0.0-synthetic', private: true }),
    'portals.yml': JSON.stringify({ tracked_companies: [{ name: 'Alpha Example', careers_url: 'https://jobs.example.com/alpha' }] }),
    // Synthetic YAML reader: portals.yml above is JSON, which is valid YAML.
    'node_modules/js-yaml/package.json': JSON.stringify({ name: 'js-yaml', version: '0.0.0-synthetic', main: 'index.js' }),
    'node_modules/js-yaml/index.js': 'module.exports = { load: (text) => JSON.parse(text) };\n',
    'providers/_registry.mjs': `import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export async function loadProviders(dir) {
  const providers = new Map();
  if (typeof dir !== 'string' || !existsSync(dir)) return providers;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.mjs') && !name.startsWith('_')).sort()) {
    const provider = (await import(pathToFileURL(path.join(dir, file)).href)).default;
    if (provider?.id && typeof provider.fetch === 'function' && !providers.has(provider.id)) providers.set(provider.id, provider);
  }
  return providers;
}
export function resolveProvider(entry, providers) {
  if (entry.provider) { const provider = providers.get(entry.provider); return provider ? { provider } : { error: 'unknown provider: ' + entry.provider }; }
  for (const provider of providers.values()) if (provider.detect?.(entry)) return { provider };
  return null;
}
`,
    'providers/_http.mjs': "export function makeHttpCtx() { return { transport: 'synthetic' }; }\n",
    'providers/fakeboard.mjs': `export default {
  id: 'fakeboard',
  detect: (entry) => String(entry.careers_url ?? '').startsWith('https://jobs.example.com/') ? { kind: 'fakeboard' } : null,
  async fetch(entry) {
    return [1001, 1002].map((id) => ({ title: 'Data Intern ' + id, company: entry.name, url: 'https://jobs.example.com/alpha/' + id, location: 'Chicago, IL' }));
  },
};
`,
    'plugins/_engine.mjs': `import { existsSync } from 'node:fs';
import path from 'node:path';
export async function mergeProviderPlugins(providersMap, { root }) {
  if (!existsSync(path.join(root, 'config', 'plugins.yml'))) return;
}
`,
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

const envWithoutPortals = () => { const env = { ...process.env }; delete env.CAREER_OPS_PORTALS; return env; };

test('[A] the raw bridge loads providers from the providers directory and merges plugins with the root (review #1)', async () => {
  const { scanCareerOpsRaw } = await bridgeModule(['scanCareerOpsRaw']);
  const root = await fakeProviderRoot();
  try {
    const result = await scanCareerOpsRaw(root, { env: envWithoutPortals(), timeoutMs: 20_000 });
    const partition = result.partitions.find((item) => item.partition === 'fakeboard:Alpha Example');
    assert.ok(partition, `the configured entry is fetched by its provider: ${JSON.stringify(result.partitions)}`);
    assert.equal(partition.status, 'ok');
    assert.equal(partition.rawCount, 2);
    assert.deepEqual(result.roles.map((role) => role.url).sort(), ['https://jobs.example.com/alpha/1001', 'https://jobs.example.com/alpha/1002']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ===================================================================== #2 provider-local source ids

test('[A] the same provider-local CareerOps id at two employers stays two postings (review #2)', async () => {
  const { parseCareerOpsRaw } = await load('A3', './src/scan/sources/careerops.mjs', ['parseCareerOpsRaw']);
  await identityModule();
  const db = freshDb();
  const alphaUrl = workdayUrl('alphaexample', 'R900401');
  const betaUrl = workdayUrl('betaexample', 'R900402', 'Austin-TX');
  const alphaApp = createApplication(db, { company: 'Alpha Example', role: 'Data Intern', jobUrl: alphaUrl, status: 'applied', appliedAt: at(-1) }, at(-1));
  const partitions = ['workday:Alpha Example', 'workday:Beta Example'];
  const parsed = parseCareerOpsRaw({
    roles: [
      { id: '4401', company: 'Alpha Example', title: 'Data Intern', url: alphaUrl, locations: ['Chicago, IL'], partition: partitions[0] },
      { id: '4401', company: 'Beta Example', title: 'Data Intern', url: betaUrl, locations: ['Austin, TX'], partition: partitions[1] },
    ],
    partitions: partitions.map((partition) => ({ partition, status: 'ok', count: 1, rawCount: 1, truncated: false, capDetected: false })),
  });
  const batch = (partition) => ({ source: 'careerops', partition, records: parsed.roles.filter((role) => role.partition === partition) });
  const alpha = await ingest(db, batch(partitions[0]));
  assert.equal(alpha.reused, 1, 'the Alpha role is the submitted application');
  const beta = await ingest(db, batch(partitions[1]));
  assert.equal(beta.reused, 0, "Alpha's submitted application must not suppress Beta's role");
  assert.equal(beta.newPostings, 1);
  assert.equal(beta.review, 1);
  const alphaPosting = db.prepare('SELECT id FROM postings WHERE application_id = ?').get(alphaApp.id).id;
  const betaPosting = postingFor(db, 'req:workday:betaexample:R900402');
  assert.ok(betaPosting, "Beta's requisition alias is recorded");
  assert.notEqual(effective(db, betaPosting).id, effective(db, alphaPosting).id, 'different employers never collapse into one posting');
});

// ===================================================================== #3 bindings across alias merges

test('[A] binding a submitted fallback posting to an official posting carries the application binding (review #3)', async () => {
  const { aliasesFor, reconcileAliases } = await identityModule();
  const db = freshDb();
  const fallbackUrl = 'https://careers.example.com/examplecorp/jobs/data-intern';
  const officialUrl = workdayUrl('examplecorp', 'R900501');
  const app = createApplication(db, { company: 'Example Corp', role: 'Data Intern', jobUrl: fallbackUrl, status: 'applied', appliedAt: at(-2) }, at(-2));
  const fallback = db.prepare('SELECT id FROM postings WHERE application_id = ?').get(app.id).id;
  db.prepare(`INSERT INTO postings (id, company, title, canonical_url, first_seen, last_seen, listed, availability, created_at, updated_at)
    VALUES ('p-official', 'Example Corp', 'Data Intern', ?, ?, ?, 1, 'open', ?, ?)`).run(officialUrl.replace(/^https:\/\//, ''), at(-1), at(-1), at(-1), at(-1));
  for (const alias of aliasesFor({ company: 'Example Corp', url: officialUrl })) {
    db.prepare('INSERT INTO posting_aliases (alias, posting_id, kind, created_at) VALUES (?, ?, ?, ?)').run(alias.alias, 'p-official', alias.kind, at(-1));
  }
  // R1 enrichment of the fallback posting finds the official requisition URL.
  const result = inTransaction(db, () => reconcileAliases(db, fallback, aliasesFor({ company: 'Example Corp', url: officialUrl }), { now: T0 }));
  assert.equal(result.action, 'bound');
  assert.equal(effective(db, fallback).application_id, app.id, 'the effective posting carries the submitted application');
  assert.equal(effective(db, 'p-official').application_id, app.id);
  const counts = await ingest(db, { source: 'careerops', partition: 'workday:Example Corp',
    records: [record({ source: 'careerops', sourceId: officialUrl, partition: 'workday:Example Corp', company: 'Example Corp', title: 'Data Intern', url: officialUrl })] }, { now: at(1) });
  assert.equal(counts.reused, 1, 'a later sighting of the requisition is already_submitted, not a new review');
  assert.equal(counts.review, 0);
});

test('[A] a second bootstrap never overwrites a submitted binding with a duplicate application (review #3)', async () => {
  const { bootstrapExisting } = await load('A6', './src/funnel/bootstrap.mjs', ['bootstrapExisting']);
  const db = freshDb();
  db.prepare(`INSERT INTO applications (id, company, role, external_id, status, applied_at, created_at, updated_at)
    VALUES ('dup-old', 'Acme Example', 'Data Intern', 'R900502', 'applied', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO applications (id, company, role, job_url, status, created_at, updated_at)
    VALUES ('dup-new', 'Acme Example', 'Data Intern', ?, 'lead', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z')`).run(workdayUrl('acmeexample', 'R900502'));
  const check = (label) => {
    const owner = effective(db, postingFor(db, 'company_req:acmeexample:R900502'));
    assert.ok(owner, `${label}: the requisition has a posting`);
    assert.equal(owner.application_id, 'dup-old', `${label}: the submitted application stays bound to the requisition's posting`);
    const newRows = db.prepare("SELECT id FROM postings WHERE application_id = 'dup-new'").all();
    assert.ok(newRows.length >= 1, `${label}: the duplicate application keeps its own posting`);
    for (const row of newRows) assert.notEqual(effective(db, row.id)?.id, owner.id, `${label}: postings with different bindings are not merged`);
  };
  bootstrapExisting(db, { provenance: PROVENANCE, now: T0 });
  check('first bootstrap');
  bootstrapExisting(db, { provenance: PROVENANCE, now: at(1) });
  check('second bootstrap');
});

// ===================================================================== #4 the application writer

test('[A] the application writer keeps two same-title applications with different requisition URLs (review #4)', async () => {
  await identityModule();
  const db = freshDb();
  const first = createApplication(db, { company: 'Demo Example', role: 'Intern', jobUrl: 'https://job-boards.greenhouse.io/demoexample/jobs/9000601', status: 'applied', appliedAt: at(-2) }, at(-2));
  const second = createApplication(db, { company: 'Demo Example', role: 'Intern', jobUrl: 'https://job-boards.greenhouse.io/demoexample/jobs/9000602', status: 'applied', appliedAt: at(-1) }, at(-1));
  assert.notEqual(second.id, first.id, 'a different requisition is a different application');
  assert.equal(applicationsCount(db), 2);
  assert.equal(second.job_url, 'https://job-boards.greenhouse.io/demoexample/jobs/9000602');
  const bound = (id) => db.prepare('SELECT id FROM postings WHERE application_id = ? AND merged_into IS NULL').get(id)?.id;
  assert.ok(bound(first.id) && bound(second.id));
  assert.notEqual(bound(first.id), bound(second.id));
});

test('[A] the application writer does not create a second application for the same requisition URL (review #4)', async () => {
  await identityModule();
  const url = 'https://job-boards.greenhouse.io/examplecorp/jobs/9000603';
  for (const change of [{ role: 'Data Intern, Summer 2027' }, { externalId: 'ext-77' }]) {
    const db = freshDb();
    const first = createApplication(db, { company: 'Example Corp', role: 'Data Intern', jobUrl: url, status: 'applied', appliedAt: at(-2) }, at(-2));
    let second;
    let error;
    try { second = createApplication(db, { company: 'Example Corp', role: 'Data Intern', jobUrl: url, ...change }, at(-1)); } catch (caught) { error = caught; }
    assert.equal(applicationsCount(db), 1, `${JSON.stringify(change)}: the same posting never gets a second application`);
    if (!error) assert.equal(second.id, first.id, `${JSON.stringify(change)}: the writer returns the application bound to that posting`);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM posting_links WHERE kind = 'conflict'").get().n, 0, 'no binding conflict is left behind');
  }
});

// ===================================================================== #5 company key for requisition aliases

test('[A] a bare-id application under a legal-suffix company name matches the same requisition at scan (review #5)', async () => {
  await identityModule();
  const db = freshDb();
  createApplication(db, { company: 'Demo Example Inc.', role: 'Data Intern', externalId: 'R900521', status: 'applied', appliedAt: at(-1) }, at(-1));
  const counts = await ingest(db, { source: 'simplify', partition: 'simplify:1', records: [
    record({ source: 'simplify', sourceId: 's-521', partition: 'simplify:1', company: 'Demo Example', title: 'Data Intern', url: 'https://careers.example.com/demo/data-intern-521', requisitionId: 'R900521' }),
  ] });
  assert.equal(counts.reused, 1, 'companyKey drops the legal suffix, so Demo Example Inc. and Demo Example share the requisition');
  assert.equal(counts.newPostings, 0);
  assert.equal(counts.review, 0);
});

test('[A] configured company aliases reach requisition matching at scan (review #5)', async () => {
  await identityModule();
  const db = freshDb();
  createApplication(db, { company: 'Example Group', role: 'Data Intern', externalId: 'R900522', status: 'applied', appliedAt: at(-1) }, at(-1));
  const policy = { ...SCREENING_POLICY, companyAliases: { 'Example Holdings': 'Example Group' } };
  const counts = await ingest(db, { source: 'simplify', partition: 'simplify:1', records: [
    record({ source: 'simplify', sourceId: 's-522', partition: 'simplify:1', company: 'Example Holdings', title: 'Data Intern', url: 'https://careers.example.com/holdings/data-intern-522', requisitionId: 'R900522' }),
  ] }, { policy });
  assert.equal(counts.reused, 1, 'Example Holdings is configured as Example Group');
  assert.equal(counts.newPostings, 0);
});

// ===================================================================== #6 missing CareerOps partitions

test('[A] a configured CareerOps partition missing from a response stays expected and goes stale (review #6)', async () => {
  const { runScan } = await runModule();
  const db = freshDb();
  const profile = { search: { jobType: 'internship', countries: ['US'], exclusions: [] }, sources: { atsBoards: [], careerOps: true, simplify: { enabled: false, url: null }, expected: ['careerops'] } };
  const employers = { 'workday:Alpha Example': 'alphaexample', 'workday:Beta Example': 'betaexample' };
  const collect = (names) => async () => ({
    sources: names.map((partition) => ({ source: 'careerops', partition, status: 'ok', count: 2, rawCount: 2, truncated: false, capDetected: false })),
    batches: names.map((partition) => ({ source: 'careerops', partition, rawCount: 2, records: ['R900601', 'R900602'].map((req) => {
      const url = workdayUrl(employers[partition], req);
      return record({ source: 'careerops', sourceId: url, partition, company: partition.split(':')[1], url });
    }) })),
  });
  for (const day of [0, 1, 2]) await runScan({ db, profile, runId: `scan-${day}`, now: at(day), policy: SCREENING_POLICY, collect: collect(Object.keys(employers)) });
  const summary = await runScan({ db, profile, runId: 'scan-3', now: at(3), policy: SCREENING_POLICY, collect: collect(['workday:Alpha Example']) });
  const beta = health(summary, 'workday:Beta Example');
  assert.deepEqual([beta?.status, beta?.alert], ['stale', 'missing'], 'a partition absent from one response is not removed from the configuration');
  assert.equal(summary.status, 'partial');
  assert.equal(db.prepare("SELECT retired_at FROM expected_partitions WHERE partition = 'workday:Beta Example'").get()?.retired_at ?? null, null, 'not retired');
});

// ===================================================================== #7 non-Workday truncation

test('[A] non-Workday truncation flags and warnings make the CareerOps partition partial (review #7)', async () => {
  const { collectCareerOpsRaw } = await bridgeModule(['collectCareerOpsRaw']);
  const jobs = (company, count) => Array.from({ length: count }, (_, index) => ({ title: `Role ${index + 1}`, company, url: `https://jobs.example.com/${company.split(' ')[0].toLowerCase()}/${9300 + index}` }));
  const providers = new Map([
    ['icims', { id: 'icims', async fetch(entry) {
      const list = jobs(entry.name, entry.name === 'Gamma Example' ? 20 : 3);
      if (entry.name === 'Gamma Example') list.icimsTruncated = true;
      return list;
    } }],
    ['eightfold', { id: 'eightfold', async fetch(entry) {
      console.error(`⚠️  eightfold: ${entry.name} truncated at max_pages=5 (50 of 400 jobs) — raise max_pages on this entry for more`);
      return jobs(entry.name, 50);
    } }],
  ]);
  const result = await collectCareerOpsRaw({
    portals: { tracked_companies: [
      { name: 'Gamma Example', provider: 'icims', careers_url: 'https://jobs.example.com/gamma' },
      { name: 'Delta Example', provider: 'icims', careers_url: 'https://jobs.example.com/delta' },
      { name: 'Epsilon Example', provider: 'eightfold', careers_url: 'https://jobs.example.com/epsilon' },
    ] },
    providers,
    resolveProvider: (entry, map) => ({ provider: map.get(entry.provider) }),
    makeHttpCtx: () => ({}),
  });
  const byName = Object.fromEntries(result.partitions.map((item) => [item.partition.split(':').at(-1), item]));
  assert.deepEqual([byName['Gamma Example']?.status, byName['Gamma Example']?.truncated], ['partial', true], 'jobs.icimsTruncated marks an incomplete census');
  assert.equal(byName['Gamma Example'].rawCount, 20, 'the returned records are kept');
  assert.equal(result.roles.filter((role) => role.company === 'Gamma Example').length, 20);
  assert.deepEqual([byName['Epsilon Example']?.status, byName['Epsilon Example']?.truncated], ['partial', true], 'a non-Workday truncation warning marks an incomplete census');
  assert.equal(byName['Delta Example']?.status, 'ok', 'an untruncated board stays ok');
});

// ===================================================================== #8 quarantined rows and closure evidence

test('[A] a partition with quarantined rows is partial, never an ok census (review #8)', async () => {
  const { runScan } = await runModule();
  const db = freshDb();
  const summary = await runScan({ db, profile: boardsProfile(['alpha', 'beta']), runId: 'scan-q', now: T0, policy: SCREENING_POLICY, collect: async () => ({
    sources: ['alpha', 'beta'].map((board) => ({ source: 'greenhouse', partition: `greenhouse:${board}`, status: 'ok', count: 2, rawCount: 2, truncated: false })),
    batches: [
      { source: 'greenhouse', partition: 'greenhouse:alpha', rawCount: 2, records: [
        record({ sourceId: '9000801', partition: 'greenhouse:alpha', url: 'https://job-boards.greenhouse.io/alpha/jobs/9000801' }),
        record({ sourceId: '9000802', partition: 'greenhouse:alpha', title: 'Analytics Intern', url: null, invalid: 'missing http(s) URL' }),
      ] },
      { source: 'greenhouse', partition: 'greenhouse:beta', rawCount: 2, records: ['9000803', '9000804'].map((id) => record({ sourceId: id, partition: 'greenhouse:beta', url: `https://job-boards.greenhouse.io/beta/jobs/${id}` })) },
    ],
  }) });
  assert.equal(summary.counts.quarantined, 1);
  assert.equal(health(summary, 'greenhouse:alpha')?.status, 'partial', 'an unaccounted quarantined record makes the census incomplete');
  assert.equal(health(summary, 'greenhouse:beta')?.status, 'ok', 'a clean board stays ok');
  assert.equal(summary.status, 'partial');
  const row = db.prepare("SELECT status, quarantined FROM run_sources WHERE run_id = 'scan-q' AND partition = 'greenhouse:alpha'").get();
  assert.notEqual(row.status, 'ok', 'the persisted census row cannot serve as absence evidence');
  assert.equal(row.quarantined, 1);
});

// ===================================================================== #9 scan run liveness and fencing

test('[A] a scan that is still collecting keeps its run alive past ten minutes (review #9)', async (t) => {
  const { runScan } = await runModule();
  const db = freshDb();
  const later = at(11 / 1440);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.parse(T0) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runScan({ db, profile: noSources(), runId: 'scan-long', now: T0, policy: SCREENING_POLICY, collect: async () => { await gate; return { sources: [], batches: [] }; } });
  first.catch(() => {});
  try {
    for (let step = 0; step < 66; step += 1) { t.mock.timers.tick(10_000); await flush(); }
    await assert.rejects(
      runScan({ db, profile: noSources(), runId: 'scan-second', now: later, policy: SCREENING_POLICY, collect: async () => ({ sources: [], batches: [] }) }),
      (error) => error.code === 75 || /already running/i.test(error.message),
      'a run that heartbeats during collection is busy, not reclaimable',
    );
    assert.equal(db.prepare("SELECT status FROM runs WHERE run_id = 'scan-long'").get().status, 'running');
  } finally {
    release();
    await first.catch(() => {});
  }
});

test('[A] a reclaimed scan never ingests or rewrites its interrupted run (review #9)', async () => {
  const { runScan } = await runModule();
  const db = freshDb();
  const profile = boardsProfile(['alpha']);
  const census = (runTag) => async () => ({
    sources: [{ source: 'greenhouse', partition: 'greenhouse:alpha', status: 'ok', count: 2, rawCount: 2, truncated: false }],
    batches: [{ source: 'greenhouse', partition: 'greenhouse:alpha', rawCount: 2, records: ['9000901', '9000902'].map((id) => record({ sourceId: `${runTag}-${id}`, partition: 'greenhouse:alpha', url: `https://job-boards.greenhouse.io/alpha/jobs/${id}` })) }],
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = runScan({ db, profile, runId: 'scan-old', now: T0, policy: SCREENING_POLICY, collect: async () => { await gate; return census('old')(); } });
  original.catch(() => {});
  // Another scan finds the old run's heartbeat stale (for example after the machine slept) and reclaims it.
  const reclaimer = await runScan({ db, profile, runId: 'scan-new', now: at(1), policy: SCREENING_POLICY, collect: census('new') });
  assert.equal(reclaimer.status, 'ok');
  assert.equal(db.prepare("SELECT status FROM runs WHERE run_id = 'scan-old'").get().status, 'interrupted');
  release();
  let outcome;
  try { outcome = await original; } catch (error) { outcome = error; }
  assert.equal(db.prepare("SELECT status FROM runs WHERE run_id = 'scan-old'").get().status, 'interrupted', 'the reclaimed run never writes its row back');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM observation_sightings WHERE run_id = 'scan-old'").get().n, 0, 'no ingestion under a reclaimed run');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM run_sources WHERE run_id = 'scan-old'").get().n, 0, 'no source health under a reclaimed run');
  if (!(outcome instanceof Error)) assert.notEqual(outcome.status, 'ok', 'the reclaimed run does not report success');
});

// ===================================================================== #10 timeouts end the whole process tree

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function goneWithin(pid, ms) {
  const end = Date.now() + ms;
  while (isAlive(pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
  return !isAlive(pid);
}
async function settleWithin(promise, ms) {
  const started = Date.now();
  let timer;
  const outcome = await Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ hung: true }), ms); }),
  ]);
  clearTimeout(timer);
  return { ...outcome, elapsed: Date.now() - started };
}
// A script that starts one long-lived descendant sharing its output pipes, records the pids, then never finishes.
const stuckScript = (pidFile) => `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, descendant.pid]));
setInterval(() => {}, 1000);
`;
async function readPids(pidFile) {
  try { return JSON.parse(await readFile(pidFile, 'utf8')); } catch { return []; }
}
const killAll = (pids) => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };

test('[A] a CareerOps scan timeout ends the adapter and its descendants promptly (review #10)', async () => {
  const { runCareerOpsScan } = await load('A3', './src/integrations/careerops.mjs', ['runCareerOpsScan']);
  const root = await tempDir('cj-a-careerops-stuck-');
  const pidFile = path.join(root, 'pids.json');
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'career-ops', version: '0.0.0-synthetic' }));
    await writeFile(path.join(root, 'career-journal-adapter.mjs'), stuckScript(pidFile));
    const result = await settleWithin(runCareerOpsScan({ root, scanTimeoutMs: 800 }), 2500);
    const pids = await readPids(pidFile);
    assert.equal(pids.length, 2, 'the adapter started its descendant before the timeout');
    assert.ok(!result.hung, `the timed-out scan settled within 2500 ms (adapter timeout 800 ms); it was still waiting after ${result.elapsed} ms`);
    assert.match(String(result.error?.message), /timed out/i);
    for (const pid of pids) assert.ok(await goneWithin(pid, 1000), `process ${pid} of the adapter tree was terminated`);
  } finally {
    killAll(await readPids(pidFile));
    await rm(root, { recursive: true, force: true });
  }
});

test('[A] a raw bridge timeout ends the worker and its nested scan promptly (review #10)', async () => {
  const { scanCareerOpsRaw } = await bridgeModule(['scanCareerOpsRaw']);
  const root = await tempDir('cj-a-bridge-stuck-');
  const pidFile = path.join(root, 'pids.json');
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'career-ops', version: '0.0.0-synthetic' }));
    await writeFile(path.join(root, 'portals.yml'), 'tracked_companies: []\n');
    // No providers directory: the worker falls back to the nested legacy scan.mjs, which never finishes.
    await writeFile(path.join(root, 'scan.mjs'), stuckScript(pidFile));
    const result = await settleWithin(scanCareerOpsRaw(root, { env: envWithoutPortals(), timeoutMs: 1200 }), 2500);
    const pids = await readPids(pidFile);
    assert.equal(pids.length, 2, 'the nested scan started its descendant before the timeout');
    assert.ok(!result.hung, `the timed-out bridge settled within 2500 ms (timeout 1200 ms); it was still waiting after ${result.elapsed} ms`);
    assert.match(String(result.error?.message), /timed out/i);
    for (const pid of pids) assert.ok(await goneWithin(pid, 1000), `process ${pid} below the bridge worker was terminated`);
  } finally {
    killAll(await readPids(pidFile));
    await rm(root, { recursive: true, force: true });
  }
});

// ===================================================================== #11 response envelopes

test('[A] a malformed board response envelope is a collection error, not an empty board (review #11)', async () => {
  const { fetchAtsBoards } = await load('A3', './src/scan/sources/ats-boards.mjs', ['fetchAtsBoards']);
  const { fetchSimplify } = await load('A3', './src/scan/sources/simplify.mjs', ['fetchSimplify']);
  const boards = [{ ats: 'greenhouse', board: 'examplecorp' }, { ats: 'lever', board: 'examplelabs' }, { ats: 'ashby', board: 'examplequant' }];
  const broken = await fetchAtsBoards(boards, fixtureFetch({
    [ATS_URLS.greenhouse]: { error: 'board not found' },
    [ATS_URLS.lever]: { ok: false, error: 'rate limited' },
    [ATS_URLS.ashby]: { jobs: 'unavailable' },
  }));
  for (const source of broken.sources) assert.equal(source.status, 'error', `${source.partition}: HTTP 200 without a valid job collection`);
  const empty = await fetchAtsBoards(boards, fixtureFetch({ [ATS_URLS.greenhouse]: { jobs: [] }, [ATS_URLS.lever]: [], [ATS_URLS.ashby]: { jobs: [] } }));
  for (const source of empty.sources) assert.deepEqual([source.partition, source.status, source.count], [source.partition, 'ok', 0], 'an explicit empty array is a genuine empty board');

  const brokenList = await fetchSimplify({ enabled: true, url: SIMPLIFY_URL }, fixtureFetch({ [SIMPLIFY_URL]: { error: 'not found' } }));
  assert.equal(brokenList.sources[0].status, 'error', 'a Simplify response without a listing array is an error');
  const emptyList = await fetchSimplify({ enabled: true, url: SIMPLIFY_URL }, fixtureFetch({ [SIMPLIFY_URL]: [] }));
  assert.deepEqual([emptyList.sources[0].status, emptyList.sources[0].count], ['ok', 0]);
});

// ===================================================================== #12 ambiguous country/state names

test('[A] an ambiguous country-or-state location such as Georgia stays in review (review #12)', async () => {
  const { classifyRole } = await load('A4', './src/funnel/classify.mjs', ['classifyRole']);
  const onsite = (locations) => record({ locations, remote: false, workplaceType: 'onsite',
    completeness: { locations: 'complete', arrangement: 'known', description: 'full', employment_type: 'absent' } });
  const georgia = classifyRole(onsite(['Georgia']), { policy: SCREENING_POLICY, profile: PROFILE });
  assert.equal(georgia.kind, 'review', 'Georgia can be the US state, so it is not a certain exclusion for a US profile');
  assert.equal(georgia.code, null);
  const berlin = classifyRole(onsite(['Berlin, Germany']), { policy: SCREENING_POLICY, profile: PROFILE });
  assert.deepEqual([berlin.kind, berlin.code], ['drop', 'outside_countries'], 'an unambiguous foreign location still drops');
});
