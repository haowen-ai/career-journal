import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = [
  '.agents/skills/career-journal/SKILL.md',
  '.agents/skills/careerops-materials/SKILL.md',
  '.agents/skills/career-journal-apply/SKILL.md',
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

test('apply skill keeps fixed hard rules, own-tab batches, and evidence-gated status in both languages', async () => {
  const root = '.agents/skills/career-journal-apply';
  const [english, chinese, briefEn, briefZh, tipsEn, tipsZh] = await Promise.all([
    'SKILL.md', 'SKILL.zh-CN.md', 'references/fill-brief.md', 'references/fill-brief.zh-CN.md', 'references/ats-tips.md', 'references/ats-tips.zh-CN.md',
  ].map((file) => readFile(`${root}/${file}`, 'utf8')));

  assert.match(english, /^---\nname: career-journal-apply\n/);
  assert.match(english, /\[简体中文\]\(SKILL\.zh-CN\.md\)/);
  assert.match(chinese, /\[English\]\(SKILL\.md\)/);
  for (const text of [english, briefEn]) {
    assert.match(text, /Never click any button labelled Submit\*/);
    assert.match(text, /Never sign in, create accounts, or type passwords or verification codes/);
    assert.match(text, /Never tick consent, attestation, certification, or arbitration boxes, and never sign/);
    assert.match(text, /Never write essays[^\n]*Only organise the user's own words/);
    assert.match(text, /transcript only when the form makes a transcript a required field/);
    assert.match(text, /Upload exactly one resume/);
    assert.match(text, /one bullet per line, each line starting with "• "/);
    assert.match(text, /Never put personal data into the repository/);
  }
  for (const text of [chinese, briefZh]) {
    assert.match(text, /不点任何写着 Submit\*/);
    assert.match(text, /不替用户登录、注册账号，不输入密码或验证码/);
    assert.match(text, /不勾同意、声明、认证或仲裁条款，不代签名/);
    assert.match(text, /不写作文[^\n]*只整理用户自己说的话/);
    assert.match(text, /成绩单只在表单把成绩单设为必填项时上传/);
    assert.match(text, /只上传一份简历/);
    assert.match(text, /每条一行，行首加“• ”/);
    assert.match(text, /不把个人资料写进仓库/);
  }
  for (const text of [english, chinese]) {
    assert.match(text, /profile status --json/);
    assert.match(text, /pace\.batchSize/);
    assert.match(text, /queue verify --id <application> --result ok\|skip --reason/);
    assert.match(text, /application list --json/);
    assert.match(text, /profile answer --question/);
    assert.match(text, /event add [^\n]*--status-after applied/);
    assert.match(text, /task add [^\n]*--due-at[^\n]*--due-note[^\n]*--link/);
    for (const mark of ['🔑', '🤖', '❓', '👆', '✅']) assert.ok(text.includes(mark), `missing tab title ${mark}`);
  }
  assert.match(english, /own new tab and uses only that tab/);
  assert.match(chinese, /自己新开一个标签页，只用这一个标签页/);
  assert.match(english, /at most 4 at a time/);
  assert.match(chinese, /每次最多问用户 4 个/);
  assert.match(english, /Never reload a half-filled page/);
  assert.match(chinese, /不得为了解决问题而刷新填了一半的页面/);

  for (const tips of [tipsEn, tipsZh]) {
    for (const name of ['Workday', 'Oracle HCM', 'iCIMS', 'Greenhouse', 'Ashby', 'Lever', 'Yello', 'SuccessFactors']) {
      assert.match(tips, new RegExp(`^## [^\\n]*${name}`, 'm'), `missing ${name}`);
    }
    assert.match(tips, /button\[aria-haspopup\][^\n]*\[role=option\]/);
    assert.match(tips, /MessageChannel/);
    assert.match(tips, /root\.stateNode\.current !== root/);
    assert.match(tips, /iframe/);
  }
  for (const text of [english, chinese, briefEn, briefZh, tipsEn, tipsZh]) {
    assert.equal(text.includes('/Users/'), false);
    assert.equal(/[A-Z0-9._%+-]+@(?!example\.com)[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text), false);
  }
});

test('orchestrator runs the profile interview after doctor and routes roles, apply, and profile requests', async () => {
  const [english, chinese, agentInstructions] = await Promise.all([
    readFile('.agents/skills/career-journal/SKILL.md', 'utf8'),
    readFile('.agents/skills/career-journal/SKILL.zh-CN.md', 'utf8'),
    readFile('AGENTS.md', 'utf8'),
  ]);
  for (const text of [english, agentInstructions]) {
    assert.match(text, /profile interview[^\n]*(?:after|passes) [^\n]*doctor|after core onboarding passes `doctor`[^\n]*profile interview/i);
    assert.match(text, /at most 4 questions per round/i);
    assert.match(text, /options plus "Other"/);
    assert.match(text, /infer[^\n]*(?:first|existing)[^\n]*confirm/i);
    assert.match(text, /career-journal-apply/);
  }
  assert.match(english, /Find roles[^\n]*`scan run`[^\n]*`queue verify/);
  assert.match(english, /Apply, start applying[^\n]*career-journal-apply/);
  assert.match(english, /Profile, preferences, or form answers[^\n]*profile show\|questions\|set\|answer\|skip\|status/);
  assert.match(chinese, /`doctor`[^\n]*个人资料问答/);
  assert.match(chinese, /每轮最多问 4 个问题/);
  assert.match(chinese, /先推断，再确认/);
  assert.match(chinese, /找岗位[^\n]*`scan run`[^\n]*`queue verify/);
  assert.match(chinese, /投递、开始投[^\n]*career-journal-apply/);
  assert.match(chinese, /个人资料、偏好或表单答案[^\n]*profile show\|questions\|set\|answer\|skip\|status/);
});
