import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevAdapter } from '../../src/decision/jev.mjs';

test('Jev adapter sends the v1 state/questions contract and reads a Choice answer', async () => {
  let request;
  const adapter = createJevAdapter({
    accessState: 'enabled',
    mode: 'active',
    model: 'jev-latest',
    secretRef: 'env:TYPESAFE_API_KEY',
  }, async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      async json() {
        return {
          model: 'jev-latest',
          answers: {
            classification: {
              type: 'choice',
              choice: 'interview',
              probabilities: { interview: 0.91, unknown: 0.09 },
              confidence: 0.82,
            },
          },
          usage: { input_tokens: 80, output_tokens: 12 },
        };
      },
    };
  }, { TYPESAFE_API_KEY: 'secret-value' });

  const decision = await adapter.decide({ kind: 'email-classification', text: 'Please record a short video response.' });
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.options.headers.authorization, 'Bearer secret-value');
  assert.equal(request.body.state, 'Please record a short video response.');
  assert.equal(request.body.model, 'jev-latest');
  assert.equal(request.body.questions.classification.type, 'choice');
  assert.equal(request.body.questions.classification.criteria.interview.length > 10, true);
  assert.equal('question' in request.body, false);
  assert.equal('choices' in request.body, false);
  assert.deepEqual(decision, {
    classification: 'interview', confidence: 0.82, usage: { input_tokens: 80, output_tokens: 12 },
  });
});

test('Jev adapter rejects malformed Choice responses instead of fabricating a rule result', async () => {
  const adapter = createJevAdapter({
    accessState: 'enabled', secretRef: 'env:TYPESAFE_API_KEY',
  }, async () => ({ ok: true, async json() { return { answers: { classification: { type: 'choice' } } }; } }), {
    TYPESAFE_API_KEY: 'secret-value',
  });
  await assert.rejects(() => adapter.decide({ kind: 'email-classification', text: 'Update' }), /invalid Jev classification response/i);
});

test('Jev adapter keeps credentials environment-only', async () => {
  const adapter = createJevAdapter({ accessState: 'enabled', secretRef: 'literal-secret' }, async () => {
    throw new Error('fetch should not run');
  }, {});
  await assert.rejects(() => adapter.decide({ kind: 'email-classification', text: 'Update' }), /env:VARIABLE/);
});

test('Jev adapter refuses to send a TypeSafe key to a different origin', async () => {
  let calls = 0;
  const adapter = createJevAdapter({
    accessState: 'enabled', baseUrl: 'https://attacker.example/v1/systemone', secretRef: 'env:TYPESAFE_API_KEY',
  }, async () => { calls += 1; }, { TYPESAFE_API_KEY: 'secret-value' });
  await assert.rejects(() => adapter.decide({ kind: 'email-classification', text: 'Update' }), /api\.typesafe\.ai/);
  assert.equal(calls, 0);
});

test('Jev adapter retries documented transient overload responses and not authentication failures', async () => {
  let transientCalls = 0;
  const transient = createJevAdapter({
    accessState: 'enabled', secretRef: 'env:TYPESAFE_API_KEY', retryDelaysMs: [0],
  }, async () => {
    transientCalls += 1;
    if (transientCalls === 1) return { ok: false, status: 529 };
    return { ok: true, async json() { return { answers: { classification: { type: 'choice', choice: 'unknown', confidence: 0.91 } } }; } };
  }, { TYPESAFE_API_KEY: 'secret-value' });
  assert.equal((await transient.decide({ kind: 'email-classification', text: 'Update' })).classification, 'unknown');
  assert.equal(transientCalls, 2);

  let authCalls = 0;
  const unauthorized = createJevAdapter({
    accessState: 'enabled', secretRef: 'env:TYPESAFE_API_KEY', retryDelaysMs: [0, 0],
  }, async () => { authCalls += 1; return { ok: false, status: 401 }; }, { TYPESAFE_API_KEY: 'secret-value' });
  await assert.rejects(() => unauthorized.decide({ kind: 'email-classification', text: 'Update' }), /HTTP 401/);
  assert.equal(authCalls, 1);
});
