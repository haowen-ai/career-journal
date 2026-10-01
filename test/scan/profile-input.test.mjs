import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultProfilePath, loadScanProfile, normalizeScanProfile } from '../../src/scan/profile-input.mjs';
import { readFixture } from '../../test-utils/scan-fixtures.mjs';

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-scan-profile-'));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('reads the shared profile contract from the data home', async () => withHome(async (home) => {
  const fixture = await readFixture('profile.json');
  const file = defaultProfilePath(home);
  assert.equal(file, path.join(home, '.career-journal', 'profile', 'profile.json'));
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
  const profile = await loadScanProfile(home);
  assert.deepEqual(profile.search.directions, { primary: ['ai-ml', 'data-science', 'data-analytics'], secondary: ['quant'] });
  assert.deepEqual(profile.search.locations[0], { label: 'New York, NY', match: ['new york', 'nyc', 'manhattan'] });
  assert.equal(profile.candidate.degree.level, 'masters');
  assert.equal(profile.candidate.authorization.status, 'permanent-resident');
  assert.equal(profile.pace.scanTime, '08:30');
  assert.deepEqual(profile.sources.atsBoards.map((item) => item.ats), ['greenhouse', 'lever', 'ashby']);
  assert.deepEqual(profile.sources.simplify, { enabled: false, url: null });
  assert.equal('materials' in profile, false, 'scan input keeps only scan fields');
}));

test('a legacy .jobops workspace keeps its profile next to its config, and the workspace profile is fully validated', async () => withHome(async (home) => {
  const fixture = await readFixture('profile.json');
  await mkdir(path.join(home, '.jobops'), { recursive: true });
  await writeFile(path.join(home, '.jobops', 'config.json'), '{}\n');
  const file = defaultProfilePath(home);
  assert.equal(file, path.join(home, '.jobops', 'profile', 'profile.json'));
  await assert.rejects(() => loadScanProfile(home), (error) => error.message.includes(`No search profile found at ${file}.`));
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
  const profile = await loadScanProfile(home);
  assert.deepEqual(profile.sources.atsBoards.map((item) => item.board), ['examplecorp', 'examplelabs', 'examplequant']);
  assert.equal(profile.sources.atsBoards[1].company, 'Example Labs');

  // The workspace profile follows the full profile contract; a hand-edited unknown field is refused.
  await writeFile(file, JSON.stringify({ ...fixture, search: { ...fixture.search, salary: 100 } }));
  await assert.rejects(() => loadScanProfile(home), /Unknown profile field: search\.salary/);
  await writeFile(file, JSON.stringify({ ...fixture, schemaVersion: undefined }));
  await assert.rejects(() => loadScanProfile(home), /Unsupported profile schema/);
}));

test('--profile reads another path and missing files explain the next step', async () => withHome(async (home) => {
  await assert.rejects(() => loadScanProfile(home), /No search profile found at .*profile\.json\. Complete the profile interview first, or pass --profile <path>\./);
  const other = path.join(home, 'elsewhere.json');
  await writeFile(other, JSON.stringify({ search: { season: 'Summer 2027' } }));
  assert.equal((await loadScanProfile(home, { path: other })).search.season, 'Summer 2027');
  await writeFile(other, '{ not json');
  await assert.rejects(() => loadScanProfile(home, { path: other }), /not valid JSON/);
}));

test('validates only the fields the scan needs, with the field path in each error', () => {
  const cases = [
    [{ schemaVersion: 2 }, /schemaVersion 2 is not supported/],
    [{ search: { directions: { primary: ['astronomy'] } } }, /search\.directions\.primary contains unknown direction "astronomy"/],
    [{ search: { locations: [{ match: ['nyc'] }] } }, /search\.locations\[0\]\.label is required/],
    [{ search: { remoteOk: 'yes' } }, /search\.remoteOk must be true or false/],
    [{ candidate: { degree: { level: 'doctorate' } } }, /candidate\.degree\.level must be one of/],
    [{ candidate: { degree: { graduation: 'December 2027' } } }, /graduation must be YYYY-MM/],
    [{ candidate: { authorization: { status: 'resident' } } }, /candidate\.authorization\.status must be one of/],
    [{ pace: { scanTime: '8am' } }, /pace\.scanTime must be HH:MM/],
    [{ sources: { atsBoards: [{ ats: 'workday', board: 'example' }] } }, /sources\.atsBoards\[0\]\.ats must be one of: greenhouse, lever, ashby/],
    [{ sources: { atsBoards: [{ ats: 'greenhouse', board: '../etc' }] } }, /sources\.atsBoards\[0\]\.board must be the public board name/],
    [{ sources: { simplify: { enabled: true, url: 'http://example.com/listings.json' } } }, /sources\.simplify\.url must be an https URL/],
  ];
  for (const [input, pattern] of cases) assert.throws(() => normalizeScanProfile(input), pattern);
  const minimal = normalizeScanProfile({});
  assert.deepEqual(minimal.search.directions, { primary: [], secondary: [] });
  assert.equal(minimal.search.remoteOk, false);
  assert.deepEqual(minimal.sources, { atsBoards: [], careerOps: false, simplify: { enabled: false, url: null } });
  const overlapping = normalizeScanProfile({ search: { directions: { primary: ['quant'], secondary: ['quant', 'product'] }, locations: [{ label: 'Boston, MA' }] } });
  assert.deepEqual(overlapping.search.directions.secondary, ['product']);
  assert.deepEqual(overlapping.search.locations[0].match, ['boston, ma']);
});

test('an unreadable profile reports the filesystem error', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => withHome(async (home) => {
  const file = defaultProfilePath(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{}');
  await chmod(file, 0o000);
  try { await assert.rejects(() => loadScanProfile(home), /EACCES|permission/i); }
  finally { await chmod(file, 0o600); }
}));
