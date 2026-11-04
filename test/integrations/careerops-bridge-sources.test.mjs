import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCareerOpsRaw } from '../../src/integrations/careerops-scan-bridge.mjs';

const job = (i) => ({ title: `Data Intern ${i}`, url: `https://jobs.example.test/${i}`, location: 'Chicago, IL' });
const collect = (entries, provider, extra = {}) => collectCareerOpsRaw({
  portals: { tracked_companies: entries },
  providers: { demo: provider },
  resolveProvider: async () => ({ provider, id: 'demo' }),
  makeHttpCtx: extra.makeHttpCtx ?? (async () => ({})),
  sleep: async () => {},
  ...extra,
});

test('a transient provider failure (timeout/abort, no HTTP status) is retried within the same run', async () => {
  let calls = 0;
  const provider = { id: 'demo', fetch: async () => {
    calls += 1;
    if (calls === 1) throw new Error('This operation was aborted');
    return [job(1), job(2)];
  } };
  const result = await collect([{ name: 'Spotify' }], provider);
  assert.equal(calls, 2);
  assert.deepEqual(result.partitions.map((p) => [p.partition, p.status, p.count]), [['demo:Spotify', 'ok', 2]]);
  assert.equal(result.partitions[0].attempts, 2);
});

test('a definite HTTP 404 is not retried and stays a reported error', async () => {
  let calls = 0;
  const provider = { id: 'demo', fetch: async () => { calls += 1; throw Object.assign(new Error('HTTP 404 Not Found'), { status: 404 }); } };
  const result = await collect([{ name: 'Gone Co' }], provider);
  assert.equal(calls, 1);
  assert.equal(result.partitions[0].status, 'error');
  assert.equal(result.partitions[0].error, 'HTTP 404 Not Found');
});

test('a transient failure that never recovers is reported as an error after the retries, not dropped', async () => {
  let calls = 0;
  const provider = { id: 'demo', fetch: async () => { calls += 1; throw Object.assign(new Error('HTTP 503'), { status: 503 }); } };
  const result = await collect([{ name: 'Flaky Co' }], provider);
  assert.equal(calls, 3);
  assert.equal(result.partitions[0].status, 'error');
  assert.equal(result.partitions[0].attempts, 3);
  assert.deepEqual(result.configuredPartitions, ['demo:Flaky Co']);
});

test('a cap warning from a failed attempt does not mark the successful retry truncated', async () => {
  let calls = 0;
  const provider = { id: 'demo', fetch: async () => {
    calls += 1;
    if (calls === 1) { console.error('demo: truncated at 5 of 9'); throw new Error('fetch failed'); }
    return [job(1)];
  } };
  const original = console.error;
  console.error = () => {};
  try {
    const result = await collect([{ name: 'Demo' }], provider);
    assert.equal(result.partitions[0].status, 'ok');
    assert.equal(result.partitions[0].truncated, false);
  } finally { console.error = original; }
});

test('HTTP helpers get a 30 s default timeout (CareerOps defaults to 10 s); an entry timeout_ms or an explicit call option wins', async () => {
  const seen = [];
  const makeHttpCtx = async () => ({
    transport: 'http',
    fetchJson: async (url, opts = {}) => { seen.push([url, opts.timeoutMs]); return []; },
    fetchText: async (url, opts = {}) => { seen.push([url, opts.timeoutMs]); return ''; },
  });
  const provider = { id: 'demo', fetch: async (entry, ctx) => {
    await ctx.fetchJson(`https://a.example.test/${entry.name}`, { redirect: 'error' });
    await ctx.fetchText(`https://b.example.test/${entry.name}`, { timeoutMs: 5_000 });
    assert.equal(ctx.transport, 'http');
    return [];
  } };
  await collect([{ name: 'Plain' }, { name: 'Slow', timeout_ms: 90_000 }], provider, { makeHttpCtx });
  assert.deepEqual(seen, [
    ['https://a.example.test/Plain', 30_000], ['https://b.example.test/Plain', 5_000],
    ['https://a.example.test/Slow', 90_000], ['https://b.example.test/Slow', 5_000],
  ]);
});

test('entries marked enabled: false are not fetched and leave the configured inventory', async () => {
  const fetched = [];
  const provider = { id: 'demo', fetch: async (entry) => { fetched.push(entry.name); return [job(entry.name)]; } };
  const result = await collect([{ name: 'On' }, { name: 'Off', enabled: false }, { name: 'Default' }], provider);
  assert.deepEqual(fetched, ['On', 'Default']);
  assert.deepEqual(result.configuredPartitions, ['demo:On', 'demo:Default']);
  assert.deepEqual(result.partitions.map((p) => p.partition), ['demo:On', 'demo:Default']);
});
