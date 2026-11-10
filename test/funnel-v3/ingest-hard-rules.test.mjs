// User 2026-11-09: postings the listing alone decides (country, title) are dropped at ingest and counted only.
// Synthetic data only: every employer and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyRole, countryOf, titleScreenRules, CERTAIN_DROP_CODES } from '../../src/funnel/classify.mjs';
import { ingestBatch } from '../../src/funnel/ingest.mjs';
import { parseCareerOpsRoles } from '../../src/scan/sources/careerops.mjs';
import { directionRules } from '../../src/review/direction.mjs';
import { scanPolicy } from '../../src/commands/scan.mjs';
import { freshDb, T0 } from '../../test-utils/funnel-v3.mjs';
import { record, SCREENING_POLICY } from '../../test-utils/funnel-v3-fixtures.mjs';

const PROFILE = Object.freeze({ search: { jobType: 'internship', season: '2027', countries: ['US'] } });
const SCREEN = {
  function: ['pharmac(?:y|ist)', '\\bnurs(?:e|ing)\\b', '\\b(?:store|retail|cashier)\\b', '\\b(?:mechanical|civil)\\b', '\\btechnicians?\\b', '\\blegal\\b'],
  // Mirrors the level list in the user's profile/title-screen.json.
  level: ["^(?!.*\\b(?:B\\.?S\\.?c?|B\\.?A|bachelor'?s?|M\\.?S\\.?c?|M\\.?Eng|masters?|master's|MBA)\\b)(?!.*(?:\\bor\\s+(?:a\\s+)?Ph\\.?\\s?D|Ph\\.?\\s?D\\.?\\s+or\\b)).*\\b(?:Ph\\.?\\s?D|doctoral|doctorate|postdoc\\w*)\\b",
    '\\bPh\\.?\\s?D\\.?[- ]only\\b', "^(?!.*\\b(?:M\\.?S\\.?c?|M\\.?Eng|masters?|master's)\\b).*\\bMBA\\b", '\\bhigh[- ]school\\b', '\\bapprentice(?:s|ship|ships)?\\b',
    '\\bJ\\.D\\.|\\bJD\\b(?!\\.com)', '\\blaw (?:students?|school|clerks?|interns?|fellows?)\\b', '\\bM\\.D\\.(?!\\w)|(?<![,\\-–]\\s{0,3})\\bMD\\b|\\bmedical (?:students?|school)\\b'],
  term: true,
  language: { maxNonLatinShare: 0.5 },
};
const POLICY = Object.freeze({ ...SCREENING_POLICY, titleScreen: titleScreenRules(SCREEN), direction: directionRules({ allow: ['\\bdata\\b', 'forward deployed'], block: [], requireAllow: [], neutral: 'deny', anyFunctionCompanies: ['Frontier Lab Example'] }) });

// A CareerOps record exactly as the source builds it: partial locations, unknown arrangement.
let serial = 0;
const careerops = (row) => parseCareerOpsRoles({ roles: [{ company: 'Example Corp', title: 'Data Science Intern', url: `https://jobs.example.com/roles/${serial += 1}`, partition: 'greenhouse:examplecorp', ...row }] })[0];
const classify = (rec, policy = POLICY, profile = PROFILE) => classifyRole(rec, { policy, profile });
const code = (result) => result.kind === 'drop' ? result.code : result.kind;

test('[H1] a CareerOps record whose every location is outside the search countries drops as outside_countries', () => {
  for (const location of ['Bengaluru, Karnataka, India', 'Lisbon, Portugal', 'HALIFAX, NS, CA']) {
    const rec = careerops({ location });
    assert.equal(rec.completeness.locations, 'partial');
    assert.equal(code(classify(rec)), 'outside_countries', location);
  }
  assert.equal(code(classify(careerops({ locations: ['London, United Kingdom', 'Berlin, Germany'] }))), 'outside_countries', 'all foreign');
  assert.deepEqual(classify(careerops({ location: 'Lisbon, Portugal' })).evidence, [{ location: 'Lisbon, Portugal', country: 'PT' }], 'evidence names the resolved country');
  assert.equal(countryOf('HALIFAX, NS, CA'), 'CA');
  assert.equal(countryOf('Toronto, Ontario'), 'CA');
});

test('[H1] US, remote, unresolved and mixed locations stay for review', () => {
  for (const location of ['Chicago, IL', 'Remote - US', 'New York, NY', 'Prague', 'Los Angeles, CA', 'Remote - India', '3 Locations', 'Multiple Locations', 'Various']) {
    assert.equal(code(classify(careerops({ location }))), 'review', location);
  }
  assert.equal(code(classify(careerops({ location: 'Lisbon, Portugal', title: 'Data Science Intern (Remote)' }))), 'review', 'remote title');
  assert.equal(code(classify(careerops({ location: 'Lisbon, Portugal', remote: true }))), 'review', 'remote flag');
  assert.equal(code(classify(careerops({ location: 'Lisbon, Portugal', workplaceType: 'Remote' }))), 'review', 'remote workplace type');
  assert.equal(code(classify(careerops({ locations: ['Lisbon, Portugal', 'New York, NY'] }))), 'review', 'one US office keeps it');
  assert.equal(code(classify(careerops({ locations: ['Lisbon, Portugal', 'Prague'] }))), 'review', 'one unresolved place keeps it');
  assert.equal(code(classify(careerops({ location: 'Lisbon, Portugal' }), POLICY, { search: { jobType: 'internship' } })), 'review', 'no country list');
  assert.equal(code(classify(careerops({ locations: [] }))), 'review', 'no location');
  assert.equal(code(classify(careerops({ locations: ['Lisbon, Portugal', '2 Locations'] }))), 'review', 'a summary entry does not resolve');
});

