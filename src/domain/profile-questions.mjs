// The first-run profile interview as data. The host Agent reads these questions and asks the
// user; the CLI never prompts interactively. Profile targets are dot-paths in profile.json;
// round 3 answers live in the private answers sheet (answers.md).

export const ANSWERS_TARGET = 'answers.md';

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

const option = (value, en, zh) => ({ value, label: { en, zh } });
const yesNo = [option(true, 'Yes', '是'), option(false, 'No', '否')];
const preferNotToSay = option('prefer-not-to-say', 'Prefer not to say', '不愿透露');

function question(key, round, group, label, prompts, details) {
  return {
    key,
    round,
    group,
    label,
    prompts,
    type: details.type,
    options: details.options ?? [],
    allowOther: details.allowOther ?? false,
    required: details.required,
    target: details.target,
    ...(details.default !== undefined ? { default: details.default } : {}),
    ...(details.example !== undefined ? { example: details.example } : {}),
  };
}

const directionOptions = [
  option('ai-ml', 'AI / machine learning', 'AI / 机器学习'),
  option('data-science', 'Data science', '数据科学'),
  option('data-analytics', 'Data analytics', '数据分析'),
  option('data-engineering', 'Data engineering', '数据工程'),
  option('software-engineering', 'Software engineering', '软件工程'),
  option('quant', 'Quantitative research or trading', '量化研究或交易'),
  option('product', 'Product management', '产品经理'),
  option('other', 'Other', '其他'),
];

const locationOption = (label, zh, match) => ({ value: { label, match }, label: { en: label, zh } });

export const profileRounds = deepFreeze([
  {
    round: 1,
    id: 'search',
    title: { en: 'What to look for', zh: '找什么样的职位' },
    intro: {
      en: 'These answers decide what the daily role scan keeps and how roles are ranked.',
      zh: '这些答案决定每日扫描保留哪些职位，以及职位的排序。',
    },
  },
  {
    round: 2,
    id: 'materials',
    title: { en: 'Materials', zh: '申请材料' },
    intro: {
      en: 'Files are referenced by path on this computer and never copied. Anything readable from the resume is pre-filled and only confirmed.',
      zh: '文件只记录在这台电脑上的路径，不会被复制。能从简历读到的内容会预先填好，只需确认。',
    },
  },
  {
    round: 3,
    id: 'answers',
    title: { en: 'Common form answers', zh: '常用表单答案' },
    intro: {
      en: 'Saved to your private answers sheet (answers.md) and reused on every form. Voluntary disclosures always allow "Prefer not to say".',
      zh: '保存在你的私密答案表（answers.md）中，每张表单都会复用。自愿披露类问题都可以选择“不愿透露”。',
    },
  },
  {
    round: 4,
    id: 'pace',
    title: { en: 'Scan sources, rules, and pace', zh: '扫描来源、规则与节奏' },
    intro: {
      en: 'Which companies and sources the daily role scan reads, batch size, daily scan time, and notifications. The hard rules below are always on and cannot be turned off.',
      zh: '每日岗位扫描读取哪些公司和来源、每批数量、每日扫描时间和通知方式。下列硬性规则始终生效，不能关闭。',
    },
  },
]);

