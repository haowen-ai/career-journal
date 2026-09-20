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

test('Getting Started smoke block executes against a clean home', async () => {
  const guide = await readFile('docs/getting-started.md', 'utf8');
  const match = guide.match(/<!-- quickstart-smoke:start -->\s*```sh\n([^]*?)\n```\s*<!-- quickstart-smoke:end -->/);
  assert.ok(match, 'Getting Started smoke block is missing');
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

test('README is a concise product landing page with one Agent setup sentence', async () => {
  const [english, chinese, agentInstructions] = await Promise.all([
    readFile('README.md', 'utf8'),
    readFile('README.zh-CN.md', 'utf8'),
    readFile('AGENTS.md', 'utf8'),
  ]);
  assert.ok(english.split('\n').length < 100, 'English README should stay concise');
  assert.ok(chinese.split('\n').length < 100, 'Chinese README should stay concise');
  assert.match(english, /## One-line setup/i);
  assert.match(chinese, /## 一句话安装/);
  assert.match(english, /Codex, Claude Code/i);
  assert.match(chinese, /Codex、Claude Code/);
  for (const readme of [english, chinese]) {
    assert.match(readme, /https:\/\/github\.com\/haowenchen0811\/career-journal/);
    assert.match(readme, /docs\/getting-started/);
    assert.doesNotMatch(readme, /#### Agent-first setup: choose one entry point|由 Agent 自动配置：任选一种入口/i);
    assert.doesNotMatch(readme, /--email-provider imap|automation register-external|codexCommandLine/);
  }
  assert.match(agentInstructions, /\.agents\/skills\/career-journal\/SKILL\.md/);
});

test('the repository-driven first run offers a review-before-write history import from a current checkout', async () => {
  const [englishReadme, chineseReadme, agentInstructions, englishSkill, chineseSkill, englishGuide, chineseGuide] = await Promise.all([
    readFile('README.md', 'utf8'),
    readFile('README.zh-CN.md', 'utf8'),
    readFile('AGENTS.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.zh-CN.md', 'utf8'),
    readFile('docs/getting-started.md', 'utf8'),
    readFile('docs/getting-started.zh-CN.md', 'utf8'),
  ]);

  assert.match(englishReadme, /Get the latest version of CAREER JOURNAL from https:\/\/github\.com\/haowenchen0811\/career-journal/);
  assert.match(chineseReadme, /请从 https:\/\/github\.com\/haowenchen0811\/career-journal 获取最新版本并自动安装配置 CAREER JOURNAL/);

  for (const document of [agentInstructions, englishSkill, englishGuide]) {
    assert.match(document, /asks? (?:the user )?whether (?:they want to|to) import (?:their )?(?:existing|historical|past) applications/i);
    assert.match(document, /read-only mailbox|file|spreadsheet|interview/i);
    assert.match(document, /candidate records/i);
    assert.match(document, /confirm[^\n]*before[^\n]*(?:writ|commit|record)/i);
    assert.match(document, /do(?:es)? not infer[^\n]*(?:date|status|submitted material)/i);
    assert.match(document, /skip/i);
  }

  for (const document of [chineseSkill, chineseGuide]) {
    assert.match(document, /询问用户是否(?:需要|希望)导入历史投递/);
    assert.match(document, /只读邮箱|文件|表格|问答/);
    assert.match(document, /候选记录/);
    assert.match(document, /确认后再写入/);
    assert.match(document, /不得推测[^\n]*(?:日期|状态|实际提交材料)/);
    assert.match(document, /跳过/);
  }
});

test('Agent onboarding discovers and selects one or more host mailboxes without extra model credentials', async () => {
  const [agentInstructions, englishSkill, chineseSkill, englishGuide, chineseGuide, englishPrd, chinesePrd, englishReadme, chineseReadme] = await Promise.all([
    readFile('AGENTS.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.zh-CN.md', 'utf8'),
    readFile('docs/getting-started.md', 'utf8'),
    readFile('docs/getting-started.zh-CN.md', 'utf8'),
    readFile('docs/superpowers/specs/2026-09-19-job-search-ops-prd-design.en.md', 'utf8'),
    readFile('docs/superpowers/specs/2026-09-19-job-search-ops-prd-design.md', 'utf8'),
    readFile('README.md', 'utf8'),
    readFile('README.zh-CN.md', 'utf8'),
  ]);
  for (const document of [agentInstructions, englishSkill, englishGuide]) {
    assert.match(document, /discover[^\n]*(?:Apple Mail|host)[^\n]*accounts/i);
    assert.match(document, /which (?:one or more|account or accounts)[^\n]*job search/i);
    assert.match(document, /sign in[^\n]*(?:Apple Mail|mail app)/i);
    assert.match(document, /current (?:coding )?Agent[^\n]*(?:Jev|semantic)/i);
    assert.match(document, /do not ask[^\n]*(?:Base URL|API key)/i);
  }
  for (const document of [chineseSkill, chineseGuide]) {
    assert.match(document, /识别[^\n]*(?:Apple Mail|宿主)[^\n]*邮箱账号/);
    assert.match(document, /一个或多个[^\n]*求职/);
    assert.match(document, /登录[^\n]*(?:Apple Mail|邮件应用)/);
    assert.match(document, /当前[^\n]*Agent[^\n]*(?:Jev|语义)/);
    assert.match(document, /不(?:要|得)询问[^\n]*(?:Base URL|API Key)/i);
  }

  for (const document of [agentInstructions, englishSkill, englishGuide, englishPrd]) {
    assert.doesNotMatch(document, /without Jev[^\n]*asks? for an OpenAI-compatible/i);
    assert.doesNotMatch(document, /without Jev[^\n]*(?:Base URL|API-key environment)/i);
  }
  for (const document of [chineseSkill, chineseGuide, chinesePrd]) {
    assert.doesNotMatch(document, /没有 Jev[^\n]*(?:询问|提供)[^\n]*(?:Base URL|API Key|环境变量)/i);
    assert.doesNotMatch(document, /没有 Jev 权限[^\n]*OpenAI-compatible/i);
  }

  assert.match(englishReadme, /latest version[^\n]*existing checkout[^\n]*(?:fast-forward|fresh isolated clone)/i);
  assert.match(chineseReadme, /最新版本[^\n]*已有[^\n]*(?:安全快进|隔离副本)/);
  assert.match(agentInstructions, /before reading local onboarding instructions[^\n]*(?:fetch|latest)/i);
  assert.match(agentInstructions, /attempt account discovery before asking/i);
  assert.match(agentInstructions, /do not ask whether Jev is available/i);
});

test('macOS mailbox discovery enumerates the full Apple Mail account inventory', async () => {
  const [agentInstructions, englishSkill, chineseSkill, englishGuide, chineseGuide] = await Promise.all([
    readFile('AGENTS.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.zh-CN.md', 'utf8'),
    readFile('docs/getting-started.md', 'utf8'),
    readFile('docs/getting-started.zh-CN.md', 'utf8'),
  ]);
  for (const document of [agentInstructions, englishSkill, englishGuide]) {
    assert.match(document, /All Inboxes/i);
    assert.match(document, /main (?:Mail )?window/i);
    assert.match(document, /every top-level account|complete account inventory/i);
    assert.match(document, /selected message[^\n]*not[^\n]*(?:account inventory|all accounts)/i);
    assert.match(document, /Mail Settings[^\n]*Accounts/i);
    assert.match(document, /count[^\n]*(?:disagree|mismatch)[^\n]*(?:do not|must not)[^\n]*(?:complete|finished)/i);
  }
  for (const document of [chineseSkill, chineseGuide]) {
    assert.match(document, /All Inboxes/i);
    assert.match(document, /Mail 主窗口|邮件主窗口/);
    assert.match(document, /全部顶层账号|完整账号清单/);
    assert.match(document, /当前选中邮件[^\n]*不能[^\n]*(?:完整账号|全部账号)/);
    assert.match(document, /Mail 设置[^\n]*账户/);
    assert.match(document, /数量[^\n]*(?:不一致|不匹配)[^\n]*不得[^\n]*(?:完成|完整)/);
  }
});

test('English and Chinese landing pages use matching-language product previews', async () => {
  const [english, chinese] = await Promise.all([
    readFile('README.md', 'utf8'),
    readFile('README.zh-CN.md', 'utf8'),
  ]);
  assert.match(english, /docs\/assets\/dashboard-preview\.en\.png/);
  assert.doesNotMatch(english, /dashboard-preview\.zh-CN\.png/);
  assert.match(chinese, /docs\/assets\/dashboard-preview\.zh-CN\.png/);
  assert.doesNotMatch(chinese, /dashboard-preview\.en\.png/);
  for (const [locale, file] of [['en', 'dashboard-preview.en'], ['zh-CN', 'dashboard-preview.zh-CN']]) {
    const preview = await readFile(`docs/assets/${file}.png`);
    const manifest = JSON.parse(await readFile(`docs/assets/${file}.json`, 'utf8'));
    assert.equal(preview.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(preview.length > 10_000, `${locale} preview must be a real browser screenshot`);
    assert.equal(createHash('sha256').update(preview).digest('hex'), manifest.sha256);
    assert.equal(preview.readUInt32BE(16), manifest.width);
    assert.equal(preview.readUInt32BE(20), manifest.height);
    assert.equal(manifest.locale, locale);
    assert.equal(manifest.fixture, 'synthetic-big-company-demo');
    assert.deepEqual(manifest.companies, ['Apple · Demo', 'Google · Demo', 'Microsoft · Demo', 'NVIDIA · Demo', 'Amazon · Demo', 'Meta · Demo', 'Tesla · Demo']);
  }
  assert.match(english, /synthetic big-company examples/i);
  assert.match(english, /do not represent real applications, outcomes, affiliations, or endorsements/i);
  assert.match(chinese, /虚构的演示数据/);
  assert.match(chinese, /不代表真实投递、求职结果、合作关系或官方背书/);
});

test('bilingual Getting Started guides retain the complete operating contract', async () => {
  const [english, chinese] = await Promise.all([
    readFile('docs/getting-started.md', 'utf8'),
    readFile('docs/getting-started.zh-CN.md', 'utf8'),
  ]);
  assert.match(english, /\[简体中文\]\(getting-started\.zh-CN\.md\)/);
  assert.match(chinese, /\[English\]\(getting-started\.md\)/);
  for (const phrase of ['Codex', 'Claude Code', 'newly released Jev', 'OpenAI-compatible', 'manual review', 'TYPESAFE_API_KEY', 'career-journal start', 'career-journal automation', 'career-journal update', 'career-journal migrate', 'career-journal backup', 'Uninstall', 'CareerOps']) {
    assert.match(english, new RegExp(phrase, 'i'));
  }
  assert.match(english, /read-only (?:email|mailbox)/i);
  for (const phrase of ['Codex', 'Claude Code', '每日自动化', '数据与隐私', '更新、迁移、备份与卸载', 'CareerOps', 'Jev', '新发布', '大语言模型']) {
    assert.match(chinese, new RegExp(phrase, 'i'));
  }
  assert.match(english, /(?:without Jev|Jev is unavailable)[^\n]*(?:current Agent|current coding Agent)/i);
  assert.match(chinese, /Jev[^\n]*2026 年 9 月 15 日/);
});

test('Getting Started uses the computer timezone and documents material rules', async () => {
  const [english, chinese] = await Promise.all([
    readFile('docs/getting-started.md', 'utf8'),
    readFile('docs/getting-started.zh-CN.md', 'utf8'),
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

test('Getting Started keeps the mailbox and two-schedule verification contract', async () => {
  const [english, chinese] = await Promise.all([
    readFile('docs/getting-started.md', 'utf8'),
    readFile('docs/getting-started.zh-CN.md', 'utf8'),
  ]);
  for (const guide of [english, chinese]) {
    assert.doesNotMatch(guide, /--skip-email/);
    for (const phrase of ['--email-provider imap', '--email-provider host', '--email-address', 'email verify-imap', 'email sync-host', 'automation register-external', 'automation verify', 'codexCommandLine', 'mail-sync', 'deadline-review', '20:00', '20:15', 'http://career-journal.localhost:<port>']) {
      assert.match(guide, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(guide, /automation run[^\n]*--external-id/);
    assert.doesNotMatch(guide, /(?:daily-consolidation[^\n]*22:00|22:00[^\n]*daily-consolidation)/i);
    assert.doesNotMatch(guide, /(?:local-backup[^\n]*23:00|23:00[^\n]*local-backup)/i);
  }
  assert.match(english, /manual EML[^\n]*(fallback|one-off)/i);
  assert.match(chinese, /手动(?:导入 )?EML[^\n]*(备用|临时|单次)/i);
  assert.match(english, /doctor[^\n]*pass/i);
  assert.match(chinese, /doctor[^\n]*通过/i);
  assert.match(english, /36 hours/i);
  assert.match(chinese, /36 小时/i);
});

test('Codex onboarding uses one shared heartbeat and the Agent performs host mail sync', async () => {
  const [agentInstructions, englishSkill, chineseSkill, englishGuide, chineseGuide] = await Promise.all([
    readFile('AGENTS.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.zh-CN.md', 'utf8'),
    readFile('docs/getting-started.md', 'utf8'),
    readFile('docs/getting-started.zh-CN.md', 'utf8'),
  ]);
  for (const document of [agentInstructions, englishSkill, englishGuide]) {
    assert.match(document, /one shared (?:Codex )?heartbeat/i);
    assert.match(document, /BYMINUTE=0,15/i);
    assert.match(document, /Agent (?:itself )?(?:acts as|is) the host (?:mail )?connector/i);
    assert.match(document, /(?:write|generate)[\s\S]{0,300}(?:read-only )?host sync batch/i);
    assert.match(document, /email sync-host/i);
  }
  for (const document of [chineseSkill, chineseGuide]) {
    assert.match(document, /一个共享的 Codex heartbeat|单个共享的 Codex heartbeat/);
    assert.match(document, /BYMINUTE=0,15/);
    assert.match(document, /Agent 自身就是宿主邮箱连接器|Agent 自己充当宿主邮箱连接器/);
    assert.match(document, /(?:生成|写入)[\s\S]{0,300}只读同步批次/);
    assert.match(document, /email sync-host/);
  }
});
