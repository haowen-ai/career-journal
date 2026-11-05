// The Claude API judge runner (src/review/claude-judge.mjs): the codexExecAdapter contract over the official SDK,
// its failure codes, the worker's breaker on an outage, and a review run with a Claude primary and no Jev at all.
// Synthetic data only. Every client is a fake: no test reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APIError } from '@anthropic-ai/sdk';
import { freshDb, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0 } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, SUMMER_CHICAGO, judgment, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';
import { VERSION as CLAUDE_SDK_VERSION } from '@anthropic-ai/sdk/version';
import { apiSchema, claudeApiAdapter } from '../../src/review/claude-judge.mjs';
import { createJudgeAdapters } from '../../src/review/judge.mjs';
import { buildJudgeRequest, buildForcedDecisionRequest, JUDGMENT_SCHEMA_PATH } from '../../src/review/prompt.mjs';
import { dependencyHash } from '../../src/review/inputs.mjs';
import { runReview } from '../../src/review/worker.mjs';
import { createSecondOpinion } from '../../src/review/second-opinion.mjs';
import { createJevSplit } from '../../src/review/jev-split.mjs';
import { createCompanySizeResolver } from '../../src/review/company-size-runtime.mjs';

const urlOf = (id) => `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
const CLAUDE = Object.freeze({ runner: 'claude', model: 'claude-opus-5-5', effort: 'low' });
const ESCALATION = Object.freeze({ runner: 'codex', model: 'codex-escalation-test', codexHome: '/nonexistent/codex-home' });

// A fake SDK client: messages.create(params, options) answers from `answer(params)`; a thrown value is thrown.
function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params, options) {
        calls.push({ params, options });
        const value = await answer(params, calls.length);
        if (value instanceof Error) throw value;
        if (value?.message) return value.message;
        return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 } };
      },
    },
  };
}
const apiError = (status, type) => APIError.generate(status, { type: 'error', error: { type, message: 'synthetic body text sk-ant-should-not-leak' } }, undefined, new Headers());
const adapter = (client, extra = {}) => claudeApiAdapter({ ...CLAUDE, tier: 'primary', client, ...extra });

async function offline(run) {
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => { attempts.push(String(url)); throw new Error(`network access in a test: ${url}`); };
  try { return await run(); } finally { globalThis.fetch = original; assert.deepEqual(attempts, [], 'no network request is made'); }
}

async function request(judge, { forced = false } = {}) {
  const inputs = await reviewInputs();
  const base = await buildJudgeRequest({ posting: { id: 'p-1', company: 'Example Corp', title: 'Data Science Intern' }, snapshot: { text: SNAPSHOTS.eligible },
    sections: [], inputs, adapter: judge, tier: judge.tier });
  return forced ? buildForcedDecisionRequest(base, 'Is the synthetic term acceptable?') : base;
}

test('[claude] one structured call: stable rules cached in system, the posting in the user turn, adaptive thinking, effort, no sampling params', async () => {
  const client = fakeClient(() => JUDGMENTS.eligible);
  const judge = adapter(client);
  assert.deepEqual([judge.runner, judge.model, judge.tier, judge.effort, judge.maxTransportRetries], ['claude', 'claude-opus-5-5', 'primary', 'low', 2]);
  await judge.ready;
  const req = await request(judge);
  const result = await offline(() => judge.judge(req, { attemptId: 'a-1', outputPath: '/nonexistent/unused.json' }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, JUDGMENTS.eligible);
  assert.equal(result.usage.cache_read_input_tokens, 80);
  const [{ params, options }] = client.calls;
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.max_tokens, 4096);
  assert.deepEqual(params.thinking, { type: 'adaptive' });
  assert.equal(params.output_config.effort, 'low');
  assert.equal(params.output_config.format.type, 'json_schema');
  for (const key of ['temperature', 'top_p', 'top_k']) assert.equal(key in params, false, key);
  assert.equal(JSON.stringify(params).includes('budget_tokens'), false);
  assert.equal(params.system.length, 1);
  assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral' });
  assert.match(params.system[0].text, /Screening rules/);
  assert.doesNotMatch(params.system[0].text, /<<<POSTING/);
  assert.equal(params.messages.length, 1);
  assert.match(params.messages[0].content, /^<<<POSTING/);
  assert.match(params.messages[0].content, /POSTING>>>$/);
  // The system text plus the user turn is exactly the prompt the codex primary gets on stdin.
  assert.equal(`${params.system[0].text}\n\n${params.messages[0].content}`, req.prompt);
  assert.deepEqual([options.timeout, options.maxRetries], [120000, 2]);
});

test('[claude] the API schema keeps types, enums and required fields; constraints the API lacks move to the description', () => {
  const judgmentSchema = JSON.parse(readFileSync(JUDGMENT_SCHEMA_PATH, 'utf8'));
  const sent = apiSchema(judgmentSchema);
  const text = JSON.stringify(sent);
  assert.equal(text.includes('"pattern"'), false);
  assert.equal(text.includes('"$schema"'), false);
  const walk = (node, visit) => { if (node && typeof node === 'object') { visit(node); Object.values(node).forEach((child) => walk(child, visit)); } };
  walk(sent, (node) => { if (Array.isArray(node.type)) assert.fail(`type array left: ${JSON.stringify(node).slice(0, 80)}`); });
  walk(sent, (node) => { if (node.type === 'object') assert.equal(node.additionalProperties, false); });
  assert.deepEqual(sent.required, judgmentSchema.required);
  const criteria = sent.properties.criteria.items.properties;
  assert.deepEqual([criteria.status.type, criteria.status.enum], ['string', ['meets', 'conflicts', 'unclear']]);
  const precision = sent.properties.deadline.properties.precision;
  assert.deepEqual(precision.anyOf, [{ type: 'string', enum: ['date', 'datetime'] }, { type: 'null' }]);
});

test('[claude] the forced-decision request uses the forced schema and validation', async () => {
  const client = fakeClient(() => ({ decision: 'eligible', assumption: 'the synthetic term is the upcoming summer' }));
  const judge = adapter(client);
  const result = await judge.judge(await request(judge, { forced: true }), { attemptId: 'a-2' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(client.calls[0].params.output_config.format.schema.required, ['decision', 'assumption']);
  assert.match(client.calls[0].params.messages[0].content, /Open question to decide:/);
});

test('[claude] failures carry a stable code and redacted text: auth, billing, rate_limited, unavailable, invalid_output, refused', async () => {
  const cases = [
    [apiError(401, 'authentication_error'), 'error', 'auth'],
    [apiError(403, 'permission_error'), 'error', 'auth'],
    [apiError(402, 'billing_error'), 'error', 'billing'],
    [apiError(400, 'billing_error'), 'error', 'billing'],
    [apiError(429, 'rate_limit_error'), 'error', 'rate_limited'],
    [apiError(500, 'api_error'), 'error', 'unavailable'],
    [apiError(529, 'overloaded_error'), 'error', 'unavailable'],
    [APIError.generate(undefined, undefined, 'socket hang up', undefined), 'error', 'unavailable'],
    [apiError(404, 'not_found_error'), 'error', 'http_404'],
    ['not json at all', 'invalid', 'invalid_output'],
    [{ alternatives: 'wrong shape' }, 'invalid', 'invalid_output'],
    [{ message: { stop_reason: 'refusal', content: [], usage: {} } }, 'refused', 'refused'],
    [{ message: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"alternatives": [' }], usage: {} } }, 'invalid', 'invalid_output'],
  ];
  for (const [answer, status, code] of cases) {
    const judge = adapter(fakeClient(() => answer));
    const result = await judge.judge(await request(judge), { attemptId: 'a-3' });
    assert.deepEqual([result.status, result.errorCode, result.output], [status, code, null], `${code}: ${result.error}`);
    assert.equal(typeof result.error, 'string');
    assert.doesNotMatch(result.error, /sk-ant|synthetic body/, 'no response body in the error');
  }
});

test('[claude] the key is resolved from secretRef once, never printed; a missing key is auth with no API call', async () => {
  const seen = [];
  const made = [];
  const resolveSecret = async (ref) => { seen.push(ref); return { value: 'sk-ant-synthetic-key' }; };
  const client = fakeClient(() => JUDGMENTS.eligible);
  const judge = claudeApiAdapter({ ...CLAUDE, tier: 'escalation', secretRef: 'keychain:career-journal-anthropic:example', resolveSecret, maxRetries: 5, timeoutMs: 9000,
    createClient: (options) => { made.push(options); return client; } });
  const req = await request(judge);
  for (const id of ['a-4', 'a-5']) assert.equal((await judge.judge(req, { attemptId: id })).status, 'ok');
  assert.deepEqual(seen, ['keychain:career-journal-anthropic:example']);
  assert.deepEqual(made, [{ apiKey: 'sk-ant-synthetic-key', maxRetries: 5, timeout: 9000 }]);

  const missing = claudeApiAdapter({ ...CLAUDE, tier: 'primary', secretRef: 'keychain:career-journal-anthropic:example',
    resolveSecret: async () => { throw new Error('macOS Keychain credential is unavailable for service career-journal-anthropic'); },
    createClient: () => assert.fail('no client without a key') });
  const result = await missing.judge(req, { attemptId: 'a-6' });
  assert.deepEqual([result.status, result.errorCode, result.error], ['error', 'auth', 'Claude API key unavailable']);
});

test('[claude] model, effort and SDK version are in the judge dependency hash', async () => {
  const client = fakeClient(() => JUDGMENTS.eligible);
  const hashes = [];
  for (const extra of [{}, { model: 'claude-sonnet-5-5' }, { effort: 'medium' }]) {
    const judge = adapter(client, extra);
    hashes.push((await request(judge)).deps.parts.model);
  }
  assert.equal(new Set(hashes).size, 3);
  const judge = adapter(client);
  await judge.ready;
  assert.equal(judge.cliVersion, `anthropic-sdk-${CLAUDE_SDK_VERSION}`);
  assert.equal((await request(judge)).deps.parts.model, dependencyHash({ runner: 'claude', model: 'claude-opus-5-5', tier: 'primary', effort: 'low', cliVersion: judge.cliVersion }));
  assert.throws(() => claudeApiAdapter({ runner: 'claude', tier: 'primary' }), /model/);
  assert.throws(() => adapter(client, { effort: 'extreme' }), /effort/);
});

test('[claude] createJudgeAdapters builds a Claude primary next to a Codex escalation; no Jev is created without secondOpinion', () => {
  const runImpl = async () => { throw new Error('the factory test never runs Codex'); };
  const policy = { ...REVIEW_POLICY, judge: { primary: { ...CLAUDE, client: fakeClient(() => ({})) }, escalation: { ...ESCALATION, runImpl } } };
  const adapters = createJudgeAdapters(policy);
  assert.deepEqual([adapters.primary.runner, adapters.primary.model, adapters.primary.tier], ['claude', 'claude-opus-5-5', 'primary']);
  assert.deepEqual([adapters.escalation.runner, adapters.escalation.model], ['codex', 'codex-escalation-test']);
  assert.equal(createSecondOpinion(policy), undefined);
  assert.equal(createJevSplit(policy), undefined);
  const both = createJudgeAdapters({ judge: { primary: { ...CLAUDE, client: {} }, escalation: { ...CLAUDE, model: 'claude-fable-5-1', client: {} } } });
  assert.deepEqual([both.escalation.runner, both.escalation.model, both.escalation.tier], ['claude', 'claude-fable-5-1', 'escalation']);
});

// ------------------------------------------------------------------ worker

const retitled = (snapshot, title) => snapshot.replace(snapshotTitle(snapshot), title);
const OUTSIDE_AREA_TEXT = retitled(SNAPSHOTS.eligible, 'Data Science Intern Mill Creek').replace('Location: Chicago, IL', 'Location: Mill Creek, TX');
const OUTSIDE_AREA = judgment({ alternatives: [{ term: SUMMER_CHICAGO.term, offices: [{ place: 'Mill Creek, TX', area: 'outside', quote: 'Location: Mill Creek, TX' }], remote: { scope: 'none', quote: null } }] });
const POSTINGS = Object.freeze({
  'p-eligible': { text: SNAPSHOTS.eligible, primary: JUDGMENTS.eligible },
  'p-outside': { text: OUTSIDE_AREA_TEXT, primary: OUTSIDE_AREA },
  'p-degree': { text: SNAPSHOTS.undergradOnly, primary: JUDGMENTS.undergradOnly, escalation: JUDGMENTS.undergradOnly },
  'p-unclear': { text: SNAPSHOTS.missingFact, primary: JUDGMENTS.missingFact, escalation: JUDGMENTS.missingFact },
});
function queue(db, ids) {
  const pages = {};
  for (const id of ids) {
    insertPosting(db, { id, url: urlOf(id), company: 'Example Corp', title: snapshotTitle(POSTINGS[id].text) });
    insertReview(db, { postingId: id, stage: 'fetch' });
    pages[urlOf(id)] = page(urlOf(id), POSTINGS[id].text);
  }
  return pages;
}
const postingOf = (params) => Object.keys(POSTINGS).find((id) => params.messages[0].content.includes(`"id":"${id}"`));
const policy = { ...REVIEW_POLICY, judge: { primary: { ...CLAUDE }, escalation: { ...ESCALATION } } };
const run = (db, pages, judges) => offline(() => runReview({ db, runId: 'review-claude', owner: 'worker-a', now: T0, budget: 20, deadlineMs: 600_000, attemptDir: null,
  sleep: async () => {}, fetcher: fakeFetcher(pages), judges, inputs: () => reviewInputs({ policy }), hooks: {} }));

test('[claude] a review run with a Claude primary, a Codex escalation and no Jev: eligible, not_eligible and unclear→escalation', async () => {
  const db = freshDb();
  const pages = queue(db, Object.keys(POSTINGS));
  const client = fakeClient((params) => POSTINGS[postingOf(params)].primary);
  // The escalation tier settles the held question with a forced decision (no Jev verifies it).
  const forced = { decision: 'not_eligible', assumption: 'synthetic: the unconfirmed cluster skill is required' };
  const escalation = fakeJudge({ tier: 'escalation', answers: (req) => ({ output: req.forceDecision ? forced : POSTINGS[req.postingId].escalation }) });
  const receipt = await run(db, pages, { primary: adapter(client), escalation });
  const outcome = (id) => { const row = reviewOf(db, id); return [row.state, row.decision, row.code]; };
  assert.deepEqual(outcome('p-eligible'), ['done', 'eligible', null]);
  assert.deepEqual(outcome('p-outside'), ['done', 'not_eligible', 'outside_area']);
  assert.deepEqual(outcome('p-degree'), ['done', 'not_eligible', 'degree']);
  assert.deepEqual(outcome('p-unclear')[0], 'done');
  assert.equal(outcome('p-unclear')[1], 'not_eligible');
  assert.deepEqual(receipt.model_decided.map((item) => [item.postingId, item.decision]), [['p-unclear', 'not_eligible']]);
  assert.equal(client.calls.length, 4, 'one Claude call per posting');
  assert.deepEqual(escalation.calls.map((call) => `${call.request.postingId}${call.request.forceDecision ? ':forced' : ''}`).sort(), ['p-degree', 'p-unclear', 'p-unclear:forced']);
  assert.equal(receipt.counts.secondOpinion, undefined);
  assert.equal(receipt.jev, undefined);
  assert.deepEqual(receipt.errors, []);
  const runners = db.prepare("SELECT runner,tier,state FROM attempts WHERE run_id='review-claude' ORDER BY tier,posting_id").all().map((row) => `${row.tier}:${row.runner}:${row.state}`);
  assert.deepEqual(runners, [...Array(3).fill('escalation:fake:responded'), ...Array(4).fill('primary:claude:responded')]);
});

test('[claude] an API outage (402 billing) stops the run after 3 identical failures: adapter_failure, postings stay due, no Codex storm', async () => {
  const db = freshDb();
  const ids = ['p-eligible', 'p-outside', 'p-degree', 'p-unclear'];
  const pages = queue(db, ids);
  const client = fakeClient(() => apiError(402, 'billing_error'));
  const escalation = fakeJudge({ tier: 'escalation', answers: () => assert.fail('no escalation call on a primary outage') });
  const receipt = await run(db, pages, { primary: adapter(client), escalation });
  assert.equal(client.calls.length, 3);
  assert.equal(escalation.calls.length, 0);
  assert.deepEqual([receipt.status, receipt.stop_reason], ['partial', 'adapter_failure']);
  assert.ok(receipt.errors.some((error) => /\(billing\).*Claude API HTTP 402 billing_error/.test(error)), receipt.errors.join('\n'));
  for (const id of ids) assert.equal(reviewOf(db, id).state, 'due', id);
});

// ------------------------------------------------------------------ company size

test('[claude] with a Claude primary and no Jev, company size is one structured Claude call per company', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cj-claude-size-'));
  try {
    await writeFile(path.join(dir, 'company-size.json'), JSON.stringify({ large: [], small: [] }));
    const client = fakeClient((params) => (params.messages[0].content.includes('Big Example Co')
      ? { size: 'large', reason: 'synthetic: a listed company with many offices' } : { size: 'small', reason: 'synthetic: about forty staff' }));
    const runImpl = async () => assert.fail('no codex call with a Claude primary');
    const resolve = createCompanySizeResolver({ profileDir: dir, reviewPolicy: { ...REVIEW_POLICY, judge: { primary: { ...CLAUDE }, escalation: { ...ESCALATION } } }, runImpl, claudeClient: client });
    const result = await offline(() => resolve({ companies: ['Big Example Co', 'Tiny Example Co'], now: T0 }));
    assert.deepEqual(result.failed, []);
    assert.equal(client.calls.length, 2);
    const [{ params }] = client.calls;
    assert.deepEqual(params.output_config.format.schema.required, ['size', 'reason']);
    assert.equal(params.model, 'claude-opus-5-5');
    assert.equal(params.system, undefined);
    const saved = JSON.parse(await readFile(path.join(dir, 'company-size.json'), 'utf8')).decided;
    assert.deepEqual(saved.map((item) => [item.company, item.size, item.by]).sort(), [['Big Example Co', 'large', 'model'], ['Tiny Example Co', 'small', 'model']]);

    const down = createCompanySizeResolver({ profileDir: dir, reviewPolicy: { judge: { primary: { ...CLAUDE } } }, claudeClient: fakeClient(() => apiError(402, 'billing_error')) });
    const failed = await down({ companies: ['Other Example Co'], now: T0 });
    assert.match(failed.failed[0].error, /Claude API HTTP 402 billing_error/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
