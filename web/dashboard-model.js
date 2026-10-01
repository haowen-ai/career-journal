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

function taskDueTime(task) {
  const value = Date.parse(task?.dueAt ?? '');
  return Number.isNaN(value) ? null : value;
}

export function compareTasksByDue(left, right) {
  const leftDue = taskDueTime(left);
  const rightDue = taskDueTime(right);
  if (leftDue !== rightDue) {
    if (leftDue === null) return 1;
    if (rightDue === null) return -1;
    return leftDue - rightDue;
  }
  return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
    || String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

export function openTasks(application) {
  return (application?.tasks ?? []).filter((task) => task.status === 'open').sort(compareTasksByDue);
}

export function hasOpenTask(application) {
  return (application?.tasks ?? []).some((task) => task.status === 'open');
}

export function taskQueue(applications) {
  const open = [];
  const done = [];
  for (const application of applications ?? []) {
    for (const task of application.tasks ?? []) {
      const item = { ...task, applicationId: application.id, company: application.company, role: application.role };
      if (task.status === 'open') open.push(item);
      else if (task.status === 'done') done.push(item);
    }
  }
  open.sort(compareTasksByDue);
  done.sort((left, right) => (Date.parse(right.updatedAt ?? 0) || 0) - (Date.parse(left.updatedAt ?? 0) || 0) || compareTasksByDue(left, right));
  return { open, done };
}

function calendarDay(time, timeZone) {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { ...options, timeZone }).formatToParts(new Date(time)); }
  catch { parts = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).formatToParts(new Date(time)); }
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value('year'), value('month') - 1, value('day')) / 86_400_000;
}

export function taskDeadlineStatus(task, { now = Date.now(), timeZone = 'UTC' } = {}) {
  const due = taskDueTime(task);
  if (due === null) return { state: 'none', daysLeft: null, urgent: false };
  const current = typeof now === 'number' ? now : Date.parse(now);
  if (due < current) return { state: 'overdue', daysLeft: null, urgent: true };
  const daysLeft = Math.max(0, calendarDay(due, timeZone) - calendarDay(current, timeZone));
  return { state: daysLeft === 0 ? 'today' : 'upcoming', daysLeft, urgent: daysLeft < 3 };
}

const deadlineCopy = {
  en: { none: 'No deadline', overdue: 'Overdue', today: 'Due today', upcoming: (days) => (days === 1 ? '1 day left' : `${days} days left`) },
  'zh-CN': { none: '无截止时间', overdue: '已过期', today: '今天截止', upcoming: (days) => `还剩 ${days} 天` },
};

export function taskDeadlineLabel(status, locale = 'en') {
  const labels = deadlineCopy[locale === 'zh-CN' ? 'zh-CN' : 'en'];
  return status.state === 'upcoming' ? labels.upcoming(status.daysLeft) : labels[status.state];
}

// The apply queue is the same set `career-journal queue list` shows: leads that
// have not been skipped.
export function isQueued(application) {
  return String(application?.status ?? '').toLowerCase() === 'lead' && application?.skipReason == null;
}

const FIT_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

