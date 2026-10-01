import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUrl,
  companyKey,
  dedupeRoles,
  requisitionKey,
  titleSimilarity,
} from '../../src/scan/dedupe.mjs';

const role = (fields) => ({ source: 'greenhouse', sourceId: '1', company: 'Example Corp', title: 'Machine Learning Intern', locations: [], url: null, ...fields });

test('requisition ids are read from common ATS link shapes', () => {
  assert.equal(requisitionKey('https://job-boards.greenhouse.io/examplecorp/jobs/4000001'), 'greenhouse:4000001');
  assert.equal(requisitionKey('https://careers.example.com/open-roles?gh_jid=4000001'), 'greenhouse:4000001');
  assert.equal(requisitionKey('https://jobs.lever.co/examplelabs/11111111-1111-4111-8111-111111111111/apply'), 'lever:11111111-1111-4111-8111-111111111111');
  assert.equal(requisitionKey('https://jobs.ashbyhq.com/examplequant/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), 'ashby:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(requisitionKey('https://example.wd5.myworkdayjobs.com/en-US/External/job/New-York-NY/Data-Science-Intern_R12345'), 'workday:example:r12345');
  assert.equal(requisitionKey('https://careers-example.icims.com/jobs/12345/data-intern/job'), 'icims:careers-example.icims.com:12345');
  assert.equal(requisitionKey('https://careers.example.com/apply?jobId=ABC-123'), 'careers.example.com:jobid:abc-123');
  assert.equal(requisitionKey('https://careers.example.com/roles/data-intern'), null);
  assert.equal(requisitionKey('not a url'), null);
});

test('links compare without tracking parameters, case, or trailing slashes', () => {
  assert.equal(canonicalUrl('https://WWW.Example.com/jobs/7/?utm_source=x&ref=Simplify'), canonicalUrl('https://example.com/jobs/7'));
  assert.notEqual(canonicalUrl('https://example.com/jobs?id=7'), canonicalUrl('https://example.com/jobs?id=8'));
});

test('company keys drop legal suffixes and honour aliases', () => {
  assert.equal(companyKey('Example Corp'), companyKey('example, Inc.'));
  assert.equal(companyKey('The Example Company'), 'example');
  assert.equal(companyKey('Example Labs'), 'examplelabs');
  assert.equal(companyKey('Example Social', { 'Example Social': 'Example Platforms' }), companyKey('Example Platforms'));
});

test('title similarity ignores punctuation and simple word forms', () => {
  assert.equal(titleSimilarity('Software Engineering Intern, Summer 2027', 'Software Engineer Internship - Summer 2027'), 1);
  assert.ok(titleSimilarity('Machine Learning Intern, Summer 2027', 'Machine Learning Intern, Summer 2027 - NLP') >= 0.6);
  assert.ok(titleSimilarity('Machine Learning Intern', 'Data Analyst Intern') < 0.6);
  assert.ok(titleSimilarity('ML Intern Summer 2026', 'ML Intern Summer 2027') < 0.9, 'a new cycle is a new role');
});

test('dedupe matches source id, requisition id, link, company requisition id, and near-identical titles', () => {
  const existing = [
    { id: 'kept-by-source', company: 'Example Corp', role: 'Data Intern', jobUrl: null, source: 'lever', sourceId: 'abc', externalId: 'lever:abc', status: 'lead' },
    { id: 'kept-by-link', company: 'Other Example', role: 'Analyst Intern', jobUrl: 'https://careers.example.com/roles/42', source: null, sourceId: null, externalId: null, status: 'applied' },
    { id: 'kept-by-req', company: 'Example Corp', role: 'Quant Intern', jobUrl: null, source: null, sourceId: null, externalId: 'REQ-77', status: 'withdrawn' },
    { id: 'kept-by-title', company: 'Example, Inc.', role: 'Machine Learning Intern, Summer 2027', jobUrl: null, source: null, sourceId: null, externalId: null, status: 'lead' },
  ];
  const results = dedupeRoles([
    role({ source: 'lever', sourceId: 'abc', title: 'Totally different title' }),
    role({ sourceId: '2', company: 'Other Example', title: 'Analyst Intern', url: 'https://careers.example.com/roles/42/?utm_source=feed' }),
    role({ sourceId: '3', title: 'Quant Intern', requisitionId: 'req-77' }),
    role({ sourceId: '4', title: 'Machine Learning Intern - Summer 2027' }),
    role({ sourceId: '5', title: 'Machine Learning Intern, Summer 2027 - NLP' }),
    role({ sourceId: '6', title: 'Quantitative Trading Intern' }),
  ], existing);
  assert.deepEqual(results.map((item) => item.status), ['duplicate', 'duplicate', 'duplicate', 'duplicate', 'possible-duplicate', 'new']);
  assert.deepEqual(results.slice(0, 5).map((item) => item.of.id), ['kept-by-source', 'kept-by-link', 'kept-by-req', 'kept-by-title', 'kept-by-title']);
  assert.match(results[0].reason, /^duplicate: same source id as kept-by-source \(lead\)$/);
  assert.match(results[1].reason, /same link/);
  assert.match(results[2].reason, /same company requisition id as kept-by-req \(withdrawn\)/);
  assert.match(results[3].reason, /same company and title \(similarity 1\)/);
  assert.match(results[4].reason, /^possible-duplicate: similar title \(similarity 0\.83\)/);
});

test('dedupe within one scan keeps the first copy and catches the same posting from another source', () => {
  const results = dedupeRoles([
    role({ sourceId: '4000001', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/4000001' }),
    role({ source: 'simplify', sourceId: 'f1', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/4000001?utm_source=Simplify', title: 'ML Intern (listing title)' }),
  ]);
  assert.equal(results[0].status, 'new');
  assert.equal(results[1].status, 'duplicate');
  assert.match(results[1].reason, /same requisition id in the link as "Machine Learning Intern" at Example Corp in this scan/);
});

test('dedupe matches records written before schema 5 and holds back likely matches to submitted applications', () => {
  const existing = [
    { id: 'legacy-simplify', company: 'Example Corp', role: 'Data Intern', jobUrl: null, source: null, sourceId: null, externalId: 'simplify:0f0e', status: 'lead' },
    { id: 'bare-req-id', company: 'Example Labs', role: '2027 Data Science Intern', jobUrl: null, source: null, sourceId: null, externalId: '4000123', status: 'applied' },
    { id: 'oracle-link', company: 'Example Bank', role: 'Analytics Intern', jobUrl: 'https://abcd.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26010001', source: null, sourceId: null, externalId: null, status: 'applied' },
    { id: 'long-title', company: 'Example Card', role: 'Campus Graduate II Summer Internship Program - 2027 Global Decision Science, Credit & Fraud Risk - New York, NY', jobUrl: null, source: null, sourceId: null, externalId: null, status: 'applied' },
    { id: 'similar-lead', company: 'Example Card', role: 'Marketing Analytics Intern, Brand Insights Strategy', jobUrl: null, source: null, sourceId: null, externalId: null, status: 'lead' },
  ];
  const results = dedupeRoles([
    role({ source: 'simplify', sourceId: '0f0e', title: 'Another title' }),
    role({ sourceId: 'x1', company: 'Example Labs', title: 'Data Science Intern', url: 'https://job-boards.greenhouse.io/examplelabs/jobs/4000123' }),
    role({ sourceId: 'x2', company: 'Example Bank', title: 'Analytics Intern 2027', url: 'https://abcd.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26010001?utm_source=feed' }),
    role({ sourceId: 'x3', company: 'Example Card', title: 'Data Science Intern - Global Decision Science - Credit & Fraud Risk' }),
    role({ sourceId: 'x4', company: 'Example Card', title: 'Brand Insights Strategy Marketing Analytics Intern' }),
  ], existing);
  assert.deepEqual(results.map((item) => item.status), ['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
  assert.deepEqual(results.map((item) => item.of.id), ['legacy-simplify', 'bare-req-id', 'oracle-link', 'long-title', 'similar-lead']);
  assert.match(results[0].reason, /same source id/);
  assert.match(results[1].reason, /same company requisition id/);
  assert.match(results[3].reason, /likely the same role as the submitted application long-title \(applied\)/);

  const lead = dedupeRoles([role({ sourceId: 'x5', company: 'Example Card', title: 'Global Decision Science Credit Fraud Risk Analyst' })],
    existing.map((item) => (item.id === 'long-title' ? { ...item, status: 'lead' } : item)));
  assert.equal(lead[0].status, 'possible-duplicate', 'a likely match to an unsubmitted lead is queued with a note');
});

test('embedded Greenhouse links and scientist/science wording match submitted applications', () => {
  const existing = [
    { id: 'embed', company: 'Example Corp', role: 'People Analytics Intern - Summer 2027 (Hybrid, New York NY)', jobUrl: null, source: null, sourceId: null, externalId: '8175517', status: 'applied' },
    { id: 'science', company: 'Example Labs', role: 'Summer 2027: AI Science Intern', jobUrl: null, source: null, sourceId: null, externalId: '24105', status: 'applied' },
  ];
  const results = dedupeRoles([
    role({ sourceId: 'e1', company: 'Example Corp', title: 'People Analytics Intern', url: 'https://boards.greenhouse.io/embed/job_app?token=8175517' }),
    role({ sourceId: 'e2', company: 'Example Labs', title: 'AI Scientist Intern', url: 'https://jobs.example.com/job/summer-2027-ai-science-intern/27595/100620927536' }),
  ], existing);
  assert.deepEqual(results.map((item) => [item.status, item.of?.id]), [['duplicate', 'embed'], ['duplicate', 'science']]);
});
