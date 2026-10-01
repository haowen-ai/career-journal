import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../src/decision/router.mjs';
import { createJevAdapter } from '../../src/decision/jev.mjs';
import { configuredDecisionAdapters } from '../../src/commands/email.mjs';
import { fitCriteria, roleFitText, ruleFit, scoreFit } from '../../src/scan/fit.mjs';
import { normalizeScanProfile } from '../../src/scan/profile-input.mjs';

const profile = normalizeScanProfile({
  search: { directions: { primary: ['ai-ml', 'data-science'], secondary: ['quant'] } },
});
const role = (title) => ({ company: 'Example Corp', title, locations: ['New York, NY'], categories: ['Research'], description: 'Build models.' });

test('fit criteria text is built from the profile directions', () => {
  const criteria = fitCriteria(profile);
  assert.deepEqual(Object.keys(criteria), ['high', 'medium', 'low']);
  assert.match(criteria.high, /primary directions: AI \/ machine learning, data science/);
  assert.match(criteria.medium, /secondary directions \(quantitative research or trading\)/);
  assert.match(roleFitText(role('ML Intern')), /^Company: Example Corp\nTitle: ML Intern\nLocations: New York, NY\nCategories: Research\n\nBuild models\.$/);
});

test('the deterministic rule scores primary in the title high, secondary medium, else low', () => {
  assert.equal(ruleFit(role('Machine Learning Intern'), profile).fit, 'high');
  assert.equal(ruleFit(role('Quantitative Research Intern'), profile).fit, 'medium');
  assert.equal(ruleFit(role('Analytics Intern'), profile).fit, 'low');
  assert.equal(ruleFit({ ...role('Intern'), categories: ['Machine Learning'] }, profile).fit, 'low', 'only the title counts for the rule');
});

test('without a semantic provider the router applies the rule and the note says so', async () => {
  const result = await scoreFit(role('Machine Learning Intern'), profile, {});
  assert.equal(result.fit, 'high');
  assert.equal(result.engine, 'rules');
  assert.equal(result.ruleBased, true);
  assert.equal(result.confidence, null);
  assert.match(result.note, /^Rule-based fit \(no semantic provider decided\): primary direction ai-ml \("machine learning"\) in the title$/);
  const dryRun = await scoreFit(role('Quant Intern'), profile, { structuredLlm: async () => { throw new Error('must not be called'); } }, { rulesOnly: true });
  assert.equal(dryRun.fit, 'medium');
  assert.match(dryRun.note, /dry run, no semantic provider called/);
});

test('active confident Jev decides role fit first; low confidence falls back to the LLM, then the rule', async () => {
  let llmCalls = 0;
  const jevHigh = { accessState: 'enabled', mode: 'active', threshold: 0.8, decide: async (input) => {
    assert.equal(input.kind, 'role-fit');
    assert.deepEqual(Object.keys(input.criteria), ['high', 'medium', 'low']);
    return { fit: 'medium', confidence: 0.92 };
  } };
  const viaJev = await scoreFit(role('Machine Learning Intern'), profile, { jev: jevHigh, structuredLlm: async () => { llmCalls += 1; } });
  assert.deepEqual([viaJev.fit, viaJev.engine, viaJev.confidence, llmCalls], ['medium', 'jev', 0.92, 0]);
  assert.equal(viaJev.note, 'Fit by Jev (confidence 0.92)');

  const lowJev = { ...jevHigh, decide: async () => ({ fit: 'low', confidence: 0.4 }) };
  const viaLlm = await scoreFit(role('Machine Learning Intern'), profile, { jev: lowJev, structuredLlm: async () => ({ fit: 'high', confidence: 0.9 }) });
  assert.deepEqual([viaLlm.fit, viaLlm.engine, viaLlm.shadow], ['high', 'structured-llm', { fit: 'low', confidence: 0.4 }]);

  const viaRule = await scoreFit(role('Quant Intern'), profile, {
    jev: { ...jevHigh, decide: async () => { throw new Error('unavailable'); } },
    structuredLlm: async () => ({ fit: 'excellent', confidence: 1 }),
  });
  assert.deepEqual([viaRule.fit, viaRule.engine, viaRule.jevOutcome], ['medium', 'rules', 'error-or-invalid']);
  assert.match(viaRule.note, /^Rule-based fit \(no semantic provider decided; Jev was unavailable\)/);
});

test('the router rejects a malformed rule decision and leaves role fit to manual review', async () => {
  const routed = await decide({ kind: 'role-fit', text: 'x', criteria: {}, ruleDecision: { fit: 'great' } }, {});
  assert.deepEqual([routed.engine, routed.applied, routed.decision.fit], ['manual-review', false, null]);
});

test('the Jev adapter sends one role-fit Choice question with profile criteria', async () => {
  let body;
  const adapter = createJevAdapter({ accessState: 'enabled', mode: 'active', secretRef: 'env:TYPESAFE_API_KEY' }, async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, async json() { return { answers: { fit: { type: 'choice', choice: 'high', confidence: 0.88 } }, usage: { input_tokens: 50, output_tokens: 4 } }; } };
  }, { TYPESAFE_API_KEY: 'fixture-secret' });
  const criteria = fitCriteria(profile);
  const decision = await adapter.decide({ kind: 'role-fit', text: 'Title: ML Intern', criteria });
  assert.equal(body.state, 'Title: ML Intern');
  assert.equal(body.questions.fit.type, 'choice');
  assert.deepEqual(body.questions.fit.criteria, criteria);
  assert.equal('classification' in body.questions, false);
  assert.deepEqual(decision, { fit: 'high', confidence: 0.88, usage: { input_tokens: 50, output_tokens: 4 } });

  const bad = createJevAdapter({ accessState: 'enabled', secretRef: 'env:TYPESAFE_API_KEY' }, async () => ({
    ok: true, async json() { return { answers: { fit: { type: 'choice', choice: 'perfect', confidence: 0.9 } } }; },
  }), { TYPESAFE_API_KEY: 'fixture-secret' });
  await assert.rejects(() => bad.decide({ kind: 'role-fit', text: 'x', criteria }), /Invalid Jev role fit response/);
});

test('the configured structured LLM answers role fit with its own schema', async () => {
  let request;
  const adapters = configuredDecisionAdapters({
    model: { provider: 'openai-compatible', baseUrl: 'https://model.example/v1', model: 'decision-model', secretRef: 'env:MODEL_API_KEY' },
    jev: { accessState: 'unavailable' },
  }, async (url, init) => {
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ fit: 'medium', confidence: 0.85 }) } }] }), { status: 200 });
  }, { MODEL_API_KEY: 'fixture-secret' });
  const result = await adapters.structuredLlm({ kind: 'role-fit', text: 'Title: Quant Intern', criteria: fitCriteria(profile) });
  assert.deepEqual(result, { fit: 'medium', confidence: 0.85 });
  assert.deepEqual(request.response_format.json_schema.schema.properties.fit.enum, ['high', 'medium', 'low']);
  assert.match(request.messages[1].content, /^Criteria:\n- high: .*\n- medium: .*\n- low: .*\n\nRole:\nTitle: Quant Intern$/);
});
