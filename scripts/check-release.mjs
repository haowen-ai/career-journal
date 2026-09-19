#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

async function readable(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function candidateFiles(root) {
  const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root });
  return stdout.split('\n').filter(Boolean);
}

export async function checkRelease(root) {
  const checks = [];
  const errors = [];
  const check = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    if (!ok) errors.push(`${id}: ${detail}`);
  };
  const read = (file) => readFile(path.join(root, file), 'utf8');

  let version = '';
  let packageJson = {};
  let changelog = '';
  try {
    [version, packageJson, changelog] = await Promise.all([
      read('VERSION').then((text) => text.trim()),
      read('package.json').then(JSON.parse),
      read('CHANGELOG.md'),
    ]);
    check('version-consistency', version === packageJson.version && changelog.includes(`## [${version}]`), `${version} / ${packageJson.version}`);
  } catch (error) { check('version-consistency', false, error.message); }

  try {
    const notices = await read('THIRD_PARTY_NOTICES.md');
    check('attribution', /career-ops-hq\/career-ops/.test(notices) && /Santiago Fernández de Valderrama/.test(notices) && /typesafe-ai\/skills/.test(notices) && /TypeSafe AI/.test(notices) && /tabler\/tabler-icons/.test(notices), 'CareerOps, TypeSafe, and Tabler attribution');
  } catch (error) { check('attribution', false, error.message); }

  const licenseFiles = ['LICENSE', 'LICENSES/career-ops-MIT.txt', 'LICENSES/typesafe-ai-skills-MIT.txt', 'LICENSES/tabler-icons-MIT.txt'];
  const licenses = await Promise.all(licenseFiles.map(async (file) => (await readable(path.join(root, file))) && /MIT License/.test(await read(file))));
  check('licenses', licenses.every(Boolean), licenseFiles.join(', '));
  check('changelog', /### Added/.test(changelog) && /### Changed/.test(changelog) && /### Fixed/.test(changelog) && /### Security/.test(changelog), 'required changelog sections');

  try {
    const [englishReadme, chineseReadme, chineseNotices, chineseBridge, englishResumeRules, chineseResumeRules, chineseChangelog, bugTemplate, dogfoodTemplate, pullRequestTemplate] = await Promise.all([
      read('README.md'),
      read('README.zh-CN.md'),
      read('THIRD_PARTY_NOTICES.zh-CN.md'),
      read('docs/integrations/careerops-bridge.zh-CN.md'),
      read('config/material-rules/us-resume-default.md'),
      read('config/material-rules/us-resume-default.zh-CN.md'),
      read('CHANGELOG.zh-CN.md'),
      read('.github/ISSUE_TEMPLATE/bug.yml'),
      read('.github/ISSUE_TEMPLATE/dogfood.yml'),
      read('.github/pull_request_template.md'),
    ]);
    const bilingual = /\[简体中文\]\(README\.zh-CN\.md\)/.test(englishReadme)
      && /\[English\]\(README\.md\)/.test(chineseReadme)
      && /### 快速开始/.test(chineseReadme)
      && /## 每日自动化/.test(chineseReadme)
      && /## 数据与隐私/.test(chineseReadme)
      && /career-ops-hq\/career-ops/.test(chineseNotices)
      && /tabler\/tabler-icons/.test(chineseNotices)
      && /CareerOps JSON 桥接契约/.test(chineseBridge)
      && /\[简体中文\]\(us-resume-default\.zh-CN\.md\)/.test(englishResumeRules)
      && /\[English\]\(us-resume-default\.md\)/.test(chineseResumeRules)
      && chineseChangelog.includes(`## [${version}]`)
      && /缺陷报告/.test(bugTemplate)
      && /全新克隆/.test(dogfoodTemplate)
      && /问题与最终行为/.test(pullRequestTemplate);
    check('bilingual-docs', bilingual, 'English and Simplified Chinese onboarding, changelog, notices, integration docs, resume rules, and contribution templates');
    const productReadme = englishReadme.indexOf('## What it does') > 0
      && englishReadme.indexOf('## Product preview') > englishReadme.indexOf('## What it does')
      && englishReadme.indexOf('## Install') > englishReadme.indexOf('## Product preview')
      && chineseReadme.indexOf('## 它能做什么') > 0
      && chineseReadme.indexOf('## 产品界面') > chineseReadme.indexOf('## 它能做什么')
      && chineseReadme.indexOf('## 安装') > chineseReadme.indexOf('## 产品界面')
      && /docs\/assets\/dashboard-preview\.png/.test(englishReadme)
      && /docs\/assets\/dashboard-preview\.png/.test(chineseReadme)
      && /http:\/\/career-journal\.localhost:<port>/.test(englishReadme)
      && /http:\/\/career-journal\.localhost:<port>/.test(chineseReadme);
    const dashboardPreview = await readFile(path.join(root, 'docs/assets/dashboard-preview.png'));
    const screenshotOk = dashboardPreview.length > 10_000
      && dashboardPreview.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    check('product-readme', productReadme && screenshotOk, 'product explanation, real browser preview, workflows, and installation order in both languages');
  } catch (error) { check('bilingual-docs', false, error.message); }

  const files = await candidateFiles(root);
  const textFiles = files.filter((file) => /\.(?:mjs|js|json|md|yml|yaml|txt|html|css)$/.test(file));
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}\b/,
    /\b(?:password|token|api_key)\s*[:=]\s*["'][^"'\n]{8,}["']/i,
  ];
  let secretFile = null;
  for (const file of textFiles) {
    const content = await read(file);
    if (secretPatterns.some((pattern) => pattern.test(content))) { secretFile = file; break; }
  }
  check('tracked-secrets', secretFile === null, secretFile ?? 'none found');

  let missingImport = null;
  for (const file of textFiles.filter((item) => item.endsWith('.mjs'))) {
    const content = await read(file);
    for (const match of content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const resolved = path.resolve(root, path.dirname(file), match[1]);
      if (!(await readable(resolved))) { missingImport = `${file}: ${match[1]}`; break; }
    }
    if (missingImport) break;
  }
  check('local-imports', missingImport === null, missingImport ?? 'all local imports resolve');
  return { ok: errors.length === 0, checks, errors };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const report = await checkRelease(process.cwd());
  for (const item of report.checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id}: ${item.detail}`);
  if (!report.ok) process.exitCode = 1;
}