function timeOrNull(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

function lastIfMissing(value) {
  return value == null ? Number.POSITIVE_INFINITY : value;
}

// Mirrors compareQueueItems in src/commands/queue.mjs: fit (high, medium, low,
// then unrated), the earliest deadline, then the most recently posted role.
// `queue list` also breaks ties by the profile's location rank. The dashboard
// API does not send the search profile to the browser, so that tiebreak is
// skipped here; roles that differ only by location rank fall through to the
// posting date, as they do in `queue list` when no profile exists.
export function compareQueueApplications(left, right) {
  return lastIfMissing(FIT_ORDER[left.fit]) - lastIfMissing(FIT_ORDER[right.fit])
    || lastIfMissing(timeOrNull(left.deadlineAt)) - lastIfMissing(timeOrNull(right.deadlineAt))
    || (timeOrNull(right.postedAt) ?? Number.NEGATIVE_INFINITY) - (timeOrNull(left.postedAt) ?? Number.NEGATIVE_INFINITY)
    || String(left.createdAt).localeCompare(String(right.createdAt))
    || String(left.id).localeCompare(String(right.id));
}

export function queueApplications(applications) {
  return (applications ?? []).filter(isQueued).sort(compareQueueApplications);
}

function matchesFilter(application, group) {
  if (group === 'all') return true;
  if (group === 'tasks') return hasOpenTask(application);
  if (group === 'queue') return isQueued(application);
  return applicationGroup(application) === group;
}

export function filterApplications(applications, { group = 'all', query = '' } = {}) {
  const normalized = String(query).trim().toLocaleLowerCase();
  const visible = (applications ?? []).filter((application) => {
    const matchesGroup = matchesFilter(application, group);
    const displayedExternalId = application.externalId ? `#${application.externalId}` : null;
    const haystack = [application.company, application.role, application.externalId, displayedExternalId, application.id]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    return matchesGroup && (!normalized || haystack.includes(normalized));
  });
  return group === 'queue' ? visible.sort(compareQueueApplications) : visible;
}

const fitCopy = {
  en: { high: 'High fit', medium: 'Medium fit', low: 'Low fit', none: 'Fit not rated' },
  'zh-CN': { high: '高匹配', medium: '中匹配', low: '低匹配', none: '未评匹配度' },
};

export function fitLevel(fit) {
  const normalized = String(fit ?? '').toLowerCase();
  return normalized in FIT_ORDER ? normalized : 'none';
}

export function fitLabel(fit, locale = 'en') {
  return fitCopy[locale === 'zh-CN' ? 'zh-CN' : 'en'][fitLevel(fit)];
}

const postingCheckCopy = {
  en: { verified: 'Verified', unverified: 'Not yet verified' },
  'zh-CN': { verified: '已核实', unverified: '尚未核实' },
};

export function postingCheckLabel(application, locale = 'en') {
  return postingCheckCopy[locale === 'zh-CN' ? 'zh-CN' : 'en'][application?.verifiedAt ? 'verified' : 'unverified'];
}

const sourceNames = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', careerops: 'CareerOps', simplify: 'SimplifyJobs' };

export function sourceName(source) {
  if (source == null || source === '') return null;
  return sourceNames[String(source).toLowerCase()] ?? String(source);
}

function skipReasonOf(application) {
  const reason = application?.skipReason;
  return reason == null || !String(reason).trim() ? null : String(reason).trim();
}

// What a card shows about a queued role, as data so it can be tested without a
// DOM. Returns null for applications past the preparing stage that were not
// skipped from the queue. The deadline time-left hint only applies while the
// role is still being prepared; a skipped role keeps its deadline date only.
export function queueSummary(application, { locale = 'en', now = Date.now(), timeZone = 'UTC' } = {}) {
  const preparing = applicationGroup(application) === 'preparing';
  const skipReason = skipReasonOf(application);
  if (!preparing && !skipReason) return null;
  const level = fitLevel(application.fit);
  const deadlineAt = timeOrNull(application.deadlineAt) === null ? null : application.deadlineAt;
  const deadline = preparing ? taskDeadlineStatus({ dueAt: deadlineAt }, { now, timeZone }) : null;
  return {
    queued: isQueued(application),
    fit: { level, label: fitLabel(level, locale), note: application.fitNote || null },
    deadline: { at: deadlineAt, status: deadline, hint: deadline ? taskDeadlineLabel(deadline, locale) : null },
    location: application.location || null,
    source: sourceName(application.source),
    check: { state: application.verifiedAt ? 'verified' : 'unverified', at: application.verifiedAt || null, label: postingCheckLabel(application, locale) },
    skipReason,
  };
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

const taskKinds = {
  en: { assessment: 'Assessment', interview: 'Interview', other: 'Other step' },
  'zh-CN': { assessment: '测评', interview: '面试', other: '其他步骤' },
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

export function taskKindLabel(kind, locale = 'en') {
  return localizedEnum(kind, locale, taskKinds);
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
