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

test('shadow Jev records its candidate but does not apply it', async () => {
  const result = await decide({ kind: 'email-classification', text: 'Ambiguous recruiting update' }, {
    jev: { accessState: 'enabled', mode: 'shadow', threshold: 0.8, decide: async () => ({ classification: 'assessment', confidence: 0.97 }) },
    structuredLlm: async () => ({ classification: 'unknown' }),
  });
  assert.equal(result.decision.classification, 'unknown');
  assert.equal(result.engine, 'structured-llm');
  assert.equal(result.shadow.classification, 'assessment');
  assert.equal(result.applied, false);
});

test('low-confidence Jev and malformed decisions fall back to structured LLM', async () => {
  for (const jevDecision of [{ classification: 'offer', confidence: 0.3 }, { classification: 'not-a-category', confidence: 0.99 }]) {
    const result = await decide({ kind: 'email-classification', text: 'Ambiguous' }, {
      jev: { accessState: 'enabled', mode: 'active', threshold: 0.8, decide: async () => jevDecision },
      structuredLlm: async () => ({ classification: 'application_confirmation' }),
    });
    assert.equal(result.engine, 'structured-llm');
    assert.equal(result.decision.classification, 'application_confirmation');
  }
});

test('rejects malformed structured LLM output', async () => {
  await assert.rejects(() => decide({ kind: 'email-classification', text: 'Ambiguous' }, {
    structuredLlm: async () => ({ classification: 'invented' }),
  }), /Invalid email classification/);
});
