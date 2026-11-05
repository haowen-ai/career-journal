// Failures wait (redesign B4): three identical consecutive Codex adapter failures stop all dispatch for the
// run (partial, adapter_failure), an initialization failure ends the run the same way, and the real cause
// (stop reason, exit status, stderr tail) is kept. Wall-clock fields never replace the frozen run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0 } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runReview } from '../../src/review/worker.mjs';
import { codexExecAdapter } from '../../src/review/judge.mjs';

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
function postings(db, ids) {
  const pages = {};
  for (const id of ids) {
    insertPosting(db, { id, url: urlOf(id), title: snapshotTitle(SNAPSHOTS.eligible) });
    insertReview(db, { postingId: id, stage: 'fetch' });
    pages[urlOf(id)] = page(urlOf(id), SNAPSHOTS.eligible);
  }
  return pages;
}
const run = (db, { pages, judges, wallClock, runId = 'review-b4' }) => runReview({ db, runId, owner: 'worker-a', now: T0, budget: 50,
  deadlineMs: 600_000, attemptDir: null, sleep: async () => {}, fetcher: fakeFetcher(pages), judges, inputs: () => reviewInputs({ policy: REVIEW_POLICY }),
  hooks: {}, ...(wallClock ? { wallClock } : {}) });

test('[B4] three identical consecutive adapter failures stop all dispatch; the run is partial with the real error', async () => {
  const db = freshDb();
  const pages = postings(db, ['p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
  const failure = { status: 'error', errorCode: 'exit_1', error: 'Judge exited 1 (exit 1, signal none); stderr: model overloaded' };
  const judges = { primary: fakeJudge({ tier: 'primary', answers: () => failure }), escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }) };
  const receipt = await run(db, { pages, judges });
  assert.equal(judges.primary.calls.length, 3, 'dispatch stops after the third identical failure');
  assert.equal(judges.escalation.calls.length, 0, 'no other tier is dispatched either');
  assert.deepEqual([receipt.status, receipt.stop_reason], ['partial', 'adapter_failure']);
  assert.ok(receipt.errors.some((error) => /stderr: model overloaded/.test(error)), JSON.stringify(receipt.errors));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state='due'").get().n, 5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state='leased'").get().n, 0);
  assert.equal(db.prepare("SELECT status FROM runs WHERE run_id='review-b4'").get().status, 'partial');
  assert.match(db.prepare("SELECT error FROM attempts LIMIT 1").get().error, /model overloaded/);
});

test('[B4] different failures do not count as a streak; one success resets it', async () => {
  const db = freshDb();
  const pages = postings(db, ['p-1', 'p-2', 'p-3', 'p-4']);
  const script = [{ status: 'error', errorCode: 'exit_1', error: 'a' }, { status: 'error', errorCode: 'timeout', error: 'b' }, { output: JUDGMENTS.eligible }, { status: 'error', errorCode: 'exit_1', error: 'a' }];
  let call = 0;
  const judges = { primary: fakeJudge({ tier: 'primary', answers: () => script[call++] }), escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }) };
  const receipt = await run(db, { pages, judges });
  assert.equal(judges.primary.calls.length, 4);
  assert.notEqual(receipt.stop_reason, 'adapter_failure');
});

test('[B4] an adapter initialization failure ends the run partial with the cause and no lease left', async () => {
  const db = freshDb();
  const pages = postings(db, ['p-1']);
  const primary = fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) });
  primary.ready = Promise.reject(new Error('codex --version failed (exit 127, signal none): codex: command not found'));
  primary.ready.catch(() => {});
  const receipt = await run(db, { pages, judges: { primary, escalation: fakeJudge({ tier: 'escalation' }) } });
  assert.deepEqual([receipt.status, receipt.stop_reason], ['partial', 'adapter_failure']);
  assert.ok(receipt.errors.some((error) => /command not found/.test(error)));
  assert.equal(primary.calls.length, 0);
  assert.equal(reviewOf(db, 'p-1').state, 'due');
  assert.equal(db.prepare("SELECT status FROM runs WHERE run_id='review-b4'").get().status, 'partial');
});

test('[B4] receipts and attempt logs carry the wall clock; the frozen run time still orders work', async () => {
  const db = freshDb();
  const pages = postings(db, ['p-1']);
  let tick = 0;
  const wallClock = () => `2026-11-05T21:00:0${tick++}.000Z`;
  const judges = { primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) }), escalation: fakeJudge({ tier: 'escalation' }) };
  const receipt = await run(db, { pages, judges, wallClock });
  assert.equal(receipt.started, T0);
  assert.equal(receipt.finished, T0);
  assert.match(receipt.wallStarted, /^2026-11-05T21:00:0/);
  assert.match(receipt.wallFinished, /^2026-11-05T21:00:0/);
  assert.ok(receipt.wallFinished > receipt.wallStarted);
  assert.equal(db.prepare('SELECT dispatched_at FROM attempts').get().dispatched_at, T0);
  const context = db.prepare("SELECT payload_json FROM review_log WHERE kind='outcome' AND attempt_id IS NOT NULL").get();
  assert.match(JSON.parse(context.payload_json).wallDispatchedAt, /^2026-11-05T21:00/);
});

test('[B4] a cancelled Codex process reports why it was stopped, its signal and its stderr tail, not "Process cancelled"', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cj-b4-'));
  try {
    const adapter = codexExecAdapter({ codexHome: dir, model: 'm', tier: 'primary', workDir: dir, timeoutMs: 60_000,
      runImpl: async ({ onStderr, signal }) => { onStderr('stream disconnected: upstream 502\n'); await new Promise((done) => signal.addEventListener('abort', done)); throw new Error('Process cancelled'); } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await adapter.judge({ prompt: 'p' }, { attemptId: 'a1', outputPath: path.join(dir, 'out.json'), signal: controller.signal });
    assert.equal(result.status, 'error');
    assert.equal(result.errorCode, 'cancelled');
    assert.doesNotMatch(result.error, /^Process cancelled/);
    assert.match(result.error, /Judge cancelled/);
    assert.match(result.error, /upstream 502/);
    assert.equal(result.diagnostics.stopReason, 'cancelled');

    const exited = codexExecAdapter({ codexHome: dir, model: 'm', tier: 'primary', workDir: dir,
      runImpl: async () => ({ exitCode: 2, signal: null, stdout: '', stderr: 'error: unknown model m\n' }) });
    const failed = await exited.judge({ prompt: 'p' }, { attemptId: 'a2', outputPath: path.join(dir, 'out2.json') });
    assert.deepEqual([failed.status, failed.errorCode, failed.diagnostics.exitCode], ['error', 'exit_2', 2]);
    assert.match(failed.error, /Judge exited 2 \(exit 2, signal none\); stderr: error: unknown model m/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
