// Lane L1 — identity rules (spec section 3; review-v3 F2 and §5.2; plan 7.1 #4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, seedApplication, reviewOf, applicationsCount, T0 } from '../../test-utils/funnel-v3.mjs';
import { record, SCREENING_POLICY } from '../../test-utils/funnel-v3-fixtures.mjs';

const identity = () => load('L1', './src/funnel/identity.mjs', ['canonicalUrl', 'providerRequisition', 'aliasesFor', 'resolvePosting', 'reconcileAliases']);
const ingest = () => load('L1', './src/funnel/ingest.mjs', ['ingestBatch']);
const bootstrap = () => load('L1', './src/funnel/bootstrap.mjs', ['bootstrapExisting']);

function batch(db, records, { runId = 'run-1', source = records[0].source, partition = records[0].partition, now = T0 } = {}) {
  return ingest().then(({ ingestBatch }) => ingestBatch(db, { runId, source, partition, records, now, policy: SCREENING_POLICY }));
}
const postingFor = (db, alias) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(alias)?.posting_id;
const effective = (db, id) => { let row = db.prepare('SELECT id, merged_into FROM postings WHERE id = ?').get(id); while (row?.merged_into) row = db.prepare('SELECT id, merged_into FROM postings WHERE id = ?').get(row.merged_into); return row?.id; };

test('[L1] canonicalUrl lowercases only the host, keeps path case and identity parameters', async () => {
  const { canonicalUrl } = await identity();
  assert.equal(canonicalUrl('https://WWW.Example.COM/Jobs/AbC/?utm_source=x&ref=y&gh_src=z&jobId=Q7xK&token=55'), 'example.com/Jobs/AbC?jobId=Q7xK&token=55');
  assert.notEqual(canonicalUrl('https://example.com/job/CaseA'), canonicalUrl('https://example.com/job/casea'));
  assert.equal(canonicalUrl('https://example.com/careers#/jobs/123'), 'example.com/careers#/jobs/123');
  assert.equal(canonicalUrl('https://example.com/careers#apply'), 'example.com/careers');
  assert.equal(canonicalUrl('https://user:pw@example.com/x'), null);
});

test('[L1] providerRequisition normalizes only where the provider guarantees equivalence', async () => {
  const { providerRequisition } = await identity();
  assert.deepEqual(providerRequisition('https://acme.wd5.myworkdayjobs.com/ext/job/Chicago-IL/Data-Intern_r900285'), { provider: 'workday', tenant: 'acme', id: 'R900285' });
  const lever = providerRequisition('https://jobs.lever.co/examplelabs/2F1C7C1E-0000-4000-8000-00000000000A');
  assert.deepEqual([lever.provider, lever.id], ['lever', '2f1c7c1e-0000-4000-8000-00000000000a']);
  assert.deepEqual(providerRequisition('https://careers.example.com/apply?jobId=CaseA'), { provider: 'generic', tenant: 'careers.example.com', id: 'CaseA' });
  assert.notDeepEqual(providerRequisition('https://careers.example.com/apply?jobId=CaseA'), providerRequisition('https://careers.example.com/apply?jobId=casea'));
});