test('[H2] each title code drops its example and keeps the neighbour', () => {
  const cases = [
    ['title_function', 'Pharmacy Intern', 'Data Science Intern'],
    ['title_function', 'Mechanical Engineering Intern', 'Software Engineering Intern'],
    ['title_function', 'Retail Store Intern', 'Financial Analyst Intern'],
    ['title_level', 'PhD Research Intern', 'MS/PhD Research Intern'],
    ['title_level', 'High School Summer Intern', 'Summer Intern'],
    ['title_level', 'MBA Product Management Intern', 'MBA/MS Product Management Intern'],
    ['title_level', 'MBA Summer Associate', 'Summer Associate, Master\'s or MBA'],
    ['title_level', 'Engineering Apprenticeship', 'Engineering Intern'],
    ['title_term', 'Intern - Summer 2026', 'Intern - Summer 2027'],
    ['title_term', 'Fall 2026 Co-op', 'Co-op, Fall 2026 or Spring 2027'],
    ['title_term', 'Summer 2026 Intern', 'Summer Data Analyst Intern (Class of 2026)'],
    ['title_term', 'Summer Intern 2026', 'Summer Intern, Class of 2026'],
    ['title_term', 'Summer Analyst 2026', 'Summer Analyst (Graduating 2026)'],
    ['title_term', 'Fall Co-op 2026', 'Fall Data Analytics Program Co-op Rotation 2026'],
    ['title_language', '数据分析实习生', 'Data Analyst Intern (数据)'],
  ];
  for (const [expected, dropped, kept] of cases) {
    const drop = classify(record({ title: dropped }));
    assert.equal(code(drop), expected, dropped);
    assert.ok(CERTAIN_DROP_CODES.includes(expected));
    assert.notEqual(code(classify(record({ title: kept }))).slice(0, 6), 'title_', kept);
  }
  assert.equal(code(classify(record({ title: 'Winter 2026 Intern' }))), 'review', 'winter of the prior year may run into the season');
  assert.equal(code(classify(record({ title: 'Analyst Intern' }))), 'review', 'analyst never drops');
});

test('[H4] review fixes: state codes in any case, PhD alternatives, bare JD/MD, earlier term with a later bare year', () => {
  // 1. A US-style ", XX" that is both a state and a country code is the state, in any case.
  for (const location of ['Chicago, il', 'Los Angeles, ca', 'Chicago, IL', 'Los Angeles, CA', 'Indianapolis, in']) {
    assert.equal(countryOf(location), 'US', location);
    assert.equal(code(classify(careerops({ location }))), 'review', location);
  }
  assert.equal(code(classify(careerops({ location: 'Bengaluru, Karnataka, India' }))), 'outside_countries');
  // 2. A PhD title stays only when it names a Bachelor's/Master's/MBA alternative or a PhD-or alternative.
  for (const title of ['PhD-only Graduate Research Intern', 'PhD Graduate Research Intern', 'PhD only - Research Intern']) assert.equal(code(classify(record({ title }))), 'title_level', title);
  for (const title of ['BS/PhD Research Intern', "Bachelor's or PhD Research Intern", 'MS/PhD Research Intern', 'M.S. or Ph.D. Research Intern', 'Research Intern (Masters or PhD)']) {
    assert.equal(code(classify(record({ title }))), 'review', title);
  }
  // 3. Bare JD and MD drop; a state after a place does not.
  for (const title of ['JD Summer Intern', 'MD Intern', 'J.D. Candidate Intern']) assert.equal(code(classify(record({ title }))), 'title_level', title);
  for (const title of ['Data Science Intern - Bethesda, MD', 'Data Analyst Intern, Baltimore, MD', 'Data Intern - MD']) assert.equal(code(classify(record({ title }))), 'review', title);
  // 4. An earlier season and year drops even next to a later bare year; a later season and year or a range keeps it.
  assert.equal(code(classify(record({ title: 'Summer 2026 Data Analyst Intern (Class of 2027)' }))), 'title_term');
  // Round 2: only a season and year pair decides; a range keeps it only when attached to a season word.
  for (const title of ['Summer Data Analyst Intern (Class of 2026)', 'Summer Intern - Grad 2026']) assert.equal(code(classify(record({ title }))), 'review', title);
  assert.equal(code(classify(record({ title: 'Summer Data Intern 2026' }))), 'title_term', 'three words between still pair');
  assert.equal(code(classify(record({ title: 'Summer 2026 Data Intern (Class of 2026-2027)' }))), 'title_term');
  assert.equal(code(classify(record({ title: 'Data Intern Summer 2026/27' }))), 'review');
  for (const title of ['2026-2027 Fall Co-op', 'Fall Co-op 2026-2027']) assert.equal(code(classify(record({ title }))), 'review', title);
  assert.equal(code(classify(record({ title: 'Fall Co-op 2026 (Class of 2026-2027)' }))), 'title_term', 'a Class-of range does not keep it');
  for (const title of ['Fall 2026 Co-op (Graduating in Spring 2026-2027)', 'Fall 2026 Co-op (Graduating Spring 2026 - Summer 2027)', 'Fall 2026 Co-op, Class of Summer 2027']) {
    assert.equal(code(classify(record({ title }))), 'title_term', `a graduation clause never keeps it: ${title}`);
  }
  assert.equal(code(classify(record({ title: 'Graduate Summer Intern 2026' }))), 'title_term', 'the word graduate alone is not a graduation clause');
  for (const title of ['Summer 2026 / Summer 2027 Data Intern', 'Data Intern Fall 2026 - Spring 2027', 'Data Co-op Fall 2026-2027', 'Data Intern 2027 (Class of 2026)']) {
    assert.equal(code(classify(record({ title }))), 'review', title);
  }
});

