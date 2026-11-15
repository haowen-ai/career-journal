import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCareerOpsRaw } from '../../src/integrations/careerops-scan-bridge.mjs';
import { fetchCareerOpsRoles, sweepStaleSpools } from '../../src/scan/sources/careerops.mjs';
import { runCareerOpsScan } from '../../src/integrations/careerops.mjs';

const job = (name, i) => ({ title: `Data Intern ${name} ${i}`, url: `https://${name}.example.test/${i}`, location: 'Chicago, IL' });
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const collect = (entries, provider, extra = {}) => collectCareerOpsRaw({
  portals: { tracked_companies: entries },
  providers: { demo: provider },
  resolveProvider: async () => ({ provider, id: 'demo' }),
  makeHttpCtx: async () => ({}),
  sleep: async () => {},
  ...extra,
});
const withTemp = async (run) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cj-bridge-spool-test-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

test('entries on different hosts are fetched in parallel up to the limit; the report keeps the configured order', async () => {
  let running = 0; let peak = 0;
  const provider = { id: 'demo', fetch: async (entry) => {
    running += 1; peak = Math.max(peak, running);
    await tick(entry.name === 'A' ? 40 : 10);
    running -= 1;
    return [job(entry.name, 1)];
  } };
  const entries = ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, careers_url: `https://${name.toLowerCase()}.example.test/jobs` }));
  const result = await collect(entries, provider, { concurrency: 3 });
  assert.equal(peak, 3);
  assert.deepEqual(result.partitions.map((p) => p.partition), ['demo:A', 'demo:B', 'demo:C', 'demo:D', 'demo:E']);
  assert.deepEqual(result.configuredPartitions, ['demo:A', 'demo:B', 'demo:C', 'demo:D', 'demo:E']);
  assert.deepEqual(result.roles.map((role) => role.partition), ['demo:A', 'demo:B', 'demo:C', 'demo:D', 'demo:E']);
});

test('entries that share a host never run at the same time', async () => {
  const active = new Map(); let overlap = false; let peak = 0; let running = 0;
  const provider = { id: 'demo', fetch: async (entry) => {
    const host = new URL(entry.careers_url).host;
    if (active.get(host)) overlap = true;
    active.set(host, true); running += 1; peak = Math.max(peak, running);
    await tick();
    active.set(host, false); running -= 1;
    return [job(entry.name, 1)];
  } };
  const entries = [
    { name: 'A1', careers_url: 'https://shared.example.test/a1' }, { name: 'A2', careers_url: 'https://shared.example.test/a2' },
    { name: 'A3', careers_url: 'https://SHARED.example.test/a3' }, { name: 'B1', careers_url: 'https://other.example.test/b1' },
  ];
  const result = await collect(entries, provider, { concurrency: 4 });
  assert.equal(overlap, false);
  assert.equal(peak, 2);
  assert.equal(result.partitions.length, 4);
});

test('without a concurrency setting entries still run one at a time', async () => {
  let running = 0; let peak = 0;
  const provider = { id: 'demo', fetch: async (entry) => { running += 1; peak = Math.max(peak, running); await tick(5); running -= 1; return [job(entry.name, 1)]; } };
  await collect([{ name: 'A', careers_url: 'https://a.example.test' }, { name: 'B', careers_url: 'https://b.example.test' }], provider);
  assert.equal(peak, 1);
});

test('a cap warning printed by one entry marks only that entry while others run beside it', async () => {
  const original = console.error;
  const quiet = () => {};
  console.error = quiet;
  try {
    const provider = { id: 'demo', fetch: async (entry) => {
      await tick(5);
      if (entry.name === 'Capped') console.error('demo: result cap reached, list truncated');
      await tick(20);
      return [job(entry.name, 1)];
    } };
    const entries = ['Plain', 'Capped', 'Other'].map((name) => ({ name, careers_url: `https://${name.toLowerCase()}.example.test` }));
    const result = await collect(entries, provider, { concurrency: 3 });
    assert.deepEqual(result.partitions.map((p) => [p.partition, p.status, p.truncated]),
      [['demo:Plain', 'ok', false], ['demo:Capped', 'partial', true], ['demo:Other', 'ok', false]]);
    assert.equal(console.error, quiet, 'console.error is restored to the caller\'s function');
  } finally { console.error = original; }
});

