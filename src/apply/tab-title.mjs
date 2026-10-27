// Priority and labels follow the frozen TAB_STATES contract. This helper stays
// independent of storage so apply briefs can use it before schema migration.
const STATES = [
  ['createAccount', '🆕 Create account', '🆕 先注册'],
  ['signIn', '🔑 Sign in', '🔑 先登录'],
  ['verify', '🤖 Verify', '🤖 人机验证'],
  ['question', '❓ Question', '❓ 有问题'],
  ['essay', '✍️ Essay', '✍️ 要写作文'],
  ['documents', '📎 Transcript/references', '📎 要成绩单/推荐人'],
  ['assessment', '🧪 Assessment link', '🧪 测评链接'],
  ['click', '👆 Click', '👆 要你点'],
  ['ready', '✅ Ready to submit', '✅ 待提交'],
];

export function tabTitle({ company, needs, language = 'en' }) {
  const state = STATES.find(([key]) => key !== 'ready' && needs?.[key]) ?? STATES.at(-1);
  const label = state[language.startsWith('zh') ? 2 : 1];
  return `${label} ${company}`;
}

export function needsFromVerdict(needs) {
  return {
    essay: needs?.essay === true,
    documents: needs?.documents === true,
    assessment: needs?.assessment === true,
  };
}
