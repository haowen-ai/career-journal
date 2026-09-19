import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { runCli } from '../../src/cli/main.mjs';
import { createRuntime } from '../../src/runtime/create-runtime.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

test('exports stable JSON, Markdown, and CSV without secret references', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-export-'));
  try {
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' }, model: { provider: 'openai-compatible', secretRef: 'env:MODEL_SECRET' } });
    const runtime = createRuntime({ root: process.cwd(), version: '0.1.0-alpha.1' });
    const add = memoryIO();
    await runCli(['application', 'add', '--home', home, '--company', 'Beta', '--role', 'Engineer'], add, runtime);
    await runCli(['application', 'add', '--home', home, '--company', 'Acme', '--role', 'Analyst'], memoryIO(), runtime);
    for (const format of ['json', 'markdown', 'csv']) {
      const destination = path.join(home, `applications.${format === 'markdown' ? 'md' : format}`);
      const io = memoryIO();
      assert.equal(await runCli(['export', format, '--home', home, '--output', destination], io, runtime), 0);
      const text = await readFile(destination, 'utf8');
      assert.equal(text.includes('MODEL_SECRET'), false);
      assert.ok(text.indexOf('Acme') < text.indexOf('Beta'));
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
