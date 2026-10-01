import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { runCli, HELP } from '../../src/cli/main.mjs';
import { createRuntime } from '../../src/runtime/create-runtime.mjs';
import { answersPath, profileDirectory, profilePath } from '../../src/domain/profile.mjs';
import { hardRules, profileQuestions } from '../../src/domain/profile-questions.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

const runtime = createRuntime({ root: process.cwd(), version: '2.0.0-test' });

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-cli-profile-'));
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

async function cli(args) {
  const io = memoryIO();
  const code = await runCli(args, io, runtime);
  return { code, io };
}

async function ok(args) {
  const result = await cli(args);
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.io.stderr}`);
  return result.io.stdout;
}

async function json(args) {
  return JSON.parse(await ok(args));
}

async function completeRoundsOneAndTwo(home) {
  const resume = path.join(home, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 synthetic resume\n');
  const values = [
    ['job-type', 'internship'],
    ['search.season', 'Summer 2027'],
    ['search.directions.primary', '["ai-ml","data-science"]'],
    ['search.directions.secondary', '["quant"]'],
    ['search.locations', '[{"label":"New York, NY","match":["new york","nyc"]}]'],
    ['search.remoteOk', 'true'],
    ['candidate.degree.level', 'masters'],
    ['candidate.degree.major', 'Data Science'],
    ['graduation', '2027-12'],
    ['candidate.authorization.status', 'permanent-resident'],
    ['candidate.authorization.needsSponsorship', 'false'],
    ['materials.resumePath', resume],
    ['materials.experienceConfirmed', 'true'],
  ];
  for (const [key, value] of values) await ok(['profile', 'set', '--home', home, '--key', key, '--value', value]);
  return resume;
}

test('help lists the profile command', () => {
  assert.match(HELP, /^ {2}profile {7}Keep the search profile and form answers used for scans and applying$/m);
});

test('profile questions prints the interview as data without needing a workspace', async () => {
  const all = await json(['profile', 'questions', '--json']);
  assert.deepEqual(all.rounds.map((round) => round.round), [1, 2, 3, 4]);
  assert.equal(all.questions.length, profileQuestions.length);
  assert.deepEqual(all.hardRules, JSON.parse(JSON.stringify(hardRules)));
  const first = all.questions[0];
  assert.deepEqual(Object.keys(first), ['key', 'round', 'group', 'label', 'prompts', 'type', 'options', 'allowOther', 'required', 'target']);
  assert.deepEqual(first.prompts, { en: 'Are you looking for an internship or a full-time role?', zh: '你要找实习还是全职工作？' });

  const roundThree = await json(['profile', 'questions', '--round', '3', '--json']);
  assert.deepEqual(roundThree.rounds.map((round) => round.id), ['answers']);
  assert.ok(roundThree.questions.length > 0 && roundThree.questions.every((question) => question.round === 3 && question.target === 'answers.md'));

  const text = await ok(['profile', 'questions', '--round', '4']);
  assert.deepEqual(text.trim().split('\n').map((line) => line.split('\t').slice(0, 4)), [
    ['round 4', 'watch-companies', 'required', 'sources.atsBoards'],
    ['round 4', 'careerops-source', 'optional', 'sources.careerOps'],
    ['round 4', 'simplify-source', 'optional', 'sources.simplify'],
    ['round 4', 'batch-size', 'required', 'pace.batchSize'],
    ['round 4', 'scan-time', 'required', 'pace.scanTime'],
    ['round 4', 'notify', 'required', 'pace.notify'],
  ]);
  for (const round of ['0', '5', '1.5', 'two']) {
    const invalid = await cli(['profile', 'questions', '--round', round, '--json']);
    assert.equal(invalid.code, 1, round);
    assert.match(invalid.io.stderr, /--round must be 1, 2, 3, or 4/);
  }
  const bare = await cli(['profile', 'questions', '--round', '--json']);
  assert.equal(bare.code, 1);
});

test('profile commands that read a workspace require setup first', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-cli-profile-unconfigured-'));
  try {
    for (const args of [['show'], ['status'], ['set', '--key', 'job-type', '--value', 'internship'], ['answer', '--question', 'Q', '--answer', 'A'], ['questions', '--missing']]) {
      const result = await cli(['profile', ...args, '--home', home]);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.io.stderr, /CAREER JOURNAL is not configured at .*Run career-journal setup/);
    }
    await assert.rejects(() => stat(path.join(home, '.career-journal')), { code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('setup, show, and status create no profile files', async () => fixture(async (home) => {
  const shown = await json(['profile', 'show', '--home', home, '--json']);
  assert.deepEqual(shown, { exists: false, path: profilePath(home), answersPath: answersPath(home), profile: null });
  assert.match(await ok(['profile', 'show', '--home', home]), /^No profile yet at .*profile\.json\. Start the interview with career-journal profile questions --json/);
  const state = await json(['profile', 'status', '--home', home, '--json']);
  assert.equal(state.exists, false);
  assert.equal(state.readiness.apply.ready, false);
  assert.match(state.readiness.apply.detail, /^incomplete: no profile yet/);
  assert.deepEqual(state.missing.filter((item) => item.round === 2).map((item) => item.key), ['resume-path', 'experience-confirmed']);
  const missing = await json(['profile', 'questions', '--missing', '--home', home, '--json']);
  assert.deepEqual(missing.questions.map((question) => question.key), state.missing.map((item) => item.key));
  assert.ok(missing.questions.every((question) => question.required && question.skipped === false));
  await assert.rejects(() => stat(profileDirectory(home)), { code: 'ENOENT' });
}));

test('profile set creates the profile on first write and reports validation errors without changing it', async () => fixture(async (home) => {
  const first = await json(['profile', 'set', '--home', home, '--key', 'search.jobType', '--value', 'internship']);
  assert.equal(first.key, 'search.jobType');
  assert.equal(first.value, 'internship');
  assert.ok(!Number.isNaN(Date.parse(first.updatedAt)));
  if (process.platform !== 'win32') assert.equal((await stat(profilePath(home))).mode & 0o777, 0o600);

  assert.deepEqual(await json(['profile', 'set', '--home', home, '--key', 'season', '--value', '2027']), { key: 'search.season', value: '2027', updatedAt: (await json(['profile', 'show', '--home', home, '--json'])).profile.updatedAt });
  assert.equal((await json(['profile', 'set', '--home', home, '--key', 'pace.batchSize', '--value', '3'])).value, 3);
  assert.equal((await json(['profile', 'set', '--home', home, '--key', 'scan-time', '--value', '07:30'])).value, '07:30');
  assert.deepEqual((await json(['profile', 'set', '--home', home, '--key', 'search.locations', '--value', '[{"label":" Seattle, WA ","match":["Seattle","Bellevue"]}]'])).value,
    [{ label: 'Seattle, WA', match: ['seattle', 'bellevue'] }]);
  assert.equal((await json(['profile', 'set', '--home', home, '--key', 'linkedin', '--value', 'https://www.linkedin.com/in/your-handle'])).value, 'https://www.linkedin.com/in/your-handle');
  assert.equal((await json(['profile', 'set', '--home', home, '--key', 'linkedin', '--value', 'null'])).value, null);

  const before = await readFile(profilePath(home), 'utf8');
  for (const [key, value, expected] of [
    ['candidate.degree.graduation', '2027-13', /candidate\.degree\.graduation must be a year and month in YYYY-MM form/],
    ['pace.batchSize', '11', /pace\.batchSize must be a whole number from 1 to 10/],
    ['pace.scanTime', '8am', /pace\.scanTime must be a 24-hour time in HH:MM form/],
    ['search.directions.primary', 'ai-ml', /search\.directions\.primary must be a JSON list/],
    ['search.directions.primary', '["robotics"]', /search\.directions\.primary\[0\] must be one of/],
    ['search.remoteOk', 'maybe', /search\.remoteOk must be true or false/],
    ['materials.resumePath', path.join(home, 'missing.pdf'), /materials\.resumePath is not a readable file/],
    ['materials.resumePath', 'resume.pdf', /must be an absolute path or start with ~\//],
    ['search.unknown', '1', /Unknown profile key: search\.unknown/],
    ['updatedAt', '"2026-10-01T00:00:00Z"', /updatedAt is managed by CAREER JOURNAL/],
    ['phone', '+1 555 0100', /phone is a form answer kept in answers\.md/],
  ]) {
    const result = await cli(['profile', 'set', '--home', home, '--key', key, '--value', value]);
    assert.equal(result.code, 1, `${key} ${value}`);
    assert.match(result.io.stderr, expected);
  }
  assert.equal(await readFile(profilePath(home), 'utf8'), before);

  for (const args of [['--key', 'season'], ['--value', 'x'], ['--key', 'season', '--value']]) {
    const usage = await cli(['profile', 'set', '--home', home, ...args]);
    assert.equal(usage.code, 1);
    assert.match(usage.io.stderr, /Usage: career-journal profile set --key <dot\.path> --value <json-or-text>/);
  }
  const text = await ok(['profile', 'show', '--home', home]);
  assert.match(text, /^search\.jobType: internship$/m);
  assert.match(text, /^search\.season: 2027$/m);
  assert.match(text, /^materials\.links\.linkedin: \(not set\)$/m);
  assert.match(text, /^pace\.batchSize: 3$/m);
}));

test('profile answer appends form answers with the date and source', async () => fixture(async (home) => {
  const learned = await json(['profile', 'answer', '--home', home, '--question', 'Are you willing to relocate?', '--answer', 'Yes, within the US']);
  assert.equal(learned.section, 'Learned while applying');
  assert.equal(learned.source, 'user');
  assert.match(learned.date, /^\d{4}-\d{2}-\d{2}$/);
  const keyed = await json(['profile', 'answer', '--home', home, '--key', 'email', '--answer', 'alex@example.com', '--source', 'resume']);
  assert.deepEqual({ ...keyed, date: null }, { section: 'Common form answers', key: 'email', question: 'Email', answer: 'alex@example.com', source: 'resume', date: null });
  const sheet = await readFile(answersPath(home), 'utf8');
  assert.match(sheet, new RegExp(`^\\| \`email\` Email \\| alex@example\\.com \\(resume, ${keyed.date}\\) \\|$`, 'm'));
  assert.match(sheet, new RegExp(`^\\| Are you willing to relocate\\? \\| Yes, within the US \\(user, ${learned.date}\\) \\|$`, 'm'));
  assert.ok(sheet.indexOf('`email`') < sheet.indexOf('## Learned while applying'));
  assert.ok(sheet.indexOf('Are you willing to relocate?') > sheet.indexOf('## Learned while applying'));
  if (process.platform !== 'win32') assert.equal((await stat(answersPath(home))).mode & 0o777, 0o600);

  for (const [args, expected] of [
    [['--question', 'Q'], /An answer is required/],
    [['--answer', 'A'], /A question is required/],
    [['--question', 'Q', '--answer', 'A', '--source', 'Agent Guess'], /answer source must be a short lowercase word/],
    [['--key', 'graduation', '--answer', '2027-05'], /graduation is stored in profile\.json; save it with profile set --key candidate\.degree\.graduation/],
    [['--key', 'shoe-size', '--answer', '9'], /Unknown answer key: shoe-size/],
    [['--question', '--answer', 'A'], /--question needs a value/],
  ]) {
    const result = await cli(['profile', 'answer', '--home', home, ...args]);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.io.stderr, expected);
  }
  assert.equal(await readFile(answersPath(home), 'utf8'), sheet);
}));

