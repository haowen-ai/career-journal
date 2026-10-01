import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  answeredKeys, answerRows, answersPath, answersTemplate, appendAnswer, defaultProfile, getProfileValue, hasScanSource, missingItems,
  normalizeProfile, parseProfileValue, profileDirectory, profilePath, profileStatus, readAnswers, readProfile,
  resolveMaterialPath, resolveProfileKey, setProfileValue, updateProfile, validateProfile, writeProfile,
} from '../../src/domain/profile.mjs';

const posixPermissions = process.platform !== 'win32';

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-profile-'));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

async function writeResume(home, name = 'resume.pdf') {
  const file = path.join(home, name);
  await writeFile(file, '%PDF-1.4 synthetic resume\n');
  return file;
}

function completeProfile(resumePath = null) {
  const profile = defaultProfile();
  profile.search = {
    jobType: 'internship',
    season: 'Summer 2027',
    directions: { primary: ['ai-ml', 'data-science'], secondary: ['quant'] },
    locations: [{ label: 'New York, NY', match: ['new york', 'nyc'] }, { label: 'Seattle, WA', match: ['seattle'] }],
    remoteOk: true,
    exclusions: ['no-return-offer'],
  };
  profile.candidate = {
    degree: { level: 'masters', major: 'Data Science', graduation: '2027-12' },
    authorization: { status: 'permanent-resident', needsSponsorship: false },
  };
  profile.materials.resumePath = resumePath;
  profile.materials.experienceConfirmed = true;
  return profile;
}

const roundThreeAnswers = [
  ['legal-name', 'Alex Example'],
  ['email', 'alex@example.com'],
  ['phone', '+1 555 0100'],
  ['address', '100 Example Street, New York, NY 10001'],
];

