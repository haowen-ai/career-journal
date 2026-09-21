import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = [
  '.agents/skills/career-journal/SKILL.md',
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
  assert.match(text, /career-journal doctor/);
  assert.match(text, /draft/i);
  assert.match(text, /submitted artifact/i);
  assert.match(text, /Agent-managed|host-managed/i);
  assert.match(text, /register-external/);
  assert.match(text, /email sync-host/);
  assert.match(text, /manual EML[^\n]*fallback/i);
  assert.match(text, /doctor[^\n]*pass/i);
  assert.match(text, /node \.\/bin\/career-journal\.mjs/);
  assert.match(text, /codexCommandLine/);
  assert.match(text, /automation_update/);
  assert.match(text, /Native `mail-sync` installation is deliberately blocked/i);
});

test('career-journal skill has paired English and Simplified Chinese contracts', async () => {
  const [english, chinese] = await Promise.all([
    readFile('.agents/skills/career-journal/SKILL.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.zh-CN.md', 'utf8'),
  ]);

  assert.match(english, /\[简体中文\]\(SKILL\.zh-CN\.md\)/);
  assert.match(chinese, /\[English\]\(SKILL\.md\)/);
  assert.match(english, /read the saved cursor[^\n]*beforeCursor/i);
  assert.match(english, /every message received[^\n]*previous 24 hours/i);
  assert.match(english, /Do not prefilter[^\n]*(?:sender|company|recruiting)/i);
  assert.match(english, /paginate[^\n]*all result pages/i);
  assert.match(english, /rolling-24h-all-messages/i);
  assert.match(chinese, /读取[^\n]*已保存[^\n]*游标[^\n]*beforeCursor/i);
  assert.match(chinese, /过去完整 24 小时[^\n]*全部邮件/i);
  assert.match(chinese, /不得先用[^\n]*(?:发件人|公司|求职关键词)[^\n]*筛选/i);
  assert.match(chinese, /翻完全部结果页[^\n]*每一封邮件/i);
  assert.match(chinese, /rolling-24h-all-messages/i);

  for (const text of [english, chinese]) {
    assert.match(text, /IMAPS/i);
    assert.match(text, /careerops-materials/i);
    assert.match(text, /career-ops-hq\/career-ops|Santiago Fernández de Valderrama/i);
    assert.match(text, /Jev[^\n]*(?:primary semantic|主要语义|optional|可选)/i);
    assert.match(text, /manual review|人工复核/i);
    assert.match(text, /generic LLM|structured LLM|通用大模型|大语言模型/i);
    assert.match(text, /current (?:coding )?Agent|当前[^\n]*Agent/i);
    assert.match(text, /structured LLM|大语言模型/i);
    assert.match(text, /Semantic Versioning|SemVer|语义化版本/i);
    assert.match(text, /Git tag/i);
    assert.match(text, /GitHub Release/i);
    assert.match(text, /CHANGELOG/i);
    assert.match(text, /fresh[- ]clone/i);
    for (const contract of [
      /mail-sync[^\n]*20:00|20:00[^\n]*mail-sync/i,
      /deadline-review[^\n]*20:15|20:15[^\n]*deadline-review/i,
    ]) assert.match(text, contract);
    assert.match(text, /(?:two|required|两个|两项)[^\n]*(?:mail-sync|任务)/i);
    assert.match(text, /(?:backup|备份)[^\n]*(?:optional|on-demand|可选|按需)/i);
  }
});

test('CareerOps routing skill keeps facts and submitted evidence gated', async () => {
  const text = await readFile(files[1], 'utf8');
  assert.match(text, /CareerOps.*required/i);
  assert.match(text, /never (invent|fabricate)/i);
  assert.match(text, /prototype.*production/i);
  assert.match(text, /career-journal material (prepare|verify)/i);
  assert.match(text, /exact.*artifact/i);
  assert.match(text, /personal.*(?:skill|rule)/i);
  assert.match(text, /materialRules|ruleFiles|material-rules/i);
  assert.match(text, /us-resume-default\.md/);
});

test('dependency manifest pins CareerOps and makes Jev primary for semantic decisions', async () => {
  const text = await readFile('config/dependency-manifest.yml', 'utf8');
  assert.match(text, /career-ops[^]*version: "1\.32\.0"/);
  assert.match(text, /jev[^]*required: false/);
  assert.match(text, /access_state: user-configured/);
  assert.match(text, /role: primary-semantic-decision-engine/);
  assert.match(text, /agent_fallback: deterministic-rules-then-current-agent-review/);
  assert.match(text, /standalone_fallback: deterministic-rules-then-structured-llm-then-manual-review/);
  assert.match(text, /  email:\n    required: true/);
  assert.match(text, /  automation:\n    required: true/);
});

test('example config represents pending live IMAPS onboarding without mailbox credentials', async () => {
  const config = JSON.parse(await readFile('config/career-journal.example.json', 'utf8'));
  assert.equal(config.email.setupState, 'pending-verification');
  assert.equal(config.email.accounts[0].provider, 'imap');
  assert.equal(config.email.accounts[0].readOnly, true);
  assert.equal(config.automation.setupState, 'pending-registration');
  assert.equal(JSON.stringify(config.email).includes('secret'), false);
});
