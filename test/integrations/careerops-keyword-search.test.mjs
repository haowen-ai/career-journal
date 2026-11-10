import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectCareerOpsRaw, withKeywordDefaults } from '../../src/integrations/careerops-scan-bridge.mjs';
import { parseCareerOpsRaw } from '../../src/scan/sources/careerops.mjs';
import { assessSourceHealth } from '../../src/funnel/health.mjs';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';

const portals = { keyword_search: { terms: ['intern', 'co-op'], min_total: 400 }, tracked_companies: [] };
const job = (i) => ({ id: `j${i}`, title: `Data Intern ${i}`, url: `https://jobs.example.test/${i}`, location: 'Chicago, IL' });

test('portals.yml keyword_search fills an entry\'s keywords and threshold; the entry\'s own values and keywords: false win', () => {
  assert.deepEqual(withKeywordDefaults({ name: 'A' }, portals), { name: 'A', keywords: ['intern', 'co-op'], keyword_min_total: 400 });
  assert.deepEqual(withKeywordDefaults({ name: 'A', keywords: ['student'], keyword_min_total: 50 }, portals), { name: 'A', keywords: ['student'], keyword_min_total: 50 });
  assert.deepEqual(withKeywordDefaults({ name: 'A', keywords: false }, portals), { name: 'A' });
  assert.deepEqual(withKeywordDefaults({ name: 'A' }, { tracked_companies: [] }), { name: 'A' });
  assert.deepEqual(withKeywordDefaults({ name: 'A' }, { keyword_search: { terms: [], min_total: 0 } }), { name: 'A' });
  const perProvider = { keyword_search: { terms: ['intern', 'co-op'], min_total: 400, providers: { workday: { terms: ['intern', 'internship'] } } } };
  assert.deepEqual(withKeywordDefaults({ name: 'A' }, perProvider, 'workday').keywords, ['intern', 'internship'], 'a provider list replaces the shared one');
  assert.deepEqual(withKeywordDefaults({ name: 'A' }, perProvider, 'oraclecloud').keywords, ['intern', 'co-op']);
});

test('the provider receives the keyword request; a keyword result is reported as mode keywords with its board total, outside the whole-board ceiling', async () => {
  const seen = [];
  const provider = { id: 'successfactors', fetch: async (entry) => {
    seen.push(entry);
    if (entry.name === 'Big') { const jobs = [job(1), job(2)]; jobs.keywordSearch = { terms: 2, boardTotal: 7513, perTerm: { intern: 2, 'co-op': 1 } }; return jobs; }
    if (entry.name === 'Capped') { const jobs = [job(3)]; jobs.keywordSearch = { terms: 2, boardTotal: null }; jobs.truncated = true; return jobs; }
    if (entry.name === 'Tagged') { const jobs = [job(4)]; jobs.keywordSearch = { mode: 'facet', facet: { name: 'tags1', values: ['Internship', 'Co-op'] }, terms: 0, boardTotal: 11843 }; return jobs; }
    return Array.from({ length: 1000 }, (_, i) => job(i));
  } };
  const result = await collectCareerOpsRaw({ portals: { ...portals, keyword_search: { ...portals.keyword_search, facet_values: ['intern', ' co-op ', ''] }, tracked_companies: [{ name: 'Big' }, { name: 'Capped' }, { name: 'Tagged' }, { name: 'Small', keywords: false }] },
    providers: { successfactors: provider }, resolveProvider: async () => ({ provider, id: 'successfactors' }), makeHttpCtx: async () => ({}), sleep: async () => {} });
  assert.deepEqual(seen.map((entry) => [entry.name, entry.keywords ?? null, entry.keyword_min_total ?? null, entry.facet_values ?? null]),
    [['Big', ['intern', 'co-op'], 400, ['intern', 'co-op']], ['Capped', ['intern', 'co-op'], 400, ['intern', 'co-op']], ['Tagged', ['intern', 'co-op'], 400, ['intern', 'co-op']], ['Small', null, null, null]]);
  const [big, capped, tagged, small] = result.partitions;
  assert.deepEqual([tagged.mode, tagged.facetName, tagged.facetValues, tagged.boardTotal, tagged.detail], ['facet', 'tags1', ['Internship', 'Co-op'], 11843, 'keyword search (facet tags1 = Internship | Co-op, board 11843)']);
  assert.deepEqual([big.status, big.count, big.mode, big.boardTotal, big.keywordTerms, big.detail], ['ok', 2, 'keywords', 7513, 2, 'keyword search (2 terms, board 7513)']);
  assert.deepEqual([capped.status, capped.truncated, capped.detail], ['partial', true, 'keyword search (2 terms, board unknown)']);
  assert.deepEqual([small.status, small.count, small.mode ?? null, small.ceiling], ['partial', 1000, null, 1000], 'a whole-board read at the provider ceiling is still reported capped');
  const sources = parseCareerOpsRaw({ ok: true, ...result }).sources;
  assert.equal(sources[0].detail, 'keyword search (2 terms, board 7513)');
  assert.equal(sources[0].mode, 'keywords');
});

