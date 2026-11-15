// Plan 2026-11-14 v6 (r2-r5): hosts that share infrastructure ("families": the provider, Workday split by
// cluster) get at most `lanes` lanes at once and at most `requestsPerMinute` requests in any 60 seconds,
// so a higher overall concurrency never sends any shared pool more than it got before. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCareerOpsRaw } from '../../src/integrations/careerops-scan-bridge.mjs';
import { createFamilyLimiter, familyOf, parseScanFamilies } from '../../src/integrations/scan-families.mjs';

// A logical clock: delay(ms) resolves when the test advances time past it.
function fakeTime() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    delay: (ms) => new Promise((resolve) => { timers.push({ at: now + Math.max(0, ms), resolve }); }),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const next = timers.shift();
        now = Math.max(now, next.at);
        next.resolve();
      }
      now = end;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('families: the provider id, and a split provider by its request host without the first label', () => {
  const split = new Set(['workday']);
  assert.equal(familyOf('avature', { careers_url: 'https://apply.deloitte.com/careers' }, split), 'avature');
  assert.equal(familyOf('workday', { careers_url: 'https://citi.wd5.myworkdayjobs.com/2' }, split), 'workday|wd5.myworkdayjobs.com');
  // The provider reads `api` first, so the family follows it (workday.mjs:538).
  assert.equal(familyOf('workday', { careers_url: 'https://brand.example.com/jobs', api: 'https://x.wd1.myworkdayjobs.com/wday/cxs/x/y/jobs' }, split), 'workday|wd1.myworkdayjobs.com');
  assert.equal(familyOf('workday', { careers_url: 'https://example.com/jobs' }, split), 'workday|example.com');
  assert.equal(familyOf('workday', {}, split), 'workday');
  assert.equal(familyOf(null, { careers_url: 'https://a.example.com' }, split), null);
  assert.equal(familyOf('workday', { careers_url: 'https://citi.wd5.myworkdayjobs.com/2' }, new Set()), 'workday');
});

test('scanFamilies config: unset is null, valid values parse, anything else is a configuration error', () => {
  assert.equal(parseScanFamilies(undefined), null);
  assert.equal(parseScanFamilies(null), null);
  const parsed = parseScanFamilies({ splitByHost: ['workday'], lanes: { default: 1, avature: 3 }, requestsPerMinute: { default: 30, avature: 119 } });
  assert.deepEqual([...parsed.splitByHost], ['workday']);
  assert.equal(parsed.lanes.get('avature'), 3);
  assert.equal(parsed.lanesDefault, 1);
  assert.equal(parsed.requestsPerMinute.get('avature'), 119);
  assert.equal(parsed.requestsPerMinuteDefault, 30);
  const none = parseScanFamilies({});
  assert.equal(none.lanesDefault, Infinity);
  assert.equal(none.requestsPerMinuteDefault, Infinity);
  for (const bad of ['x', 3, [], { lanes: { avature: 0 } }, { lanes: { default: 1.5 } }, { requestsPerMinute: { a: '5' } },
    { requestsPerMinute: [] }, { splitByHost: 'workday' }, { splitByHost: [3] }, { other: 1 }]) {
    assert.throws(() => parseScanFamilies(bad), /scanFamilies/, JSON.stringify(bad));
  }
});

test('limiter: a held slot frees only 60 s after its call ends; the 7th of 6 waits for that (Codex r4 counterexample)', async () => {
  const time = fakeTime();
  const limiter = createFamilyLimiter({ requestsPerMinute: () => 6, now: time.now, delay: time.delay });
  const slots = [];
  // Slots at 0, 500, ..., 2500 ms. The first call really goes out at 100 ms and ends at 500 ms; the
  // others end the moment they are granted. Counting from the grant would free the first slot at 60,000 ms
  // and let a 7th request out 59,900 ms after the first one really went out.
  for (let i = 0; i < 6; i += 1) {
    slots.push(await limiter.acquire('f'));
    if (i === 1) slots[0].release();
    if (i > 0) slots[i].release();
    await time.advance(500);
  }
  let seventh = null;
  limiter.acquire('f').then((slot) => { seventh = time.now(); slot.release(); });
  await time.advance(60_499 - time.now());
  assert.equal(seventh, null, 'held until 60 s after the first call ended');
  await time.advance(1);
  assert.equal(seventh, 60_500);
});

test('limiter: a failed call holds its slot for 60 s too; other families never wait; no limit means no wait', async () => {
  const time = fakeTime();
  const limiter = createFamilyLimiter({ requestsPerMinute: (family) => (family === 'a' ? 1 : Infinity), now: time.now, delay: time.delay });
  const first = await limiter.acquire('a');
  first.release();
  let second = null;
  limiter.acquire('a').then((slot) => { second = slot; });
  const other = await limiter.acquire('b');
  assert.ok(other, 'another family is not held up');
  await time.advance(59_999);
  assert.equal(second, null);
  await time.advance(1);
  assert.ok(second);
  assert.ok(second.waitedMs >= 60_000);
});

