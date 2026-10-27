// Integration — the screening funnel end to end (screening plan Task I1). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, freshDb, fakeJudge, fakeFetcher, applicationsCount, T0, at } from '../../test-utils/funnel-v3.mjs';
import { JUDGMENTS, SCREENING_POLICY, SNAPSHOTS, page, record, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { defaultRoutes, fixtureFetch, readFixture } from '../../test-utils/scan-fixtures.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

test('[I] a low-fit eligible role travels from a source record to the bottom of the visible queue', async () => {
  const { runScan } = await load('I1', './src/scan/run.mjs', ['runScan']);
  const { runReview } = await load('I1', './src/review/worker.mjs', ['runReview']);
  const { listQueue } = await load('I1', './src/commands/queue.mjs', ['listQueue']);
  const db = freshDb();
  const partition = 'greenhouse:examplecorp';
  const roles = [
    record({ sourceId: '9500001', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9500001', title: 'Data Science Intern, Summer 2027' }),
    record({ sourceId: '9500002', url: 'https://job-boards.greenhouse.io/examplecorp/jobs/9500002', title: 'Analytics Intern, Summer 2027' }),
  ];
  const envelope = {
    sources: [{ source: 'greenhouse', partition, status: 'ok', count: 2, rawCount: 2, truncated: false }],
    batches: [{ source: 'greenhouse', partition, rawCount: 2, records: roles }],
  };
  const profile = { search: { jobType: 'internship', countries: ['US'], exclusions: [] }, sources: { atsBoards: [{ ats: 'greenhouse', board: 'examplecorp' }], careerOps: false, simplify: { enabled: false, url: null }, expected: [] } };
  const summary = await runScan({ db, profile, runId: 'scan-1', now: T0, policy: SCREENING_POLICY, collect: async () => envelope });
  assert.equal(summary.counts.observed, 2);
  assert.equal(applicationsCount(db), 0, 'the scan creates no leads');

  const postingId = (sourceId) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(`source:greenhouse:${sourceId}`).posting_id;
  const lowId = postingId('9500002');
  const pages = Object.fromEntries(roles.map((role) => [role.url, page(role.url, SNAPSHOTS.eligible, { title: role.title })]));
  const answers = (request) => ({ output: request.postingId === lowId ? JUDGMENTS.lowFit : JUDGMENTS.eligible });
  await runReview({
    db, runId: 'review-1', owner: 'worker-a', now: at(0.01), budget: 10, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fakeFetcher(pages),
    judges: { primary: fakeJudge({ tier: 'primary', answers }), escalation: fakeJudge({ tier: 'escalation', answers }) },
    inputs: () => reviewInputs(),
    hooks: {},
  });

  const queue = listQueue(db);
  assert.equal(queue.length, 2, 'both eligible roles are visible');
  assert.equal(queue[0].fit, 'high');
  assert.equal(queue.at(-1).fit, 'low', 'low fit is listed last, never hidden');
  assert.equal(queue.at(-1).role, 'Analytics Intern, Summer 2027');
});

test('[I] a daily sequence with a failure injected after each stage finalizes the right status', async () => {
  const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
  const { runCli } = await import('../../src/cli/main.mjs');
  const { setup } = await import('../../src/commands/setup.mjs');
  const base = createRuntime({ root: process.cwd(), version: 'test' });
  for (const name of ['review', 'prune']) if (!base.commands.has(name)) throw new Error(`NOT IMPLEMENTED [I1]: \`${name}\` command is not registered in create-runtime.mjs`);
  const { readCurrentReceipt } = await load('I1', './src/review/receipt.mjs', ['readCurrentReceipt']);
  const runtime = { ...base, fetch: fixtureFetch(await defaultRoutes()) };
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-daily-'));
  const cli = async (args) => {
    const io = memoryIO();
    const code = await runCli([...args, '--home', home], io, runtime);
    return { code, io };
  };
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const profileFile = path.join(home, '.career-journal', 'profile', 'profile.json');
    await mkdir(path.dirname(profileFile), { recursive: true, mode: 0o700 });
    await writeFile(profileFile, JSON.stringify(await readFixture('profile.json'), null, 2), { mode: 0o600 });
    const today = new Date().toISOString().slice(0, 10);
    const d = `daily-${today}-2130`;

    const scan = await cli(['scan', 'run', '--run-id', `${d}:scan`, '--parent-run-id', d, '--json']);
    assert.equal(scan.code, 0, scan.io.stderr);
    const review = await cli(['review', 'run', '--run-id', `${d}:review`, '--parent-run-id', d]);
    assert.equal(review.code, 1, 'review without configured inputs fails loudly');
    const prune = await cli(['prune', '--apply', '--run-id', `${d}:prune`, '--parent-run-id', d, '--protect', d, '--json']);
    assert.equal(prune.code, 0, prune.io.stderr);

    const finalize = async (dailyId, stages, expected) => {
      const result = await cli(['review', 'daily-finalize', '--run-id', dailyId, ...stages.flatMap((stage) => ['--stage', stage]), '--json']);
      assert.equal(result.code, expected.exit, `${dailyId}: ${result.io.stderr}`);
      assert.equal(JSON.parse(result.io.stdout).status, expected.status, dailyId);
      const current = await readCurrentReceipt(home, { date: today });
      assert.equal(current.state, 'finished', dailyId);
      assert.equal(current.receipt.run_id, dailyId, 'latest.json points to this daily receipt');
      assert.equal(current.receipt.kind, 'daily');
    };
    await finalize(d, [`scan=ok:${d}:scan`, `review=failed:${d}:review`, `prune=ok:${d}:prune`], { exit: 1, status: 'failed' });

    const cases = [
      ['2131', { scan: 'ok', review: 'ok', prune: 'ok' }, { exit: 0, status: 'ok' }],
      ['2132', { scan: 'ok', review: 'partial', prune: 'ok' }, { exit: 2, status: 'partial' }],
      ['2133', { scan: 'ok', review: 'ok', prune: 'failed' }, { exit: 1, status: 'failed' }],
      ['2134', { scan: 'failed', review: 'ok', prune: 'ok' }, { exit: 1, status: 'failed' }],
    ];
    for (const [time, stages, expected] of cases) {
      const id = `daily-${today}-${time}`;
      await finalize(id, Object.entries(stages).map(([name, status]) => `${name}=${status}:${id}:${name}`), expected);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
