// End-to-end smoke of the merged redesign in a temporary home (never a real one): scan ingest, review runs
// with fake Jev/Codex adapters, a rule edit, an explicit rejudge, a Jev outage and a sticky withdrawal.
// Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fakeJudge, T0, at, seedApplication, insertPosting, insertReview } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, PROFILE, SNAPSHOTS, JUDGMENTS, RULES, page, record, snapshotTitle, writeReviewHome } from '../../test-utils/funnel-v3-fixtures.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { JEV_SPLIT_QUESTIONS } from '../../src/review/jev-split.mjs';
import { JevError } from '../../src/review/second-opinion.mjs';
import { runScan } from '../../src/scan/run.mjs';
import { scanPolicy } from '../../src/commands/scan.mjs';

const THRESHOLDS = {
  reject: { degree: 0.3, term: 0.3, place: 0.3, auth: 0.3, function: 0.3, skills: 0.2 },
  accept: { degree: 0.7, term: 0.65, place: 0.8, auth: 0.55, function: 0.7, skills: 0.4 },
};
const POLICY = { ...REVIEW_POLICY, exploration: { share: 0 }, judge: { primary: { runner: 'jev-split', model: 'jev-test', thresholds: THRESHOLDS },
  fallback: { runner: 'codex', model: 'codex-fallback', codexHome: '/nonexistent' }, escalation: { runner: 'codex', model: 'codex-escalation', codexHome: '/nonexistent' } } };
const HIGH = { degree: 0.97, term: 0.82, place: 0.87, auth: 0.95, function: 0.71, skills: 0.63 };
const dimensionOf = (question) => Object.keys(JEV_SPLIT_QUESTIONS).find((key) => JEV_SPLIT_QUESTIONS[key] === question);
const PARTITION = 'greenhouse:examplecorp';
const urlOf = (n) => `https://job-boards.greenhouse.io/examplecorp/jobs/${n}`;
const LONG = (text) => `${text} `.repeat(30);
const role = (n, overrides = {}) => record({ sourceId: String(n), url: urlOf(n), ...overrides });
const NO_SIGNAL = { title: 'Senior Data Engineer', description: LONG('Ten years of platform engineering required.') };

