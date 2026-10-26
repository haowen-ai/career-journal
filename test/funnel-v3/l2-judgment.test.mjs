// Lane L2 — R3 judgment semantics, clause validation, escalation, judge adapter (spec section 6.3; review-v3 F3, F6, §4, §5.3; plan 7.1 #3).
// Recorded/scripted model outputs test downstream logic only; evaluating a real prompt/model on adjudicated snapshots
// is a separate private step (see the private acceptance list).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../../test-utils/funnel-v3.mjs';
import { FACTS, REVIEW_POLICY, SNAPSHOTS, JUDGMENTS } from '../../test-utils/funnel-v3-fixtures.mjs';

const decideModule = () => load('L2', './src/review/decide.mjs', ['decide']);
const clauses = () => load('L2', './src/review/clauses.mjs', ['segmentSections', 'clauseAt', 'validateCriterion']);

async function decideOn(snapshot, judgment, tier = 'escalation') {
  const { decide } = await decideModule();
  return decide({ snapshotText: SNAPSHOTS[snapshot], judgment: JUDGMENTS[judgment], facts: FACTS, policy: REVIEW_POLICY, tier });
}

test('[L2] sections come from headings, not from the model', async () => {
  const { segmentSections } = await clauses();
  const kinds = segmentSections(SNAPSHOTS.eligible).map((section) => section.kind);
  assert.ok(kinds.includes('required'));
  assert.ok(kinds.includes('preferred'));
  assert.ok(kinds.includes('responsibilities'));
  const minimum = segmentSections(SNAPSHOTS.undergradOnly).map((section) => section.kind);
  assert.ok(minimum.includes('required'), '"Minimum Qualifications" counts as required');
});

test('[L2] clauseAt returns the whole bullet around a quote', async () => {
  const { clauseAt } = await clauses();
  const text = SNAPSHOTS.orClause;
  const clause = clauseAt(text, text.indexOf('Scala'));
  assert.equal(clause.text.trim(), '• Experience programming in Python or Scala.');
});

test('[L2] eligible: allowed office, 2027 term, no confirmed conflict → eligible with fit', async () => {
  const result = await decideOn('eligible', 'eligible', 'primary');
  assert.equal(result.decision, 'eligible');
  assert.equal(result.escalate, false);
  assert.equal(result.fit.level, 'high');
});

test('[L2] an OR clause quoted only on the branch the candidate lacks is not a conflict', async () => {
  for (const judgment of ['orClauseCppOnly', 'orClauseWholeButOneBranch']) {
    const result = await decideOn('orClause', judgment);
    assert.notEqual(result.decision, 'not_eligible', judgment);
  }
});

test('[L2] "or equivalent practical experience" never yields not_eligible; it asks the user', async () => {
  const result = await decideOn('equivalent', 'equivalent');
  assert.equal(result.decision, 'unclear');
  assert.equal(result.nextAction, 'user_review');
});

test('[L2] a preferred-section quote mislabeled required by the model never blocks', async () => {
  const result = await decideOn('preferredMislabel', 'preferredMislabel');
  assert.equal(result.decision, 'eligible');
});

test('[L2] a conflict without a lacks/constraint fact is unclear, not not_eligible', async () => {
  const result = await decideOn('missingFact', 'missingFact');
  assert.equal(result.decision, 'unclear');
});

test('[L2] a quote that does not occur in the snapshot is discarded → unclear, never not_eligible', async () => {
  const result = await decideOn('eligible', 'invented');
  assert.notEqual(result.decision, 'not_eligible');
});

test('[L2] a partial-clause quote on a negative is invalid and escalates from the primary tier', async () => {
  const primary = await decideOn('undergradOnly', 'undergradOnlyPartialQuote', 'primary');
  assert.equal(primary.escalate, true);
  assert.notEqual(primary.decision, 'not_eligible');
  const escalation = await decideOn('undergradOnly', 'undergradOnlyPartialQuote', 'escalation');
  assert.notEqual(escalation.decision, 'not_eligible');
});

