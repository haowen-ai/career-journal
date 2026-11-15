// Plan 2026-11-14 v4: the bridge starts the hosts that took longest in the previous scan first (longest lane first),
// so one slow host is not left to start last. Order only: coverage, per-host serialisation and the report order are
// unchanged. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectCareerOpsRaw, readIncrementalInput } from '../../src/integrations/careerops-scan-bridge.mjs';

const collect = (entries, provider, extra = {}) => collectCareerOpsRaw({
  portals: { tracked_companies: entries },
  providers: { demo: provider },
  resolveProvider: async () => ({ provider, id: 'demo' }),
  makeHttpCtx: async () => ({}),
  sleep: async () => {},
  ...extra,
});
const entry = (name, host = name.toLowerCase()) => ({ name, careers_url: `https://${host}.example.test/jobs` });

test('lanes start longest-first by the previous elapsed time; unknown hosts keep their configured order after them', async () => {
  const started = [];
  const provider = { id: 'demo', fetch: async (item) => { started.push(item.name); return [{ title: `Intern ${item.name}`, url: `https://x.test/${item.name}` }]; } };
  const entries = ['A', 'B', 'C', 'D', 'E'].map((name) => entry(name));
  const result = await collect(entries, provider, { concurrency: 1, laneWeights: new Map([['C', 90_000], ['E', 5_000], ['B', 30_000]]) });
  assert.deepEqual(started, ['C', 'B', 'E', 'A', 'D']);
  assert.deepEqual(result.partitions.map((p) => p.partition), ['demo:A', 'demo:B', 'demo:C', 'demo:D', 'demo:E'], 'the report keeps the configured order');
});

test('a lane is weighted by the sum of its entries, and entries of one host stay in configured order', async () => {
  const started = [];
  const provider = { id: 'demo', fetch: async (item) => { started.push(item.name); return []; } };
  const entries = [entry('S1', 'shared'), entry('X'), entry('S2', 'shared')];
  await collect(entries, provider, { concurrency: 1, laneWeights: new Map([['S1', 10], ['S2', 15], ['X', 20]]) });
  assert.deepEqual(started, ['S1', 'S2', 'X']);
});

test('no weights: configured order, exactly as before', async () => {
  const started = [];
  const provider = { id: 'demo', fetch: async (item) => { started.push(item.name); return []; } };
  await collect(['A', 'B', 'C'].map((name) => entry(name)), provider, { concurrency: 1 });
  assert.deepEqual(started, ['A', 'B', 'C']);
});

test('the incremental input file carries lane weights by entry name', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cj-lanes-'));
  try {
    const file = path.join(directory, 'known.json');
    await writeFile(file, JSON.stringify({ known: {}, elapsed: { Apple: 700_000, Citi: 300_000, bad: 'x' } }));
    const input = readIncrementalInput(file);
    assert.deepEqual([...input.laneWeights], [['Apple', 700_000], ['Citi', 300_000]]);
    assert.equal(readIncrementalInput(undefined).laneWeights.size, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fetchCareerOpsRoles writes the lane weights for the bridge, also before any list is baselined', async () => {
  const { readFileSync } = await import('node:fs');
  const { fetchCareerOpsRoles } = await import('../../src/scan/sources/careerops.mjs');
  let fileText;
  await fetchCareerOpsRoles(true, {}, {
    detect: async () => ({ ok: true }),
    run: async (config) => { fileText = readFileSync(config.knownListingsFile, 'utf8'); return { ok: true, roles: [], partitions: [], configuredPartitions: [] }; },
  }, { knownListings: null, laneWeights: { Apple: 700_000 } });
  assert.deepEqual(JSON.parse(fileText), { known: {}, watermarks: {}, elapsed: { Apple: 700_000 } });
  assert.equal(readIncrementalInput(null).laneWeights.size, 0);
});