// The fixed hard rules of the career-journal-apply Skill, word for word in both languages
// (.agents/skills/career-journal-apply/SKILL.md and SKILL.zh-CN.md). Round 4 shows them;
// nothing turns them off. Change them only together with the Skill and its fill brief.
export const hardRules = deepFreeze([
  {
    id: 'never-submit',
    en: 'Never click any button labelled Submit* (Submit, Submit Application, Submit Profile, and similar), even when it looks like an intermediate step, and never click any other button that sends the application. Stop before it; the user clicks it.',
    zh: '不点任何写着 Submit*（Submit、Submit Application、Submit Profile 等）的按钮，即使它看起来只是中间步骤；也不点其他任何会把申请发出去的按钮。停在它前面，由用户自己点。',
  },
  {
    id: 'never-sign-in',
    en: 'Never sign in, create accounts, or type passwords or verification codes for the user, and never solve or bypass a CAPTCHA.',
    zh: '不替用户登录、注册账号，不输入密码或验证码，也不做或绕过 CAPTCHA。',
  },
  {
    id: 'never-consent-or-sign',
    en: 'Never tick consent, attestation, certification, or arbitration boxes, and never sign: no drawn signature and no typed name or date entered as an e-signature.',
    zh: '不勾同意、声明、认证或仲裁条款，不代签名：不手写签名，也不输入姓名或日期作为电子签名。',
  },
  {
    id: 'never-write-essays',
    en: "Never write essays: cover letters, why-us, motivation, and supplemental answers are the user's. Only organise the user's own words.",
    zh: '不写作文：cover letter、why us、动机和补充问答都属于用户本人。只整理用户自己说的话。',
  },
  {
    id: 'transcript-only-when-required',
    en: 'Upload the transcript only when the form makes a transcript a required field; never into resume, optional, or "other attachments" slots.',
    zh: '成绩单只在表单把成绩单设为必填项时上传；不放进简历、可选或“其他附件”位置。',
  },
  {
    id: 'one-chosen-resume',
    en: 'Upload exactly one resume, the one the user chose: `materials.resumePath`, or a per-role version only when the user picked it for that role. Never substitute another version.',
    zh: '只上传一份简历，即用户选定的那份：`materials.resumePath`，或者用户为该岗位明确指定的版本。不换成其他版本。',
  },
  {
    id: 'one-bullet-per-line',
    en: 'Enter work descriptions one bullet per line, each line starting with "• ".',
    zh: '工作描述每条一行，行首加“• ”。',
  },
  {
    id: 'no-personal-data-in-repository',
    en: "Never put personal data into the repository. Profile, answers, resumes, transcripts, screenshots, filled briefs, and fill reports stay in the user's data home or a private temporary directory.",
    zh: '不把个人资料写进仓库。资料、答案表、简历、成绩单、截图、填好的任务说明和填表报告只放在用户的数据目录或私有临时目录。',
  },
]);

