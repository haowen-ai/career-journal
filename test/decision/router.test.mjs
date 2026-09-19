import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../src/decision/router.mjs';

test('waitlisted Jev is never called and deterministic rules handle known email', async () => {
  let calls = 0;
  const result = await decide({ kind: 'email-classification', text: 'We would like to schedule an interview' }, {
    jev: { accessState: 'waitlisted', decide: async () => { calls += 1; } },
  });
  assert.equal(calls, 0);
  assert.equal(result.decision.classification, 'interview');
  assert.equal(result.engine, 'rules');
});

test('shadow Jev records its candidate and routes the email to manual review without using an LLM', async () => {
  let llmCalls = 0;
  const result = await decide({ kind: 'email-classification', text: 'Ambiguous recruiting update' }, {
    jev: { accessState: 'enabled', mode: 'shadow', threshold: 0.8, decide: async () => ({ classification: 'assessment', confidence: 0.97 }) },
    structuredLlm: async () => { llmCalls += 1; return { classification: 'offer', confidence: 1 }; },
  });
  assert.equal(result.decision.classification, 'unknown');
  assert.equal(result.engine, 'manual-review');
  assert.equal(result.shadow.classification, 'assessment');
  assert.equal(result.applied, false);
  assert.equal(llmCalls, 0);
});

test('low-confidence and malformed Jev decisions require manual review without using an LLM', async () => {
  for (const jevDecision of [{ classification: 'offer', confidence: 0.3 }, { classification: 'not-a-category', confidence: 0.99 }]) {
    let llmCalls = 0;
    const result = await decide({ kind: 'email-classification', text: 'Ambiguous' }, {
      jev: { accessState: 'enabled', mode: 'active', threshold: 0.8, decide: async () => jevDecision },
      structuredLlm: async () => { llmCalls += 1; return { classification: 'application_confirmation' }; },
    });
    assert.equal(result.engine, 'manual-review');
    assert.equal(result.decision.classification, 'unknown');
    assert.equal(result.applied, false);
    assert.equal(llmCalls, 0);
  }
});

test('configured structured LLM is not used when Jev is unavailable', async () => {
  let llmCalls = 0;
  const result = await decide({ kind: 'email-classification', text: 'Ambiguous' }, {
    structuredLlm: async () => { llmCalls += 1; return { classification: 'offer' }; },
  });
  assert.equal(result.engine, 'manual-review');
  assert.equal(result.applied, false);
  assert.equal(llmCalls, 0);
});

test('a confident Jev unknown remains a manual-review candidate', async () => {
  const result = await decide({ kind: 'email-classification', text: 'Administrative update' }, {
    jev: { accessState: 'enabled', mode: 'active', threshold: 0.8, decide: async () => ({ classification: 'unknown', confidence: 0.99 }) },
  });
  assert.equal(result.engine, 'manual-review');
  assert.equal(result.decision.classification, 'unknown');
  assert.equal(result.applied, false);
});