test('[SMOKE] decide once end to end: counted drops, settled rows stay settled, explicit rejudge, Jev outage waits, withdrawals stick', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-int-smoke-'));
  try {
    const { setup } = await import('../../src/commands/setup.mjs');
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const profileDir = path.join(home, '.career-journal', 'profile');
    await writeReviewHome(home, { policy: POLICY });
    await writeFile(path.join(profileDir, 'company-size.json'), JSON.stringify({ large: ['Example Corp'], small: ['Tiny Example Co'] }));
    const { openHomeDatabase } = await import('../../src/runtime/home.mjs');
    const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
    const { runCli } = await import('../../src/cli/main.mjs');
    const base = createRuntime({ root: process.cwd(), version: 'test' });
    const context = await openHomeDatabase(home);
    const { db } = context;
    const scanProfile = { ...PROFILE, sources: { expected: ['atsBoards'], atsBoards: [{ ats: 'greenhouse', board: 'examplecorp' }] } };
    const scan = async (runId, now, records) => runScan({ db, profile: scanProfile, runId, now, policy: await scanPolicy(context),
      collect: async () => ({ sources: [{ source: 'greenhouse', partition: PARTITION, status: 'ok', count: records.length, rawCount: records.length }],
        batches: [{ source: 'greenhouse', partition: PARTITION, records, rawCount: records.length }] }) });
    const postingOf = (n) => db.prepare('SELECT posting_id FROM posting_aliases WHERE alias=?').get(`url:${urlOf(n).replace('https://', '')}`)?.posting_id;
    const reviewOf = (id) => db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(id);
    const reviewRows = () => JSON.stringify(db.prepare('SELECT posting_id,state,decision,code FROM reviews ORDER BY posting_id').all());

    // Pages by URL; the title is the snapshot's first line.
    const texts = new Map();
    const fetcher = { calls: [], async fetch(request) { this.calls.push(request); const text = texts.get(request.url); return text ? page(request.url, text) : { ok: false, httpStatus: 404, error: 'not found' }; } };
    let jevDown = false;
    const jevCalls = [];
    const jev = { async ask({ state, question }) {
      jevCalls.push(question);
      if (jevDown) throw new JevError('Jev HTTP 503', { kind: 'http', status: 503 });
      const dimension = dimensionOf(question);
      if (dimension === 'degree' && /junior undergraduate/.test(state.postingText ?? '')) return { probability: 0.05 };
      return { probability: HIGH[dimension] };
    } };
    const judges = { primary: fakeJudge({ tier: 'primary', answers: () => ({ output: JUDGMENTS.eligible }) }), escalation: fakeJudge({ tier: 'escalation', answers: () => ({ output: JUDGMENTS.eligible }) }) };
    const codexCalls = () => judges.primary.calls.length + judges.escalation.calls.length;
    const sizeAsked = [];
    const companySize = { askJev: async (question, { company }) => { sizeAsked.push(company); return { probability: 0.95 }; }, askModel: async () => { throw new Error('not expected'); } };
    const cli = async (args, now) => {
      const io = memoryIO();
      const code = await runCli([...args, '--home', home], io, { ...base, now: () => now, review: { judges, fetcher, jev, companySize } });
      return { code, out: io.stdout, err: io.stderr };
    };
    const reviewRun = async (now) => { const result = await cli(['review', 'run'], now); return { ...result, receipt: JSON.parse(result.out) }; };

    // ---- history from before the redesign: a settled drop, a judged rejection, a withdrawn lead.
    const eligibleTitle = snapshotTitle(SNAPSHOTS.eligible);
    const undergradTitle = snapshotTitle(SNAPSHOTS.undergradOnly);
    await scan('scan-0', T0, [role(1, { title: eligibleTitle }), role(2, { title: eligibleTitle }), role(3, { title: eligibleTitle })]);
    const settledDrop = postingOf(1); const rejected = postingOf(2); const withdrawn = postingOf(3);
    db.prepare("UPDATE reviews SET state='done',decision='dropped',code='no_student_signal',next_due=NULL WHERE posting_id=?").run(settledDrop);
    db.prepare("UPDATE reviews SET state='done',decision='not_eligible',code='outside_area',stage='deliver',next_due=NULL,evidence_json=? WHERE posting_id=?")
      .run(JSON.stringify({ provenance: 'automated' }), rejected);
    const withdrawnApp = seedApplication(db, { company: 'Example Corp', role: eligibleTitle, status: 'withdrawn', skipReason: 'outside_area', skipOwner: 'review', jobUrl: urlOf(3) });
    db.prepare("UPDATE application_events SET source_json=? WHERE application_id=?").run(JSON.stringify({ actor: 'review-worker' }), withdrawnApp.id);
    db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(withdrawnApp.id, withdrawn);
    db.prepare("UPDATE reviews SET state='done',decision='not_eligible',code='outside_area',stage='deliver',next_due=NULL,evidence_json=? WHERE posting_id=?")
      .run(JSON.stringify({ provenance: 'automated' }), withdrawn);

    // ---- 1. a synthetic batch: unknown certain drops, a known settled drop, a new student role, an eligible lead.
    for (const [n, text] of [[10, SNAPSHOTS.undergradOnly], [11, SNAPSHOTS.eligible]]) texts.set(urlOf(n), text);
    const scan1 = await scan('scan-1', at(0.1), [
      role(1, NO_SIGNAL),                                                     // known, settled as the same drop
      role(20, NO_SIGNAL), role(21, { ...NO_SIGNAL, sourceId: '21' }),         // unknown no-signal
      role(22, { company: 'Excluded Example Co', title: eligibleTitle }),      // unknown, excluded company
      role(23, { company: 'Tiny Example Co', title: eligibleTitle }),          // unknown, known-small company
      role(10, { title: undergradTitle }),                                    // new student role (the judge rejects it)
      role(11, { company: 'Fresh Example Co', title: eligibleTitle }),         // new eligible lead, company size unknown
    ]);
    assert.deepEqual([scan1.counts.raw, scan1.counts.stored, scan1.counts.countedOnly], [7, 2, 5]);
    assert.deepEqual(scan1.counts.countedOnlyBy, { no_student_signal: 3, company_excluded: 1, company_small: 1 });
    for (const n of [20, 21, 22, 23]) assert.equal(postingOf(n), undefined, `record ${n} is counted, not stored`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM observations WHERE posting_id=?').get(settledDrop).n, 1, 'no new observation for the settled drop');

    const run1 = await reviewRun(at(0.2));
    assert.deepEqual([run1.code, run1.receipt.status, run1.receipt.stop_reason], [0, 'ok', null], run1.err + JSON.stringify(run1.receipt.errors));
    assert.deepEqual(sizeAsked, ['Fresh Example Co'], 'the unknown company is decided once');
    const lead = postingOf(11); const student = postingOf(10);
    assert.deepEqual([reviewOf(lead).decision, reviewOf(student).decision, reviewOf(student).code], ['eligible', 'not_eligible', 'degree']);
    assert.equal(db.prepare('SELECT a.status FROM postings p JOIN applications a ON a.id=p.application_id WHERE p.id=?').get(lead).status, 'lead');
    assert.equal(codexCalls(), 0, 'Jev decided both; nothing escalated');
    assert.deepEqual([run1.receipt.counts.judged, run1.receipt.counts.eligible, run1.receipt.backlog.actionable_due], [2, 1, 0]);
    const summary = await cli(['review', 'receipt', '--run-id', run1.receipt.run_id, '--summary', 'zh'], at(0.2));
    assert.match(summary.out, /状态 ok；.*判定 2，合格 1；剩余待审 0；挂起 0；停止原因 无/);

    // ---- 2. a rule edit: nothing settled is re-queued, nothing is judged or fetched.
    await writeFile(path.join(profileDir, 'screening-rules.md'), `${RULES.screening}\nEdited on purpose: one more synthetic rule line.\n`);
    const settledBefore = reviewRows();
    const jevBefore = jevCalls.length; const fetchBefore = fetcher.calls.length;
    const run2 = await reviewRun(at(1));
    assert.equal(run2.receipt.status, 'ok', JSON.stringify(run2.receipt.errors));
    assert.equal(reviewRows(), settledBefore, 'zero settled rows re-queued after a rule edit');
    assert.deepEqual([jevCalls.length - jevBefore, fetcher.calls.length - fetchBefore, codexCalls()], [0, 0, 0]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM review_log WHERE kind='replan' AND at>=?").get(at(1)).n, 0);

    // ---- 3. an explicit rejudge re-queues exactly the rows it names.
    const dry = JSON.parse((await cli(['review', 'rejudge', '--code', 'degree'], at(1.1))).out);
    assert.deepEqual([dry.dryRun, dry.selected], [true, 1]);
    const applied = JSON.parse((await cli(['review', 'rejudge', '--code', 'degree', '--apply'], at(1.1))).out);
    assert.equal(applied.requeued, 1);
    const due = db.prepare("SELECT posting_id FROM reviews WHERE state='due'").all().map((row) => row.posting_id);
    assert.deepEqual(due, [student], 'only the rejudged row is due');

    // ---- 4. a Jev outage: the run ends partial jev_unavailable, nothing escalates, the work stays due.
    const fresh = Array.from({ length: 21 }, (_, i) => 100 + i);
    for (const n of fresh) texts.set(urlOf(n), SNAPSHOTS.eligible);
    // The withdrawn lead's listing changes; a settled review is not reset by the scan.
    await scan('scan-2', at(1.2), [...fresh.map((n) => role(n, { title: eligibleTitle })), role(3, { title: eligibleTitle, description: LONG('Updated synthetic description.') })]);
    assert.equal(reviewOf(withdrawn).state, 'done', 'a content change does not reopen a settled review');
    jevDown = true;
    const run3 = await reviewRun(at(1.3));
    assert.deepEqual([run3.code, run3.receipt.status, run3.receipt.stop_reason], [2, 'partial', 'jev_unavailable']);
    assert.ok(run3.receipt.errors.some((error) => /Jev HTTP 503/.test(error)), 'the real error is kept');
    assert.equal(codexCalls(), 0, 'nothing escalated to Codex');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE state='due'").get().n, fresh.length + 1, 'every posting waits, undecided');
    const zh = await cli(['review', 'receipt', '--run-id', run3.receipt.run_id, '--summary', 'zh'], at(1.3));
    assert.match(zh.out, /停止原因 jev_unavailable（Jev 不可用）/);

    // ---- 5. Jev is back: the run finishes the due work; the withdrawn lead is not restored by a normal run.
    jevDown = false;
    const run4 = await reviewRun(at(2));
    assert.deepEqual([run4.receipt.status, run4.receipt.backlog.actionable_due], ['ok', 0], JSON.stringify(run4.receipt.errors));
    assert.equal(codexCalls(), 0);
    assert.equal(db.prepare('SELECT status FROM applications WHERE id=?').get(withdrawnApp.id).status, 'withdrawn', 'the withdrawal sticks');
    assert.deepEqual([reviewOf(withdrawn).state, reviewOf(withdrawn).code], ['done', 'outside_area']);
    assert.equal(reviewOf(rejected).state, 'done');
    assert.equal(reviewOf(student).code, 'degree', 'the rejudged row was judged afresh and settled again');
    db.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('[SMOKE] the new maintenance commands are in their usage text and run against a temporary home', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cj-int-cli-'));
  try {
    const { setup } = await import('../../src/commands/setup.mjs');
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    await writeReviewHome(home);
    await writeFile(path.join(home, '.career-journal', 'profile', 'profile.json'), JSON.stringify({ schemaVersion: 1, ...PROFILE, sources: { atsBoards: [] } }));
    const { openHomeDatabase } = await import('../../src/runtime/home.mjs');
    const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
    const { runCli } = await import('../../src/cli/main.mjs');
    const runtime = createRuntime({ root: process.cwd(), version: 'test' });
    const cli = async (...args) => { const io = memoryIO(); const code = await runCli([...args, '--home', home], io, runtime); return { code, out: io.stdout, err: io.stderr }; };
    const reviewUsage = (await cli('review', 'nope')).err;
    for (const word of ['rejudge', 'settle-backlog', 'hold', 'list [--held] [--json]', 'attach', '--leads', '--apply', '--summary [zh]']) assert.ok(reviewUsage.includes(word), `review usage names ${word}`);
    const queueUsage = (await cli('queue', 'nope')).err;
    for (const word of ['rescreen [--decide-sizes] [--apply]', 'verify', '--actor user|apply|audit']) assert.ok(queueUsage.includes(word), `queue usage names ${word}`);
    assert.match((await cli('event', 'nope')).err, /--force/);
    const context = await openHomeDatabase(home);
    const app = seedApplication(context.db, { company: 'Example Corp', role: 'Data Science Intern', status: 'applied', appliedAt: T0 });
    const lead = seedApplication(context.db, { company: 'Example Corp', role: 'Analytics Intern' });
    insertPosting(context.db, { id: 'p-wall', company: 'Wall Example Co', title: 'Research Intern', url: 'https://careers.wall-example.test/jobs/9900001' });
    insertReview(context.db, { postingId: 'p-wall', state: 'held', decision: 'unclear', code: 'browser_review', holdOwner: 'system' });
    context.db.close();
    for (const args of [['review', 'list', '--held', '--json'], ['review', 'rejudge', '--leads'], ['review', 'settle-backlog'], ['queue', 'rescreen', '--json'],
      ['queue', 'verify', '--id', lead.id, '--result', 'ok', '--reason', 'synthetic check', '--actor', 'apply']]) {
      const result = await cli(...args);
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}`);
    }
    const held = await cli('review', 'hold', '--posting', 'p-wall', '--code', 'external_signin_wall', '--reason', 'synthetic sign-in wall');
    assert.equal(held.code, 0, held.err);
    assert.deepEqual(JSON.parse((await cli('review', 'list', '--held', '--json')).out).map((row) => [row.posting_id, row.code]), [['p-wall', 'external_signin_wall']]);
    const again = await cli('event', 'add', '--id', app.id, '--type', 'submitted', '--title', 'Submitted again', '--status-after', 'applied');
    const forced = await cli('event', 'add', '--id', app.id, '--type', 'submitted', '--title', 'Submitted again', '--status-after', 'applied', '--force');
    assert.deepEqual([again.code, forced.code], [0, 0], again.err + forced.err);
    const [second, third] = [JSON.parse(again.out), JSON.parse(forced.out)];
    assert.deepEqual([second.created, Boolean(second.duplicateOf)], [false, true], 'a second submission is a no-op returning the first');
    assert.equal(third.created, true, '--force records a distinct submission');
  } finally { await rm(home, { recursive: true, force: true }); }
});