export const profileQuestions = deepFreeze([
  // Round 1: what to look for.
  question('job-type', 1, 'target',
    { en: 'Job type', zh: '职位类型' },
    { en: 'Are you looking for an internship or a full-time role?', zh: '你要找实习还是全职工作？' },
    {
      type: 'choice', required: true, target: 'search.jobType',
      options: [
        option('internship', 'Internship', '实习'),
        option('full-time', 'Full-time', '全职'),
        option('co-op', 'Co-op', 'Co-op（带薪实习学期）'),
        option('other', 'Other', '其他'),
      ],
    }),
  question('season', 1, 'target',
    { en: 'Season or start term', zh: '季度或入职时间' },
    {
      en: 'Which season or start term should the scan look for? For example Summer 2027, or Fall 2027 for a full-time start.',
      zh: '扫描哪个季度或入职时间的职位？例如 Summer 2027；全职可写 2027 年秋季入职。',
    },
    { type: 'text', required: true, allowOther: true, target: 'search.season', example: 'Summer 2027' }),
  question('directions-primary', 1, 'directions',
    { en: 'Primary directions', zh: '主要方向' },
    { en: 'Which directions are your primary targets? Pick one or more.', zh: '你的主要目标方向是哪些？可多选。' },
    { type: 'multi-choice', required: true, target: 'search.directions.primary', options: directionOptions }),
  question('directions-secondary', 1, 'directions',
    { en: 'Secondary directions', zh: '次要方向' },
    { en: 'Any secondary directions you would also consider? Optional.', zh: '还有哪些次要方向也愿意考虑？可不填。' },
    { type: 'multi-choice', required: false, target: 'search.directions.secondary', options: directionOptions }),
  question('locations', 1, 'locations',
    { en: 'Locations in order', zh: '按优先顺序的地点' },
    {
      en: 'Which cities or metro areas, in order of preference? The first one is your top choice.',
      zh: '想去哪些城市或都市圈？请按优先顺序列出，第一个最优先。',
    },
    {
      type: 'locations', required: true, allowOther: true, target: 'search.locations',
      options: [
        locationOption('Austin, TX', '奥斯汀（得州）', ['austin']),
        locationOption('Boston, MA', '波士顿（马萨诸塞州）', ['boston', 'cambridge, ma']),
        locationOption('Chicago, IL', '芝加哥（伊利诺伊州）', ['chicago']),
        locationOption('Los Angeles, CA', '洛杉矶（加州）', ['los angeles', 'santa monica']),
        locationOption('New York, NY', '纽约（纽约州）', ['new york', 'nyc', 'manhattan', 'brooklyn']),
        locationOption('San Francisco Bay Area, CA', '旧金山湾区（加州）', ['san francisco', 'bay area', 'palo alto', 'mountain view', 'menlo park', 'sunnyvale', 'san jose']),
        locationOption('Seattle, WA', '西雅图（华盛顿州）', ['seattle', 'bellevue', 'redmond']),
        locationOption('Washington, DC', '华盛顿特区', ['washington, dc', 'arlington, va']),
      ],
    }),
  question('remote-ok', 1, 'locations',
    { en: 'Remote OK', zh: '接受远程' },
    { en: 'Are remote roles OK?', zh: '可以接受远程岗位吗？' },
    { type: 'boolean', required: true, target: 'search.remoteOk', options: yesNo }),
  question('degree-level', 1, 'degree',
    { en: 'Degree', zh: '学位' },
    { en: 'Which degree are you studying for, or did you most recently complete?', zh: '你正在攻读或最近完成的是什么学位？' },
    {
      type: 'choice', required: true, target: 'candidate.degree.level',
      options: [
        option('bachelors', "Bachelor's", '本科'),
        option('masters', "Master's", '硕士'),
        option('phd', 'PhD', '博士'),
        option('mba', 'MBA', 'MBA'),
        option('other', 'Other', '其他'),
      ],
    }),
  question('major', 1, 'degree',
    { en: 'Major', zh: '专业' },
    { en: 'What is your major or field of study?', zh: '你的专业或研究方向是什么？' },
    { type: 'text', required: true, allowOther: true, target: 'candidate.degree.major', example: 'Computer Science' }),
  question('graduation', 1, 'degree',
    { en: 'Graduation month', zh: '毕业年月' },
    { en: 'When do you graduate? Give the year and month, such as 2027-05.', zh: '什么时候毕业？请写年和月，例如 2027-05。' },
    { type: 'month', required: true, allowOther: true, target: 'candidate.degree.graduation', example: '2027-05' }),
  question('authorization-status', 1, 'authorization',
    { en: 'Work authorization', zh: '工作许可' },
    {
      en: 'What is your work authorization in the country where you are applying?',
      zh: '你在申请所在国家的工作许可身份是什么？',
    },
    {
      type: 'choice', required: true, target: 'candidate.authorization.status',
      options: [
        option('citizen', 'Citizen', '公民'),
        option('permanent-resident', 'Permanent resident (green card)', '永久居民（绿卡）'),
        option('visa', 'Visa holder (for example F-1 CPT/OPT or H-1B)', '持签证（例如 F-1 CPT/OPT 或 H-1B）'),
        option('other', 'Other', '其他'),
      ],
    }),
  question('needs-sponsorship', 1, 'authorization',
    { en: 'Needs sponsorship', zh: '需要工作签证担保' },
    {
      en: 'Will you now or in the future need employer sponsorship for a work visa?',
      zh: '你现在或将来是否需要雇主为工作签证提供担保？',
    },
    { type: 'boolean', required: true, target: 'candidate.authorization.needsSponsorship', options: yesNo }),
  question('exclusions', 1, 'exclusions',
    { en: 'Hard exclusions', zh: '坚决排除' },
    {
      en: 'Anything you never want queued? Roles that match are dropped with the reason. Optional.',
      zh: '有没有坚决不要的职位？符合条件的职位会被排除并注明原因。可不填。',
    },
    {
      type: 'multi-choice', required: false, allowOther: true, target: 'search.exclusions',
      options: [
        option('no-return-offer', 'Roles that explicitly offer no return offer', '明确不提供转正机会的职位'),
        option('unpaid', 'Unpaid roles', '无薪职位'),
        option('staffing-agency', 'Staffing-agency or third-party contract roles', '猎头或第三方外包职位'),
      ],
    }),

  // Round 2: materials.
  question('resume-path', 2, 'resume',
    { en: 'Resume file', zh: '简历文件' },
    {
      en: 'Which resume file should every application use? Give the full path to the file on this computer. Per-role versions go through the careerops-materials Skill.',
      zh: '每个申请默认使用哪份简历？请提供这台电脑上的完整文件路径。针对单个职位的版本通过 careerops-materials Skill 生成。',
    },
    { type: 'path', required: true, allowOther: true, target: 'materials.resumePath', example: '~/job-search/resume.pdf' }),
  question('transcript-path', 2, 'transcript',
    { en: 'Transcript file', zh: '成绩单文件' },
    {
      en: 'Optional: the path to your transcript. It is uploaded only when a site makes the transcript a required field, never into other attachments.',
      zh: '可选：成绩单文件路径。只有网站把成绩单设为必填项时才会上传，绝不放进“其他附件”。',
    },
    { type: 'path', required: false, allowOther: true, target: 'materials.transcriptPath', example: '~/job-search/transcript.pdf' }),
  question('transcript-policy', 2, 'transcript',
    { en: 'Transcript upload rule', zh: '成绩单上传规则' },
    {
      en: 'When may the transcript be uploaded? The default is only when the site marks it required.',
      zh: '什么时候可以上传成绩单？默认只在网站设为必填时上传。',
    },
    {
      type: 'choice', required: true, target: 'materials.transcriptPolicy', default: 'required-only',
      options: [
        option('required-only', 'Only when the site marks it required (default)', '仅在网站设为必填时上传（默认）'),
        option('never', 'Never; stop and ask me instead', '从不上传，遇到时先问我'),
      ],
    }),
  question('linkedin', 2, 'links',
    { en: 'LinkedIn', zh: 'LinkedIn' },
    { en: 'Your LinkedIn profile URL. Optional.', zh: '你的 LinkedIn 主页链接。可不填。' },
    { type: 'url', required: false, allowOther: true, target: 'materials.links.linkedin', example: 'https://www.linkedin.com/in/your-handle' }),
  question('github', 2, 'links',
    { en: 'GitHub', zh: 'GitHub' },
    { en: 'Your GitHub profile URL. Optional.', zh: '你的 GitHub 主页链接。可不填。' },
    { type: 'url', required: false, allowOther: true, target: 'materials.links.github', example: 'https://github.com/your-handle' }),
  question('website', 2, 'links',
    { en: 'Personal website', zh: '个人网站' },
    { en: 'Your personal website or portfolio URL. Optional.', zh: '你的个人网站或作品集链接。可不填。' },
    { type: 'url', required: false, allowOther: true, target: 'materials.links.website', example: 'https://alex.example.com' }),
  question('experience-confirmed', 2, 'experience',
    { en: 'Education and experience confirmed', zh: '教育与工作经历已确认' },
    {
      en: 'The Agent reads your education and each job from the resume (company, title, location, start and end month, and each bullet). Confirm them one by one; job descriptions are entered one bullet per line, each starting with "• ".',
      zh: 'Agent 会从简历读取教育经历和每段工作（公司、职位、地点、起止年月和每条要点），请逐条确认；工作描述每行一条，以“• ”开头。',
    },
    {
      type: 'confirm', required: true, target: 'materials.experienceConfirmed',
      options: [option(true, 'Confirmed', '已确认'), option(false, 'Not yet', '还没有')],
    }),

  // Round 3: common form answers, stored in answers.md.
  question('legal-name', 3, 'identity',
    { en: 'Legal name', zh: '法定姓名' },
    { en: 'Your full legal name, exactly as forms should show it.', zh: '你的法定全名，按表单应填写的样子。' },
    { type: 'text', required: true, allowOther: true, target: ANSWERS_TARGET, example: 'Alex Example' }),
  question('preferred-name', 3, 'identity',
    { en: 'Preferred name', zh: '常用名' },
    { en: 'Your preferred first name, if it differs from your legal name. Optional.', zh: '如果和法定名不同，你的常用名是什么？可不填。' },
    { type: 'text', required: false, allowOther: true, target: ANSWERS_TARGET, example: 'Alex' }),
  question('email', 3, 'identity',
    { en: 'Email', zh: '电子邮箱' },
    { en: 'The email address to put on applications.', zh: '申请表上填写的电子邮箱。' },
    { type: 'text', required: true, allowOther: true, target: ANSWERS_TARGET, example: 'alex@example.com' }),
  question('phone', 3, 'identity',
    { en: 'Phone', zh: '电话' },
    { en: 'Your phone number, including the country code.', zh: '你的电话号码，包含国家区号。' },
    { type: 'text', required: true, allowOther: true, target: ANSWERS_TARGET, example: '+1 555 0100' }),
  question('address', 3, 'identity',
    { en: 'Address', zh: '地址' },
    { en: 'Your mailing address, or at least city, state or province, and postal code.', zh: '你的通讯地址，至少包含城市、州或省和邮编。' },
    { type: 'text', required: true, allowOther: true, target: ANSWERS_TARGET, example: '100 Example Street, New York, NY 10001' }),
  question('gender', 3, 'voluntary',
    { en: 'Gender', zh: '性别' },
    { en: 'Gender, for voluntary self-identification sections.', zh: '性别（用于表单中的自愿披露部分）。' },
    {
      type: 'choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [
        option('female', 'Female', '女'),
        option('male', 'Male', '男'),
        option('non-binary', 'Non-binary', '非二元'),
        preferNotToSay,
      ],
    }),
  question('race-ethnicity', 3, 'voluntary',
    { en: 'Race and ethnicity', zh: '种族与族裔' },
    { en: 'Race and ethnicity, for voluntary self-identification sections. Pick all that apply.', zh: '种族与族裔（用于自愿披露部分），可多选。' },
    {
      type: 'multi-choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [
        option('hispanic-latino', 'Hispanic or Latino', '西班牙裔或拉丁裔'),
        option('american-indian-alaska-native', 'American Indian or Alaska Native', '美洲印第安人或阿拉斯加原住民'),
        option('asian', 'Asian', '亚裔'),
        option('black-african-american', 'Black or African American', '黑人或非裔美国人'),
        option('native-hawaiian-pacific-islander', 'Native Hawaiian or Other Pacific Islander', '夏威夷原住民或其他太平洋岛民'),
        option('white', 'White', '白人'),
        option('two-or-more', 'Two or more races', '两个或以上种族'),
        preferNotToSay,
      ],
    }),
  question('veteran-status', 3, 'voluntary',
    { en: 'Veteran status', zh: '退伍军人身份' },
    { en: 'Veteran status, for voluntary self-identification sections.', zh: '退伍军人身份（用于自愿披露部分）。' },
    {
      type: 'choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [
        option('not-a-protected-veteran', 'I am not a protected veteran', '我不是受保护的退伍军人'),
        option('protected-veteran', 'I identify as one or more protected veteran classifications', '我属于一种或多种受保护的退伍军人类别'),
        preferNotToSay,
      ],
    }),
  question('disability-status', 3, 'voluntary',
    { en: 'Disability status', zh: '残障状况' },
    { en: 'Disability status, for voluntary self-identification sections.', zh: '残障状况（用于自愿披露部分）。' },
    {
      type: 'choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [
        option('no', 'No, I do not have a disability', '没有残障'),
        option('yes', 'Yes, I have a disability or have had one in the past', '有残障，或过去曾有'),
        preferNotToSay,
      ],
    }),
  question('languages', 3, 'background',
    { en: 'Languages', zh: '语言' },
    { en: 'Which languages do you speak, and at what level?', zh: '你会哪些语言？各自是什么水平？' },
    { type: 'text', required: false, allowOther: true, target: ANSWERS_TARGET, example: 'English (fluent); Spanish (conversational)' }),
  question('availability', 3, 'availability',
    { en: 'Availability', zh: '可入职时间' },
    { en: 'When can you start, or which dates can you work?', zh: '你什么时候可以入职，或者哪些日期可以工作？' },
    { type: 'text', required: false, allowOther: true, target: ANSWERS_TARGET, example: 'May 2027 to August 2027' }),
  question('full-time-availability', 3, 'availability',
    { en: 'Full-time availability', zh: '能否全职' },
    { en: 'Can you work full time, about 40 hours a week, for the whole term?', zh: '整个任职期间你能否全职工作（每周约 40 小时）？' },
    {
      type: 'choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [option('yes', 'Yes', '能'), option('no', 'No', '不能')],
    }),
  question('notice-period', 3, 'availability',
    { en: 'Notice period', zh: '离职通知期' },
    { en: 'How much notice do you need before you can start?', zh: '入职前你需要多长的通知期？' },
    {
      type: 'choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [
        option('none', 'None; available from the start date', '不需要，开始日期即可入职'),
        option('two-weeks', 'Two weeks', '两周'),
        option('one-month', 'One month', '一个月'),
      ],
    }),
  question('salary-expectation', 3, 'availability',
    { en: 'Expected salary wording', zh: '期望薪资的回答方式' },
    {
      en: 'How should expected-salary questions be answered? Wording without a number is common.',
      zh: '期望薪资问题怎么回答？通常用不带具体数字的说法。',
    },
    {
      type: 'choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [
        option('in-line-with-posted-range', 'In line with the posted range', '与职位公布的薪资范围一致'),
        option('open-to-discussion', 'Open to discussion', '可以商议'),
      ],
    }),
  question('first-generation', 3, 'background',
    { en: 'First-generation student', zh: '第一代大学生' },
    { en: 'Are you a first-generation college student?', zh: '你是家里的第一代大学生吗？' },
    {
      type: 'choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [option('yes', 'Yes', '是'), option('no', 'No', '否'), preferNotToSay],
    }),
  question('relatives-government', 3, 'background',
    { en: 'Relatives in government', zh: '亲属在政府任职' },
    {
      en: 'Do any of your relatives hold a government office or work for a government? Some forms ask this for conflict-of-interest checks.',
      zh: '你是否有亲属担任政府职务或在政府部门工作？部分表单会为利益冲突审查询问此事。',
    },
    {
      type: 'choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [option('no', 'No', '没有'), option('yes', 'Yes', '有')],
    }),
  question('relatives-at-company', 3, 'background',
    { en: 'Relatives at the company', zh: '亲属在该公司工作' },
    {
      en: 'What should forms say when they ask whether relatives work at the company?',
      zh: '表单问“是否有亲属在本公司工作”时应如何回答？',
    },
    {
      type: 'choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [
        option('no', 'No', '没有'),
        option('ask-each-time', 'It depends on the company; ask me each time', '视公司而定，每次先问我'),
      ],
    }),
  question('non-compete', 3, 'background',
    { en: 'Non-compete or confidentiality', zh: '竞业禁止或保密协议' },
    {
      en: 'Are you bound by a non-compete, non-solicitation, or confidentiality agreement?',
      zh: '你是否受竞业禁止、禁止招揽或保密协议的约束？',
    },
    {
      type: 'choice', required: false, allowOther: true, target: ANSWERS_TARGET,
      options: [option('no', 'No', '没有'), option('yes', 'Yes', '有')],
    }),
  question('certifications', 3, 'background',
    { en: 'Certifications and awards', zh: '证书与奖项' },
    { en: 'Certifications and awards worth listing on forms. Optional.', zh: '值得在表单上填写的证书和奖项。可不填。' },
    { type: 'text', required: false, allowOther: true, target: ANSWERS_TARGET, example: 'Example Cloud Practitioner (2026)' }),

  // Round 4: scan sources, rules, and pace. Ask the three sources questions together.
  question('watch-companies', 4, 'sources',
    { en: 'Companies to watch', zh: '关注的公司' },
    {
      en: "Which companies should the daily role scan watch? Name as many as you like. The Agent finds each company's official Greenhouse, Lever, or Ashby job board from its careers page and saves it; a company that uses another hiring system cannot be scanned this way, and the Agent tells you which ones.",
      zh: '每日岗位扫描要关注哪些公司？数量不限。Agent 会从每家公司的招聘页找到它在 Greenhouse、Lever 或 Ashby 上的官方职位板并保存；使用其他招聘系统的公司无法用这种方式扫描，Agent 会告诉你是哪几家。',
    },
    {
      type: 'ats-boards', required: true, allowOther: true, target: 'sources.atsBoards',
      example: [{ ats: 'greenhouse', board: 'examplecorp', company: 'ExampleCorp' }],
    }),
  question('careerops-source', 4, 'sources',
    { en: 'CareerOps portal scans', zh: 'CareerOps 门户扫描' },
    {
      en: 'Also scan the company portals tracked by CareerOps? Optional and off by default. It runs only when CareerOps, a separately installed MIT-licensed project, is set up on this computer.',
      zh: '是否同时扫描 CareerOps 跟踪的公司招聘门户？可选，默认关闭。只有这台电脑上已经安装并配置 CareerOps（一个单独安装、采用 MIT 许可证的项目）时才会运行。',
    },
    { type: 'boolean', required: false, target: 'sources.careerOps', default: false, options: yesNo }),
  question('simplify-source', 4, 'sources',
    { en: 'SimplifyJobs list', zh: 'SimplifyJobs 列表' },
    {
      en: 'Also read the public SimplifyJobs internship and new-grad list? The list has no licence, so it stays off unless you turn it on. When on, it is read live on this computer at scan time and is never bundled, cached, or redistributed. To turn it on, give the https link to the list\'s JSON file.',
      zh: '是否同时读取 SimplifyJobs 公开的实习和应届生岗位列表？这份列表没有许可证，所以除非你主动开启，否则一直关闭。开启后只在扫描时在这台电脑上实时读取，从不打包、缓存或再分发。要开启，请提供该列表 JSON 文件的 https 链接。',
    },
    {
      type: 'opt-in-url', required: false, allowOther: true, target: 'sources.simplify', default: { enabled: false, url: null },
      options: [option({ enabled: false, url: null }, 'No, keep it off (default)', '不开启（默认）')],
      example: { enabled: true, url: 'https://example.com/listings.json' },
    }),
  question('batch-size', 4, 'pace',
    { en: 'Batch size', zh: '每批数量' },
    { en: 'How many roles should the Agent fill at a time? Any whole number from 1 to 10.', zh: 'Agent 每批同时填写几个职位？可以是 1 到 10 之间的整数。' },
    {
      type: 'integer', required: true, allowOther: true, target: 'pace.batchSize', default: 5,
      options: [option(3, '3', '3'), option(5, '5 (default)', '5（默认）'), option(10, '10', '10')],
    }),
  question('scan-time', 4, 'pace',
    { en: 'Daily scan time', zh: '每日扫描时间' },
    {
      en: 'What time should the daily role scan run? Use 24-hour HH:MM in the workspace time zone.',
      zh: '每天几点扫描新职位？请用 24 小时制 HH:MM，按工作区时区。',
    },
    {
      type: 'time', required: true, allowOther: true, target: 'pace.scanTime', default: '08:00',
      options: [option('07:00', '07:00', '07:00'), option('08:00', '08:00 (default)', '08:00（默认）'), option('09:00', '09:00', '09:00')],
    }),
  question('notify', 4, 'pace',
    { en: 'Notification', zh: '通知方式' },
    { en: 'How should you hear about newly queued roles?', zh: '有新职位进入队列时如何通知你？' },
    {
      type: 'choice', required: true, target: 'pace.notify', default: 'desktop',
      options: [
        option('desktop', 'Desktop notification (default)', '桌面通知（默认）'),
        option('none', 'No notification; I will check the dashboard', '不通知，我自己查看看板'),
      ],
    }),
]);

const byKey = new Map(profileQuestions.map((item) => [item.key, item]));

export function questionByKey(key) {
  return byKey.get(key) ?? null;
}

export function questionsForRound(round) {
  return profileQuestions.filter((item) => item.round === round);
}