const collect = (entries, provider, extra = {}) => collectCareerOpsRaw({
  portals: { tracked_companies: entries },
  providers: { demo: provider },
  resolveProvider: async () => ({ provider, id: 'demo' }),
  makeHttpCtx: async () => ({ fetchJson: async (url) => ({ url }) }),
  sleep: async () => {},
  ...extra,
});
const entry = (name, host = `${name.toLowerCase()}.pool.example.test`) => ({ name, careers_url: `https://${host}/jobs` });

test('lanes: never more lanes of one family at once than its cap, every lane still runs, and a failing lane frees its place', async () => {
  let running = 0;
  let peak = 0;
  const done = [];
  const provider = { id: 'demo', fetch: async (item) => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1; done.push(item.name);
    if (item.name === 'B') throw new Error('HTTP 429 Too Many Requests');
    return [{ title: `Intern ${item.name}`, url: `https://x.test/${item.name}` }];
  } };
  const entries = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => entry(name));
  const families = parseScanFamilies({ lanes: { default: 1, demo: 2 } });
  const result = await collect(entries, provider, { concurrency: 6, families });
  assert.equal(peak, 2);
  assert.deepEqual(done.sort(), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(result.partitions.find((p) => p.partition === 'demo:B').status, 'error', 'a failure stays an error, it is not dropped');
  assert.equal(result.partitions.filter((p) => p.status === 'ok').length, 5);
  for (const part of result.partitions) { assert.equal(part.family, 'demo'); assert.ok(Number.isFinite(part.startedMs)); }
});

test('lanes: a family with one lane is not capped; families do not block each other; unset config keeps the old order', async () => {
  const started = [];
  const provider = { id: 'demo', fetch: async (item) => { started.push(item.name); await new Promise((resolve) => setTimeout(resolve, 2)); return []; } };
  const two = { demo: provider, other: { ...provider, id: 'other' } };
  const resolveProvider = async (item) => (item.name.startsWith('O') ? { provider: two.other, id: 'other' } : { provider: two.demo, id: 'demo' });
  const entries = [entry('A'), entry('B'), entry('O1'), entry('C')];
  const capped = await collect(entries, provider, { providers: two, resolveProvider, concurrency: 4, families: parseScanFamilies({ lanes: { default: 1 } }) });
  // demo has three lanes and cap 1: A, then the single-lane `other` family starts at once, then B, C.
  assert.deepEqual(started.slice(0, 2), ['A', 'O1']);
  assert.equal(capped.partitions.length, 4);
  started.length = 0;
  const plain = await collect(entries, provider, { providers: two, resolveProvider, concurrency: 1 });
  assert.deepEqual(started, ['A', 'B', 'O1', 'C']);
  assert.equal('family' in plain.partitions[0], false, 'no new fields without the config');
});

test('requests: every ctx fetch of a multi-lane family takes a slot (retries too), waits before the call, and is reported as rateWaitMs', async () => {
  const time = fakeTime();
  const calls = [];
  const provider = { id: 'demo', fetch: async (item, ctx) => {
    for (let page = 0; page < 3; page += 1) await ctx.fetchJson(`https://${item.name}/p${page}`);
    return [{ title: `Intern ${item.name}`, url: `https://x.test/${item.name}` }];
  } };
  const makeHttpCtx = async () => ({ fetchJson: async (url, opts) => { calls.push({ url, at: time.now(), timeoutMs: opts?.timeoutMs }); return {}; } });
  const families = parseScanFamilies({ lanes: { default: 2 }, requestsPerMinute: { demo: 4 } });
  const pending = collect([entry('A'), entry('B')], provider, { makeHttpCtx, concurrency: 2, families, now: time.now, delay: time.delay });
  await time.advance(10);
  assert.equal(calls.length, 4, 'four of six calls in the first minute');
  await time.advance(60_000);
  const result = await pending;
  assert.equal(calls.length, 6);
  assert.ok(calls.slice(4).every((call) => call.at >= 60_000));
  assert.ok(calls.every((call) => call.timeoutMs === 30_000), 'the per-call timeout still applies, and starts after the wait');
  assert.ok(result.partitions.some((p) => p.rateWaitMs >= 60_000));
});

test('requests: a single-lane family and a scan without the config are never limited', async () => {
  const time = fakeTime();
  let calls = 0;
  const provider = { id: 'demo', fetch: async (item, ctx) => { for (let i = 0; i < 10; i += 1) await ctx.fetchJson(`https://${item.name}/${i}`); return []; } };
  const makeHttpCtx = async () => ({ fetchJson: async () => { calls += 1; return {}; } });
  await collect([entry('A')], provider, { makeHttpCtx, families: parseScanFamilies({ requestsPerMinute: { default: 1 } }), now: time.now, delay: time.delay });
  assert.equal(calls, 10);
  calls = 0;
  await collect([entry('A'), entry('B')], provider, { makeHttpCtx, concurrency: 2, now: time.now, delay: time.delay });
  assert.equal(calls, 20);
});