test('with a spool folder each entry\'s roles go to its own file and the report carries no role text', async () => withTemp(async (spoolDir) => {
  const provider = { id: 'demo', fetch: async (entry) => entry.name === 'Broken' ? Promise.reject(Object.assign(new Error('HTTP 404'), { status: 404 }))
    : [job(entry.name, 1), job(entry.name, 2)] };
  const entries = ['A', 'Broken', 'C'].map((name) => ({ name, careers_url: `https://${name.toLowerCase()}.example.test` }));
  const result = await collect(entries, provider, { concurrency: 2, spoolDir });
  assert.equal(result.spooled, true);
  assert.deepEqual(result.roles, []);
  assert.deepEqual(result.partitions.map((p) => [p.partition, p.status, p.count, p.spoolFile ?? null]),
    [['demo:A', 'ok', 2, '0.json'], ['demo:Broken', 'error', 0, null], ['demo:C', 'ok', 2, '2.json']]);
  assert.deepEqual((await readdir(spoolDir)).sort(), ['0.json', '2.json']);
  const stored = JSON.parse(await readFile(path.join(spoolDir, '2.json'), 'utf8'));
  assert.deepEqual(stored.map((role) => [role.company, role.partition, role.title]), [['C', 'demo:C', 'Data Intern C 1'], ['C', 'demo:C', 'Data Intern C 2']]);
}));

const scanRoot = async (directory) => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.join(directory, 'providers'), { recursive: true });
  await writeFile(path.join(directory, 'VERSION'), '1.32.0\n');
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'career-ops', version: '1.32.0' }));
  await writeFile(path.join(directory, 'scan.mjs'), '');
  await writeFile(path.join(directory, 'portals.yml'), 'tracked_companies: []\n');
};

test('a spooled scan becomes one batch per entry whose records are read from disk only when asked for', async () => withTemp(async (root) => {
  await scanRoot(root);
  let spoolDir; let environment;
  const result = await fetchCareerOpsRoles(true, { root, pinnedVersion: '1.32.0', scanConcurrency: 5 }, {
    detect: async () => ({ ok: true }),
    execute: async (options) => {
      environment = options.env;
      spoolDir = options.env.CAREER_JOURNAL_SCAN_SPOOL;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(spoolDir, '0.json'), JSON.stringify([{ ...job('a', 1), company: 'A', partition: 'demo:A' }, { ...job('a', 2), company: 'A', partition: 'demo:A' }]));
      await writeFile(path.join(spoolDir, '2.json'), JSON.stringify([{ ...job('c', 1), company: 'C', partition: 'demo:C' }]));
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, spooled: true, roles: [], configuredPartitions: ['demo:A', 'demo:B', 'demo:C'], partitions: [
        { partition: 'demo:A', status: 'ok', count: 2, rawCount: 2, spoolFile: '0.json' },
        { partition: 'demo:B', status: 'error', count: 0, rawCount: 0, error: 'HTTP 404' },
        { partition: 'demo:C', status: 'ok', count: 1, rawCount: 1, capDetected: true, spoolFile: '2.json' },
      ] }) };
    },
  });
  assert.equal(environment.CAREER_JOURNAL_SCAN_CONCURRENCY, '5');
  assert.ok(existsSync(spoolDir));
  assert.deepEqual(result.sources.map((s) => [s.partition, s.status, s.count, s.rawCount]), [['demo:A', 'ok', 2, 2], ['demo:B', 'error', 0, 0], ['demo:C', 'partial', 1, 1]]);
  assert.equal(result.sources[1].detail, 'HTTP 404');
  assert.deepEqual(result.configuredPartitions, ['demo:A', 'demo:B', 'demo:C']);
  assert.deepEqual(result.batches.map((b) => [b.source, b.partition, b.rawCount]), [['careerops', 'demo:A', 2], ['careerops', 'demo:B', 0], ['careerops', 'demo:C', 1]]);
  const records = result.batches[0].records;
  assert.deepEqual(records.map((r) => [r.source, r.company, r.partition, r.title]), [['careerops', 'A', 'demo:A', 'Data Intern a 1'], ['careerops', 'A', 'demo:A', 'Data Intern a 2']]);
  assert.deepEqual(result.batches[1].records, []);
  assert.equal(result.batches[2].records.length, 1);
  // A copy of a batch must not pull every partition's rows into memory.
  assert.equal(Object.keys({ ...result.batches[0] }).includes('records'), false);
  result.dispose();
  assert.equal(existsSync(spoolDir), false);
}));

