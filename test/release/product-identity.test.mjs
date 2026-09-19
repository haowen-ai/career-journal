import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

test('publishes CAREER JOURNAL as the primary repository, package, CLI, and Skill identity', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const [english, chinese, englishGuide, chineseGuide, skill] = await Promise.all([
    readFile('README.md', 'utf8'),
    readFile('README.zh-CN.md', 'utf8'),
    readFile('docs/getting-started.md', 'utf8'),
    readFile('docs/getting-started.zh-CN.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.md', 'utf8'),
  ]);

  assert.equal(packageJson.name, '@haowenchen0811/career-journal');
  assert.equal(packageJson.repository.url, 'https://github.com/haowenchen0811/career-journal.git');
  assert.equal(packageJson.bin['career-journal'], 'bin/career-journal.mjs');
  assert.equal(packageJson.bin.jobops, 'bin/jobops.mjs');
  await access('bin/career-journal.mjs');
  await access('career-journal');
  await access('career-journal.cmd');
  assert.match(skill, /^---\nname: career-journal\n/m);
  for (const readme of [english, chinese]) {
    assert.match(readme, /github\.com\/haowenchen0811\/career-journal(?:\.git)?/);
    assert.doesNotMatch(readme, /git clone [^\n]*job-search-ops/);
  }
  assert.match(englishGuide, /career-journal start/);
  assert.match(chineseGuide, /career-journal start/);
});
