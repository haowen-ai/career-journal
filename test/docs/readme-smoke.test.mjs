import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('close', (code) => resolve({ code, output }));
  });
}

test('Quick Start smoke block executes against a clean home', async () => {
  const readme = await readFile('README.md', 'utf8');
  const match = readme.match(/<!-- quickstart-smoke:start -->\s*```sh\n([^]*?)\n```\s*<!-- quickstart-smoke:end -->/);
  assert.ok(match, 'README smoke block is missing');
  const home = await mkdtemp(path.join(os.tmpdir(), 'jobops-readme-'));
  try {
    for (const raw of match[1].split('\n').filter(Boolean)) {
      const line = raw.replaceAll('$REPO', process.cwd()).replaceAll('$JOBOPS_HOME', home);
      const args = line.trim().split(/\s+/);
      const result = await run(process.execPath, args, process.cwd());
      assert.equal(result.code, 0, `${line}\n${result.output}`);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('README documents both modes and every lifecycle command', async () => {
  const readme = await readFile('README.md', 'utf8');
  for (const phrase of ['Codex-native', 'OpenAI-compatible', 'jobops start', 'jobops automation', 'jobops update', 'jobops migrate', 'jobops backup', 'Uninstall', 'CareerOps', 'Jev', 'read-only email', 'THIRD_PARTY_NOTICES.md']) {
    assert.match(readme, new RegExp(phrase, 'i'));
  }
});
