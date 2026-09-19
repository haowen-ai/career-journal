import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = [
  '.agents/skills/job-search-ops/SKILL.md',
  '.agents/skills/careerops-materials/SKILL.md',
];

test('repo skills have portable discovery frontmatter', async () => {
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.match(text, /^---\nname: [a-z0-9-]+\ndescription: Use when [^\n]+\n---\n/);
    assert.equal(text.includes('/Users/'), false);
  }
});

test('orchestrator names required and optional capabilities explicitly', async () => {
  const text = await readFile(files[0], 'utf8');
  for (const name of ['careerops-materials', 'PDF', 'Documents', 'email', 'automation', 'Wiki', 'Jev']) {
    assert.match(text, new RegExp(name, 'i'));
  }
  assert.match(text, /jobops doctor/);
  assert.match(text, /draft/i);
  assert.match(text, /submitted artifact/i);
});

test('CareerOps routing skill keeps facts and submitted evidence gated', async () => {
  const text = await readFile(files[1], 'utf8');
  assert.match(text, /CareerOps.*required/i);
  assert.match(text, /never (invent|fabricate)/i);
  assert.match(text, /prototype.*production/i);
  assert.match(text, /jobops material (prepare|verify)/i);
  assert.match(text, /exact.*artifact/i);
});

test('dependency manifest pins CareerOps and keeps Jev optional', async () => {
  const text = await readFile('config/dependency-manifest.yml', 'utf8');
  assert.match(text, /career-ops[^]*version: "1\.32\.0"/);
  assert.match(text, /jev[^]*required: false/);
  assert.match(text, /access_state: waitlisted/);
});
