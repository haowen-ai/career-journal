import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../../src/cli/main.mjs';

function memoryIO() {
  const state = { stdout: '', stderr: '' };
  return {
    get stdout() { return state.stdout; },
    get stderr() { return state.stderr; },
    out(value) { state.stdout += `${value}\n`; },
    err(value) { state.stderr += `${value}\n`; },
  };
}

const runtime = {
  version: '0.1.0-alpha.1',
  commands: new Map(),
};

test('prints the repository version', async () => {
  const io = memoryIO();
  assert.equal(await runCli(['--version'], io, runtime), 0);
  assert.equal(io.stdout.trim(), '0.1.0-alpha.1');
});

test('rejects an unknown command', async () => {
  const io = memoryIO();
  assert.equal(await runCli(['unknown'], io, runtime), 2);
  assert.match(io.stderr, /Unknown command: unknown/);
});

