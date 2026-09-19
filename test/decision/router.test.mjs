import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../src/decision/router.mjs';
import { configuredDecisionAdapters } from '../../src/commands/email.mjs';

test('waitlisted Jev is never called and deterministic rules handle known email', async () => {
  let calls = 0;
  const result = await decide({ kind: 'email-classification', text: 'We would like to schedule an interview' }, {
    jev: { accessState: 'waitlisted', decide: async () => { calls += 1; } },
  });
  assert.equal(calls, 0);
  assert.equal(result.decision.classification, 'interview');
  assert.equal(result.engine, 'rules');
});

test('shadow Jev records its candidate and falls back to the configured structured LLM', async () => {
  let llmCalls = 0;
  const result = await decide({ kind: 'email-classification', text: 'Ambiguous recruiting update' }, {
    jev: { accessState: 'enabled', mode: 'shadow', threshold: 0.8, decide: async () => ({ classification: 'assessment', confidence: 0.97 }) },
    structuredLlm: async () => { llmCalls += 1; return { classification: 'offer', confidence: 1 }; },
  });
  assert.equal(result.decision.classification, 'offer');
  assert.equal(result.engine, 'structured-llm');
  assert.equal(result.shadow.classification, 'assessment');
  assert.equal(result.applied, true);
  assert.equal(llmCalls, 1);
});

test('low-confidence and malformed Jev decisions fall back to the configured structured LLM', async () => {
  for (const jevDecision of [{ classification: 'offer', confidence: 0.3 }, { classification: 'not-a-category', confidence: 0.99 }]) {
    let llmCalls = 0;
    const result = await decide({ kind: 'email-classification', text: 'Ambiguous' }, {
      jev: { accessState: 'enabled', mode: 'active', threshold: 0.8, decide: async () => jevDecision },
      structuredLlm: async () => { llmCalls += 1; return { classification: 'application_confirmation', confidence: 0.91 }; },
    });
    assert.equal(result.engine, 'structured-llm');
    assert.equal(result.decision.classification, 'application_confirmation');
    assert.equal(result.applied, true);
    assert.equal(llmCalls, 1);
  }
});

test('configured structured LLM is the default semantic engine when Jev is unavailable', async () => {
  let llmCalls = 0;
  const result = await decide({ kind: 'email-classification', text: 'Ambiguous' }, {
    structuredLlm: async () => { llmCalls += 1; return { classification: 'offer', confidence: 0.93 }; },
  });
  assert.equal(result.engine, 'structured-llm');
  assert.equal(result.decision.classification, 'offer');
  assert.equal(result.applied, true);
  assert.equal(llmCalls, 1);
});

test('Jev errors and confident unknown decisions fall back to the configured structured LLM', async () => {
  for (const decideJev of [
    async () => { throw new Error('Jev unavailable'); },
    async () => ({ classification: 'unknown', confidence: 0.99 }),
  ]) {
    let llmCalls = 0;
    const result = await decide({ kind: 'email-classification', text: 'Administrative update' }, {
      jev: { accessState: 'enabled', mode: 'active', threshold: 0.8, decide: decideJev },
      structuredLlm: async () => { llmCalls += 1; return { classification: 'assessment', confidence: 0.9 }; },
    });
    assert.equal(result.engine, 'structured-llm');
    assert.equal(result.decision.classification, 'assessment');
    assert.equal(result.applied, true);
    assert.equal(llmCalls, 1);
  }
});

test('invalid low-confidence or unavailable structured LLM decisions require manual review', async () => {
  for (const structuredLlm of [
    async () => ({ classification: 'offer', confidence: 0.2 }),
    async () => ({ classification: 'not-a-category', confidence: 0.99 }),
    async () => { throw new Error('provider unavailable'); },
  ]) {
    const result = await decide({ kind: 'email-classification', text: 'Administrative update' }, {
      structuredLlm,
      structuredLlmThreshold: 0.8,
    });
    assert.equal(result.engine, 'manual-review');
    assert.equal(result.decision.classification, 'unknown');
    assert.equal(result.applied, false);
  }
});

test('a confident Jev decision remains primary and never calls the structured LLM', async () => {
  let llmCalls = 0;
  const result = await decide({ kind: 'email-classification', text: 'Administrative update' }, {
    jev: { accessState: 'enabled', mode: 'active', threshold: 0.8, decide: async () => ({ classification: 'offer', confidence: 0.99 }) },
    structuredLlm: async () => { llmCalls += 1; return { classification: 'assessment', confidence: 1 }; },
  });
  assert.equal(result.engine, 'jev');
  assert.equal(result.decision.classification, 'offer');
  assert.equal(result.applied, true);
  assert.equal(llmCalls, 0);
});

test('configured email adapters expose the OpenAI-compatible provider as the LLM fallback', async () => {
  let request;
  const adapters = configuredDecisionAdapters({
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://model.example/v1',
      model: 'decision-model',
      secretRef: 'env:MODEL_API_KEY',
      threshold: 0.8,
    },
    jev: { accessState: 'unavailable' },
  }, async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ classification: 'interview', confidence: 0.94 }) } }] }), { status: 200 });
  }, { MODEL_API_KEY: 'runtime-secret' });

  const result = await adapters.structuredLlm({ kind: 'email-classification', text: 'Could we find time to speak?' });
  assert.deepEqual(result, { classification: 'interview', confidence: 0.94 });
  assert.equal(adapters.structuredLlmThreshold, 0.8);
  assert.equal(request.url, 'https://model.example/v1/chat/completions');
  assert.equal(request.init.headers.authorization, 'Bearer runtime-secret');
});
