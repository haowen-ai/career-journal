import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { insertPosting, insertReview, seedApplication, T0 } from '../../test-utils/funnel-v3.mjs';
import { SNAPSHOTS, writeReviewHome } from '../../test-utils/funnel-v3-fixtures.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { closedPageWording, isStubText, hasNoPostingBody } from '../../src/review/fetch.mjs';

for (const text of [
  "The page you are looking for doesn't exist.",
  'The page you’re looking for does not exist',
  'Page not found',
  'Job not found',
  'Job not available. This job is unavailable at the moment.',
  'This job is no longer available',
  'This position has been filled.',
  'This posting has expired.',
  'We are no longer accepting applications for this role.',
]) test(`a gone page reads as closed: ${text}`, () => assert.ok(closedPageWording(text)));

for (const text of [
  'Applications are accepted until the position is filled.',
  'The salary range depends on where this position is filled.',
  'Applications remain open until our recruiting team confirms with the hiring manager that this position has been filled.',
  'Pay reflects the geographic differential for the location in which the position is filled.',
  'The role is closed to remote work.',
  'Data Science Intern. Requirements: Python and SQL. This job is unavailable for remote work. Apply now.',
  'Data Science Intern. Requirements: Python and SQL. Please note that this role is closed to remote work. Apply now.',
  'Relocation for this position not available.',
  'You will track how long each job is open and when the position is closed out.',
  'Open until this position has been filled.',
  'We will review resumes once the position is closed to new candidates.',
  'Data Science Intern. You will build dashboards and models.',
  '',
]) test(`a live page does not read as closed: ${text || '(empty)'}`, () => assert.equal(closedPageWording(text), null));

test('a status inside a long job description does not close it; the same status as its own sentence does', () => {
  const body = 'Build Python models and SQL dashboards with the analytics team. '.repeat(12);
  assert.equal(closedPageWording(`${body}Your manager reviews whether this position has been filled by a contractor.`), null);
  assert.ok(closedPageWording(`This position has been filled. ${body}`));
  assert.ok(closedPageWording(`${body}\nThis job has expired.`));
  assert.ok(closedPageWording(`${body}Page not found`));
  assert.ok(closedPageWording('Build your Career at Tesla\nJob not available\nThis job is unavailable at the moment.'));
});

test('a complete short job description is not an empty page', () => {
  assert.equal(hasNoPostingBody('Data Science Intern — Example Corp. Chicago, IL. Summer 2027, full time, paid. Build Python models and SQL dashboards. Current BS or MS students welcome. Must be authorized to work in the US. Apply using the form below.'), false);
  assert.equal(hasNoPostingBody('Data Analyst Intern — Example Corp, Chicago. June–August 2027, $25/hour. Build dashboards, analyze customer data and present findings. Enrolled in a BS or MS program; Python and SQL proficiency. Apply below.'), false);
  assert.equal(hasNoPostingBody('Skip to main content Sign In Search for Jobs Follow Us'), true);
});

test('stub text has no posting body; a full posting does not count as a stub', () => {
  assert.equal(isStubText('Something went wrong. Please try again.'), true);
  assert.equal(isStubText(SNAPSHOTS.eligible), false);
});

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-attach-closed-'));
  try {
    const { setup } = await import('../../src/commands/setup.mjs');
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    await writeReviewHome(home);
    const { openHomeDatabase } = await import('../../src/runtime/home.mjs');
    const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
    const { runCli } = await import('../../src/cli/main.mjs');
    const runtime = createRuntime({ root: process.cwd(), version: 'test' });
    const attach = async (text) => {
      const file = path.join(home, 'page.txt'); await writeFile(file, text);
      const io = memoryIO(); let code;
      try { code = await runCli(['review', 'attach', '--posting', 'p-gone', '--file', file, '--home', home], io, runtime); } catch (error) { code = 1; io.stderr += error.message; }
      return { code, out: io.stdout, err: io.stderr };
    };
    const read = async (fn) => { const context = await openHomeDatabase(home); try { return fn(context.db); } finally { context.db.close(); } };
    await run({ attach, read });
  } finally { await rm(home, { recursive: true, force: true }); }
}
const seed = (db, extra = {}) => {
  insertPosting(db, { id: 'p-gone', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/p-gone', company: 'Example Corp', firstSeen: T0 });
  insertReview(db, { postingId: 'p-gone', state: 'held', lane: 'new', decision: 'unclear', code: 'browser_review', firstSeen: T0, stage: 'fetch', ...extra });
};

test('attaching a page that no longer exists settles it closed and never reaches the judge', () => withHome(async ({ attach, read }) => {
  await read((db) => seed(db));
  const result = await attach("The page you are looking for doesn't exist.");
  assert.equal(result.code, 0, result.out + result.err);
  await read((db) => {
    const row = db.prepare('SELECT state,decision,code,lease_owner FROM reviews WHERE posting_id=?').get('p-gone');
    assert.deepEqual({ ...row }, { state: 'done', decision: 'not_eligible', code: 'closed_verified', lease_owner: null });
    assert.equal(db.prepare('SELECT availability FROM postings WHERE id=?').get('p-gone').availability, 'closed_verified');
  });
}));

test('a queued lead whose page is gone leaves the queue', () => withHome(async ({ attach, read }) => {
  await read((db) => {
    seed(db, { state: 'done', decision: 'eligible', code: null });
    const app = seedApplication(db, { company: 'Example Corp', role: 'Role', status: 'lead' });
    db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, 'p-gone');
  });
  const result = await attach('Page not found');
  assert.equal(result.code, 0, result.out + result.err);
  await read((db) => assert.equal(db.prepare('SELECT a.status FROM applications a JOIN postings p ON p.application_id=a.id WHERE p.id=?').get('p-gone').status, 'withdrawn'));
}));

test('a gone page never withdraws a lead the user approved', () => withHome(async ({ attach, read }) => {
  await read((db) => {
    seed(db, { state: 'done', decision: 'eligible', code: null });
    const app = seedApplication(db, { company: 'Example Corp', role: 'Role', status: 'lead' });
    db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, 'p-gone');
    db.prepare("INSERT INTO review_log(posting_id,at,stage,kind,payload_json) VALUES ('p-gone',?,'deliver','user','{}')").run(T0);
  });
  const result = await attach('Page not found');
  assert.notEqual(result.code, 0);
  assert.match(result.out + result.err, /owned by a user decision/);
  await read((db) => {
    assert.equal(db.prepare('SELECT a.status FROM applications a JOIN postings p ON p.application_id=a.id WHERE p.id=?').get('p-gone').status, 'lead');
    assert.equal(db.prepare('SELECT decision FROM reviews WHERE posting_id=?').get('p-gone').decision, 'eligible');
  });
}));

test('attaching a stub with no posting body is refused and the hold stays', () => withHome(async ({ attach, read }) => {
  await read((db) => seed(db));
  const result = await attach('Something went wrong. Please try again.');
  assert.notEqual(result.code, 0);
  assert.match(result.out + result.err, /too_short/);
  await read((db) => assert.equal(db.prepare('SELECT state FROM reviews WHERE posting_id=?').get('p-gone').state, 'held'));
}));

test('attaching a real posting still goes to the judge', () => withHome(async ({ attach, read }) => {
  await read((db) => seed(db));
  const result = await attach(SNAPSHOTS.eligible);
  assert.equal(result.code, 0, result.out + result.err);
  await read((db) => assert.deepEqual({ ...db.prepare('SELECT state,stage FROM reviews WHERE posting_id=?').get('p-gone') }, { state: 'due', stage: 'judge' }));
}));