test('[L1] case-distinct generic query ids stay two postings (both reviewed)', async () => {
  const db = freshDb();
  const a = record({ source: 'careerops', sourceId: 'x1', partition: 'generic:example', url: 'https://careers.example.com/apply?jobId=CaseA', title: 'Data Intern' });
  const b = record({ source: 'careerops', sourceId: 'x2', partition: 'generic:example', url: 'https://careers.example.com/apply?jobId=casea', title: 'Data Intern' });
  const counts = await batch(db, [a, b]);
  assert.equal(counts.newPostings, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state = 'due'").get().n, 2);
});

test('[L1] the same posting seen via an aggregator and via its Workday link is one posting with both observations', async () => {
  const db = freshDb();
  const url = 'https://acme.wd5.myworkdayjobs.com/ext/job/Chicago-IL/Data-Science-Intern_R900285';
  await batch(db, [record({ source: 'simplify', sourceId: 's-1', partition: 'simplify:list', url, completeness: { locations: 'partial', arrangement: 'unknown', description: 'tags', employment_type: 'absent' } })]);
  await batch(db, [record({ source: 'careerops', sourceId: url, partition: 'workday:acme', url: url.replace('Data-Science-Intern', 'data-science-intern') })], { runId: 'run-2' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM postings').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM observations').get().n, 2);
});

test('[L1] a fallback posting upgraded with a requisition after fetch keeps its id and history', async () => {
  const { reconcileAliases } = await identity();
  const db = freshDb();
  await batch(db, [record({ source: 'simplify', sourceId: 's-9', partition: 'simplify:list', url: 'https://careers.example.com/jobs/view/abc', title: 'Analytics Intern' })]);
  const postingId = postingFor(db, 'source:simplify:s-9');
  const result = reconcileAliases(db, postingId, [{ alias: 'company_req:example:R50001', kind: 'company_req' }], { now: T0 });
  assert.equal(result.action, 'added');
  assert.equal(postingFor(db, 'company_req:example:R50001'), postingId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM observations WHERE posting_id = ?').get(postingId).n, 1);
});

test('[L1] post-fetch alias collision with an already-submitted posting binds to it and never creates a lead', async () => {
  const { reconcileAliases } = await identity();
  const { bootstrapExisting } = await bootstrap();
  const db = freshDb();
  const submitted = seedApplication(db, { company: 'Example Corp', role: 'ML Intern', status: 'applied', externalId: 'R900519', appliedAt: '2026-09-29T00:00:00Z' });
  bootstrapExisting(db, { provenance: { automatedSkipPrefixes: [], userDeclineMarkers: [] }, now: T0 });
  await batch(db, [record({ source: 'simplify', sourceId: 's-77', partition: 'simplify:list', url: 'https://careers.example.com/jobs/view/ml-intern', title: 'Machine Learning Engineer Intern' })]);
  const fallback = postingFor(db, 'source:simplify:s-77');
  const target = db.prepare('SELECT id FROM postings WHERE application_id = ?').get(submitted.id).id;
  assert.notEqual(fallback, target, 'before fetch the aggregator record is its own posting');
  const before = applicationsCount(db);
  const result = reconcileAliases(db, fallback, [{ alias: 'company_req:example:R900519', kind: 'company_req' }], { now: T0 });
  assert.equal(result.action, 'bound');
  assert.equal(effective(db, fallback), target);
  const review = reviewOf(db, target);
  assert.equal(review.decision, 'reused');
  assert.equal(review.code, 'already_submitted');
  assert.equal(applicationsCount(db), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM observations WHERE posting_id IN (?, ?)').get(fallback, target).n, 1, 'observation history kept on its original posting');
  assert.notEqual(reviewOf(db, fallback)?.state, 'due', 'the fallback review does not continue on its own');
});

test('[L1] contradictory authoritative aliases are quarantined, not merged', async () => {
  const { reconcileAliases } = await identity();
  const db = freshDb();
  await batch(db, [
    record({ sourceId: '9100001', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9100001', requisitionId: 'R1001', title: 'Data Intern' }),
    record({ sourceId: '9100002', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9100002', requisitionId: 'R1002', title: 'Data Intern' }),
  ]);
  const first = postingFor(db, 'source:greenhouse:9100001');
  const second = postingFor(db, 'source:greenhouse:9100002');
  const result = reconcileAliases(db, first, [{ alias: 'company_req:example:R1002', kind: 'company_req' }], { now: T0 });
  assert.equal(result.action, 'quarantined');
  assert.equal(effective(db, first), first);
  assert.equal(effective(db, second), second);
  assert.equal(reviewOf(db, first).state, 'held');
  assert.equal(reviewOf(db, first).code, 'identity_conflict');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM posting_links WHERE kind = 'conflict'").get().n, 1);
});

test('[L1] same title with a different requisition is a separate posting linked maybe_same, never inheriting a submitted decision', async () => {
  const { bootstrapExisting } = await bootstrap();
  const db = freshDb();
  seedApplication(db, { company: 'Example Corp', role: 'Data Science Intern - Team A', status: 'applied', jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/9200001', appliedAt: '2026-10-01T00:00:00Z' });
  bootstrapExisting(db, { provenance: { automatedSkipPrefixes: [], userDeclineMarkers: [] }, now: T0 });
  await batch(db, [record({ sourceId: '9200002', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9200002', title: 'Data Science Intern - Team B' })]);
  const fresh = postingFor(db, 'source:greenhouse:9200002');
  const review = reviewOf(db, fresh);
  assert.equal(review.state, 'due');
  assert.equal(review.decision, null);
  assert.ok(JSON.parse(review.flags_json).some((flag) => String(flag).startsWith('maybe_same')), review.flags_json);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM posting_links WHERE kind = 'maybe_same'").get().n, 1);
});

for (const status of ['lead', 'applied', 'rejected', 'withdrawn']) {
  test(`[L1] a same-title new requisition after a ${status} application is reviewed as a new posting`, async () => {
    const { bootstrapExisting } = await bootstrap();
    const db = freshDb();
    seedApplication(db, { company: 'Example Corp', role: 'Analytics Intern', status, jobUrl: 'https://job-boards.greenhouse.io/examplecorp/jobs/9300001', appliedAt: status === 'applied' || status === 'rejected' ? '2026-09-01T00:00:00Z' : null });
    bootstrapExisting(db, { provenance: { automatedSkipPrefixes: [], userDeclineMarkers: [] }, now: T0 });
    await batch(db, [record({ sourceId: '9300009', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9300009', title: 'Analytics Intern' })]);
    assert.equal(reviewOf(db, postingFor(db, 'source:greenhouse:9300009')).state, 'due');
  });
}

test('[L1] an exact alias hit on a submitted application is reused at scan with zero work', async () => {
  const { bootstrapExisting } = await bootstrap();
  const db = freshDb();
  seedApplication(db, { company: 'Example Bank', role: 'AI Engineering Intern', status: 'applied', jobUrl: 'https://examplebank.wd12.myworkdayjobs.com/Ext/job/New-York-NY/AI-Engineering-Intern_R900109-1', appliedAt: '2026-09-29T00:00:00Z' });
  bootstrapExisting(db, { provenance: { automatedSkipPrefixes: [], userDeclineMarkers: [] }, now: T0 });
  const counts = await batch(db, [record({ source: 'simplify', sourceId: 's-cap', partition: 'simplify:list', company: 'Example Bank', title: 'AI Engineer Intern', url: 'https://examplebank.wd12.myworkdayjobs.com/Ext/job/New-York-NY/Current-Masters-AI-Engineering-Intern_R900109-1' })]);
  assert.equal(counts.reused, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state IN ('due','leased')").get().n, 0);
});