test('[L2] a cheap-model rejection always escalates; only a validated escalation-tier result rejects', async () => {
  const primary = await decideOn('undergradOnly', 'undergradOnly', 'primary');
  assert.equal(primary.escalate, true);
  assert.notEqual(primary.decision, 'not_eligible');
  const escalation = await decideOn('undergradOnly', 'undergradOnly', 'escalation');
  assert.equal(escalation.decision, 'not_eligible');
  const conflict = escalation.evidence.find((item) => item.confirmed);
  assert.equal(conflict.section, 'required');
  assert.match(conflict.clause, /junior undergraduate student pursuing a Bachelor's degree/);
  assert.deepEqual(conflict.factIds, ['degree']);
});

test('[L2] term/office alternatives are never cross-combined', async () => {
  for (const tier of ['primary', 'escalation']) {
    const result = await decideOn('alternatives', 'alternatives', tier);
    assert.notEqual(result.decision, 'eligible', `${tier}: Summer 2027 is in Austin and the San Jose track is a co-op`);
  }
});

test('[L2] missing positive term evidence is unclear', async () => {
  const result = await decideOn('noTerm', 'noTerm');
  assert.equal(result.decision, 'unclear');
});

test('[L2] a sales-function analyst role is a user policy call, not a rejection', async () => {
  const result = await decideOn('sales', 'sales');
  assert.equal(result.decision, 'unclear');
  assert.equal(result.nextAction, 'user_review');
});

test('[L2] fit adjustments: quant → low, general PM one level lower, eligible low fit stays eligible', async () => {
  const quant = await decideOn('eligible', 'quantLow', 'primary');
  assert.equal(quant.decision, 'eligible');
  assert.equal(quant.fit.level, 'low');
  const pm = await decideOn('eligible', 'productGeneral', 'primary');
  assert.equal(pm.fit.level, 'medium');
  const low = await decideOn('eligible', 'lowFit', 'primary');
  assert.equal(low.decision, 'eligible');
  assert.equal(low.fit.level, 'low');
});

// -------------------------------------------------------------- adapter

const adapterModule = () => load('L2', './src/review/judge.mjs', ['buildCodexArgv', 'codexExecAdapter']);

test('[L2] the Codex runner uses codex exec with an output schema, its own CODEX_HOME and no API key', async () => {
  const { buildCodexArgv } = await adapterModule();
  const { command, args, env } = buildCodexArgv({ bin: 'codex', codexHome: '/tmp/codex-home-a', model: 'model-cheap', schemaPath: '/tmp/s.json', outputPath: '/tmp/o.json', workDir: '/tmp/empty' });
  assert.equal(command, 'codex');
  assert.equal(args[0], 'exec');
  for (const flag of ['--output-schema', '--ephemeral', '--skip-git-repo-check', '--json']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('-m') + 1], 'model-cheap');
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
  assert.equal(args[args.indexOf('-o') + 1], '/tmp/o.json');
  assert.equal(args.at(-1), '-', 'prompt on stdin');
  assert.equal(env.CODEX_HOME, '/tmp/codex-home-a');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('[L2] the adapter makes exactly one invocation per call: no automatic retries; transport retries are counted', async () => {
  const { codexExecAdapter } = await adapterModule();
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cj-judge-'));
  try {
    const calls = [];
    const failing = codexExecAdapter({ bin: 'codex', codexHome: directory, model: 'm', tier: 'primary', schemaPath: path.join(directory, 's.json'), workDir: directory,
      runImpl: async (spec) => { calls.push(spec); return { exitCode: 1, stdout: '', stderr: 'rate limited' }; } });
    const failed = await failing.judge({ postingId: 'p1', prompt: 'x' }, { attemptId: 'a1', outputPath: path.join(directory, 'a1.json') });
    assert.equal(failed.status, 'error');
    assert.equal(calls.length, 1);

    const ok = codexExecAdapter({ bin: 'codex', codexHome: directory, model: 'm', tier: 'primary', schemaPath: path.join(directory, 's.json'), workDir: directory,
      runImpl: async (spec) => {
        await writeFile(spec.args[spec.args.indexOf('-o') + 1], JSON.stringify(JUDGMENTS.eligible));
        return { exitCode: 0, stdout: [JSON.stringify({ type: 'error', message: 'stream disconnected - retrying turn (1/5)' }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 300 } })].join('\n'), stderr: '' };
      } });
    const answered = await ok.judge({ postingId: 'p1', prompt: 'x' }, { attemptId: 'a2', outputPath: path.join(directory, 'a2.json') });
    assert.equal(answered.status, 'ok');
    assert.deepEqual(answered.output.fit, JUDGMENTS.eligible.fit);
    assert.equal(answered.transportRetries, 1);
    assert.equal(answered.usage.input_tokens, 900);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('[L2] judge configuration without model or Codex home fails loudly (no hardcoded defaults)', async () => {
  const { createJudgeAdapters } = await load('L2', './src/review/judge.mjs', ['createJudgeAdapters']);
  assert.throws(() => createJudgeAdapters({ judge: { primary: { runner: 'codex' } } }), /model|codexHome/);
});
