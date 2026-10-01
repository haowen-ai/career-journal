import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ATS_ENDPOINTS, fetchAtsBoards, parseAshby, parseGreenhouse, parseLever } from '../../src/scan/sources/ats-boards.mjs';
import { fetchSimplify, parseSimplify } from '../../src/scan/sources/simplify.mjs';
import { fetchCareerOpsRoles } from '../../src/scan/sources/careerops.mjs';
import { htmlToText } from '../../src/scan/text.mjs';
import { ATS_URLS, SIMPLIFY_URL, fixtureFetch, scanFixtures } from '../../test-utils/scan-fixtures.mjs';

test('uses the official public job-board endpoints', () => {
  assert.equal(ATS_ENDPOINTS.greenhouse('examplecorp'), ATS_URLS.greenhouse);
  assert.equal(ATS_ENDPOINTS.lever('examplelabs'), ATS_URLS.lever);
  assert.equal(ATS_ENDPOINTS.ashby('examplequant'), ATS_URLS.ashby);
});

test('Greenhouse parser decodes escaped HTML and normalises each job', async () => {
  const { greenhouse } = await scanFixtures();
  const roles = parseGreenhouse(greenhouse, { ats: 'greenhouse', board: 'examplecorp' });
  assert.equal(roles.length, 6, 'records without an id or an http(s) link are skipped');
  assert.deepEqual({ ...roles[0], description: undefined }, {
    source: 'greenhouse',
    sourceId: '4000001',
    company: 'Example Corp',
    title: 'Machine Learning Intern, Summer 2027',
    locations: ['New York, NY'],
    url: 'https://job-boards.greenhouse.io/examplecorp/jobs/4000001',
    postedAt: '2026-09-28T18:00:00.000Z',
    description: undefined,
    categories: ['Engineering'],
    requisitionId: 'REQ-1001',
  });
  assert.match(roles[0].description, /Pursuing a Bachelor's or Master's degree/);
  assert.match(roles[0].description, /Python & SQL/);
  assert.doesNotMatch(roles[0].description, /[<>]|&lt;|&amp;/);
  assert.equal(roles[1].postedAt, '2026-09-20T10:00:00.000Z', 'falls back to updated_at');
  assert.equal(parseGreenhouse({ jobs: [{ id: 1, title: 'Intern', absolute_url: 'https://example.com/1' }] }, { board: 'example-corp' })[0].company, 'Example Corp');
  assert.deepEqual(parseGreenhouse(null, { board: 'x' }), []);
});

test('Lever parser reads categories, lists, timestamps, and remote workplace type', async () => {
  const { lever } = await scanFixtures();
  const roles = parseLever(lever, { ats: 'lever', board: 'examplelabs', company: 'Example Labs' });
  assert.equal(roles.length, 5);
  assert.equal(roles[0].source, 'lever');
  assert.equal(roles[0].sourceId, '11111111-1111-4111-8111-111111111111');
  assert.equal(roles[0].company, 'Example Labs');
  assert.deepEqual(roles[0].locations, ['New York, NY']);
  assert.deepEqual(roles[0].categories, ['Research', 'Intern']);
  assert.equal(roles[0].postedAt, '2026-09-22T16:00:00.000Z');
  assert.match(roles[0].description, /Requirements\n• Pursuing a graduate degree/);
  assert.equal(roles[2].remote, true);
  assert.equal(parseLever({ data: lever }, { board: 'examplelabs' }).length, 5, 'tolerates a wrapped list');
});

