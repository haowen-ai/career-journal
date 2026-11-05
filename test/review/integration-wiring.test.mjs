// Cross-lane wiring of the redesign (integration items a–h). Synthetic data only: every employer,
// place and URL is invented; no network, no real model or Jev call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, insertPosting, insertReview, reviewOf, seedApplication, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SCREENING_POLICY, PROFILE, SNAPSHOTS, JUDGMENTS, page, record, reviewInputs, writeReviewHome } from '../../test-utils/funnel-v3-fixtures.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';
import { createCompanySizeResolver, companySizeSettings } from '../../src/review/company-size-runtime.mjs';
import { companySizes } from '../../src/review/company-size.mjs';
import { applyCompanyCap, deliver, storedReopenAuthorization, suppressSubmittedDuplicates } from '../../src/review/deliver.mjs';
import { claimItem } from '../../src/review/lease.mjs';
import { applyRoleDirection } from '../../src/review/direction-pass.mjs';
import { directionRules } from '../../src/review/direction.mjs';
import { JEV_SPLIT_QUESTIONS } from '../../src/review/jev-split.mjs';
import { DEFAULT_PLACE_QUESTION } from '../../src/config/defaults.mjs';
import { ingestBatch, DEFAULT_CERTAIN_DROP_CODES } from '../../src/funnel/ingest.mjs';
import { CERTAIN_DROP_CODES } from '../../src/funnel/classify.mjs';
import { runReview } from '../../src/review/worker.mjs';
import { nightlySummary } from '../../src/review/summary.mjs';
import { reviewReport } from '../../src/review/report.mjs';

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
const temp = (prefix) => mkdtemp(path.join(os.tmpdir(), prefix));
const readSizes = async (dir) => JSON.parse(await readFile(path.join(dir, 'company-size.json'), 'utf8'));
const ESCALATION = { runner: 'codex', model: 'codex-escalation-test', codexHome: '/nonexistent/codex-home', effort: 'medium' };

// A fake process runner standing in for `codex exec`: writes the -o output file like the CLI does.
function fakeCodex(answer) {
  const calls = [];
  const runImpl = async (spec) => {
    calls.push(spec);
    const value = typeof answer === 'function' ? answer(spec) : answer;
    if (value.exitCode) return { exitCode: value.exitCode, signal: null, stdout: '', stderr: value.stderr ?? '' };
    await writeFile(spec.args[spec.args.indexOf('-o') + 1], JSON.stringify(value));
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  };
  return { calls, runImpl };
}

async function cliHome(prefix) {
  const home = await temp(prefix);
  const { setup } = await import('../../src/commands/setup.mjs');
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  await writeReviewHome(home);
  const { openHomeDatabase } = await import('../../src/runtime/home.mjs');
  const { createRuntime } = await import('../../src/runtime/create-runtime.mjs');
  const { runCli } = await import('../../src/cli/main.mjs');
  const base = createRuntime({ root: process.cwd(), version: 'test' });
  const cli = async (args, extra = {}) => {
    const io = memoryIO();
    const code = await runCli([...args, '--home', home], io, { ...base, ...extra });
    return { code, out: io.stdout, err: io.stderr };
  };
  return { home, profileDir: path.join(home, '.career-journal', 'profile'), cli, open: () => openHomeDatabase(home) };
}

// ===================================================================== (a) company size

