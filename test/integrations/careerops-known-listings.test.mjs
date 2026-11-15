// Plan 2026-11-14 v2 step 2: the bridge hands each provider the listing ids its list already has, so a provider can
// skip detail requests for them. The list itself is still read and delivered in full. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectCareerOpsRaw, readKnownListings } from '../../src/integrations/careerops-scan-bridge.mjs';
import { fetchCareerOpsRoles, KNOWN_LISTINGS_FILE } from '../../src/scan/sources/careerops.mjs';

const job = (token) => ({ title: `Data Intern ${token}`, url: `https://acme.wd5.myworkdayjobs.com/x/job/Chicago/Data-Intern_${token}`, location: 'Chicago, IL', listingId: token });
const collect = (entries, provider, extra = {}) => collectCareerOpsRaw({
  portals: { tracked_companies: entries },
  providers: { workday: provider },
  resolveProvider: async () => ({ provider, id: 'workday' }),
  makeHttpCtx: async () => ({}),
  sleep: async () => {},
  ...extra,
});

test('a provider of a baselined list gets isKnownListing; the full list is still delivered', async () => {
  const asked = [];
  const provider = { id: 'workday', fetch: async (_entry, ctx) => {
    const jobs = [job('R1'), job('R2'), job('R3')];
    asked.push(typeof ctx.isKnownListing === 'function' ? jobs.map((item) => ctx.isKnownListing(item)) : null);
    return jobs;
  } };
  const result = await collect([{ name: 'Acme' }, { name: 'Fresh' }], provider, { knownListings: new Map([['workday:Acme', new Set(['R1', 'R3'])]]) });
  assert.deepEqual(asked, [[true, false, true], null], 'only the baselined list is told what it has');
  assert.deepEqual(result.partitions.map((p) => [p.partition, p.count]), [['workday:Acme', 3], ['workday:Fresh', 3]]);
  assert.equal(result.roles.filter((role) => role.partition === 'workday:Acme').length, 3);
});

test('the known-listings file round-trips from the scan to the bridge worker', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cj-known-'));
  try {
    const file = path.join(directory, 'known.json');
    await writeFile(file, JSON.stringify({ 'workday:Acme': ['R1', 'R2'] }));
    const known = readKnownListings(file);
    assert.deepEqual([...known.get('workday:Acme')], ['R1', 'R2']);
    assert.equal(readKnownListings(undefined).size, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fetchCareerOpsRoles writes the known listings for the bridge and passes the file path', async () => {
  const { readFileSync } = await import('node:fs');
  let seenConfig;
  let fileText;
  await fetchCareerOpsRoles(true, {}, {
    detect: async () => ({ ok: true }),
    run: async (config) => { seenConfig = config; fileText = readFileSync(config.knownListingsFile, 'utf8'); return { ok: true, roles: [], partitions: [], configuredPartitions: [] }; },
  }, { knownListings: { 'workday:Acme': new Set(['R9']) } });
  assert.equal(path.basename(seenConfig.knownListingsFile), KNOWN_LISTINGS_FILE);
  assert.deepEqual(JSON.parse(fileText), { 'workday:Acme': ['R9'] });
});

test('without known listings no file is written', async () => {
  let seenConfig;
  await fetchCareerOpsRoles(true, {}, {
    detect: async () => ({ ok: true }),
    run: async (config) => { seenConfig = config; return { ok: true, roles: [], partitions: [], configuredPartitions: [] }; },
  }, { knownListings: null });
  assert.equal(seenConfig.knownListingsFile, undefined);
});