test('Ashby parser skips unlisted jobs and merges secondary locations', async () => {
  const { ashby } = await scanFixtures();
  const roles = parseAshby(ashby, { ats: 'ashby', board: 'examplequant', company: 'Example Quant' });
  assert.deepEqual(roles.map((item) => item.sourceId), ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd']);
  assert.equal(roles[0].remote, true);
  assert.deepEqual(roles[2].locations, ['Manhattan, New York', 'Seattle, WA']);
  assert.deepEqual(roles[0].categories, ['Research', 'Machine Learning', 'Intern']);
  assert.equal(roles[2].description, "Open to students pursuing a Bachelor's, Master's, or PhD.");
});

test('a failing board is reported without stopping the other boards', async () => {
  const { greenhouse } = await scanFixtures();
  const calls = [];
  const result = await fetchAtsBoards([
    { ats: 'greenhouse', board: 'examplecorp' },
    { ats: 'lever', board: 'examplelabs' },
    { ats: 'ashby', board: 'examplequant' },
  ], fixtureFetch({ [ATS_URLS.greenhouse]: greenhouse, [ATS_URLS.lever]: 404, [ATS_URLS.ashby]: new Error('socket hang up') }, calls));
  assert.equal(result.roles.length, 6);
  assert.deepEqual(result.sources.map((item) => [item.source, item.status, item.detail ?? null]), [
    ['greenhouse', 'ok', null],
    ['lever', 'error', 'HTTP 404'],
    ['ashby', 'error', 'socket hang up'],
  ]);
  assert.deepEqual(calls.sort(), Object.values(ATS_URLS).sort());
});

test('Simplify is skipped unless opted in with a URL, and only reads active listings', async () => {
  const { simplify } = await scanFixtures();
  const calls = [];
  const fetchImpl = fixtureFetch({ [SIMPLIFY_URL]: simplify }, calls);
  assert.equal((await fetchSimplify({ enabled: false, url: SIMPLIFY_URL }, fetchImpl)).sources[0].status, 'skipped');
  assert.match((await fetchSimplify({ enabled: true, url: null }, fetchImpl)).sources[0].detail, /no URL/);
  assert.equal(calls.length, 0, 'no request is made unless the user opts in');
  const result = await fetchSimplify({ enabled: true, url: SIMPLIFY_URL }, fetchImpl);
  assert.deepEqual(calls, [SIMPLIFY_URL]);
  assert.equal(result.sources[0].status, 'ok');
  assert.equal(result.roles.length, 6, 'inactive listings are skipped');
  const [first, second] = result.roles;
  assert.equal(first.url, 'https://job-boards.greenhouse.io/examplecorp/jobs/4000001?ref=Simplify', 'utm parameters are removed');
  assert.deepEqual(first.terms, ['Summer 2027']);
  assert.equal(second.postedAt, new Date(1790697600 * 1000).toISOString());
  assert.match(parseSimplify(simplify).find((item) => item.company === 'Example Defense').description, /Sponsorship: U\.S\. Citizenship is Required/);
  assert.equal(parseSimplify({ listings: simplify }).length, 6);
});

test('the Simplify module documents that it is opt-in with no redistribution', async () => {
  const source = await readFile(new URL('../../src/scan/sources/simplify.mjs', import.meta.url), 'utf8');
  assert.match(source, /without an\s+\/\/ open-source licence|without an open-source licence/);
  assert.match(source, /opt-in/);
  assert.match(source, /no redistribution/i);
});

test('CareerOps runs only when enabled and detected, through the read-only bridge scan', async () => {
  const { careerops } = await scanFixtures();
  assert.match((await fetchCareerOpsRoles(false, {})).sources[0].detail, /not enabled/);
  const missing = await fetchCareerOpsRoles(true, { root: null });
  assert.equal(missing.sources[0].status, 'skipped');
  assert.match(missing.sources[0].detail, /CareerOps not detected/);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'career-journal-careerops-scan-'));
  try {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'career-ops', version: '1.32.0' }));
    await writeFile(path.join(directory, 'career-journal-adapter.mjs'), '');
    let invocation;
    const result = await fetchCareerOpsRoles(true, { root: directory, pinnedVersion: '1.32.0' }, {
      execute: async (value) => { invocation = value; return { exitCode: 0, stdout: JSON.stringify(careerops), stderr: '' }; },
    });
    assert.deepEqual(invocation.args, [path.join(directory, 'career-journal-adapter.mjs'), 'scan']);
    assert.deepEqual(JSON.parse(invocation.stdin), { action: 'scan', readOnly: true });
    assert.equal(result.sources[0].status, 'ok');
    assert.equal(result.roles.length, 1, 'roles without a link are skipped');
    assert.deepEqual(result.roles[0].locations, ['Seattle, WA']);
    assert.equal(result.roles[0].source, 'careerops');

    const failed = await fetchCareerOpsRoles(true, { root: directory, pinnedVersion: '1.32.0' }, {
      execute: async () => ({ exitCode: 1, stdout: '', stderr: 'portal unavailable' }),
    });
    assert.equal(failed.sources[0].status, 'error');
    assert.match(failed.sources[0].detail, /portal unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTML job descriptions become readable text', () => {
  assert.equal(htmlToText('&lt;p&gt;One &amp;amp; two&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Three&lt;/li&gt;&lt;/ul&gt;'), 'One & two\n• Three');
  assert.equal(htmlToText('<script>alert(1)</script><b>Bold</b>&nbsp;text&#x21;'), 'Bold text!');
});
