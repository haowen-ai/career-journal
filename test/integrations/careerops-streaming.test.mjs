// Component F (user 2026-11-09): each CareerOps entry is handed over the moment its fetch finishes,
// through every hop (worker -> middle hop -> parent), instead of after the slowest entry. Synthetic data
// only; no network: the providers below are local fakes in a temporary CareerOps root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectCareerOpsRaw, scanCareerOpsRaw } from '../../src/integrations/careerops-scan-bridge.mjs';
import { executeCareerOpsProcess, splitLines } from '../../src/integrations/careerops-process.mjs';
import { BUILT_IN_SCAN_BRIDGE, runCareerOpsScan } from '../../src/integrations/careerops.mjs';
import { fetchCareerOpsRoles } from '../../src/scan/sources/careerops.mjs';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const event = (partition) => `${JSON.stringify({ event: 'partition', partition })}\n`;

// A CareerOps root with the upstream module layout. Entry `wait_for` makes the provider wait (up to 10 s)
// until that file exists and say in its job title whether it was released or gave up.
async function fakeRoot(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cj-streaming-root-'));
  const files = {
    'package.json': JSON.stringify({ name: 'career-ops', version: '0.0.0-synthetic', private: true }),
    'portals.yml': JSON.stringify({ tracked_companies: entries }),
    'node_modules/js-yaml/package.json': JSON.stringify({ name: 'js-yaml', version: '0.0.0-synthetic', main: 'index.js' }),
    'node_modules/js-yaml/index.js': 'module.exports = { load: (text) => JSON.parse(text) };\n',
    'providers/_registry.mjs': `const fake = (await import(new URL('./fakeboard.mjs', import.meta.url))).default;
export async function loadProviders() { return new Map([['fakeboard', fake]]); }
export function resolveProvider(entry, providers) { return { provider: providers.get('fakeboard') }; }
`,
    'providers/_http.mjs': 'export function makeHttpCtx() { return {}; }\n',
    'providers/fakeboard.mjs': `import { existsSync } from 'node:fs';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export default {
  id: 'fakeboard',
  async fetch(entry) {
    let state = 'plain';
    if (entry.wait_for) {
      state = 'gave-up';
      for (let i = 0; i < 400; i += 1) { if (existsSync(entry.wait_for)) { state = 'released'; break; } await sleep(25); }
    }
    if (entry.fail) throw new Error('board unavailable');
    return [1, 2].map((n) => ({ title: 'Data Intern ' + state + ' ' + n, company: entry.name, url: entry.careers_url + '/' + n, location: 'Chicago, IL' }));
  },
};
`,
    'plugins/_engine.mjs': 'export async function mergeProviderPlugins(providers) { return providers; }\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}
const entry = (name, extra = {}) => ({ name, careers_url: `https://${name.toLowerCase()}.example.test/jobs`, ...extra });
const envFor = (spool) => { const env = { ...process.env, CAREER_JOURNAL_SCAN_SPOOL: spool, CAREER_JOURNAL_SCAN_CONCURRENCY: '4' }; delete env.CAREER_OPS_PORTALS; return env; };
const withTemp = async (prefix, run) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

test('collectCareerOpsRaw reports each entry through onPartition as soon as its spool file is written', async () => {
  await withTemp('cj-streaming-spool-', async (spool) => {
    let releaseSlow;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const seen = [];
    const provider = { id: 'demo', fetch: async (item) => {
      if (item.name === 'Slow') await slowGate;
      return [{ title: `Data Intern ${item.name}`, url: `https://${item.name}.example.test/1` }];
    } };
    const result = await collectCareerOpsRaw({
      portals: { tracked_companies: ['Slow', 'Fast', 'Failing'].map((name) => entry(name)) },
      providers: { demo: provider },
      resolveProvider: async (item) => (item.name === 'Failing' ? null : { provider, id: 'demo' }),
      makeHttpCtx: async () => ({}), sleep: async () => {}, concurrency: 3, spoolDir: spool,
      onPartition: (meta) => {
        seen.push(meta);
        // The file named by the report is already complete when the report arrives.
        if (meta.spoolFile) assert.ok(existsSync(path.join(spool, meta.spoolFile)), 'spool file is written first');
        if (seen.length === 2) releaseSlow();
      },
    });
    assert.deepEqual(seen.slice(0, 2).map((meta) => meta.partition).sort(), ['demo:Fast', 'unknown:Failing']);
    assert.equal(seen[2].partition, 'demo:Slow', 'reported in finishing order; the slow entry waited for the other two');
    assert.equal(seen.find((meta) => meta.partition === 'unknown:Failing').status, 'error', 'a failed entry is reported too');
    for (const meta of seen) assert.ok(result.partitions.includes(meta), 'the reported object is the one the result keeps');
    const fast = seen.find((meta) => meta.partition === 'demo:Fast');
    assert.equal(JSON.parse(await readFile(path.join(spool, fast.spoolFile), 'utf8')).length, 1);
  });
});

test('the worker prints one partition line per entry before its result line, and the result line is last', async () => {
  const root = await fakeRoot([entry('Alpha'), entry('Beta'), entry('Gamma', { fail: true })]);
  try {
    await withTemp('cj-streaming-spool-', async (spool) => {
      const env = { ...envFor(spool), CAREER_OPS_PORTALS: path.join(root, 'portals.yml') };
      const execution = await executeCareerOpsProcess({ command: process.execPath, args: [BUILT_IN_SCAN_BRIDGE, 'scan-raw', '--worker'], cwd: root, env, timeoutMs: 20_000 });
      assert.equal(execution.exitCode, 0, execution.stderr);
      assert.ok(execution.stdout.endsWith('\n'));
      const lines = execution.stdout.trimEnd().split('\n').map((line) => JSON.parse(line));
      const events = lines.slice(0, -1);
      assert.equal(events.length, 3, 'one line per entry');
      assert.ok(events.every((line) => line.event === 'partition'));
      assert.deepEqual(events.map((line) => line.partition.partition).sort(), ['fakeboard:Alpha', 'fakeboard:Beta', 'fakeboard:Gamma']);
      const final = lines.at(-1);
      assert.equal(final.ok, true);
      assert.equal(final.spooled, true);
      assert.equal(final.partitions.length, 3);
      const alpha = events.find((line) => line.partition.partition === 'fakeboard:Alpha').partition;
      assert.deepEqual(alpha, final.partitions.find((part) => part.partition === 'fakeboard:Alpha'), 'the event carries the same report as the result');
      assert.match(alpha.spoolFile, /^\d+\.json$/);
      assert.equal(events.find((line) => line.partition.partition === 'fakeboard:Gamma').partition.status, 'error');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the middle hop passes partition lines on while the worker runs and prints its result once', async () => {
  // Events reach `write` before the worker ends; the result line is returned, not written.
  const written = [];
  let finished = false;
  await withTemp('cj-streaming-mid-', async (directory) => {
    const portals = path.join(directory, 'portals.yml');
    await writeFile(portals, '{}');
    const parts = [{ partition: 'demo:A', status: 'ok', count: 1, spoolFile: '0.json' }, { partition: 'demo:B', status: 'ok', count: 1, spoolFile: '1.json' }];
    const final = { ok: true, roles: [], partitions: parts, configuredPartitions: ['demo:A', 'demo:B'], spooled: true };
    const output = await scanCareerOpsRaw(directory, {
      env: { CAREER_OPS_PORTALS: portals },
      write: (text) => written.push({ text, finished }),
      execute: async (command, args, options) => {
        assert.deepEqual(args.slice(1), ['scan-raw', '--worker']);
        const stream = `${event(parts[0])}${event(parts[1])}${JSON.stringify(final)}\n`;
        // Chunks split lines in the middle, as a pipe may.
        options.onStdout(stream.slice(0, 25));
        await tick(5);
        options.onStdout(stream.slice(25, event(parts[0]).length + 7));
        await tick(5);
        options.onStdout(stream.slice(event(parts[0]).length + 7));
        finished = true;
        return { exitCode: 0, stdout: stream, stderr: '' };
      },
    });
    assert.deepEqual(written.map((item) => item.text), [event(parts[0]), event(parts[1])], 'only the partition lines are passed on, each whole');
    assert.ok(written.every((item) => !item.finished), 'they are passed on while the worker still runs');
    assert.deepEqual(output, final, 'the result line is parsed, not the first line');
  });
});

test('the middle hop process prints every partition line and exactly one result line, last', async () => {
  const root = await fakeRoot([entry('Alpha'), entry('Beta')]);
  try {
    await withTemp('cj-streaming-spool-', async (spool) => {
      const execution = await executeCareerOpsProcess({ command: process.execPath, args: [BUILT_IN_SCAN_BRIDGE, 'scan-raw'], cwd: root, env: envFor(spool),
        stdin: JSON.stringify({ action: 'scan-raw', readOnly: true }), timeoutMs: 20_000 });
      assert.equal(execution.exitCode, 0, execution.stderr);
      const lines = execution.stdout.trimEnd().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(lines.slice(0, -1).map((line) => line.event), ['partition', 'partition']);
      assert.equal(lines.filter((line) => line.ok === true).length, 1, 'the result is printed once');
      assert.equal(lines.at(-1).ok, true);
      assert.equal(lines.at(-1).partitions.length, 2);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runCareerOpsScan calls onPartition for every partition line and reads only the last line as the result', async () => {
  const root = await fakeRoot([]);
  try {
    const parts = [{ partition: 'demo:A', status: 'ok', count: 2 }, { partition: 'demo:B', status: 'error', count: 0, error: 'boom' }];
    const final = { ok: true, roles: [], partitions: parts, spooled: true };
    const seen = [];
    let finished = false;
    const result = await runCareerOpsScan({ root, scanSpoolDir: '/nonexistent-spool' }, {
      onPartition: (partition) => seen.push({ partition, finished }),
      execute: async (spec) => {
        assert.equal(spec.env.CAREER_JOURNAL_SCAN_SPOOL, '/nonexistent-spool');
        assert.ok(spec.signal instanceof AbortSignal);
        const stream = `${event(parts[0])}not json\n${event(parts[1])}${JSON.stringify(final)}\n`;
        for (let i = 0; i < stream.length; i += 17) { spec.onStdout(stream.slice(i, i + 17)); await tick(0); }
        finished = true;
        return { exitCode: 0, stdout: stream, stderr: '' };
      },
    });
    assert.deepEqual(seen.map((item) => item.partition), parts);
    assert.ok(seen.every((item) => !item.finished), 'each line is handled when it arrives');
    assert.deepEqual(result, final);
    // A bridge that prints one pretty-printed object is still read whole.
    const pretty = await runCareerOpsScan({ root }, { execute: async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, roles: [] }, null, 2), stderr: '' }) });
    assert.deepEqual(pretty, { ok: true, roles: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an onPartition error stops the scan and is the scan error', async () => {
  const root = await fakeRoot([]);
  try {
    let aborted = false;
    await assert.rejects(runCareerOpsScan({ root }, {
      onPartition: () => { throw new Error('ingest failed for demo:A'); },
      execute: (spec) => new Promise((resolve, reject) => {
        spec.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('Process cancelled'), { code: 'PROCESS_CANCELLED' })); });
        spec.onStdout(event({ partition: 'demo:A', status: 'ok', count: 0 }));
        setTimeout(() => resolve({ exitCode: 0, stdout: '', stderr: '' }), 2_000).unref();
      }),
    }), /ingest failed for demo:A/);
    assert.equal(aborted, true, 'the child is stopped');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('splitLines keeps partial lines until they are complete', () => {
  const lines = [];
  const feed = splitLines((line) => lines.push(line));
  for (const chunk of ['ab', 'c\nde', 'f\n\n', 'g', '\n']) feed(chunk);
  assert.deepEqual(lines, ['abc', 'def', 'g']);
});

test('fetchCareerOpsRoles with onBatch hands each finished entry over during the fetch and leaves it out of the returned batches', async () => {
  const release = path.join(os.tmpdir(), `cj-streaming-release-${process.pid}-${Date.now()}`);
  const root = await fakeRoot([entry('Slow', { wait_for: release }), entry('Fast'), entry('Quick'), entry('Broken', { fail: true })]);
  try {
    const delivered = [];
    const result = await fetchCareerOpsRoles(true, { root, scanConcurrency: 4 }, {}, {
      onBatch: (batch) => {
        // Rows are readable from the spool at once.
        delivered.push({ partition: batch.partition, rawCount: batch.rawCount, titles: batch.records.map((role) => role.title) });
        // The slow entry is only released after the three others were handed over.
        if (delivered.length === 3) writeFileSync(release, 'go');
      },
    });
    try {
      assert.deepEqual(delivered.slice(0, 3).map((item) => item.partition).sort(), ['fakeboard:Broken', 'fakeboard:Fast', 'fakeboard:Quick']);
      const slow = delivered.find((item) => item.partition === 'fakeboard:Slow');
      assert.ok(slow, 'the slow entry is delivered too');
      assert.ok(slow.titles.every((title) => title.includes('released')), `the slow fetch was still running when the others were delivered: ${slow.titles}`);
      assert.deepEqual(delivered.find((item) => item.partition === 'fakeboard:Fast'), { partition: 'fakeboard:Fast', rawCount: 2, titles: ['Data Intern plain 1', 'Data Intern plain 2'] });
      assert.equal(delivered.find((item) => item.partition === 'fakeboard:Broken').rawCount, 0);
      assert.deepEqual(result.batches, [], 'delivered entries are not returned again');
      assert.deepEqual(result.sources.map((source) => source.partition), ['fakeboard:Slow', 'fakeboard:Fast', 'fakeboard:Quick', 'fakeboard:Broken'], 'the source list is complete, in configured order');
      assert.equal(result.sources.find((source) => source.partition === 'fakeboard:Broken').status, 'error');
      assert.deepEqual(result.configuredPartitions, ['fakeboard:Slow', 'fakeboard:Fast', 'fakeboard:Quick', 'fakeboard:Broken']);
    } finally { result.dispose?.(); }
  } finally { await rm(root, { recursive: true, force: true }); await rm(release, { force: true }); }
});

test('fetchCareerOpsRoles returns only entries that were not streamed, propagates onBatch errors, and keeps streamed entries when the scan fails', async () => {
  const root = await fakeRoot([]);
  try {
    const parts = ['demo:A', 'demo:B', 'demo:C'].map((partition, index) => ({ partition, status: 'ok', count: 1, rawCount: 1, truncated: false, capDetected: false, spoolFile: `${index}.json` }));
    const spoolWith = async (spec) => {
      const spool = spec.env.CAREER_JOURNAL_SCAN_SPOOL;
      for (const [index, part] of parts.entries()) await writeFile(path.join(spool, `${index}.json`), JSON.stringify([{ id: part.partition, title: 'Data Intern', company: 'Example Corp', url: `https://example.test/${index}`, partition: part.partition }]));
    };
    // Two entries stream, the third is only in the result.
    const streamed = [];
    const mixed = await fetchCareerOpsRoles(true, { root }, { execute: async (spec) => {
      await spoolWith(spec);
      spec.onStdout(event(parts[0]) + event(parts[1]));
      return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, roles: [], partitions: parts, configuredPartitions: parts.map((part) => part.partition), spooled: true })}\n`, stderr: '' };
    } }, { onBatch: (batch) => streamed.push([batch.partition, batch.records.length]) });
    try {
      assert.deepEqual(streamed, [['demo:A', 1], ['demo:B', 1]]);
      assert.deepEqual(mixed.batches.map((batch) => [batch.partition, batch.records.length]), [['demo:C', 1]]);
      assert.equal(mixed.sources.length, 3);
    } finally { mixed.dispose?.(); }

    // Without onBatch nothing changes: every entry is a returned batch.
    const plain = await fetchCareerOpsRoles(true, { root }, { execute: async (spec) => {
      await spoolWith(spec);
      return { exitCode: 0, stdout: `${event(parts[0])}${JSON.stringify({ ok: true, roles: [], partitions: parts, spooled: true })}\n`, stderr: '' };
    } });
    try { assert.deepEqual(plain.batches.map((batch) => batch.partition), ['demo:A', 'demo:B', 'demo:C']); } finally { plain.dispose?.(); }

    // An onBatch error fails the fetch with that error.
    await assert.rejects(fetchCareerOpsRoles(true, { root }, { execute: async (spec) => {
      await spoolWith(spec);
      spec.onStdout(event(parts[0]));
      if (spec.signal.aborted) throw Object.assign(new Error('Process cancelled'), { code: 'PROCESS_CANCELLED' });
      return { exitCode: 0, stdout: '', stderr: '' };
    } }, { onBatch: () => { throw new Error('Ingest conservation violation: demo:A'); } }), /Ingest conservation violation: demo:A/);

    // A scan that fails after streaming keeps the streamed entries' status beside the failure.
    const failed = await fetchCareerOpsRoles(true, { root }, { execute: async (spec) => {
      await spoolWith(spec);
      spec.onStdout(event(parts[0]));
      return { exitCode: null, stdout: '', stderr: 'CareerOps request timed out after 10ms' };
    } }, { onBatch: () => {} });
    assert.deepEqual(failed.sources.map((source) => [source.partition, source.status]), [['demo:A', 'ok'], ['all', 'error']]);
    assert.deepEqual(failed.batches, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
