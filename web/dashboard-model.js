const waitingStatuses = new Set(['applied', 'assessment']);
const interviewStatuses = new Set(['interview', 'offer']);
const closedStatuses = new Set(['rejected', 'withdrawn', 'accepted', 'declined']);
const preparingStatuses = new Set(['lead', 'prepared']);
const submittedStatuses = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected', 'accepted', 'declined']);

export function applicationGroup(application) {
  const status = String(application?.status ?? '').toLowerCase();
  if (waitingStatuses.has(status)) return 'waiting';
  if (interviewStatuses.has(status)) return 'interview';
  if (closedStatuses.has(status)) return 'closed';
  if (preparingStatuses.has(status)) return 'preparing';
  return 'unknown';
}

export function wasApplied(application) {
  if (application?.appliedAt) return true;
  if (submittedStatuses.has(String(application?.status ?? '').toLowerCase())) return true;
  if ((application?.events ?? []).some((event) => event.type === 'application_submitted')) return true;
  if ((application?.events ?? []).some((event) => submittedStatuses.has(String(event.statusAfter ?? '').toLowerCase()))) return true;
  return (application?.artifacts ?? []).some((artifact) => artifact.lifecycle === 'submitted');
}

export function applicationStats(applications) {
  const stats = { applied: 0, waiting: 0, interview: 0, closed: 0, preparing: 0 };
  for (const application of applications ?? []) {
    const group = applicationGroup(application);
    if (group in stats && group !== 'applied') stats[group] += 1;
    if (wasApplied(application)) stats.applied += 1;
  }
  return stats;
}

export function filterApplications(applications, { group = 'all', query = '' } = {}) {
  const normalized = String(query).trim().toLocaleLowerCase();
  return (applications ?? []).filter((application) => {
    const matchesGroup = group === 'all' || applicationGroup(application) === group;
    const displayedExternalId = application.externalId ? `#${application.externalId}` : null;
    const haystack = [application.company, application.role, application.externalId, displayedExternalId, application.id]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    return matchesGroup && (!normalized || haystack.includes(normalized));
  });
}

export function compareEventsNewestFirst(left, right) {
  const leftTime = Date.parse(left.recordedAt ?? left.observedAt ?? left.occurredAt ?? 0) || 0;
  const rightTime = Date.parse(right.recordedAt ?? right.observedAt ?? right.occurredAt ?? 0) || 0;
  return rightTime - leftTime || String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

export function latestEvent(application) {
  return [...(application?.events ?? [])].sort(compareEventsNewestFirst)[0] ?? null;
}

const materialKinds = {
  en: { resume: 'Resume', 'cover-letter': 'Cover letter', cover_letter: 'Cover letter', cv: 'CV', portfolio: 'Portfolio' },
  'zh-CN': { resume: '简历', 'cover-letter': '求职信', cover_letter: '求职信', cv: '履历', portfolio: '作品集' },
};

const verificationStates = {
  en: { passed: 'Passed', failed: 'Failed', pending: 'Pending' },
  'zh-CN': { passed: '通过', failed: '未通过', pending: '待验证' },
};

function localizedEnum(value, locale, translations) {
  const language = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const normalized = String(value ?? '').toLowerCase();
  return translations[language][normalized] ?? String(value ?? '');
}

export function materialKindLabel(kind, locale = 'en') {
  return localizedEnum(kind, locale, materialKinds);
}

export function verificationLabel(verification, locale = 'en') {
  return localizedEnum(verification, locale, verificationStates);
}

const nextActions = {
  en: {
    lead: 'Review the role and decide whether to apply',
    prepared: 'Confirm the application materials before submitting',
    applied: 'Monitor for a recruiting update',
    assessment: 'Review the assessment instructions and deadline',
    interview: 'Prepare examples and questions for the next interview',
    offer: 'Review the offer details and decision timeline',
    rejected: 'Archive the outcome and capture useful feedback',
    withdrawn: 'Keep the reason for withdrawal with the record',
    accepted: 'Record onboarding milestones and close the search loop',
    declined: 'Record the decision and any useful context',
    unknown: 'Review this application status',
  },
  'zh-CN': {
    lead: '评估岗位并决定是否投递',
    prepared: '确认申请材料后再提交',
    applied: '留意招聘方后续通知',
    assessment: '查看测评要求和截止时间',
    interview: '准备下一轮面试案例和问题',
    offer: '核对录用信息和决定期限',
    rejected: '归档结果并记录有用反馈',
    withdrawn: '在记录中保留撤回原因',
    accepted: '记录入职节点并完成求职闭环',
    declined: '记录决定及相关背景',
    unknown: '核对这条申请的状态',
  },
};

export function suggestedNextAction(application, locale = 'en') {
  const language = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const status = String(application?.status ?? 'unknown').toLowerCase();
  return nextActions[language][status] ?? nextActions[language].unknown;
}