test('requests: a provider retry is another request and takes another slot', async () => {
  const time = fakeTime();
  const calls = [];
  const provider = { id: 'demo', fetch: async (item, ctx) => {
    for (let attempt = 0; ; attempt += 1) {
      try { await ctx.fetchJson(`https://${item.name}/list`); break; } catch (error) { if (attempt === 2) throw error; }
    }
    return [];
  } };
  let failures = 2;
  const makeHttpCtx = async () => ({ fetchJson: async (url) => { calls.push(time.now()); if (failures-- > 0) throw Object.assign(new Error('HTTP 429'), { status: 429 }); return {}; } });
  const pending = collect([entry('A'), entry('B')], provider, { makeHttpCtx, concurrency: 1,
    families: parseScanFamilies({ requestsPerMinute: { demo: 2 } }), now: time.now, delay: time.delay });
  await time.advance(10);
  assert.equal(calls.length, 2, 'A\'s first try and its retry use the budget of two');
  await time.advance(120_000);
  const result = await pending;
  assert.equal(calls.length, 4);
  assert.ok(calls[2] >= 60_000);
  assert.deepEqual(result.partitions.map((p) => p.status), ['ok', 'ok']);
});

test('lanes: a host lane holding entries of two families counts against both caps (Codex code review r1-1)', async () => {
  const running = new Map();
  const peak = new Map();
  const make = (id) => ({ id, fetch: async () => {
    running.set(id, (running.get(id) ?? 0) + 1); peak.set(id, Math.max(peak.get(id) ?? 0, running.get(id)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    running.set(id, running.get(id) - 1);
    return [];
  } });
  const p1 = make('p1');
  const p2 = make('p2');
  const resolveProvider = async (item) => (item.name.startsWith('B') || item.name.startsWith('C') ? { provider: p2, id: 'p2' } : { provider: p1, id: 'p1' });
  // Lane shared.test: A (p1) then B (p2). Lane c.test: C (p2). Lane d.test: D (p1).
  const entries = [entry('A', 'shared.test'), entry('B', 'shared.test'), entry('C', 'c.test'), entry('D', 'd.test')];
  const result = await collect(entries, p1, { providers: { p1, p2 }, resolveProvider, concurrency: 3, families: parseScanFamilies({ lanes: { default: 1 } }) });
  assert.equal(peak.get('p2'), 1);
  assert.equal(peak.get('p1'), 1);
  assert.equal(result.partitions.filter((p) => p.status === 'ok').length, 4);
});

test('requests: a split provider is budgeted by the host it really requests, not by its careers page (Codex code review r1-2)', async () => {
  const time = fakeTime();
  const calls = [];
  const wd = { id: 'wd', fetch: async (item, ctx) => { await ctx.fetchJson(item.tenantApi); return []; } };
  const entries = [
    { name: 'A', careers_url: 'https://brand-a.example.com/careers', tenantApi: 'https://a.wd1.myworkdayjobs.com/wday/cxs/a/x/jobs' },
    { name: 'B', careers_url: 'https://brand-b.example.org/careers', api: 'https://not-workday.example.org/feed', tenantApi: 'https://b.wd1.myworkdayjobs.com/wday/cxs/b/y/jobs' },
  ];
  const makeHttpCtx = async () => ({ fetchJson: async (url) => { calls.push([url, time.now()]); return {}; } });
  const pending = collect(entries, wd, { providers: { wd }, resolveProvider: async () => ({ provider: wd, id: 'wd' }), makeHttpCtx, concurrency: 2,
    families: parseScanFamilies({ splitByHost: ['wd'], requestsPerMinute: { 'wd|wd1.myworkdayjobs.com': 1 } }), now: time.now, delay: time.delay });
  await time.advance(10);
  assert.equal(calls.length, 1, 'both tenants are on wd1: one request in the first minute');
  await time.advance(60_000);
  await pending;
  assert.equal(calls.length, 2);
  assert.ok(calls[1][1] >= 60_000);
});

test('requests: a split provider family missing from the config gets the default budget, even with one lane', async () => {
  const time = fakeTime();
  let calls = 0;
  const wd = { id: 'wd', fetch: async (item, ctx) => { for (let i = 0; i < 3; i += 1) await ctx.fetchJson(`https://t.wd9.myworkdayjobs.com/p${i}`); return []; } };
  const pending = collect([entry('A')], wd, { providers: { wd }, resolveProvider: async () => ({ provider: wd, id: 'wd' }),
    makeHttpCtx: async () => ({ fetchJson: async () => { calls += 1; return {}; } }),
    families: parseScanFamilies({ splitByHost: ['wd'], requestsPerMinute: { default: 2 } }), now: time.now, delay: time.delay });
  await time.advance(10);
  assert.equal(calls, 2);
  await time.advance(60_000);
  await pending;
  assert.equal(calls, 3);
});

test('scanFamilies config: an explicit null list or map is rejected, not read as empty (Codex code review r1-3)', () => {
  for (const bad of [{ splitByHost: null }, { lanes: null }, { requestsPerMinute: null }]) {
    assert.throws(() => parseScanFamilies(bad), /scanFamilies/, JSON.stringify(bad));
  }
});