test('the default profile is valid and matches the blank repository templates', async () => {
  assert.deepEqual(validateProfile(defaultProfile()), { ok: true, errors: [] });
  const template = JSON.parse(await readFile('config/profile.template.json', 'utf8'));
  assert.deepEqual(template, defaultProfile());
  const answers = await readFile('config/answers.template.md', 'utf8');
  assert.equal(answers, answersTemplate());
  assert.match(answers, /^## Common form answers · 常用表单答案$/m);
  assert.match(answers, /^## Learned while applying · 申请中补充$/m);
  assert.deepEqual(answerRows(answers), []);
});

test('the shared contract example from the implementation plan validates', () => {
  const example = {
    schemaVersion: 1,
    updatedAt: '2026-10-01T00:00:00Z',
    search: {
      jobType: 'internship',
      season: 'Summer 2027',
      directions: { primary: ['ai-ml', 'data-science', 'data-analytics'], secondary: ['quant'] },
      locations: [{ label: 'New York, NY', match: ['new york', 'nyc', 'manhattan'] }],
      remoteOk: true,
      exclusions: ['no-return-offer'],
    },
    candidate: {
      degree: { level: 'masters', major: 'Machine Learning and Data Science', graduation: '2027-12' },
      authorization: { status: 'permanent-resident', needsSponsorship: false },
    },
    materials: {
      resumePath: null,
      transcriptPath: null,
      transcriptPolicy: 'required-only',
      links: { linkedin: null, github: null, website: null },
      experienceConfirmed: false,
    },
    pace: { batchSize: 5, scanTime: '08:00', notify: 'desktop' },
    sources: {
      atsBoards: [{ ats: 'greenhouse', board: 'examplecorp' }],
      careerOps: false,
      simplify: { enabled: false, url: null },
    },
    interview: { roundsCompleted: [], skipped: [] },
  };
  assert.deepEqual(validateProfile(example), { ok: true, errors: [] });
});

test('the profile schema accepts every source field the role scan reads, including the optional company name', async () => {
  const fixture = JSON.parse(await readFile('test/fixtures/scan/profile.json', 'utf8'));
  assert.deepEqual(validateProfile(fixture), { ok: true, errors: [] });
  assert.ok(fixture.sources.atsBoards.some((board) => board.company), 'the scan fixture names a company');
  const profile = completeProfile();
  profile.sources = {
    atsBoards: [{ ats: 'greenhouse', board: 'examplecorp', company: 'ExampleCorp' }, { ats: 'ashby', board: 'example.quant_2' }],
    careerOps: true,
    simplify: { enabled: true, url: 'https://example.com/listings.json' },
  };
  assert.deepEqual(validateProfile(profile), { ok: true, errors: [] });
});

test('hasScanSource needs a job board, CareerOps, or the Simplify list together with its URL', () => {
  const withSources = (sources) => ({ ...defaultProfile(), sources: { ...defaultProfile().sources, ...sources } });
  assert.equal(hasScanSource(defaultProfile()), false);
  assert.equal(hasScanSource(null), false);
  assert.equal(hasScanSource(withSources({ atsBoards: [{ ats: 'lever', board: 'examplelabs' }] })), true);
  assert.equal(hasScanSource(withSources({ careerOps: true })), true);
  assert.equal(hasScanSource(withSources({ simplify: { enabled: true, url: null } })), false);
  assert.equal(hasScanSource(withSources({ simplify: { enabled: false, url: 'https://example.com/listings.json' } })), false);
  assert.equal(hasScanSource(withSources({ simplify: { enabled: true, url: 'https://example.com/listings.json' } })), true);
});

test('validation names the field and the rule for every invalid value', () => {
  const cases = [
    [(p) => { p.search.jobType = 'gig'; }, /^search\.jobType must be one of: internship, full-time, co-op, other$/],
    [(p) => { p.search.season = '   '; }, /^search\.season must be non-empty text/],
    [(p) => { p.search.directions.primary = ['ai-ml', 'robotics']; }, /^search\.directions\.primary\[1\] must be one of: ai-ml, data-science/],
    [(p) => { p.search.directions.primary = ['quant', 'quant']; }, /^search\.directions\.primary\[1\] repeats "quant"$/],
    [(p) => { p.search.directions = { primary: ['quant'], secondary: ['quant', 'product'] }; }, /^search\.directions\.secondary repeats primary directions: quant$/],
    [(p) => { p.search.directions.primary = 'ai-ml'; }, /^search\.directions\.primary must be a JSON list$/],
    [(p) => { p.search.locations = [{ label: 'New York, NY' }]; }, /^search\.locations\[0\] match must be a non-empty list/],
    [(p) => { p.search.locations = ['New York']; }, /^search\.locations\[0\] must be an object such as/],
    [(p) => { p.search.locations = [{ label: 'NYC', match: ['nyc'], radius: 5 }]; }, /^search\.locations\[0\] has unknown field radius$/],
    [(p) => { p.search.locations = [{ label: 'NYC', match: ['nyc'] }, { label: 'nyc', match: ['new york'] }]; }, /^search\.locations\[1\] repeats "nyc"$/],
    [(p) => { p.search.remoteOk = 'yes'; }, /^search\.remoteOk must be true or false$/],
    [(p) => { p.candidate.degree.level = 'associate'; }, /^candidate\.degree\.level must be one of: bachelors, masters, phd, mba, other$/],
    [(p) => { p.candidate.degree.graduation = '2027-13'; }, /^candidate\.degree\.graduation must be a year and month in YYYY-MM form/],
    [(p) => { p.candidate.degree.graduation = '2027-5'; }, /YYYY-MM/],
    [(p) => { p.candidate.degree.graduation = '2027/05'; }, /YYYY-MM/],
    [(p) => { p.candidate.degree.graduation = 202705; }, /YYYY-MM/],
    [(p) => { p.candidate.authorization.status = 'pending'; }, /^candidate\.authorization\.status must be one of: citizen, permanent-resident, visa, other$/],
    [(p) => { p.candidate.authorization.needsSponsorship = 0; }, /^candidate\.authorization\.needsSponsorship must be true or false$/],
    [(p) => { p.materials.resumePath = 'https://example.com/resume.pdf'; }, /^materials\.resumePath must be a local file path, not a URL$/],
    [(p) => { p.materials.resumePath = 'resume.pdf'; }, /^materials\.resumePath must be an absolute path or start with ~\/$/],
    [(p) => { p.materials.transcriptPolicy = 'always'; }, /^materials\.transcriptPolicy must be one of: required-only, never$/],
    [(p) => { p.materials.links.linkedin = 'linkedin.com/in/someone'; }, /^materials\.links\.linkedin must be an http or https URL$/],
    [(p) => { p.materials.links.github = 'ftp://example.com/x'; }, /^materials\.links\.github must be an http or https URL$/],
    [(p) => { p.materials.links.website = 'https://user:pass@example.com/'; }, /^materials\.links\.website must not contain credentials$/],
    [(p) => { p.materials.experienceConfirmed = null; }, /^materials\.experienceConfirmed must be true or false$/],
    [(p) => { p.pace.batchSize = 0; }, /^pace\.batchSize must be a whole number from 1 to 10$/],
    [(p) => { p.pace.batchSize = 11; }, /^pace\.batchSize must be a whole number from 1 to 10$/],
    [(p) => { p.pace.batchSize = 2.5; }, /^pace\.batchSize must be a whole number from 1 to 10$/],
    [(p) => { p.pace.batchSize = '5'; }, /^pace\.batchSize must be a whole number from 1 to 10$/],
    [(p) => { p.pace.scanTime = '24:00'; }, /^pace\.scanTime must be a 24-hour time in HH:MM form/],
    [(p) => { p.pace.scanTime = '8:00'; }, /HH:MM/],
    [(p) => { p.pace.scanTime = '08:60'; }, /HH:MM/],
    [(p) => { p.pace.notify = 'email'; }, /^pace\.notify must be one of: desktop, none$/],
    [(p) => { p.sources.atsBoards = [{ ats: 'workday', board: 'examplecorp' }]; }, /^sources\.atsBoards\[0\] ats must be one of: greenhouse, lever, ashby$/],
    [(p) => { p.sources.atsBoards = [{ ats: 'lever', board: '../etc' }]; }, /^sources\.atsBoards\[0\] board must be the board name/],
    [(p) => { p.sources.atsBoards = [{ ats: 'ashby', board: 'Example' }, { ats: 'ashby', board: 'example' }]; }, /^sources\.atsBoards\[1\] repeats "ashby:example"$/],
    [(p) => { p.sources.atsBoards = [{ ats: 'lever', board: 'examplelabs', company: '  ' }]; }, /^sources\.atsBoards\[0\] company must be non-empty text/],
    [(p) => { p.sources.atsBoards = [{ ats: 'lever', board: 'examplelabs', url: 'https://jobs.lever.co/examplelabs' }]; }, /^sources\.atsBoards\[0\] has unknown field url$/],
    [(p) => { p.sources.simplify.url = 'http://example.com/list.json'; }, /^sources\.simplify\.url must be an https URL$/],
    [(p) => { p.sources.careerOps = 'yes'; }, /^sources\.careerOps must be true or false$/],
    [(p) => { p.interview.roundsCompleted = [1, 5]; }, /^interview\.roundsCompleted\[1\] must be a whole number from 1 to 4$/],
    [(p) => { p.interview.skipped = ['favourite-colour']; }, /^interview\.skipped\[0\] must be a profile question key$/],
    [(p) => { p.schemaVersion = 2; }, /^schemaVersion must be 1$/],
    [(p) => { p.updatedAt = 'yesterday'; }, /^updatedAt must be an ISO 8601 date-time$/],
    [(p) => { p.search.salary = 100; }, /^Unknown profile field: search\.salary$/],
    [(p) => { p.extra = true; }, /^Unknown profile field: extra$/],
    [(p) => { delete p.pace.notify; }, /^pace\.notify is missing$/],
    [(p) => { p.candidate = []; }, /^candidate must be an object$/],
  ];
  for (const [mutate, expected] of cases) {
    const profile = completeProfile();
    mutate(profile);
    const result = validateProfile(profile);
    assert.equal(result.ok, false, String(expected));
    assert.ok(result.errors.some((error) => expected.test(error)), `${expected}\n${result.errors.join('\n')}`);
  }
  assert.deepEqual(validateProfile(null), { ok: false, errors: ['profile must be an object'] });
  for (const file of ['/data/job-search/resume.pdf', '~/job-search/resume.pdf', 'C:\\job-search\\resume.pdf']) {
    const profile = completeProfile(file);
    assert.equal(validateProfile(profile).ok, true, file);
  }
});

test('readProfile returns null for a new workspace without creating anything', async () => withHome(async (home) => {
  assert.equal(await readProfile(home), null);
  assert.equal(await readAnswers(home), null);
  await assert.rejects(() => stat(profileDirectory(home)), { code: 'ENOENT' });
  assert.equal(profilePath(home), path.join(home, '.career-journal', 'profile', 'profile.json'));
  assert.equal(answersPath(home), path.join(home, '.career-journal', 'profile', 'answers.md'));
}));

test('profile files follow an existing legacy workspace directory', async () => withHome(async (home) => {
  await mkdir(path.join(home, '.jobops'), { recursive: true });
  await writeFile(path.join(home, '.jobops', 'config.json'), '{}\n');
  assert.equal(profilePath(home), path.join(home, '.jobops', 'profile', 'profile.json'));
}));

test('writeProfile writes atomically with owner-only permissions and keeps the old file on invalid input', async () => withHome(async (home) => {
  const stored = await writeProfile(home, completeProfile(), { now: '2026-10-01T12:00:00.000Z' });
  assert.equal(stored.updatedAt, '2026-10-01T12:00:00.000Z');
  const text = await readFile(profilePath(home), 'utf8');
  assert.deepEqual(JSON.parse(text), stored);
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(await readdir(profileDirectory(home)), ['profile.json']);
  if (posixPermissions) {
    assert.equal((await stat(profileDirectory(home))).mode & 0o777, 0o700);
    assert.equal((await stat(profilePath(home))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readProfile(home), stored);

  const invalid = completeProfile();
  invalid.pace.batchSize = 50;
  await assert.rejects(() => writeProfile(home, invalid), /Invalid profile: pace\.batchSize must be a whole number from 1 to 10/);
  assert.equal(await readFile(profilePath(home), 'utf8'), text);
  assert.deepEqual(await readdir(profileDirectory(home)), ['profile.json']);
}));

test('writeProfile tightens an existing profile directory to owner-only access', { skip: !posixPermissions }, async () => withHome(async (home) => {
  await mkdir(profileDirectory(home), { recursive: true, mode: 0o755 });
  await writeProfile(home, defaultProfile());
  assert.equal((await stat(profileDirectory(home))).mode & 0o777, 0o700);
}));

test('readProfile fills sections added later and rejects broken files with the reason', async () => withHome(async (home) => {
  await mkdir(profileDirectory(home), { recursive: true });
  const partial = completeProfile();
  delete partial.sources;
  delete partial.interview;
  delete partial.materials.links;
  await writeFile(profilePath(home), JSON.stringify(partial));
  const profile = await readProfile(home);
  assert.deepEqual(profile.sources, defaultProfile().sources);
  assert.deepEqual(profile.interview, defaultProfile().interview);
  assert.deepEqual(profile.materials.links, defaultProfile().materials.links);
  assert.equal(profile.search.season, 'Summer 2027');

  await writeFile(profilePath(home), '{"schemaVersion": 1,');
  await assert.rejects(() => readProfile(home), /profile\.json is not valid JSON/);
  await writeFile(profilePath(home), '[]');
  await assert.rejects(() => readProfile(home), /must contain a JSON object/);
  await writeFile(profilePath(home), JSON.stringify({ ...defaultProfile(), schemaVersion: 2 }));
  await assert.rejects(() => readProfile(home), /Unsupported profile schema: 2/);
  await writeFile(profilePath(home), JSON.stringify({ schemaVersion: 1, pace: { batchSize: 0 } }));
  await assert.rejects(() => readProfile(home), /profile\.json is invalid: pace\.batchSize must be a whole number from 1 to 10/);
}));

test('profile keys accept dot-paths and interview question keys but not unknown, managed, or answers-sheet keys', () => {
  assert.equal(resolveProfileKey('search.jobType'), 'search.jobType');
  assert.equal(resolveProfileKey(' job-type '), 'search.jobType');
  assert.equal(resolveProfileKey('resume-path'), 'materials.resumePath');
  assert.equal(resolveProfileKey('sources.simplify'), 'sources.simplify');
  assert.throws(() => resolveProfileKey('search.jobtype'), /Unknown profile key: search\.jobtype/);
  assert.throws(() => resolveProfileKey('updatedAt'), /updatedAt is managed by CAREER JOURNAL/);
  assert.throws(() => resolveProfileKey('schemaVersion'), /schemaVersion is managed by CAREER JOURNAL/);
  assert.throws(() => resolveProfileKey('legal-name'), /legal-name is a form answer kept in answers\.md; save it with profile answer --key legal-name/);
  assert.throws(() => resolveProfileKey(''), /A profile key is required/);
  assert.throws(() => resolveProfileKey(true), /A profile key is required/);

  const base = defaultProfile();
  const next = setProfileValue(base, 'job-type', 'internship');
  assert.equal(next.search.jobType, 'internship');
  assert.equal(base.search.jobType, null, 'setProfileValue must not mutate its input');
  assert.equal(getProfileValue(next, 'search.jobType'), 'internship');
  assert.equal(getProfileValue(next, 'job-type'), 'internship');
  const subtree = setProfileValue(base, 'sources.simplify', { enabled: true, url: 'https://example.com/list.json' });
  assert.deepEqual(subtree.sources.simplify, { enabled: true, url: 'https://example.com/list.json' });
});

test('command-line values parse as JSON except where a text field keeps plain text', () => {
  assert.equal(parseProfileValue('search.season', 'Summer 2027'), 'Summer 2027');
  assert.equal(parseProfileValue('search.season', '2027'), '2027');
  assert.equal(parseProfileValue('search.season', '"Fall 2027"'), 'Fall 2027');
  assert.equal(parseProfileValue('search.season', 'null'), null);
  assert.equal(parseProfileValue('graduation', '2027-05'), '2027-05');
  assert.equal(parseProfileValue('pace.scanTime', '08:00'), '08:00');
  assert.equal(parseProfileValue('pace.batchSize', '5'), 5);
  assert.equal(parseProfileValue('pace.batchSize', 'five'), 'five');
  assert.equal(parseProfileValue('remote-ok', 'true'), true);
  assert.equal(parseProfileValue('materials.links.linkedin', 'null'), null);
  assert.deepEqual(parseProfileValue('directions-primary', '["ai-ml","quant"]'), ['ai-ml', 'quant']);
  assert.deepEqual(parseProfileValue('search.locations', '[{"label":"Seattle, WA","match":["seattle"]}]'), [{ label: 'Seattle, WA', match: ['seattle'] }]);
  assert.throws(() => parseProfileValue('search.season', true), /A profile value is required/);
  assert.throws(() => parseProfileValue('nope', '1'), /Unknown profile key: nope/);
});

test('normalizeProfile trims text, clears blank optional text, and lowercases location match terms', () => {
  const profile = completeProfile();
  profile.search.season = '  Summer 2027 ';
  profile.materials.links.github = '   ';
  profile.search.locations = [{ label: ' New York, NY ', match: ['New York', ' NYC ', 'nyc'] }];
  const normalized = normalizeProfile(profile);
  assert.equal(normalized.search.season, 'Summer 2027');
  assert.equal(normalized.materials.links.github, null);
  assert.deepEqual(normalized.search.locations, [{ label: 'New York, NY', match: ['new york', 'nyc'] }]);
  assert.equal(profile.search.season, '  Summer 2027 ', 'normalizeProfile must not mutate its input');
});

test('updateProfile creates the profile on first write and checks that material files are readable', async () => withHome(async (home) => {
  const first = await updateProfile(home, 'job-type', 'internship', { now: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual({ key: first.key, value: first.value, updatedAt: first.profile.updatedAt }, {
    key: 'search.jobType', value: 'internship', updatedAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal((await readProfile(home)).search.jobType, 'internship');

  await assert.rejects(() => updateProfile(home, 'materials.resumePath', path.join(home, 'missing.pdf')), /materials\.resumePath is not a readable file: .*missing\.pdf/);
  await assert.rejects(() => updateProfile(home, 'materials.resumePath', 'resume.pdf'), /must be an absolute path or start with ~\//);
  await mkdir(path.join(home, 'folder.pdf'));
  await assert.rejects(() => updateProfile(home, 'materials.transcriptPath', path.join(home, 'folder.pdf')), /materials\.transcriptPath is not a readable file/);
  const resume = await writeResume(home);
  assert.equal((await updateProfile(home, 'resume-path', resume)).value, resume);
  assert.equal((await updateProfile(home, 'materials.resumePath', null)).value, null);
  await assert.rejects(() => updateProfile(home, 'pace.batchSize', 0), /Invalid profile: pace\.batchSize/);
  assert.equal((await readProfile(home)).pace.batchSize, 5);
  assert.equal(resolveMaterialPath('~/job-search/resume.pdf'), path.join(os.homedir(), 'job-search', 'resume.pdf'));
  assert.equal(resolveMaterialPath(resume), resume);
}));

test('concurrent profile updates are serialized and none is lost', async () => withHome(async (home) => {
  const updates = [
    ['search.jobType', 'internship'], ['search.season', 'Summer 2027'], ['search.remoteOk', false],
    ['candidate.degree.level', 'masters'], ['candidate.degree.major', 'Statistics'], ['candidate.degree.graduation', '2027-05'],
    ['pace.batchSize', 3], ['pace.scanTime', '07:30'], ['pace.notify', 'none'], ['materials.experienceConfirmed', true],
  ];
  await Promise.all(updates.map(([key, value]) => updateProfile(home, key, value)));
  const profile = await readProfile(home);
  for (const [key, value] of updates) assert.equal(getProfileValue(profile, key), value, key);
  assert.deepEqual(await readdir(profileDirectory(home)), ['profile.json']);
}));

test('missingItems lists every unanswered required item by round and key', () => {
  const initial = missingItems(defaultProfile());
  assert.deepEqual(initial.map((item) => `${item.round}:${item.key}`), [
    '1:job-type', '1:season', '1:directions-primary', '1:locations', '1:remote-ok', '1:degree-level', '1:major', '1:graduation',
    '1:authorization-status', '1:needs-sponsorship', '2:resume-path', '2:experience-confirmed',
    '3:legal-name', '3:email', '3:phone', '3:address', '4:watch-companies',
  ]);
  assert.deepEqual(initial[0], { round: 1, key: 'job-type', target: 'search.jobType', skipped: false });
  assert.deepEqual(missingItems(null), initial);

  const profile = completeProfile('/data/resume.pdf');
  assert.deepEqual(missingItems(profile).map((item) => item.key), ['legal-name', 'email', 'phone', 'address', 'watch-companies']);
  profile.materials.experienceConfirmed = false;
  profile.search.remoteOk = false;
  profile.search.directions.primary = [];
  profile.interview.skipped = ['directions-primary', 'phone', 'watch-companies'];
  const answers = `${answersTemplate()}| \`legal-name\` Legal name | Alex Example (user, 2026-10-01) |\n| \`email\` Email | alex@example.com (user, 2026-10-01) |\n| \`address\` Address |  |\n`;
  assert.deepEqual(missingItems(profile, { answers }), [
    { round: 1, key: 'directions-primary', target: 'search.directions.primary', skipped: true },
    { round: 2, key: 'experience-confirmed', target: 'materials.experienceConfirmed', skipped: false },
    { round: 3, key: 'phone', target: 'answers.md', skipped: true },
    { round: 3, key: 'address', target: 'answers.md', skipped: false },
    { round: 4, key: 'watch-companies', target: 'sources.atsBoards', skipped: true },
  ]);
  // Companies to watch is answered once any source feeds the scan, even an opt-in one alone.
  profile.sources.careerOps = true;
  assert.equal(missingItems(profile, { answers }).some((item) => item.key === 'watch-companies'), false);
});

test('answers rows parse keys, escaped pipes, and the latest row for a key', () => {
  const text = [
    '# Answers sheet',
    '',
    '## Common form answers',
    '',
    '| Question | Answer |',
    '|---|---|',
    '| `phone` Phone | +1 555 0100 (user, 2026-10-01) |',
    '| `email` Email | alex@example.com (resume, 2026-10-01) |',
    '',
    '## Learned while applying',
    '',
    '| Question | Answer |',
    '| :--- | ---: |',
    '| Why \\| how? | Because (user, 2026-10-02) |',
    '| `email` Email |  |',
  ].join('\r\n');
  assert.deepEqual(answerRows(text), [
    { section: 'Common form answers', key: 'phone', question: 'Phone', answer: '+1 555 0100 (user, 2026-10-01)' },
    { section: 'Common form answers', key: 'email', question: 'Email', answer: 'alex@example.com (resume, 2026-10-01)' },
    { section: 'Learned while applying', key: null, question: 'Why \\| how?', answer: 'Because (user, 2026-10-02)' },
    { section: 'Learned while applying', key: 'email', question: 'Email', answer: '' },
  ]);
  assert.deepEqual([...answeredKeys(text)], ['phone']);
  assert.deepEqual([...answeredKeys(null)], []);
});

test('appendAnswer creates a private answers sheet and appends free-form answers under Learned while applying', async () => withHome(async (home) => {
  const first = await appendAnswer(home, 'How did you hear about us?', 'Company careers page', 'user', {
    now: new Date('2026-10-01T03:00:00Z'), timeZone: 'America/Los_Angeles',
  });
  assert.deepEqual(first, {
    section: 'Learned while applying', key: null, question: 'How did you hear about us?', answer: 'Company careers page', source: 'user', date: '2026-09-30',
  });
  await appendAnswer(home, 'Pick | one', 'A | B\nC', 'form', { now: '2026-10-02T12:00:00Z', timeZone: 'UTC' });
  const text = await readAnswers(home);
  assert.ok(text.startsWith(answersTemplate().trimEnd()));
  assert.ok(text.endsWith([
    '## Learned while applying · 申请中补充',
    '',
    '| Question · 问题 | Answer · 答案 |',
    '|---|---|',
    '| How did you hear about us? | Company careers page (user, 2026-09-30) |',
    '| Pick \\| one | A \\| B<br>C (form, 2026-10-02) |',
    '',
  ].join('\n')));
  assert.deepEqual(answerRows(text).map((row) => row.question), ['How did you hear about us?', 'Pick \\| one']);
  if (posixPermissions) assert.equal((await stat(answersPath(home))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(profileDirectory(home))).sort(), ['answers.md']);
}));

test('appendAnswer keeps one row per interview key under Common form answers', async () => withHome(async (home) => {
  const now = '2026-10-01T12:00:00Z';
  for (const [key, answer] of roundThreeAnswers) {
    const record = await appendAnswer(home, undefined, answer, 'user', { key, now, timeZone: 'UTC' });
    assert.equal(record.section, 'Common form answers');
    assert.equal(record.key, key);
  }
  await appendAnswer(home, 'Mobile phone number', '+1 555 0199', 'resume', { key: 'phone', now: '2026-10-03T12:00:00Z', timeZone: 'UTC' });
  await appendAnswer(home, 'Are you over 18?', 'Yes', undefined, { now, timeZone: 'UTC' });
  const text = await readAnswers(home);
  const common = answerRows(text).filter((row) => row.section === 'Common form answers · 常用表单答案');
  assert.deepEqual(common.map((row) => [row.key, row.question, row.answer]), [
    ['legal-name', 'Legal name', 'Alex Example (user, 2026-10-01)'],
    ['email', 'Email', 'alex@example.com (user, 2026-10-01)'],
    ['phone', 'Mobile phone number', '+1 555 0199 (resume, 2026-10-03)'],
    ['address', 'Address', '100 Example Street, New York, NY 10001 (user, 2026-10-01)'],
  ]);
  assert.deepEqual(answerRows(text).filter((row) => row.section.startsWith('Learned')).map((row) => row.question), ['Are you over 18?']);
  assert.deepEqual(missingItems(completeProfile('/data/resume.pdf'), { answers: text }).map((item) => item.key), ['watch-companies']);
}));

test('appendAnswer keeps hand-edited sheets intact', async () => withHome(async (home) => {
  await mkdir(profileDirectory(home), { recursive: true });
  await writeFile(answersPath(home), [
    '# My answers',
    '',
    '## Learned while applying',
    '',
    '| Question | Answer |',
    '|---|---|',
    '| Existing | Kept (user, 2026-09-01) |',
    '',
    'Notes I wrote by hand.',
    '',
    '## Later section',
    '',
    'Untouched.',
    '',
  ].join('\n'));
  await appendAnswer(home, 'New question', 'New answer', 'user', { now: '2026-10-01T12:00:00Z', timeZone: 'UTC' });
  await appendAnswer(home, null, 'Prefer not to say', 'user', { key: 'gender', now: '2026-10-01T12:00:00Z', timeZone: 'UTC' });
  assert.equal(await readAnswers(home), [
    '# My answers',
    '',
    '## Learned while applying',
    '',
    '| Question | Answer |',
    '|---|---|',
    '| Existing | Kept (user, 2026-09-01) |',
    '| New question | New answer (user, 2026-10-01) |',
    '',
    'Notes I wrote by hand.',
    '',
    '## Later section',
    '',
    'Untouched.',
    '',
    '## Common form answers · 常用表单答案',
    '',
    '| Question · 问题 | Answer · 答案 |',
    '|---|---|',
    '| `gender` Gender | Prefer not to say (user, 2026-10-01) |',
    '',
  ].join('\n'));

  await writeFile(answersPath(home), '# Bare sheet\n\n## Learned while applying\n\n## Other\n\nText.\n');
  await appendAnswer(home, 'Q', 'A', 'user', { now: '2026-10-01T12:00:00Z', timeZone: 'UTC' });
  assert.equal(await readAnswers(home), [
    '# Bare sheet',
    '',
    '## Learned while applying',
    '',
    '| Question · 问题 | Answer · 答案 |',
    '|---|---|',
    '| Q | A (user, 2026-10-01) |',
    '',
    '## Other',
    '',
    'Text.',
    '',
  ].join('\n'));
}));

test('appendAnswer rejects incomplete or unknown input without writing', async () => withHome(async (home) => {
  const cases = [
    [() => appendAnswer(home, '', 'Yes'), /A question is required/],
    [() => appendAnswer(home, undefined, 'Yes'), /A question is required/],
    [() => appendAnswer(home, 'Over 18?', '  '), /An answer is required/],
    [() => appendAnswer(home, 'Over 18?', undefined), /An answer is required/],
    [() => appendAnswer(home, 'Over 18?', 'Yes', 'Confirmed by user'), /answer source must be a short lowercase word/],
    [() => appendAnswer(home, 'x'.repeat(501), 'Yes'), /question must be at most 500 characters/],
    [() => appendAnswer(home, 'Q', 'x'.repeat(2001)), /answer must be at most 2000 characters/],
    [() => appendAnswer(home, null, 'Yes', 'user', { key: 'shoe-size' }), /Unknown answer key: shoe-size/],
    [() => appendAnswer(home, null, 'Summer 2027', 'user', { key: 'season' }), /season is stored in profile\.json; save it with profile set --key search\.season/],
    [() => appendAnswer(home, 'Q', 'A', 'user', { now: 'not a date' }), /answer date must be a valid time/],
  ];
  for (const [run, expected] of cases) await assert.rejects(run, expected);
  assert.equal(await readAnswers(home), null);
}));

test('concurrent answers are serialized and none is lost', async () => withHome(async (home) => {
  const questions = Array.from({ length: 12 }, (_, index) => `Question ${index + 1}`);
  await Promise.all(questions.map((question) => appendAnswer(home, question, 'Yes', 'user', { now: '2026-10-01T12:00:00Z', timeZone: 'UTC' })));
  const rows = answerRows(await readAnswers(home));
  assert.deepEqual(rows.map((row) => row.question).sort(), [...questions].sort());
  assert.deepEqual(await readdir(profileDirectory(home)), ['answers.md']);
}));

test('profileStatus reports round completion and scan and apply readiness', async () => withHome(async (home) => {
  const empty = await profileStatus(home);
  assert.equal(empty.exists, false);
  assert.equal(empty.answersExists, false);
  assert.deepEqual(empty.rounds.map((round) => [round.round, round.id, round.complete]), [[1, 'search', false], [2, 'materials', false], [3, 'answers', false], [4, 'pace', false]]);
  assert.deepEqual(empty.readiness.scan, { ready: false, detail: 'incomplete: no profile yet; run the profile interview' });
  assert.deepEqual(empty.readiness.apply, { ready: false, detail: 'incomplete: no profile yet; complete interview rounds 1 and 2' });
  assert.deepEqual(empty.resume, { set: false, readable: false });
  await assert.rejects(() => stat(profileDirectory(home)), { code: 'ENOENT' });

  const roundOnePartial = completeProfile();
  roundOnePartial.search.season = null;
  await writeProfile(home, roundOnePartial);
  assert.deepEqual((await profileStatus(home)).readiness.scan, {
    ready: false,
    detail: 'incomplete: round 1 (search) is missing season; no scan sources; name companies to watch or turn on an opt-in source (round 4)',
  });

  const partial = completeProfile();
  await writeProfile(home, partial);
  const noSources = await profileStatus(home);
  assert.deepEqual(noSources.readiness.scan, { ready: false, detail: 'incomplete: no scan sources; name companies to watch or turn on an opt-in source (round 4)' });
  assert.equal(noSources.readiness.apply.detail, 'incomplete: round 2 (materials) is missing resume-path');

  for (const sources of [
    { atsBoards: [{ ats: 'greenhouse', board: 'examplecorp', company: 'ExampleCorp' }] },
    { careerOps: true },
    { simplify: { enabled: true, url: 'https://example.com/listings.json' } },
  ]) {
    await writeProfile(home, { ...partial, sources: { ...partial.sources, ...sources } });
    const roundOne = await profileStatus(home);
    assert.deepEqual(roundOne.readiness.scan, { ready: true, detail: 'ready: interview round 1 is complete and at least one scan source is set' }, JSON.stringify(sources));
    assert.equal(roundOne.rounds[3].complete, true, JSON.stringify(sources));
  }
  await writeProfile(home, { ...partial, sources: { ...partial.sources, simplify: { enabled: true, url: null } } });
  assert.equal((await profileStatus(home)).readiness.scan.ready, false, 'Simplify without a URL cannot feed the scan');

  const resume = await writeResume(home);
  const withResume = completeProfile(resume);
  await writeProfile(home, withResume);
  const ready = await profileStatus(home);
  assert.deepEqual(ready.resume, { set: true, readable: true });
  assert.deepEqual(ready.readiness.apply, { ready: true, detail: 'ready: interview rounds 1 and 2 are complete and the resume file is readable' }, 'assisted applying does not depend on scan sources');
  assert.deepEqual(ready.missing.map((item) => item.key), ['legal-name', 'email', 'phone', 'address', 'watch-companies']);

  await rm(resume);
  const moved = await profileStatus(home);
  assert.deepEqual(moved.resume, { set: true, readable: false });
  assert.equal(moved.readiness.apply.detail, 'incomplete: the resume file is not readable');

  for (const [key, answer] of roundThreeAnswers) await appendAnswer(home, null, answer, 'user', { key });
  withResume.sources.atsBoards = [{ ats: 'ashby', board: 'examplequant' }];
  await writeProfile(home, withResume);
  const answered = await profileStatus(home);
  assert.equal(answered.answersExists, true);
  assert.deepEqual(answered.rounds.map((round) => round.complete), [true, true, true, true]);
}));