test('a spool file name that leaves the spool folder is refused', async () => withTemp(async (root) => {
  await scanRoot(root);
  const result = await fetchCareerOpsRoles(true, { root, pinnedVersion: '1.32.0' }, {
    detect: async () => ({ ok: true }),
    execute: async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, spooled: true, roles: [], configuredPartitions: ['demo:A'],
      partitions: [{ partition: 'demo:A', status: 'ok', count: 1, rawCount: 1, spoolFile: '../../etc/passwd' }] }) }),
  });
  assert.throws(() => result.batches[0].records, /spool file/i);
  result.dispose();
}));

test('a scan that fails, or a bridge that does not spool, leaves no spool folder behind', async () => withTemp(async (root) => {
  await scanRoot(root);
  const seen = [];
  const failed = await fetchCareerOpsRoles(true, { root, pinnedVersion: '1.32.0' }, {
    detect: async () => ({ ok: true }),
    execute: async (options) => { seen.push(options.env.CAREER_JOURNAL_SCAN_SPOOL); return { exitCode: 1, stderr: 'boom' }; },
  });
  assert.equal(failed.sources[0].status, 'error');
  const plain = await fetchCareerOpsRoles(true, { root, pinnedVersion: '1.32.0' }, {
    detect: async () => ({ ok: true }),
    execute: async (options) => { seen.push(options.env.CAREER_JOURNAL_SCAN_SPOOL);
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, roles: [{ ...job('a', 1), company: 'A', partition: 'demo:A' }], partitions: [{ partition: 'demo:A', status: 'ok', count: 1 }] }) }; },
  });
  assert.equal(plain.batches[0].records.length, 1);
  assert.equal(seen.length, 2);
  for (const directory of seen) assert.equal(existsSync(directory), false);
}));

test('runCareerOpsScan leaves the child environment alone unless a spool folder or a concurrency is configured', async () => withTemp(async (root) => {
  await scanRoot(root);
  const calls = [];
  const execute = async (options) => { calls.push(options); return { exitCode: 0, stdout: JSON.stringify({ ok: true, roles: [] }) }; };
  await runCareerOpsScan({ root }, { execute });
  await runCareerOpsScan({ root, scanSpoolDir: '/tmp/spool-x', scanConcurrency: 7 }, { execute });
  assert.equal(calls[0].env, undefined);
  assert.equal(calls[1].env.CAREER_JOURNAL_SCAN_SPOOL, '/tmp/spool-x');
  assert.equal(calls[1].env.CAREER_JOURNAL_SCAN_CONCURRENCY, '7');
  assert.equal(calls[1].env.PATH, process.env.PATH);
}));

test('spool folders left by a killed scan are removed after two days; recent ones and other folders stay', async () => withTemp(async (directory) => {
  const { mkdir, utimes } = await import('node:fs/promises');
  const old = path.join(directory, 'career-journal-scan-spool-old');
  const fresh = path.join(directory, 'career-journal-scan-spool-fresh');
  const other = path.join(directory, 'something-else');
  for (const target of [old, fresh, other]) await mkdir(target);
  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * 86_400_000);
  await utimes(old, threeDaysAgo, threeDaysAgo);
  await utimes(other, threeDaysAgo, threeDaysAgo);
  assert.equal(sweepStaleSpools(directory, now), 1);
  assert.deepEqual([existsSync(old), existsSync(fresh), existsSync(other)], [false, true, true]);
}));

test('runCareerOpsScan passes careerOps.scanFamilies to the bridge as JSON, and a malformed value stops the scan before it starts', async () => withTemp(async (root) => {
  await scanRoot(root);
  const calls = [];
  const execute = async (options) => { calls.push(options); return { exitCode: 0, stdout: JSON.stringify({ ok: true, roles: [] }) }; };
  const scanFamilies = { splitByHost: ['workday'], lanes: { default: 1, avature: 3 }, requestsPerMinute: { default: 30 } };
  await runCareerOpsScan({ root, scanFamilies }, { execute });
  assert.deepEqual(JSON.parse(calls[0].env.CAREER_JOURNAL_SCAN_FAMILIES), scanFamilies);
  await assert.rejects(runCareerOpsScan({ root, scanFamilies: { lanes: { avature: 0 } } }, { execute }), /careerOps\.scanFamilies: lanes\.avature must be a positive integer/);
  assert.equal(calls.length, 1, 'the malformed config never reaches the bridge');
}));