test('[H2] a direction word or a role-direction allow match overrides the function list', () => {
  for (const title of ['Pharmacy Data Analyst Intern', 'Retail Strategy Intern', 'Clinical Nursing Analytics Intern', 'Store Product Intern',
    'Legal Technology Intern', 'Mechanical Engineering AI Intern', 'Retail Forward Deployed Intern', 'Quant Technician Intern']) {
    assert.equal(code(classify(record({ title }))), 'review', title);
  }
  assert.equal(code(classify(record({ title: 'Nursing Intern' }))), 'title_function');
  assert.equal(code(classify(record({ title: 'Mechanical Lead', company: 'Frontier Lab Example' }))), 'review', 'any-function company');
  assert.equal(code(classify(record({ title: 'PhD Research Intern', company: 'Frontier Lab Example' }))), 'title_level', 'level, term and language still apply there');
});

test('[H2] without a title screen nothing changes', () => {
  const { titleScreen, ...plain } = POLICY;
  assert.equal(code(classify(record({ title: 'Pharmacy Intern' }), plain)), 'review');
});

test('[H2] a malformed title screen is rejected at load, a missing one is no screen', async () => {
  assert.throws(() => titleScreenRules({ function: ['pharmac(y'] }), /invalid pattern/);
  assert.throws(() => titleScreenRules({ level: 'phd' }), /list of non-empty strings/);
  assert.throws(() => titleScreenRules({ term: 'yes' }), /term must be/);
  assert.throws(() => titleScreenRules({ language: { maxNonLatinShare: 2 } }), /maxNonLatinShare/);
  assert.throws(() => titleScreenRules({ functions: [] }), /unknown key/);
  assert.equal(titleScreenRules(undefined), null);
  const root = await mkdtemp(path.join(os.tmpdir(), 'cj-title-screen-'));
  try {
    const profileDir = path.join(root, '.career-journal', 'profile');
    await mkdir(profileDir, { recursive: true });
    const context = { root, config: { data: { database: '.career-journal/career-journal.db' } } };
    assert.equal((await scanPolicy(context)).titleScreen, null);
    await writeFile(path.join(profileDir, 'title-screen.json'), JSON.stringify({ function: ['\\bnurs(?:e|ing)\\b'] }));
    assert.ok((await scanPolicy(context)).titleScreen.function[0].test('Nursing Intern'));
    await writeFile(path.join(profileDir, 'title-screen.json'), JSON.stringify({ function: ['nurs(e'] }));
    await assert.rejects(scanPolicy(context), /title-screen\.json.*invalid pattern/);
    await writeFile(path.join(profileDir, 'title-screen.json'), '{ not json');
    await assert.rejects(scanPolicy(context), /title-screen\.json/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('[H3] ingest counts listing drops without storing them', () => {
  const db = freshDb();
  const records = [
    careerops({ location: 'Bengaluru, Karnataka, India' }),
    careerops({ location: 'Chicago, IL', title: 'Pharmacy Intern' }),
    careerops({ location: 'Chicago, IL', title: 'PhD Research Intern' }),
    careerops({ location: 'Chicago, IL', title: 'Intern - Summer 2025' }),
    careerops({ location: 'Chicago, IL', title: '薬剤師インターン' }),
    careerops({ location: 'Chicago, IL', title: 'Data Science Intern' }),
  ];
  const counts = ingestBatch(db, { runId: 'scan-1', source: 'careerops', partition: 'greenhouse:examplecorp', records, now: T0, policy: POLICY, profile: PROFILE });
  assert.deepEqual(counts.countedOnlyBy, { outside_countries: 1, title_function: 1, title_level: 1, title_term: 1, title_language: 1 });
  assert.deepEqual([counts.observed, counts.stored, counts.countedOnly, counts.review], [6, 1, 5, 1]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM postings').get().n, 1, 'only the reviewable role is stored');
});