test('[INT-a] the size resolver asks Jev once per company, sends the in-between ones to one codex call, and saves decisions', async () => {
  const dir = await temp('cj-int-size-');
  try {
    await writeFile(path.join(dir, 'company-size.json'), JSON.stringify({ large: ['Known Big Example Co'], small: [] }));
    const asked = [];
    const probability = { 'Sure Example Co': 0.92, 'Tiny Example Co': 0.08, 'Middle Example Co': 0.5 };
    const jevAdapter = { async ask({ state, question }) { asked.push({ state, question }); return { probability: probability[state.company] }; } };
    const codex = fakeCodex({ size: 'small', reason: 'about 200 employees on its about page' });
    const reviewPolicy = { ...REVIEW_POLICY, judge: { escalation: ESCALATION }, companySize: { question: 'Synthetic size question about {company}?', thresholds: { accept: 0.75, reject: 0.25 } } };
    const resolve = createCompanySizeResolver({ profileDir: dir, reviewPolicy, jevAdapter, runImpl: codex.runImpl });
    const result = await resolve({ companies: ['Known Big Example Co', 'Sure Example Co', 'Sure Example Co', 'Tiny Example Co', 'Middle Example Co'], now: T0 });
    assert.deepEqual(result.failed, []);
    assert.deepEqual(asked.map((item) => item.question).sort(), ['Synthetic size question about Middle Example Co?', 'Synthetic size question about Sure Example Co?', 'Synthetic size question about Tiny Example Co?']);
    assert.equal(codex.calls.length, 1, 'only the in-between company reaches the model');
    const args = codex.calls[0].args;
    assert.equal(args[args.indexOf('-m') + 1], 'codex-escalation-test', 'the escalation tier model');
    assert.ok(args.includes('--output-schema'));
    assert.equal(codex.calls[0].env.CODEX_HOME, '/nonexistent/codex-home');
    assert.match(codex.calls[0].stdin, /Middle Example Co/);
    const saved = (await readSizes(dir)).decided;
    assert.deepEqual(saved.map((item) => [item.company, item.size, item.by]).sort(), [['Middle Example Co', 'small', 'model'], ['Sure Example Co', 'large', 'jev'], ['Tiny Example Co', 'small', 'jev']]);
    // Decided once: a second call asks nothing.
    const again = await resolve({ companies: ['Sure Example Co', 'Middle Example Co'], now: at(1) });
    assert.deepEqual([again.decided.length, again.failed.length, asked.length, codex.calls.length], [0, 0, 3, 1]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('[INT-a] an operational Jev or codex failure decides nothing and returns the real error', async () => {
  const dir = await temp('cj-int-size-fail-');
  try {
    await writeFile(path.join(dir, 'company-size.json'), JSON.stringify({ large: [], small: [] }));
    const jevAdapter = { async ask({ state }) { if (state.company === 'Down Example Co') throw new Error('Jev HTTP 503'); return { probability: 0.5 }; } };
    const codex = fakeCodex({ exitCode: 2, stderr: 'model unavailable for this account' });
    const resolve = createCompanySizeResolver({ profileDir: dir, reviewPolicy: { ...REVIEW_POLICY, judge: { escalation: ESCALATION } }, jevAdapter, runImpl: codex.runImpl });
    const result = await resolve({ companies: ['Down Example Co', 'Middle Example Co'], now: T0 });
    const failed = Object.fromEntries(result.failed.map((item) => [item.company, item]));
    assert.match(failed['Down Example Co'].error, /Jev HTTP 503/);
    assert.match(failed['Middle Example Co'].error, /codex exited 2.*model unavailable/);
    assert.deepEqual((await readSizes(dir)).decided ?? [], [], 'nothing saved');
    assert.throws(() => companySizeSettings({ companySize: { thresholds: { accept: 0.3, reject: 0.6 } } }), /reject must be below accept/);
    assert.throws(() => companySizeSettings({ companySize: { question: 'no placeholder' } }), /\{company\}/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('[INT-a] review run decides unknown sizes before judging; deliver sees the new size; a failed company stays due (company_size_unavailable)', async () => {
  const { home, profileDir, cli, open } = await cliHome('cj-int-size-run-');
  try {
    await writeFile(path.join(profileDir, 'company-size.json'), JSON.stringify({ large: [], small: [] }));
    const context = await open();
    const pages = {};
    for (const [id, company] of [['p-new', 'New Example Co'], ['p-down', 'Down Example Co']]) {
      insertPosting(context.db, { id, company, url: urlOf(id) });
      insertReview(context.db, { postingId: id, stage: 'fetch' });
      pages[urlOf(id)] = page(urlOf(id), SNAPSHOTS.eligible);
    }
    context.db.close();
    const asked = [];
    const askJev = async (question, { company }) => { asked.push(company); if (company === 'Down Example Co') throw new Error('Jev network error'); return { probability: 0.95 }; };
    const judge = () => ({ output: JUDGMENTS.eligible });
    const review = { judges: { primary: fakeJudge({ tier: 'primary', answers: judge }), escalation: fakeJudge({ tier: 'escalation', answers: judge }) },
      fetcher: fakeFetcher(pages), companySize: { askJev, askModel: async () => { throw new Error('not expected'); } } };
    const result = await cli(['review', 'run'], { review, now: () => T0 });
    const receipt = JSON.parse(result.out);
    assert.deepEqual([result.code, receipt.status, receipt.stop_reason], [2, 'partial', 'company_size_unavailable'], result.err);
    assert.deepEqual(asked.sort(), ['Down Example Co', 'New Example Co']);
    assert.deepEqual((await readSizes(profileDir)).decided.map((item) => [item.company, item.size]), [['New Example Co', 'large']]);
    const db = (await open()).db;
    try {
      const fresh = reviewOf(db, 'p-new');
      assert.deepEqual([fresh.state, fresh.decision], ['done', 'eligible'], 'deliver used the size decided in this run');
      assert.equal(db.prepare("SELECT a.status FROM postings p JOIN applications a ON a.id=p.application_id WHERE p.id='p-new'").get().status, 'lead');
      assert.equal(reviewOf(db, 'p-down').state, 'due', 'the failed company waits, undecided');
      assert.equal(review.judges.primary.calls.filter((call) => call.request.postingId === 'p-down').length, 0, 'and is not judged');
    } finally { db.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('[INT-a] queue rescreen --decide-sizes settles unknown lead companies first, then applies the gate', async () => {
  const { home, profileDir, cli, open } = await cliHome('cj-int-rescreen-');
  try {
    await writeFile(path.join(profileDir, 'company-size.json'), JSON.stringify({ large: ['Big Example Co'], small: [] }));
    const context = await open();
    seedApplication(context.db, { company: 'Tiny Lead Example Co', role: 'Data Science Intern' });
    seedApplication(context.db, { company: 'Big Example Co', role: 'Data Science Intern' });
    context.db.close();
    const plain = await cli(['queue', 'rescreen', '--json']);
    assert.deepEqual(JSON.parse(plain.out).results.map((item) => item.code), ['company_size_unknown']);
    const asked = [];
    const companySize = { askJev: async (question, { company }) => { asked.push(company); return { probability: 0.05 }; } };
    const decided = await cli(['queue', 'rescreen', '--decide-sizes', '--json'], { review: { companySize } });
    const summary = JSON.parse(decided.out);
    assert.deepEqual(asked, ['Tiny Lead Example Co'], 'only the unknown company is asked');
    assert.deepEqual(summary.sizeDecisions.decided.map((item) => [item.company, item.size]), [['Tiny Lead Example Co', 'small']]);
    assert.deepEqual(summary.results.map((item) => [item.company, item.code, item.action]), [['Tiny Lead Example Co', 'company_small', 'would_withdraw']]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

// ===================================================================== (b) startup pass

test('[INT-b] the startup pass separates old identity holds and re-queues a system_failure hold once, then reports it external', async () => {
  const db = freshDb();
  insertPosting(db, { id: 'p-a' }); insertReview(db, { postingId: 'p-a', state: 'done', decision: 'not_eligible', code: 'outside_area' });
  insertPosting(db, { id: 'p-held' }); insertReview(db, { postingId: 'p-held', state: 'held', decision: 'unclear', code: 'identity_conflict', holdOwner: 'user' });
  db.prepare("INSERT INTO posting_links(left_id,right_id,kind,reason,created_at) VALUES ('p-a','p-held','conflict','synthetic contradiction',?)").run(T0);
  insertPosting(db, { id: 'p-sys' }); insertReview(db, { postingId: 'p-sys', state: 'held', decision: 'unclear', code: 'system_failure', holdOwner: 'system' });
  insertPosting(db, { id: 'p-sys2' }); insertReview(db, { postingId: 'p-sys2', state: 'held', decision: 'unclear', code: 'system_failure', holdOwner: 'system', flags: ['system_failure_requeued'] });
  const receipt = await runReview({ db, runId: 'review-int-b', owner: 'w', now: T0, budget: 0, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fakeFetcher({}), judges: { primary: fakeJudge({ tier: 'primary' }), escalation: fakeJudge({ tier: 'escalation' }) }, inputs: () => reviewInputs(), hooks: {} });
  assert.deepEqual([reviewOf(db, 'p-held').state, reviewOf(db, 'p-held').hold_owner], ['due', null], 'judged on its own, no user hold');
  assert.equal(reviewOf(db, 'p-sys').state, 'due');
  assert.ok(JSON.parse(reviewOf(db, 'p-sys').flags_json).includes('system_failure_requeued'));
  assert.equal(reviewOf(db, 'p-sys2').state, 'held', 'a second failure stays held');
  assert.deepEqual(receipt.external_failures.map((item) => item.postingId), ['p-sys2']);
  assert.equal(receipt.status, 'partial');
  assert.deepEqual(reviewOf(db, 'p-a').state, 'done', 'the settled partner keeps its decision');
});

// ===================================================================== (c) reopen authorization

test('[INT-c] deliver reads the stored rejudge authorization and the relist flag, and drops both after delivering', () => {
  const db = freshDb();
  const make = (id, { skipReason, evidence = {}, flags = [], listed = 1 }) => {
    insertPosting(db, { id, url: urlOf(id), listed });
    insertReview(db, { postingId: id, stage: 'deliver', flags });
    db.prepare('UPDATE reviews SET evidence_json=? WHERE posting_id=?').run(JSON.stringify(evidence), id);
    const app = seedApplication(db, { company: 'Example Corp', role: `Role ${id}`, status: 'withdrawn', skipReason, skipOwner: 'review' });
    db.prepare("UPDATE application_events SET source_json=? WHERE application_id=?").run(JSON.stringify({ actor: 'review-worker' }), app.id);
    db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, id);
    return app.id;
  };
  const rejudged = make('p-rejudge', { skipReason: 'outside_area', evidence: { provenance: 'automated', reopenAuthorization: { authorization: 'rejudge', at: T0, fresh: true } } });
  const relisted = make('p-relist', { skipReason: 'delisted', flags: ['authorization:relist'], listed: 0 });
  const plain = make('p-plain', { skipReason: 'outside_area', evidence: { provenance: 'automated' } });
  assert.equal(storedReopenAuthorization(db, reviewOf(db, 'p-rejudge')), 'rejudge');
  assert.equal(storedReopenAuthorization(db, reviewOf(db, 'p-relist')), 'relist');
  assert.equal(storedReopenAuthorization(db, reviewOf(db, 'p-plain')), null);
  const verdict = { decision: 'eligible', code: null, fit: { level: 'medium', note: 'synthetic' }, deadline: { kind: 'none' } };
  const policy = { ...SCREENING_POLICY };
  for (const id of ['p-rejudge', 'p-relist', 'p-plain']) deliver(db, { postingId: id, verdict, fence: claimItem(db, id, { owner: 'w', now: T0 }), now: T0, policy });
  const status = (id) => db.prepare('SELECT status FROM applications WHERE id=?').get(id).status;
  assert.deepEqual([status(rejudged), status(relisted), status(plain)], ['lead', 'lead', 'withdrawn']);
  assert.equal(JSON.parse(reviewOf(db, 'p-rejudge').evidence_json).reopenAuthorization, undefined, 'the authorization is not written back');
  assert.ok(!JSON.parse(reviewOf(db, 'p-relist').flags_json).includes('authorization:relist'), 'the relist flag is single-use');
});

// ===================================================================== (d) direction pass with anyFunctionCompanies

test('[INT-d] the startup direction pass honours anyFunctionCompanies for title rules and software-only labels', () => {
  const db = freshDb();
  const lead = (id, company, title, fn) => {
    insertPosting(db, { id, company, title, url: urlOf(id) });
    insertReview(db, { postingId: id, state: 'done', decision: 'eligible', stage: 'deliver' });
    db.prepare('UPDATE reviews SET evidence_json=? WHERE posting_id=?').run(JSON.stringify({ provenance: 'automated', function: fn, fit: { level: 'medium', note: 'x' } }), id);
    const app = seedApplication(db, { company, role: title });
    db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, id);
    return app.id;
  };
  const anyClaims = lead('p-any-claims', 'Any Function Example Co', 'Claims Operations Intern', 'operations');
  const anySwe = lead('p-any-swe', 'Any Function Example Co', 'Platform Engineer Intern', 'software_engineering');
  const otherClaims = lead('p-other-claims', 'Other Example Co', 'Claims Operations Intern', 'operations');
  const otherSwe = lead('p-other-swe', 'Other Example Co', 'Platform Engineer Intern', 'software_engineering');
  const direction = directionRules({ block: ['claims'], anyFunctionCompanies: ['Any Function Example Co'] });
  applyRoleDirection(db, { now: T0, policy: { ...SCREENING_POLICY, direction, companyAliases: {} } });
  const status = (id) => db.prepare('SELECT status FROM applications WHERE id=?').get(id).status;
  assert.deepEqual([status(anyClaims), status(anySwe), status(otherClaims), status(otherSwe)], ['lead', 'lead', 'withdrawn', 'withdrawn']);
  // The pass itself must see the company: an any-function lead is not even claimed and re-delivered.
  for (const id of ['p-any-claims', 'p-any-swe']) assert.equal(db.prepare('SELECT COUNT(*) n FROM review_log WHERE posting_id=?').get(id).n, 0, `${id} is left alone`);
});

// ===================================================================== (e) place question

test('[INT-e] the Jev split place question is the default own-requisition wording', () => {
  assert.equal(JEV_SPLIT_QUESTIONS.place, DEFAULT_PLACE_QUESTION);
});

// ===================================================================== (f) certain drops at ingest

test('[INT-f] ingest uses the classifier certain-drop set: a known-small company is counted only for unknown postings', () => {
  assert.equal(DEFAULT_CERTAIN_DROP_CODES, CERTAIN_DROP_CODES);
  const db = freshDb();
  const policy = { ...SCREENING_POLICY, companySizes: companySizes({ small: ['Tiny Example Co'] }) };
  const counts = ingestBatch(db, { runId: 'scan-f', source: 'greenhouse', partition: 'greenhouse:tinyexample', now: T0, policy, profile: PROFILE,
    records: [record({ sourceId: '9300001', company: 'Tiny Example Co', url: urlOf('9300001') })] });
  assert.deepEqual([counts.stored, counts.countedOnly, counts.countedOnlyBy], [0, 1, { company_small: 1 }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM postings').get().n, 0, 'nothing stored');
});

// ===================================================================== (g) cap and dedupe passes select open work

test('[INT-g] the dedupe and cap passes leave settled history alone; a non-judged cap release carries cap_release', async () => {
  const db = freshDb();
  // A submitted application and a settled, unrelated rejection that would match it as a duplicate.
  const submitted = seedApplication(db, { company: 'Example Corp', role: 'Data Science Intern', status: 'applied', jobUrl: urlOf('9400001'), appliedAt: at(-30) });
  // The submitted application owns its own posting; this is another listing of the same requisition.
  insertPosting(db, { id: 'p-settled', url: 'https://boards.greenhouse.io/examplecorp/jobs/9400001' });
  const { submittedDuplicate } = await import('../../src/funnel/identity.mjs');
  assert.ok(submittedDuplicate(db, db.prepare("SELECT * FROM postings WHERE id='p-settled'").get(), {}), 'precondition: it matches the submitted application');
  insertReview(db, { postingId: 'p-settled', state: 'done', decision: 'not_eligible', code: 'outside_area', stage: 'deliver' });
  const before = JSON.stringify(reviewOf(db, 'p-settled'));
  suppressSubmittedDuplicates(db, { now: T0, policy: SCREENING_POLICY });
  assert.equal(JSON.stringify(reviewOf(db, 'p-settled')), before, 'a settled review is not rewritten by the dedupe pass');
  assert.ok(submitted.id);
  // A cap settlement without a kept verdict: released by the cap pass as a fresh fetch, authorized cap_release.
  insertPosting(db, { id: 'p-capped', company: 'Released Example Co', url: urlOf('9400002') });
  insertReview(db, { postingId: 'p-capped', state: 'done', decision: 'not_eligible', code: 'company_cap', stage: 'deliver' });
  applyCompanyCap(db, { now: T0, policy: { ...SCREENING_POLICY, companyCap: { max: 5, windowDays: 90 } } });
  const released = reviewOf(db, 'p-capped');
  assert.deepEqual([released.state, released.stage], ['due', 'fetch']);
  assert.equal(JSON.parse(released.evidence_json).reopenAuthorization.authorization, 'cap_release');
  const log = db.prepare("SELECT payload_json FROM review_log WHERE posting_id='p-capped'").all().map((row) => JSON.parse(row.payload_json));
  assert.ok(log.some((item) => item.action === 'company_cap_restored' && item.authorization === 'cap_release'));
});

// ===================================================================== (h) receipt consumers

test('[INT-h] the nightly summary line and the zh report show the new receipt fields and tolerate old receipts', () => {
  const scan = { runId: 'scan-1', status: 'ok', counts: { raw: 120, stored: 7, countedOnly: 113 },
    ingest: [{ source: 'greenhouse', partition: 'greenhouse:examplecorp', fetched: 120, stored: 7, countedOnly: 113, quarantined: 0, elapsedMs: 12 }] };
  const review = { kind: 'review', run_id: 'review-1', status: 'partial', stop_reason: 'jev_unavailable', counts: { judged: 5, eligible: 2 },
    backlog: { actionable_due: 3, held: 1 }, wallStarted: T0, wallFinished: at(0.01), errors: ['Jev HTTP 503'] };
  const daily = { kind: 'daily', run_id: 'daily-1', status: 'partial', stages: [{ name: 'scan', receipt: scan }, { name: 'review', receipt: review }] };
  assert.equal(nightlySummary(daily),
    'daily-1: status partial; fetched 120, stored 7 (counted only 113); judged 5, eligible 2; due left 3; holds 1; stop reason jev_unavailable (Jev unavailable)');
  assert.match(nightlySummary(daily, { lang: 'zh' }), /状态 partial；抓取 120，入库 7（只计数 113）；判定 5，合格 2；剩余待审 3；挂起 1；停止原因 jev_unavailable（?.*Jev 不可用/);
  for (const code of ['unfinished', 'external_failure', 'adapter_failure', 'company_size_unavailable']) assert.match(nightlySummary({ ...review, stop_reason: code }), new RegExp(code));
  assert.match(nightlySummary({ run_id: 'old', status: 'ok', counts: { attempts: 1 } }), /old: status ok; fetched 0, stored 0 .* due left \?; holds \?; stop reason none/);
  const db = freshDb();
  const report = reviewReport(db, { receipt: review, sourceReceipts: [scan], lang: 'zh' });
  assert.match(report, /抓取 120，入库 7/);
  assert.match(report, /## 抓取与入库\n- greenhouse greenhouse:examplecorp: 120 \/ 7 \/ 113/);
  assert.match(report, /停止原因: jev_unavailable — Jev 不可用/);
  assert.match(report, /实际时间/);
  assert.doesNotThrow(() => reviewReport(db, { receipt: { run_id: 'old', status: 'ok' }, sourceReceipts: [{ sources: [] }] }));
});
