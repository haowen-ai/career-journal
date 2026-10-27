// Real-size census limits found in the 2026-10-26 rehearsal: the Summer 2027 list is about 13 MB and
// the raw CareerOps emission with full descriptions exceeded the 50 MB process cap, so both sources errored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSimplify } from '../../src/scan/sources/simplify.mjs';
import { collectCareerOpsRaw } from '../../src/integrations/careerops-scan-bridge.mjs';

const listing = (i) => ({ id: `syn-${i}`, company_name: 'Example Co', title: `Data Intern ${i}`, locations: ['Chicago, IL'], terms: ['Summer 2027'], url: `https://jobs.example.test/${i}`, active: true, is_visible: true, date_posted: 1793000000 });

test('[A] a Simplify list of real size (about 13 MB) is collected, not rejected by the byte cap (census limits)', async () => {
  const filler = 'x'.repeat(13_100_000);
  const body = JSON.stringify([listing(1), { ...listing(2), description: filler }]);
  const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } });
  const result = await fetchSimplify({ enabled: true, urls: ['https://lists.example.test/listings.json'] }, fetchImpl, {});
  assert.equal(result.sources[0].status, 'ok', result.sources[0].detail);
  assert.equal(result.sources[0].count, 2);
});

test('[A] raw CareerOps emission keeps identity fields but bounds free text per record (census limits)', async () => {
  const big = 'Long description. '.repeat(60_000);
  const providers = { demo: { id: 'demo', fetch: async () => [{ id: 'r1', title: 'Data Intern', url: 'https://jobs.example.test/r1', location: 'Chicago, IL', description: big, content: big }] } };
  const result = await collectCareerOpsRaw({ portals: { tracked_companies: [{ name: 'Example Co' }] }, providers, resolveProvider: async () => ({ provider: providers.demo, id: 'demo' }), makeHttpCtx: async () => ({}) });
  const [role] = result.roles;
  assert.equal(role.title, 'Data Intern');
  assert.equal(role.url, 'https://jobs.example.test/r1');
  for (const field of ['description', 'content']) {
    assert.ok(!(field in role) || String(role[field]).length <= 4000, `${field} is bounded to 4000 characters`);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result.roles)) < 20_000, 'one record stays small');
});
