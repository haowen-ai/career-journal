import test from 'node:test';
import assert from 'node:assert/strict';
import { runScan } from '../../src/scan/run.mjs';
import { freshDb, at } from '../../test-utils/funnel-v3.mjs';
import { record, SCREENING_POLICY } from '../../test-utils/funnel-v3-fixtures.mjs';

const profile = {
  search: { jobType: 'internship', countries: ['US'], exclusions: [] },
  sources: { atsBoards: [{ ats: 'greenhouse', board: 'alpha' }, { ats: 'greenhouse', board: 'beta' }], careerOps: false, simplify: { enabled: false, url: null }, expected: ['atsBoards'] },
};
const part = (partition, { status = 'ok', count = 3, truncated = false } = {}) => ({
  source: 'greenhouse', partition, status, count, rawCount: count, truncated, capDetected: truncated, ...(status === 'error' ? { detail: 'HTTP 404 Not Found' } : {}),
});
const batch = (partition, count) => ({ source: 'greenhouse', partition, rawCount: count,
  records: Array.from({ length: count }, (_, i) => record({ source: 'greenhouse', partition, sourceId: `${partition}-${i}`, url: `https://job-boards.greenhouse.io/${partition.split(':')[1]}/jobs/${9200000 + i}` })) });
async function scan(db, day, parts) {
  const sources = parts.map(([partition, options]) => part(partition, options));
  const batches = sources.filter((s) => s.count > 0).map((s) => batch(s.partition, s.count));
  return runScan({ db, profile, runId: `scan-${day}`, now: at(day), policy: SCREENING_POLICY, collect: async () => ({ sources, batches }) });
}
const view = (summary, partition) => summary.sources.find((item) => item.partition === partition);

test('a source that keeps failing reports how many runs in a row it has failed, so a chronic failure is not read as a one-off', async () => {
  const db = freshDb();
  await scan(db, 0, [['greenhouse:alpha'], ['greenhouse:beta']]);
  let last;
  for (const day of [1, 2, 3]) last = await scan(db, day, [['greenhouse:alpha', { status: 'error', count: 0 }], ['greenhouse:beta', { status: 'partial', truncated: true }]]);
  assert.equal(view(last, 'greenhouse:alpha').failStreak, 3);
  assert.equal(view(last, 'greenhouse:beta').failStreak, 3);
  const recovered = await scan(db, 4, [['greenhouse:alpha'], ['greenhouse:beta', { status: 'partial', truncated: true }]]);
  assert.equal(view(recovered, 'greenhouse:alpha').failStreak, 0, 'a successful run resets the streak');
  assert.equal(view(recovered, 'greenhouse:beta').failStreak, 4);
  assert.ok(recovered.alerts.some((item) => item.partition === 'greenhouse:beta' && item.failStreak === 4), 'the alert list carries the streak');
});

test('a run where the source was not attempted (disabled) breaks the streak', async () => {
  const db = freshDb();
  await scan(db, 0, [['greenhouse:alpha', { status: 'error', count: 0 }], ['greenhouse:beta']]);
  await scan(db, 1, [['greenhouse:alpha', { status: 'disabled', count: 0 }], ['greenhouse:beta']]);
  const last = await scan(db, 2, [['greenhouse:alpha', { status: 'error', count: 0 }], ['greenhouse:beta']]);
  assert.equal(view(last, 'greenhouse:alpha').failStreak, 1);
});
