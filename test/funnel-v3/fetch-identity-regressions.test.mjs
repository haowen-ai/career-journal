// Fetch identity regressions from the 2026-10-26 diagnosis of postings stuck as wrong_posting, host_mismatch,
// challenge and req_conflict after an official fetch (rulings G–J). Shapes follow real fetch results; every name,
// host and id below is synthetic.
//   G identity by id, then fuzzy title: the fetched page is the requested posting when (a) it came from the ATS API
//     keyed by the requested URL, (b) the fetched requisition id appears in the requested URL, or (c) the requested
//     URL's job id (>= 5 chars, contains a digit) is still in the final URL's path and the titles match loosely
//     (titleSimilarity >= 0.4 or titleContainment >= 0.6). Homepage/listing redirects that lose the id still fail.
//   H a host change is allowed when the job id survives in the final path and the titles match loosely;
//     *.greenhouse.io subdomains are one host.
//   I "search results" navigation text on a normal posting page is not a challenge; real challenges still are.
//   J Workday requisition ids compare ignoring case and punctuation, and one may be a suffix of the other with at
//     least four digits; the URL id parser keeps a year-prefixed id (R26_0000029138) whole. Distinct ids conflict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../../test-utils/funnel-v3.mjs';
import { SNAPSHOTS, page } from '../../test-utils/funnel-v3-fixtures.mjs';

const fetchModule = () => load('B4', './src/review/fetch.mjs', ['validateSnapshot']);
const identityModule = () => load('A', './src/funnel/identity.mjs', ['providerRequisition']);

const BODY = SNAPSHOTS.eligible;
const html = (url, title, extra = {}) => page(url, BODY, { method: 'html', title, ...extra });
const jsonld = (url, title, extra = {}) => page(url, BODY, { method: 'jsonld', title, jsonLd: { '@type': 'JobPosting', title }, ...extra });

// ===================================================================== G

test('[B] an ATS API fetch keyed by the requested URL is the requested posting even when its title differs (fetch G)', async () => {
  const { validateSnapshot } = await fetchModule();
  // The URL id ends in a letter, so the posting carries no requisition of its own; a posting that does carry one
  // still needs it confirmed (l2-recovery R1: an ATS page without a requisition and an unrelated title is wrong_posting).
  const url = 'https://examplerobotics.wd1.myworkdayjobs.com/Early-Careers/job/Belfast/Co-op--Robotics-Research_REF088379W';
  const posting = { id: 'p-g1', company: 'Example Robotics', title: 'Robotics Co-op', url };
  const result = page(url, BODY, { method: 'ats_api', title: 'Co-op - Research & Data Engineering', requisitionId: null });
  assert.deepEqual(validateSnapshot(posting, result), { identityOk: true, reason: null });
  const redirected = { ...result, finalUrl: 'https://examplerobotics.wd1.myworkdayjobs.com/Early-Careers' };
  assert.equal(validateSnapshot(posting, redirected).reason, 'wrong_posting', 'an API result that landed elsewhere is not keyed by the requested URL');
});

test('[B] a fetched requisition id that appears in the requested URL identifies the posting (fetch G)', async () => {
  const { validateSnapshot } = await fetchModule();
  const url = 'https://careers.examplelabs.test/job/Research-Intern/JR-48213';
  const posting = { id: 'p-g2', company: 'Example Labs', title: 'Machine Learning Research Intern', url };
  const result = jsonld(url, 'Research Internship, Applied ML (2027)', { requisitionId: 'JR-48213' });
  assert.deepEqual(validateSnapshot(posting, result), { identityOk: true, reason: null });
  assert.equal(validateSnapshot(posting, { ...result, requisitionId: 'JR-48214', title: 'Corporate Communications Associate' }).identityOk, false,
    'a requisition id the URL does not carry, with an unrelated title, is not the posting');
});

test('[B] a job id kept in the final path plus a loosely matching title identifies the posting; redirects that lose the id still fail (fetch G)', async () => {
  const { validateSnapshot } = await fetchModule();
  const same = { id: 'p-g3', company: 'Example Applied Physics Lab', title: 'Data Scientist Intern - Data Science - System Performance Evaluation', url: 'https://careers.exampleapl.test/jobs/59800' };
  assert.deepEqual(validateSnapshot(same, jsonld(same.url, '2027 Internship – Data Science – System Performance Evaluation')), { identityOk: true, reason: null },
    'same URL, reworded title (similarity 0.86)');
  const moved = { id: 'p-g4', company: 'Example Instruments', title: 'Photonics Design Software & Automation Engineer Intern', url: 'https://jobs.exampleinstruments.test/jobs/54619' };
  assert.deepEqual(validateSnapshot(moved, jsonld('https://jobs.exampleinstruments.test/external/jobs/54619', 'Intern - Photonics Design Software & Automation Engineer (PhD Level)')),
    { identityOk: true, reason: null }, 'the id survives a path rewrite on the same host');
  // Redirects that lose the job id, unrelated titles and too-short ids still fail.
  const posting = { id: 'p-g5', company: 'Example Labs', title: 'Quantitative Research Intern', url: 'https://careers.examplelabs.test/jobs/54620' };
  assert.equal(validateSnapshot(posting, html('https://careers.examplelabs.test/', 'Careers at Example Labs')).reason, 'wrong_posting', 'homepage redirect');
  assert.equal(validateSnapshot(posting, html('https://careers.examplelabs.test/jobs?q=research', 'Quantitative Research Internship - Summer 2027')).reason, 'wrong_posting',
    'a listing page that lost the id fails even with a loosely matching title');
  assert.equal(validateSnapshot(posting, html(posting.url, 'Corporate Communications Associate')).reason, 'wrong_posting', 'id kept but an unrelated title');
  const short = { ...posting, url: 'https://careers.examplelabs.test/jobs/4821' };
  assert.equal(validateSnapshot(short, html(short.url, 'Quantitative Research Internship - Summer 2027')).reason, 'wrong_posting', 'a four-character id is not a job id');
});