test('source health compares a keyword census only with keyword censuses: switching a big board to keyword search is not a drop, and zero hits alarm only after hits were seen', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-keyword-health-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const { db } = await openHomeDatabase(home);
    try {
      const partition = 'workday:Big Co';
      const manifest = [{ source: 'careerops', partition }];
      const night = (n) => `2026-11-0${n}T03:00:00.000Z`;
      const run = (runId, now, item) => {
        db.prepare("INSERT INTO runs (run_id,kind,owner,started_at,heartbeat_at,finished_at,status) VALUES (?,'scan','o',?,?,?,'ok')").run(runId, now, now, now);
        return assessSourceHealth(db, { runId, now, manifest, reported: [{ source: 'careerops', partition, ...item }] })[0];
      };
      for (const n of [1, 2, 3]) assert.equal(run(`s${n}`, night(n), { status: 'ok', count: 10_000, rawCount: 10_000 }).alert, null);
      const switched = run('s4', night(4), { status: 'ok', count: 150, rawCount: 150, mode: 'keywords', detail: 'keyword search (10 terms, board 10000)' });
      assert.equal(switched.alert, null, '150 keyword hits are not a drop from 10,000 whole-board jobs');
      assert.equal(switched.baseline, null, 'no keyword census yet to compare with');
      const empty = run('s5', night(5), { status: 'ok', count: 0, rawCount: 0, mode: 'keywords', detail: 'keyword search (10 terms, board 10000)' });
      assert.equal(empty.alert, 'zero', 'a search that found 150 last night and nothing tonight is worth a look');
      const back = run('s6', night(6), { status: 'ok', count: 9_000, rawCount: 9_000 });
      assert.equal(back.alert, null, 'a whole-board read is compared with whole-board reads only');
      assert.equal(back.baseline, 10_000);
      const fresh = run('s7', night(7), { status: 'ok', count: 0, rawCount: 0, mode: 'keywords', detail: 'keyword search (10 terms, board 300)' });
      assert.equal(fresh.alert, 'zero', 'earlier keyword censuses found hits, so zero still alarms');
    } finally { db.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a keyword search that never found a student role on this board is empty, not an alarm', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-keyword-health-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
    const { db } = await openHomeDatabase(home);
    try {
      const partition = 'oraclecloud:Grocer';
      const manifest = [{ source: 'careerops', partition }];
      db.prepare("INSERT INTO expected_partitions (source,partition,first_expected,last_expected) VALUES ('careerops',?,'2026-09-01T00:00:00.000Z','2026-11-01T00:00:00.000Z')").run(partition);
      let result;
      for (const n of [1, 2, 3, 4]) {
        const now = `2026-11-0${n}T03:00:00.000Z`;
        db.prepare("INSERT INTO runs (run_id,kind,owner,started_at,heartbeat_at,finished_at,status) VALUES (?,'scan','o',?,?,?,'ok')").run(`g${n}`, now, now, now);
        result = assessSourceHealth(db, { runId: `g${n}`, now, manifest, reported: [{ source: 'careerops', partition, status: 'ok', count: 0, rawCount: 0, mode: 'keywords', detail: 'keyword search (10 terms, board 10000)' }] })[0];
      }
      assert.deepEqual([result.status, result.alert, result.coldStart], ['empty', null, false]);
    } finally { db.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});
