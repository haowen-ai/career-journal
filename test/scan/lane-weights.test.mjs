// Plan 2026-11-14 v4: each scan hands the CareerOps collector the fetch time of every entry in the previous finished
// scan (from its receipt), so the bridge can start the slowest hosts first. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, T0, at } from '../../test-utils/funnel-v3.mjs';
import { record, PROFILE, SCREENING_POLICY } from '../../test-utils/funnel-v3-fixtures.mjs';
import { runScan } from '../../src/scan/run.mjs';
import { previousLaneWeights } from '../../src/scan/lane-weights.mjs';

const CO_PROFILE = { ...PROFILE, sources: { expected: ['careerops'], atsBoards: [], careerOps: true } };
const row = (partition, n) => record({ source: 'careerops', partition, sourceId: `https://acme.example.test/job/${n}`, url: `https://acme.example.test/job/${n}` });
const scan = (db, runId, now, lists, seen = []) => runScan({ db, profile: CO_PROFILE, runId, now, policy: SCREENING_POLICY, incremental: { enabled: true },
  collect: async (_profile, args) => {
    seen.push(args);
    return { careerOpsPartitions: lists.map((list) => list.partition),
      sources: lists.map(({ partition, records, elapsedMs }) => ({ source: 'careerops', partition, status: 'ok', count: records.length, rawCount: records.length, truncated: false, elapsedMs })),
      batches: lists.map(({ partition, records }) => ({ source: 'careerops', partition, records, rawCount: records.length })) };
  } });

test('the next scan gets the previous scan\'s fetch time per entry name; the first scan gets none', async () => {
  const db = freshDb();
  const seen = [];
  await scan(db, 'scan-1', T0, [{ partition: 'apple:Apple', records: [row('apple:Apple', 1)], elapsedMs: 700_000 }, { partition: 'workday:Citi', records: [row('workday:Citi', 2)], elapsedMs: 300_000 }], seen);
  assert.equal(seen[0].laneWeights, null);
  await scan(db, 'scan-2', at(1), [{ partition: 'workday:Citi', records: [row('workday:Citi', 2)], elapsedMs: 200_000 }], seen);
  assert.deepEqual(seen[1].laneWeights, { Apple: 700_000, Citi: 300_000 });
  await scan(db, 'scan-3', at(2), [], seen);
  assert.deepEqual(seen[2].laneWeights, { Citi: 200_000 }, 'only the most recent finished scan counts');
});

test('scans without CareerOps entries (browser reads, boards) do not hide the last CareerOps timing', () => {
  const db = freshDb();
  const insert = db.prepare("INSERT INTO runs (run_id,kind,owner,started_at,heartbeat_at,finished_at,status,receipt_json) VALUES (?,?,?,?,?,?,?,?)");
  insert.run('scan-a', 'scan', 'o', T0, T0, T0, 'partial', JSON.stringify({ sources: [{ source: 'careerops', partition: 'workday:Citi', elapsedMs: 1234 }, { source: 'careerops', partition: 'all', elapsedMs: 9 }] }));
  insert.run('scan-b', 'scan', 'o', at(1), at(1), at(1), 'partial', JSON.stringify({ sources: [{ source: 'browser', partition: 'browser:x', elapsedMs: 5 }] }));
  insert.run('scan-c', 'scan', 'o', at(2), at(2), null, 'running', JSON.stringify({ sources: [{ source: 'careerops', partition: 'workday:Citi', elapsedMs: 1 }] }));
  assert.deepEqual(previousLaneWeights(db), { Citi: 1234 });
  assert.equal(previousLaneWeights(freshDb()), null);
});
