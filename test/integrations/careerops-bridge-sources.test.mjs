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

test('when every entry is enabled: false the scan reports CareerOps as disabled, not as a legacy partial list', async () => {
  const { parseCareerOpsRaw } = await import('../../src/scan/sources/careerops.mjs');
  const provider = { id: 'demo', fetch: async () => { throw new Error('must not fetch'); } };
  const raw = await collect([{ name: 'Off', enabled: false }], provider);
  const parsed = parseCareerOpsRaw({ ok: true, ...raw });
  assert.deepEqual(parsed.sources.map((s) => [s.partition, s.status]), [['all', 'disabled']]);
  assert.match(parsed.sources[0].detail, /enabled: false/);
  const legacy = parseCareerOpsRaw({ ok: true, roles: [] });
  assert.equal(legacy.sources[0].detail, 'legacy display-line bridge', 'a bridge with no partition list is still treated as legacy');
});

// CareerOps 1.40 marks a partly read list in a structured shape; the fork and older providers use a
// boolean or a legacy tag. Every one of them must make the partition partial (plan 2026-11-13 step 3a).
const partialWith = (tag) => {
  const provider = { id: 'demo', fetch: async () => Object.assign([job(1), job(2)], tag) };
  return collect([{ name: 'Cut Co', careers_url: 'https://cut.example.test/jobs' }], provider);
};

test('boolean jobs.truncated === true makes the partition partial', async () => {
  const [part] = (await partialWith({ truncated: true })).partitions;
  assert.deepEqual([part.status, part.truncated, part.count, part.truncationReason], ['partial', true, 2, 'incomplete']);
});

test('structured jobs.truncated = { reason, fetched, total } makes the partition partial and keeps the reason', async () => {
  const [part] = (await partialWith({ truncated: { reason: 'page-cap', fetched: 2, total: 9 } })).partitions;
  assert.deepEqual([part.status, part.truncated, part.truncationReason], ['partial', true, 'page-cap']);
});

test('peoplesoftIncomplete makes the partition partial', async () => {
  const [part] = (await partialWith({ peoplesoftIncomplete: true })).partitions;
  assert.equal(part.status, 'partial');
});

test('a legacy <name>Truncated tag, boolean or reason string, makes the partition partial', async () => {
  assert.equal((await partialWith({ jibeapplyTruncated: true })).partitions[0].status, 'partial');
  const [part] = (await partialWith({ workdayTruncated: 'transient' })).partitions;
  assert.deepEqual([part.status, part.truncationReason], ['partial', 'transient']);
});

test('a partial partition carries its company and careers page for the browser read', async () => {
  const [part] = (await partialWith({ truncated: { reason: 'page-cap' } })).partitions;
  assert.deepEqual([part.company, part.careersUrl], ['Cut Co', 'https://cut.example.test/jobs']);
});

test('markers that are not truncation (keywordSearch, workdayNoDateSkip, a false tag) leave the list ok', async () => {
  const [part] = (await partialWith({ keywordSearch: { mode: 'keywords', terms: 2, truncated: true }, workdayNoDateSkip: true, oraclecloudTruncated: false })).partitions;
  assert.deepEqual([part.status, part.truncated, 'careersUrl' in part], ['ok', false, false]);
});
