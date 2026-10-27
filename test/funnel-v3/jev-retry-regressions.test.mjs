// Ruling of 2026-10-27 after the first v3 nightly: 34 of 46 Jev postings failed in one window and pushed
// the run onto Codex until it stopped. A rerun minutes later had zero Jev errors.
//   K1  A transient Jev failure (network error, HTTP 429 or 5xx) is retried up to two more times before the
//       ask fails; the posting goes to the fallback only after the last try.
//   K2  A 4xx other than 429 is not retried (the request itself is wrong).
//   K3  The credential is resolved once per adapter, not once per question.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevAdapter } from '../../src/review/second-opinion.mjs';

const ok = (p) => new Response(JSON.stringify({ answers: { eligible: { noul: p } } }), { status: 200 });

async function withFetch(responses, fn) {
  const original = globalThis.fetch; const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = async () => { const next = responses[Math.min(calls, responses.length - 1)]; calls += 1; if (next instanceof Error) throw next; return next(); };
  try { return await fn(() => calls); } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
  }
}

test('K1 transient Jev failures are retried, then succeed', async () => {
  await withFetch([new TypeError('fetch failed'), () => new Response('', { status: 503 }), () => ok(0.8)], async (calls) => {
    const jev = createJevAdapter({ model: 'jev-test', retryDelayMs: 1 });
    assert.equal((await jev.ask({ state: 's', question: 'q' })).probability, 0.8);
    assert.equal(calls(), 3);
  });
});

test('K1 a 429 that never clears fails after three tries', async () => {
  await withFetch([() => new Response('', { status: 429 })], async (calls) => {
    const jev = createJevAdapter({ model: 'jev-test', retryDelayMs: 1 });
    await assert.rejects(jev.ask({ state: 's', question: 'q' }), /Jev second opinion request failed/);
    assert.equal(calls(), 3);
  });
});

test('K2 a 400 is not retried', async () => {
  await withFetch([() => new Response('', { status: 400 })], async (calls) => {
    const jev = createJevAdapter({ model: 'jev-test', retryDelayMs: 1 });
    await assert.rejects(jev.ask({ state: 's', question: 'q' }));
    assert.equal(calls(), 1);
  });
});
