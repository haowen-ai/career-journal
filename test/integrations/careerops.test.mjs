import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectCareerOps, runCareerOps } from '../../src/integrations/careerops.mjs';

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobops-careerops-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('reports a missing CareerOps installation as optional capability health', async () => withDirectory(async (directory) => {
  const health = await detectCareerOps({ root: path.join(directory, 'missing'), pinnedVersion: '1.32.0' });
  assert.equal(health.ok, false);
  assert.equal(health.code, 'missing');
  assert.match(health.detail, /install|configure/i);
}));

test('detects the exact pinned CareerOps version and bridge', async () => withDirectory(async (directory) => {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'career-ops', version: '1.32.0' }));
  await writeFile(path.join(directory, 'jobops-adapter.mjs'), '');
  const health = await detectCareerOps({ root: directory, pinnedVersion: '1.32.0' });
  assert.equal(health.ok, true);
  assert.equal(health.installedVersion, '1.32.0');
  assert.equal(health.entrypoint, path.join(directory, 'jobops-adapter.mjs'));
}));

test('rejects a version mismatch instead of silently accepting drift', async () => withDirectory(async (directory) => {
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'career-ops', version: '1.31.0' }));
  await writeFile(path.join(directory, 'jobops-adapter.mjs'), '');
  const health = await detectCareerOps({ root: directory, pinnedVersion: '1.32.0' });
  assert.equal(health.ok, false);
  assert.equal(health.code, 'version-mismatch');
}));

test('constructs a bounded structured draft request and validates the result', async () => withDirectory(async (directory) => {
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'career-ops', version: '1.32.0' }));
  await writeFile(path.join(directory, 'jobops-adapter.mjs'), '');
  let invocation;
  const result = await runCareerOps({
    action: 'prepare', applicationId: 'app-1', materialKind: 'resume', jdPath: '/tmp/jd.txt', evidencePath: '/tmp/profile.md',
  }, { root: directory, pinnedVersion: '1.32.0' }, {
    execute: async (value) => {
      invocation = value;
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, lifecycle: 'draft', outputPath: '/tmp/resume.pdf', verification: 'passed' }), stderr: '' };
    },
  });
  assert.deepEqual(invocation.args, [path.join(directory, 'jobops-adapter.mjs'), 'material', 'prepare']);
  const request = JSON.parse(invocation.stdin);
  assert.equal(request.lifecycle, 'draft');
  assert.equal(request.applicationId, 'app-1');
  assert.equal(result.verification, 'passed');
}));

test('does not fabricate success or accept a submitted lifecycle from the adapter', async () => withDirectory(async (directory) => {
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'career-ops', version: '1.32.0' }));
  await writeFile(path.join(directory, 'jobops-adapter.mjs'), '');
  const config = { root: directory, pinnedVersion: '1.32.0' };
  await assert.rejects(() => runCareerOps({ action: 'prepare', applicationId: 'app-1', materialKind: 'resume' }, config, {
    execute: async () => ({ exitCode: 1, stdout: '', stderr: 'fact gate failed' }),
  }), /fact gate failed/);
  await assert.rejects(() => runCareerOps({ action: 'prepare', applicationId: 'app-1', materialKind: 'resume' }, config, {
    execute: async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, lifecycle: 'submitted', outputPath: '/tmp/resume.pdf', verification: 'passed' }), stderr: '' }),
  }), /draft lifecycle/);
}));

test('rejects unsupported actions and oversized structured requests', async () => withDirectory(async (directory) => {
  const config = { root: directory, pinnedVersion: '1.32.0' };
  await assert.rejects(() => runCareerOps({ action: 'submit', applicationId: 'app-1' }, config, { execute: async () => ({}) }), /Unsupported CareerOps action/);
  await assert.rejects(() => runCareerOps({ action: 'prepare', applicationId: 'app-1', materialKind: 'resume', context: 'x'.repeat(1_000_001) }, config, { execute: async () => ({}) }), /too large/);
}));
