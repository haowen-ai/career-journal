import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../../src/commands/setup.mjs';
import { openHomeDatabase } from '../../src/runtime/home.mjs';
import { createApplication } from '../../src/commands/application.mjs';
import { materialCommand } from '../../src/commands/material.mjs';
import { memoryIO } from '../../test-utils/helpers.mjs';

test('material prepare validates, hashes, and archives the generated draft', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'career-journal-material-'));
  const home = path.join(root, 'home');
  const careerOps = path.join(root, 'career-ops');
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(careerOps, { recursive: true }));
    await writeFile(path.join(careerOps, 'package.json'), JSON.stringify({ name: 'career-ops', version: '1.32.0' }));
    await writeFile(path.join(careerOps, 'career-journal-adapter.mjs'), `import { readFile, writeFile } from 'node:fs/promises';
let text=''; for await (const chunk of process.stdin) text += chunk; const request=JSON.parse(text);
await writeFile(request.requestedOutput, '%PDF generated');
console.log(JSON.stringify({ok:true, applicationId:request.applicationId, lifecycle:'draft', outputPath:request.requestedOutput, verification:'passed', verificationEvidence:{factGate:'passed',ruleFiles:request.ruleFiles}}));`);
    const rules = path.join(root, 'personal-rules.md');
    await writeFile(rules, '# Personal material rules\n');
    await setup(home, { timezone: 'UTC', email: { mode: 'skip' }, careerOps: { root: careerOps }, materialRules: [rules] });
    const context = await openHomeDatabase(home);
    createApplication(context.db, { company: 'Acme', role: 'Architect' });
    context.db.close();
    const output = path.join(root, 'resume.pdf');
    const requestFile = path.join(root, 'request.json');
    await writeFile(requestFile, JSON.stringify({ applicationId: 'acme-architect', materialKind: 'resume', requestedOutput: output }));
    const io = memoryIO();
    await materialCommand({ subcommand: 'prepare', options: { home, request: requestFile } }, io);
    const result = JSON.parse(io.stdout);
    assert.equal(result.artifact.lifecycle, 'draft');
    assert.equal(result.artifact.verification, 'passed');
    assert.deepEqual(result.verificationEvidence.ruleFiles, [
      path.join(process.cwd(), 'config', 'material-rules', 'us-resume-default.md'),
      rules,
    ]);
    assert.equal(result.artifact.storagePath.includes(`${path.sep}.career-journal${path.sep}artifacts${path.sep}`), true);
    assert.equal(await readFile(result.artifact.storagePath, 'utf8'), '%PDF generated');
    const inspect = await openHomeDatabase(home);
    assert.equal(inspect.db.prepare('SELECT COUNT(*) count FROM artifacts').get().count, 1);
    inspect.db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