test('profile answer dates each row in the workspace time zone', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-cli-profile-zone-'));
  const timeZone = 'Pacific/Kiritimati';
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  try {
    await setup(home, { timezone: timeZone, email: { mode: 'skip' } });
    const before = today();
    const record = await json(['profile', 'answer', '--home', home, '--question', 'Q', '--answer', 'A']);
    assert.ok([before, today()].includes(record.date), `${record.date} is not the ${timeZone} date`);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('profile status and questions --missing follow the interview to apply readiness', async () => fixture(async (home) => {
  await completeRoundsOneAndTwo(home);
  const noSources = await json(['profile', 'status', '--home', home, '--json']);
  assert.equal(noSources.exists, true);
  assert.deepEqual(noSources.rounds.map((round) => round.complete), [true, true, false, false]);
  assert.deepEqual(noSources.readiness.scan, {
    ready: false, detail: 'incomplete: no scan sources; name companies to watch or turn on an opt-in source (round 4)',
  });
  assert.deepEqual(noSources.readiness.apply, { ready: true, detail: 'ready: interview rounds 1 and 2 are complete and the resume file is readable' });
  assert.deepEqual(noSources.missing.map((item) => item.key), ['legal-name', 'email', 'phone', 'address', 'watch-companies']);
  assert.match(await ok(['profile', 'status', '--home', home]), /^scan: incomplete: no scan sources; /m);

  await ok(['profile', 'set', '--home', home, '--key', 'watch-companies', '--value', '[{"ats":"greenhouse","board":"examplecorp","company":"ExampleCorp"}]']);
  const ready = await json(['profile', 'status', '--home', home, '--json']);
  assert.deepEqual(ready.rounds.map((round) => round.complete), [true, true, false, true]);
  assert.deepEqual(ready.readiness.scan, { ready: true, detail: 'ready: interview round 1 is complete and at least one scan source is set' });
  assert.deepEqual(ready.missing.map((item) => item.key), ['legal-name', 'email', 'phone', 'address']);
  assert.deepEqual((await json(['profile', 'show', '--home', home, '--json'])).profile.sources.atsBoards, [{ ats: 'greenhouse', board: 'examplecorp', company: 'ExampleCorp' }]);

  await ok(['profile', 'set', '--home', home, '--key', 'interview.skipped', '--value', '["address"]']);
  await ok(['profile', 'set', '--home', home, '--key', 'interview.roundsCompleted', '--value', '[1,2]']);
  await ok(['profile', 'answer', '--home', home, '--key', 'legal-name', '--answer', 'Alex Example']);
  await ok(['profile', 'answer', '--home', home, '--key', 'phone', '--answer', '+1 555 0100']);
  const missing = await json(['profile', 'questions', '--missing', '--home', home, '--json']);
  assert.deepEqual(missing.questions.map((question) => [question.key, question.skipped]), [['email', false], ['address', true]]);
  const roundTwoMissing = await json(['profile', 'questions', '--missing', '--round', '2', '--home', home, '--json']);
  assert.deepEqual(roundTwoMissing.questions, []);

  const text = await ok(['profile', 'status', '--home', home]);
  assert.match(text, /^profile: saved \(/m);
  assert.match(text, /^round 1 search: complete$/m);
  assert.match(text, /^round 3 answers: missing email, address$/m);
  assert.match(text, /^apply: ready: /m);

  await ok(['profile', 'set', '--home', home, '--key', 'materials.experienceConfirmed', '--value', 'false']);
  const incomplete = await json(['profile', 'status', '--home', home, '--json']);
  assert.equal(incomplete.readiness.apply.detail, 'incomplete: round 2 (materials) is missing experience-confirmed');
}));

test('profile rejects unknown subcommands with usage', async () => fixture(async (home) => {
  for (const sub of [null, 'interview', 'toString']) {
    const result = await cli(['profile', ...(sub ? [sub] : []), '--home', home]);
    assert.equal(result.code, 1, String(sub));
    assert.match(result.io.stderr, /Usage: career-journal profile show\|questions\|set\|answer\|status/);
  }
}));

test('profile commands never use the network', async () => {
  const sources = await Promise.all(['src/domain/profile.mjs', 'src/domain/profile-questions.mjs', 'src/commands/profile.mjs'].map((file) => readFile(file, 'utf8')));
  for (const source of sources) assert.doesNotMatch(source, /node:(?:https?|http2|net|tls|dgram|dns)|\bfetch\(|XMLHttpRequest|WebSocket/);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('network is not allowed in profile tests'); };
  try {
    await fixture(async (home) => {
      await completeRoundsOneAndTwo(home);
      await ok(['profile', 'set', '--home', home, '--key', 'sources.atsBoards', '--value', '[{"ats":"greenhouse","board":"examplecorp"}]']);
      await ok(['profile', 'set', '--home', home, '--key', 'sources.simplify', '--value', '{"enabled":true,"url":"https://example.com/listings.json"}']);
      await ok(['profile', 'answer', '--home', home, '--key', 'legal-name', '--answer', 'Alex Example']);
      await ok(['profile', 'status', '--home', home, '--json']);
      await ok(['profile', 'show', '--home', home, '--json']);
      await ok(['profile', 'questions', '--missing', '--home', home, '--json']);
    });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 0);
});