// ===================================================================== H

test('[B] a host change that keeps the job id with a loosely matching title is allowed (fetch H)', async () => {
  const { validateSnapshot } = await fetchModule();
  const posting = { id: 'p-h1', company: 'Example Instruments', title: 'Photonics Design Software & Automation Engineer Intern', url: 'https://jobs.exampleinstruments.test/jobs/54619' };
  const result = jsonld('https://careers.exampleinstruments.test/external/jobs/54619', 'Intern - Photonics Design Software & Automation Engineer (PhD Level)');
  assert.deepEqual(validateSnapshot(posting, result), { identityOk: true, reason: null });
  assert.equal(validateSnapshot(posting, jsonld('https://other.example.net/careers', 'Intern - Photonics Design Software & Automation Engineer (PhD Level)')).reason, 'host_mismatch',
    'a host change that loses the id is still a mismatch');
  assert.equal(validateSnapshot(posting, jsonld('https://careers.exampleinstruments.test/external/jobs/54619', 'Corporate Communications Associate')).identityOk, false,
    'a host change with the id but an unrelated title is not the posting');
});

test('[B] Greenhouse subdomains count as one host (fetch H)', async () => {
  const { validateSnapshot } = await fetchModule();
  const posting = { id: 'p-h2', company: 'Examplecorp', title: 'Software Engineer Intern', url: 'https://boards.greenhouse.io/embed/job_app?token=8168322' };
  const result = html('https://job-boards.greenhouse.io/embed/job_app?for=examplecorp&token=8168322', 'Software Engineer Intern');
  assert.deepEqual(validateSnapshot(posting, result), { identityOk: true, reason: null });
  assert.equal(validateSnapshot(posting, html('https://examplecorp.test/careers', 'Software Engineer Intern')).reason, 'host_mismatch',
    'leaving greenhouse.io without the id is still a mismatch');
});

// ===================================================================== I

test('[B] "search results" navigation on a normal posting page is not a challenge (fetch I)', async () => {
  const { validateSnapshot } = await fetchModule();
  const posting = { id: 'p-i1', company: 'Example Bank', title: 'Data Science Intern', url: 'https://careers.examplebank.test/jobs/77120' };
  for (const nav of ['Jobs search results', 'Back to Search Results']) {
    assert.deepEqual(validateSnapshot(posting, html(posting.url, 'Data Science Intern', { text: `${nav}\n${BODY}` })), { identityOk: true, reason: null }, nav);
  }
  for (const wall of ['Please verify you are human before continuing.', 'Access denied', 'Please complete the captcha below.', 'Enable JavaScript and cookies to continue']) {
    assert.equal(validateSnapshot(posting, html(posting.url, 'Data Science Intern', { text: `${wall}\n${BODY}` })).reason, 'challenge', wall);
  }
});

// ===================================================================== J

test('[B] Workday requisitions match ignoring case, punctuation and a year prefix (fetch J)', async () => {
  const { validateSnapshot } = await fetchModule();
  const wd = (slug, requisition) => ({ id: `p-${slug}`, company: 'Example Holdings', title: 'Data Analyst Intern', requisition,
    url: `https://exampleholdings.wd1.myworkdayjobs.com/Careers/job/Chicago-IL/Data-Analyst-Intern_${slug}` });
  const ok = (posting, fetched) => assert.deepEqual(validateSnapshot(posting, page(posting.url, BODY, { title: posting.title, requisitionId: fetched })),
    { identityOk: true, reason: null }, `${posting.requisition ?? '(from URL)'} vs ${fetched}`);
  const conflict = (posting, fetched) => assert.equal(validateSnapshot(posting, page(posting.url, BODY, { title: posting.title, requisitionId: fetched })).reason,
    'req_conflict', `${posting.requisition ?? '(from URL)'} vs ${fetched}`);
  ok(wd('Job_Req_55893', 'REQ_55893'), 'Job_Req_55893');
  ok(wd('R0062297', 'R0062297'), 'R.0062297');
  ok(wd('R26_0000029138', '0000029138'), 'R26_0000029138');
  ok(wd('R26_6022', '6022'), 'R26_6022');
  ok(wd('R26_0000029138', undefined), 'R26_0000029138');
  conflict(wd('R0062297', 'R0062297'), 'R.0062298');
  conflict(wd('R26_6022', '6022'), 'R26_6023');
  conflict(wd('R26_6022', 'R26_6022'), 'R27_6022');
  conflict(wd('R26_6022', '022'), 'R26_6022');
  conflict(wd('Job_Req_55893', 'REQ_55893'), 'Job_Req_55894');
});

test('[A] the Workday URL id keeps a year-prefixed requisition whole (fetch J)', async () => {
  const { providerRequisition } = await identityModule();
  const id = (slug) => providerRequisition(`https://exampleholdings.wd1.myworkdayjobs.com/Careers/job/Chicago-IL/Data-Analyst-Intern_${slug}`)?.id;
  assert.equal(id('R26_0000029138'), 'R26_0000029138');
  assert.equal(id('R26_6022'), 'R26_6022');
  assert.notEqual(id('R26_0000029138'), id('R27_0000029138'), 'different year prefixes are different requisitions');
  assert.equal(id('R900777-1'), 'R900777-1', 'posting suffix ids are unchanged');
  assert.equal(id('JR-2002'), 'JR-2002');
});
