import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../../src/providers/interface.mjs';

test('uses configurable base URL, secret reference, and validates structured output', async () => {
  const calls = [];
  const provider = createProvider({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'local-model', secretRef: 'env:TEST_MODEL_KEY', timeoutMs: 100 }, async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"classification":"interview"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, { TEST_MODEL_KEY: 'top-secret' });
  const result = await provider.structured({ system: 'Classify', input: 'Interview invite', schema: { required: ['classification'] } });
  assert.equal(result.classification, 'interview');
  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer top-secret');
  assert.equal(JSON.stringify(calls).includes('response_format'), true);
});

test('rejects missing required fields without exposing secrets', async () => {
  const provider = createProvider({ provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'model', secretRef: 'env:TEST_MODEL_KEY' }, async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 }), { TEST_MODEL_KEY: 'top-secret' });
  await assert.rejects(() => provider.structured({ system: 'Classify', input: 'text', schema: { required: ['classification'] } }), (error) => {
    assert.match(error.message, /classification/);
    assert.equal(error.message.includes('top-secret'), false);
    return true;
  });
});

test('times out a stalled provider request', async () => {
  const provider = createProvider({ provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'model', timeoutMs: 5 }, async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  await assert.rejects(() => provider.structured({ system: 'Classify', input: 'text', schema: { required: [] } }), /timed out/);
});

