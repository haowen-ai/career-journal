import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const home = await mkdtemp(path.join(os.tmpdir(), 'career-journal-readme-'));
  try {
    for (const raw of match[1].split('\n').filter(Boolean)) {
      const line = raw.replaceAll('$REPO', process.cwd()).replaceAll('$CAREER_JOURNAL_HOME', home);
      const args = line.trim().split(/\s+/);
      const result = await run(process.execPath, args, process.cwd());
      assert.equal(result.code, 0, `${line}\n${result.output}`);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('README documents both modes and every lifecycle command', async () => {
  const readme = await readFile('README.md', 'utf8');
  for (const phrase of ['Codex-native', 'OpenAI-compatible', 'career-journal start', 'career-journal automation', 'career-journal update', 'career-journal migrate', 'career-journal backup', 'Uninstall', 'CareerOps', 'Jev', 'read-only email', 'THIRD_PARTY_NOTICES.md']) {
    assert.match(readme, new RegExp(phrase, 'i'));
  }
});

test('English and Simplified Chinese READMEs cross-link and cover onboarding', async () => {
  const [english, chinese] = await Promise.all([
    readFile('README.md', 'utf8'),
    readFile('README.zh-CN.md', 'utf8'),
  ]);
  assert.match(english, /\[\u7b80\u4f53\u4e2d\u6587\]\(README\.zh-CN\.md\)/);
  assert.match(chinese, /\[English\]\(README\.md\)/);
  for (const phrase of ['\u5feb\u901f\u5f00\u59cb', '\u4e24\u79cd\u8fd0\u884c\u6a21\u5f0f', '\u6bcf\u65e5\u81ea\u52a8\u5316', '\u6570\u636e\u4e0e\u9690\u79c1', '\u66f4\u65b0\u3001\u8fc1\u79fb\u3001\u5907\u4efd\u4e0e\u5378\u8f7d', 'CareerOps', 'Jev']) {
    assert.match(chinese, new RegExp(phrase, 'i'));
  }
});

test('onboarding uses the computer timezone and documents built-in and personal material rules', async () => {
  const [english, chinese] = await Promise.all([
    readFile('README.md', 'utf8'),
    readFile('README.zh-CN.md', 'utf8'),
  ]);
  assert.doesNotMatch(english, /setup[^\n]*--timezone America\/Chicago/);
  assert.doesNotMatch(chinese, /setup[^\n]*--timezone America\/Chicago/);
  assert.match(english, /computer.*time ?zone/i);
  assert.match(chinese, /电脑.*时区/);
  assert.match(english, /us-resume-default\.md/);
  assert.match(chinese, /us-resume-default\.md/);
  assert.match(english, /--material-rules/);
  assert.match(chinese, /--material-rules/);
});

test('README leads with the product, interface, and workflows before installation', async () => {
  const [english, chinese] = await Promise.all([
    readFile('README.md', 'utf8'),
    readFile('README.zh-CN.md', 'utf8'),
  ]);
  for (const [readme, product, preview, install] of [
    [english, '## What it does', '## Product preview', '## Install'],
    [chinese, '## 它能做什么', '## 产品界面', '## 安装'],
  ]) {
    assert.ok(readme.indexOf(product) > 0, `missing ${product}`);
    assert.ok(readme.indexOf(preview) > readme.indexOf(product), `${preview} must follow the product explanation`);
    assert.ok(readme.indexOf(install) > readme.indexOf(preview), `${install} must follow the interface preview`);
    assert.match(readme, /!\[[^\]]+\]\(docs\/assets\/dashboard-preview\.png\)/);
  }
  const preview = await readFile('docs/assets/dashboard-preview.png');
  const previewManifest = JSON.parse(await readFile('docs/assets/dashboard-preview.json', 'utf8'));
  assert.equal(preview.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(preview.length > 10_000, 'dashboard preview must be a real browser screenshot');
  assert.equal(createHash('sha256').update(preview).digest('hex'), previewManifest.sha256);
  assert.equal(preview.readUInt32BE(16), previewManifest.width);
  assert.equal(preview.readUInt32BE(20), previewManifest.height);
  assert.equal(previewManifest.fixture, 'synthetic-big-company-demo');
  assert.deepEqual(previewManifest.companies, ['Apple · Demo', 'Google · Demo', 'Microsoft · Demo', 'NVIDIA · Demo', 'Amazon · Demo', 'Meta · Demo', 'Tesla · Demo']);
  assert.match(english, /synthetic big-company examples/i);
  assert.match(english, /do not represent real applications, outcomes, affiliations, or endorsements/i);
  assert.match(chinese, /大厂名称作为合成演示数据/);
  assert.match(chinese, /不代表真实投递、结果、关联或背书/);
});

test('public onboarding uses the friendly localhost dashboard URL', async () => {
  const [english, chinese] = await Promise.all([
    readFile('README.md', 'utf8'),
    readFile('README.zh-CN.md', 'utf8'),
  ]);
  for (const readme of [english, chinese]) {
    assert.match(readme, /http:\/\/career-journal\.localhost:<port>/);
    assert.doesNotMatch(readme, /dashboard runs locally on `127\.0\.0\.1`|看板在本机 `127\.0\.0\.1` 运行/i);
  }
});
