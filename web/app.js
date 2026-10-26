import {
  applicationGroup,
  applicationStats,
  compareEventsNewestFirst,
  FIT_FILTERS,
  filterApplications,
  fitCounts,
  hasOpenTask,
  hasRoleControls,
  isQueued,
  latestEvent,
  materialKindLabel,
  openTasks,
  queueSummary,
  ROLE_SORTS,
  statFilter,
  suggestedNextAction,
  taskCardHint,
  taskCardSummary,
  taskDeadlineLabel,
  taskDeadlineStatus,
  taskKindLabel,
  taskQueue,
  toApplyQueue,
  toApplyRow,
  toApplySummaryLine,
  verificationLabel,
} from './dashboard-model.js';

const copy = {
  en: {
    localWorkspace: 'Local workspace', heroEyebrow: 'EVERY STEP, ON RECORD', heroTitle: 'Your job search, at a glance',
    heroBody: 'Applications, submitted materials, and interview updates in one place.',
    reminderTitle: 'Keep progress moving', reminderBody: "When enabled, daily checks follow this workspace's local time zone.",
    statApplied: 'Applications sent', statAppliedNote: 'Confirmed submissions', statWaiting: 'Waiting',
    statWaitingNote: 'Submitted or in assessment', statInterview: 'Interview / Offer', statInterviewNote: 'Active interview or decision',
    statClosed: 'Closed', statClosedNote: 'Finished, withdrawn, or rejected', statPreparing: 'Preparing',
    statPreparingNote: 'Not yet confirmed as submitted', applicationsTitle: 'All applications',
    applicationsBody: 'Different roles at the same company stay separate.', searchLabel: 'Search applications',
    searchPlaceholder: 'Search company, role, or ID', filterAll: 'All', filterWaiting: 'Waiting',
    filterInterview: 'Interview / Offer', filterClosed: 'Closed', filterPreparing: 'Preparing',
    loading: 'Loading applications…', emptyTitle: 'No applications found', emptyBody: 'Try a different search or status filter.',
    errorTitle: 'The dashboard could not load', retry: 'Try again', footerPrivacy: 'Local-first · SQLite · Your records stay on this computer',
    currentStage: 'Current stage', appliedDate: 'Applied date', latestUpdate: 'Latest update', suggestedNext: 'Suggested next step',
    details: 'View history and materials', history: 'Application timeline', historyNote: 'Evidence-backed updates, newest first.',
    materials: 'Application materials', materialsNote: 'Draft and submitted files remain distinct.', noHistory: 'No events recorded yet',
    noMaterials: 'No materials recorded yet', noStage: 'No stage recorded', noDate: 'Not provided', noUpdate: 'No update recorded',
    recorded: 'Recorded', source: 'Source', updated: 'Updated', record: 'Record', openJob: 'Open job posting',
    submitted: 'Submitted', draft: 'Draft', verified: 'Verification', checksum: 'SHA-256', openMaterial: 'Open file', openFolder: 'Show in folder', folderOpened: 'Shown in folder', folderError: 'Could not open folder', results: (visible, total) => `${visible} of ${total}`,
    generated: (value) => `Dashboard updated ${value}`, languageLabel: 'Switch dashboard language to Chinese',
    tasksTitle: 'Assessments & interviews', tasksBody: 'Open steps across all applications, soonest deadline first.',
    tasksEmptyTitle: 'No open assessments or interviews', tasksEmptyBody: 'Online assessments, coding tests, and interview steps with deadlines appear here.',
    filterTasks: 'Assessments / interviews', markDone: 'Mark done', undo: 'Undo', taskUpdateError: 'Could not update',
    completedTasks: (count) => `Completed (${count})`, taskCompleted: 'Completed', platform: 'Platform', openLink: 'Open link', deadline: 'Deadline',
    openSteps: 'Open steps', cardTasks: 'Assessment and interview steps', cardTasksNote: 'Deadlines use the workspace time zone.',
    filterQueue: 'Queue', queueFacts: 'Role queue details', location: 'Location', skipReason: 'Skip reason',
    sortLabel: 'Sort by', sortDeadline: 'Deadline (soonest first)', sortFit: 'Fit', sortNewest: 'Newest',
    fitFilterLabel: 'Fit', fitAll: 'All', fitHigh: 'High', fitMedium: 'Medium', fitLow: 'Low', fitNone: 'Unrated',
    filterSent: 'Sent', statCardLabel: (stat, count) => `${{
      applied: 'Show sent applications', waiting: 'Show Waiting applications', interview: 'Show Interview / Offer applications',
      closed: 'Show Closed applications', preparing: 'Show Preparing applications',
    }[stat]} (${count})`,
    statTasks: 'Assessments & interviews', statTasksLabel: (count, hint) => `Go to Assessments & interviews (${count}): ${hint}`,
    toApplyTitle: 'To apply', toApplyBody: 'Roles waiting for you to apply, soonest deadline first.',
    toApplyToday: 'Apply today', toApplyWeek: 'Due this week', toApplyLater: (count) => `Later (${count})`,
    toApplyNone: (count) => `No confirmed cutoff time (${count})`, openPosting: 'Open posting', deadlineSource: 'Source',
    toApplyEmptyTitle: 'Nothing waiting to apply', toApplyEmptyBody: 'Leads you have not applied to or skipped appear here, soonest deadline first.',
  },
  'zh-CN': {
    localWorkspace: '本地档案', heroEyebrow: '让每一步都有记录', heroTitle: '求职进度总览',
    heroBody: '申请进展、实际提交的材料与面试记录，放在一起查看。',
    reminderTitle: '每天，留一点时间看进展', reminderBody: '启用后，每日检查会按照当前工作区保存的本地时区运行。',
    statApplied: '实际已投', statAppliedNote: '已确认投递的申请', statWaiting: '等待进展', statWaitingNote: '已投递或正在测评',
    statInterview: '面试 / Offer', statInterviewNote: '面试推进或等待决定', statClosed: '已结束', statClosedNote: '结束、撤回、拒绝或录用',
    statPreparing: '准备中', statPreparingNote: '尚未确认投递', applicationsTitle: '全部申请', applicationsBody: '同一家公司的不同职位，分别记录。',
    searchLabel: '搜索申请', searchPlaceholder: '搜索公司、职位或编号', filterAll: '全部', filterWaiting: '等待进展',
    filterInterview: '面试 / Offer', filterClosed: '已结束', filterPreparing: '准备中', loading: '正在加载申请…',
    emptyTitle: '没有找到申请', emptyBody: '请尝试其他搜索词或状态筛选。', errorTitle: '看板加载失败', retry: '重新加载',
    footerPrivacy: '本地优先 · SQLite · 求职记录保存在这台电脑上', currentStage: '当前阶段', appliedDate: '实际投递日期',
    latestUpdate: '最近进展', suggestedNext: '建议下一步', details: '查看档案与时间线', history: '申请时间线',
    historyNote: '按记录时间从新到旧展示有证据的进展。', materials: '申请材料', materialsNote: '草稿与实际提交文件分别记录。',
    noHistory: '还没有事件记录', noMaterials: '还没有材料记录', noStage: '未记录阶段', noDate: '未提供', noUpdate: '暂无进展记录',
    recorded: '记录时间', source: '来源', updated: '更新', record: '记录', openJob: '打开职位页面', submitted: '已提交', draft: '草稿',
    verified: '验证状态', checksum: 'SHA-256', openMaterial: '打开文件', openFolder: '打开所在文件夹', folderOpened: '已在文件夹中显示', folderError: '无法打开文件夹', results: (visible, total) => `显示 ${visible} / ${total} 条`,
    generated: (value) => `看板更新于 ${value}`, languageLabel: '将看板语言切换为英文',
    tasksTitle: '测评与面试准备', tasksBody: '汇总所有申请中待完成的步骤，截止时间最近的排在前面。',
    tasksEmptyTitle: '暂无待完成的测评或面试', tasksEmptyBody: '在线测评、编程测试和面试等带截止时间的步骤会显示在这里。',
    filterTasks: '测评 / 面试', markDone: '标记完成', undo: '撤销', taskUpdateError: '更新失败',
    completedTasks: (count) => `已完成（${count}）`, taskCompleted: '已完成', platform: '平台', openLink: '打开链接', deadline: '截止时间',
    openSteps: '待完成步骤', cardTasks: '测评与面试步骤', cardTasksNote: '截止时间按工作区时区显示。',
    filterQueue: '投递队列', queueFacts: '待投岗位信息', location: '地点', skipReason: '跳过原因',
    sortLabel: '排序', sortDeadline: '截止时间（最近的在前）', sortFit: '匹配度', sortNewest: '最新加入',
    fitFilterLabel: '匹配度', fitAll: '全部', fitHigh: '高', fitMedium: '中', fitLow: '低', fitNone: '未评',
    filterSent: '已投递', statCardLabel: (stat, count) => `${{
      applied: '查看已投递的申请', waiting: '查看等待进展的申请', interview: '查看面试 / Offer 的申请',
      closed: '查看已结束的申请', preparing: '查看准备中的申请',
    }[stat]}（${count}）`,
    statTasks: '测评与面试准备', statTasksLabel: (count, hint) => `前往测评与面试准备（${count}）：${hint}`,
    toApplyTitle: '等待我投递', toApplyBody: '等你投递的岗位，截止时间最近的排在前面。',
    toApplyToday: '今天要投', toApplyWeek: '本周截止', toApplyLater: (count) => `稍后（${count}）`,
    toApplyNone: (count) => `无明确截止时间（${count}）`, openPosting: '打开官网', deadlineSource: '截止来源',
    toApplyEmptyTitle: '暂无等待投递的岗位', toApplyEmptyBody: '尚未投递、也没有跳过的线索会显示在这里，截止时间最近的排在前面。',
  },
};

const statusCopy = {
  en: { lead: 'Lead', prepared: 'Prepared', applied: 'Applied', assessment: 'Assessment', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn', accepted: 'Accepted', declined: 'Declined' },
  'zh-CN': { lead: '待评估', prepared: '材料已准备', applied: '已投递', assessment: '测评中', interview: '面试中', offer: '已获 Offer', rejected: '被拒绝', withdrawn: '已撤回', accepted: '已接受', declined: '已婉拒' },
};

const sourceCopy = {
  en: { api: 'API', cli: 'CLI', email: 'Email', import: 'Import', manual: 'Manual', system: 'System', 'role-scan': 'Role scan', 'queue-verify': 'Posting check', other: 'Other' },
  'zh-CN': { api: 'API', cli: '命令行', email: '邮件', import: '导入', manual: '手动记录', system: '系统', 'role-scan': '岗位扫描', 'queue-verify': '岗位核对', other: '其他' },
};

const state = {
  applications: [], group: 'all', locale: initialLocale(), timezone: 'UTC', generatedAt: null,
  sort: savedChoice('career-journal-role-sort', ROLE_SORTS, 'deadline'), fit: savedChoice('career-journal-role-fit', FIT_FILTERS, 'all'),
};
const elements = {
  search: document.querySelector('#search'), list: document.querySelector('#applications'), empty: document.querySelector('#empty'),
  loading: document.querySelector('#loading'), error: document.querySelector('#error'), errorMessage: document.querySelector('#error-message'),
  resultCount: document.querySelector('#result-count'), template: document.querySelector('#application-template'),
  languageToggle: document.querySelector('#language-toggle'), generatedAt: document.querySelector('#generated-at'),
  openTasks: document.querySelector('#open-tasks'), doneTasks: document.querySelector('#done-tasks'),
  tasksEmpty: document.querySelector('#tasks-empty'), completedTasks: document.querySelector('#completed-tasks'),
  completedTasksLabel: document.querySelector('#completed-tasks-label'), taskTemplate: document.querySelector('#task-template'),
  applyTemplate: document.querySelector('#apply-template'), applySummary: document.querySelector('#to-apply-summary'),
  applyEmpty: document.querySelector('#to-apply-empty'),
  applyLaterLabel: document.querySelector('#apply-later-label'), applyNoneLabel: document.querySelector('#apply-none-label'),
  roleControls: document.querySelector('#role-controls'),
  tasksCard: document.querySelector('[data-testid="stat-card-tasks"]'), tasksCount: document.querySelector('#stat-tasks'),
  tasksHint: document.querySelector('#stat-tasks-hint'),
};

// Remembered view choices are a convenience: without storage the defaults apply.
function savedChoice(key, allowed, fallback) {
  try {
    const saved = localStorage.getItem(key);
    if (allowed.includes(saved)) return saved;
  } catch {}
  return fallback;
}

function saveChoice(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function initialLocale() {
  try {
    const saved = localStorage.getItem('career-journal-locale');
    if (saved === 'en' || saved === 'zh-CN') return saved;
  } catch {}
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function t(key) { return copy[state.locale][key]; }
function statusLabel(status) { return statusCopy[state.locale][String(status ?? '').toLowerCase()] ?? String(status ?? t('noStage')); }

function formatDate(value, { includeTime = false } = {}) {
  if (!value) return t('noDate');
  if (!includeTime && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  const options = includeTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: state.timezone }
    : { year: 'numeric', month: 'short', day: 'numeric', timeZone: state.timezone };
  try { return new Intl.DateTimeFormat(state.locale, options).format(date); }
  catch { return new Intl.DateTimeFormat(state.locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date); }
}

function formatDeadline(value, { compact = false, zone = false } = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  const options = compact
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(zone ? { timeZoneName: 'short' } : {}) }
    : { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
  try { return new Intl.DateTimeFormat(state.locale, { ...options, timeZone: state.timezone }).format(date); }
  catch { return new Intl.DateTimeFormat(state.locale, options).format(date); }
}

function deadlineBadge(deadline, label = taskDeadlineLabel(deadline, state.locale)) {
  const badge = document.createElement('span');
  badge.className = `task-badge is-${deadline.state}${deadline.urgent && deadline.state !== 'overdue' ? ' is-urgent' : ''}`;
  badge.textContent = label;
  return badge;
}

function taskBadge(task) {
  if (task.status === 'done') {
    const badge = document.createElement('span');
    badge.className = 'task-badge is-done';
    badge.textContent = t('taskCompleted');
    return badge;
  }
  return deadlineBadge(taskDeadlineStatus(task, { timeZone: state.timezone }));
}

const knownTaskKinds = new Set(['assessment', 'interview', 'other']);
function taskKindClass(kind) { return `task-kind task-kind-${knownTaskKinds.has(kind) ? kind : 'other'}`; }

function initials(company) {
  const words = String(company ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase();
  return `${[...words[0]][0] ?? ''}${[...words[1]][0] ?? ''}`.toUpperCase();
}

function setText(root, selector, value) { root.querySelector(selector).textContent = value; }

function renderTimeline(container, application) {
  const events = [...(application.events ?? [])].sort(compareEventsNewestFirst);
  if (!events.length) {
    const empty = document.createElement('p'); empty.className = 'missing'; empty.textContent = t('noHistory'); container.append(empty); return;
  }
  for (const event of events) {
    const item = document.createElement('li');
    const top = document.createElement('div'); top.className = 'event-top';
    const title = document.createElement('strong'); title.textContent = event.title;
    const time = document.createElement('time'); time.textContent = formatDate(event.occurredAt);
    top.append(title, time); item.append(top);
    if (event.statusAfter) { const stage = document.createElement('div'); stage.className = 'event-stage'; stage.textContent = statusLabel(event.statusAfter); item.append(stage); }
    if (event.note) { const note = document.createElement('p'); note.className = 'event-note'; note.textContent = event.note; item.append(note); }
    const meta = document.createElement('p'); meta.className = 'micro';
    meta.textContent = `${t('recorded')}: ${formatDate(event.recordedAt, { includeTime: true })} · ${t('source')}: ${sourceCopy[state.locale][event.sourceKind] ?? sourceCopy[state.locale].other}`;
    item.append(meta); container.append(item);
  }
}

function renderMaterials(container, application) {
  const artifacts = [...(application.artifacts ?? [])].sort((left, right) => {
    if (left.lifecycle !== right.lifecycle) return left.lifecycle === 'submitted' ? -1 : 1;
    return (Date.parse(right.recordedAt) || 0) - (Date.parse(left.recordedAt) || 0);
  });
  if (!artifacts.length) {
    const empty = document.createElement('p'); empty.className = 'missing'; empty.textContent = t('noMaterials'); container.append(empty); return;
  }
  for (const artifact of artifacts) {
    const card = document.createElement('article'); card.className = `material-card ${artifact.lifecycle === 'submitted' ? 'submitted' : ''}`;
    const lifecycle = document.createElement('p'); lifecycle.className = 'eyebrow'; lifecycle.textContent = artifact.lifecycle === 'submitted' ? t('submitted') : t('draft');
    const name = document.createElement('div'); name.className = 'file-name'; name.textContent = artifact.fileName;
    const meta = document.createElement('p'); meta.className = 'material-meta';
    const materialDate = artifact.lifecycle === 'submitted' ? artifact.submittedAt : artifact.recordedAt;
    meta.textContent = `${materialKindLabel(artifact.kind, state.locale)} · ${formatDate(materialDate)} · ${t('verified')}: ${verificationLabel(artifact.verification, state.locale)}`;
    card.append(lifecycle, name, meta);
    if (artifact.sha256) { const checksum = document.createElement('div'); checksum.className = 'material-checksum'; checksum.textContent = `${t('checksum')}: ${artifact.sha256}`; card.append(checksum); }
    const openLink = document.createElement('a');
    openLink.className = 'material-open';
    openLink.href = `/api/artifacts/${encodeURIComponent(artifact.id)}/file`;
    openLink.target = '_blank';
    openLink.rel = 'noreferrer';
    openLink.textContent = t('openMaterial');
    openLink.setAttribute('aria-label', `${t('openMaterial')}: ${artifact.fileName}`);
    const revealButton = document.createElement('button');
    revealButton.className = 'material-reveal';
    revealButton.type = 'button';
    revealButton.textContent = t('openFolder');
    revealButton.setAttribute('aria-label', `${t('openFolder')}: ${artifact.fileName}`);
    revealButton.addEventListener('click', async () => {
      revealButton.disabled = true;
      try {
        const response = await fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/reveal`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        if (!response.ok) throw new Error('Reveal failed');
        revealButton.textContent = t('folderOpened');
      } catch {
        revealButton.textContent = t('folderError');
      } finally {
        window.setTimeout(() => { revealButton.textContent = t('openFolder'); revealButton.disabled = false; }, 1800);
      }
    });
    const actions = document.createElement('div'); actions.className = 'material-actions'; actions.append(openLink, revealButton);
    card.append(actions);
    container.append(card);
  }
}

async function updateTaskStatus(task, status, button) {
  button.disabled = true;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
    });
    if (!response.ok) throw new Error('Task update failed');
    const updated = (await response.json()).task;
    const application = state.applications.find((item) => item.id === task.applicationId);
    if (application) application.tasks = (application.tasks ?? []).map((item) => (item.id === updated.id ? updated : item));
    render();
  } catch {
    button.textContent = t('taskUpdateError');
    window.setTimeout(() => { button.textContent = status === 'done' ? t('markDone') : t('undo'); button.disabled = false; }, 1800);
  }
}

function renderTaskRow(task) {
  const fragment = elements.taskTemplate.content.cloneNode(true);
  const row = fragment.querySelector('.task-row');
  const completed = task.status === 'done';
  row.dataset.taskId = task.id;
  row.classList.toggle('is-completed', completed);
  setText(row, '.task-company', task.company);
  setText(row, '.task-role', task.role);
  setText(row, '.task-title', task.title);
  const kind = row.querySelector('.task-kind'); kind.className = taskKindClass(task.kind); kind.textContent = taskKindLabel(task.kind, state.locale);
  const platform = row.querySelector('.task-platform');
  platform.textContent = task.platform ? `${t('platform')}: ${task.platform}` : '';
  platform.hidden = !task.platform;
  const link = row.querySelector('.task-link');
  const safeLink = /^https?:\/\//i.test(task.link ?? '') ? task.link : '';
  link.textContent = safeLink ? t('openLink') : '';
  if (safeLink) link.href = safeLink; else link.removeAttribute('href');
  link.setAttribute('aria-label', safeLink ? `${t('openLink')}: ${task.title}` : '');
  link.hidden = !safeLink;
  const dueNote = row.querySelector('.task-due-note');
  dueNote.textContent = task.dueNote ?? '';
  dueNote.hidden = !task.dueNote;
  const deadline = row.querySelector('.task-deadline');
  if (task.dueAt) { deadline.dateTime = task.dueAt; deadline.textContent = formatDeadline(task.dueAt); }
  deadline.hidden = !task.dueAt;
  row.querySelector('.task-badge').replaceWith(taskBadge(task));
  const action = row.querySelector('.task-action');
  const label = completed ? t('undo') : t('markDone');
  action.textContent = label;
  action.setAttribute('aria-label', `${label}: ${task.title}`);
  action.addEventListener('click', () => updateTaskStatus(task, completed ? 'open' : 'done', action));
  return fragment;
}

// The Assessments & interviews card counts open steps; it turns amber when a
// step is past due or due within 2 days.
function renderTasksCard() {
  const summary = taskCardSummary(state.applications, { timeZone: state.timezone });
  const hint = taskCardHint(summary, { locale: state.locale, timeZone: state.timezone });
  elements.tasksCount.textContent = summary.open;
  elements.tasksHint.textContent = hint;
  elements.tasksCard.classList.toggle('is-urgent', summary.urgent);
  elements.tasksCard.setAttribute('aria-label', t('statTasksLabel')(summary.open, hint));
}

function renderTasks() {
  const { open, done } = taskQueue(state.applications);
  elements.openTasks.replaceChildren(...open.map(renderTaskRow));
  elements.openTasks.hidden = open.length === 0;
  elements.tasksEmpty.hidden = open.length !== 0;
  elements.doneTasks.replaceChildren(...done.map(renderTaskRow));
  elements.completedTasks.hidden = done.length === 0;
  elements.completedTasksLabel.textContent = t('completedTasks')(done.length);
}

function renderDeadlineReview(review) {
  const note = document.createElement('p');
  note.className = 'task-due-note';
  note.textContent = review.label;
  if (review.sourceUrl) {
    const source = document.createElement('a');
    source.href = review.sourceUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = t('deadlineSource');
    note.append(' · ', source);
  }
  return note;
}

function renderApplyRow(application, now) {
  const summary = toApplyRow(application, { locale: state.locale, now, timeZone: state.timezone });
  const fragment = elements.applyTemplate.content.cloneNode(true);
  const row = fragment.querySelector('.apply-row');
  row.dataset.applicationId = summary.id;
  setText(row, '.apply-company', summary.company);
  setText(row, '.apply-role', summary.role);
  const fit = row.querySelector('.fit-badge');
  fit.className = `fit-badge fit-${summary.fit.level}`;
  fit.textContent = summary.fit.label;
  if (summary.fit.note) fit.title = summary.fit.note;
  const location = row.querySelector('.apply-location');
  location.textContent = summary.location ? `${t('location')}: ${summary.location}` : '';
  location.hidden = !summary.location;
  const check = row.querySelector('.apply-check');
  check.className = `queue-check apply-check is-${summary.check.state}`;
  check.textContent = summary.check.label;
  const deadline = row.querySelector('.apply-deadline');
  const badge = row.querySelector('.task-badge');
  if (summary.deadline.at) {
    deadline.dateTime = summary.deadline.at;
    deadline.textContent = formatDeadline(summary.deadline.at, { compact: true, zone: true });
    badge.replaceWith(deadlineBadge(summary.deadline.status, summary.deadline.label));
  } else {
    row.querySelector('.task-when').hidden = true;
  }
  if (summary.deadline.review) row.querySelector('.task-main').append(renderDeadlineReview(summary.deadline.review));
  const link = row.querySelector('.apply-link');
  if (summary.jobUrl) {
    link.href = summary.jobUrl;
    link.textContent = t('openPosting');
    link.setAttribute('aria-label', `${t('openPosting')}: ${summary.company} · ${summary.role}`);
  } else link.remove();
  return fragment;
}

function renderToApply() {
  const now = Date.now();
  const groups = toApplyQueue(state.applications, { now, timeZone: state.timezone });
  for (const key of ['today', 'week', 'later', 'none']) {
    document.querySelector(`#apply-${key}-rows`).replaceChildren(...groups[key].map((application) => renderApplyRow(application, now)));
    document.querySelector(`#apply-group-${key}`).hidden = groups[key].length === 0;
  }
  document.querySelector('#apply-today-count').textContent = groups.today.length;
  document.querySelector('#apply-week-count').textContent = groups.week.length;
  elements.applyLaterLabel.textContent = t('toApplyLater')(groups.later.length);
  elements.applyNoneLabel.textContent = t('toApplyNone')(groups.none.length);
  const line = toApplySummaryLine(groups, state.locale);
  elements.applySummary.textContent = line;
  elements.applySummary.hidden = !line;
  elements.applyEmpty.hidden = Boolean(line);
}

function renderCardTasks(card, application) {
  const pending = openTasks(application);
  const line = card.querySelector('.card-tasks');
  line.hidden = pending.length === 0;
  setText(card, '.card-tasks-label', t('openSteps'));
  card.querySelector('.card-task-chips').replaceChildren(...pending.map((task) => {
    const chip = document.createElement('li'); chip.className = 'card-task-chip';
    const title = document.createElement('span'); title.className = 'card-task-name'; title.textContent = task.title;
    chip.append(title);
    if (task.dueAt) { const due = document.createElement('time'); due.dateTime = task.dueAt; due.textContent = formatDeadline(task.dueAt, { compact: true }); chip.append(due); }
    chip.append(taskBadge(task));
    return chip;
  }));

  const tasks = [...pending, ...(application.tasks ?? []).filter((task) => task.status !== 'open')];
  const section = card.querySelector('.card-task-section');
  section.hidden = tasks.length === 0;
  setText(card, '.card-task-title', t('cardTasks'));
  setText(card, '.card-task-note', t('cardTasksNote'));
  card.querySelector('.card-task-list').replaceChildren(...tasks.map((task) => {
    const item = document.createElement('li'); item.className = `card-task-item${task.status === 'done' ? ' is-completed' : ''}`;
    const top = document.createElement('div'); top.className = 'event-top';
    const title = document.createElement('strong'); title.textContent = task.title;
    top.append(title, taskBadge(task));
    const meta = document.createElement('p'); meta.className = 'micro';
    meta.textContent = [
      taskKindLabel(task.kind, state.locale),
      task.platform ? `${t('platform')}: ${task.platform}` : null,
      `${t('deadline')}: ${task.dueAt ? formatDeadline(task.dueAt) : taskDeadlineLabel({ state: 'none' }, state.locale)}`,
    ].filter(Boolean).join(' · ');
    item.append(top, meta);
    for (const value of [task.dueNote, task.note].filter(Boolean)) {
      const note = document.createElement('p'); note.className = 'event-note'; note.textContent = value; item.append(note);
    }
    return item;
  }));
}

function queueFact(className, label, ...content) {
  const item = document.createElement('li'); item.className = `card-queue-fact ${className}`;
  const name = document.createElement('span'); name.className = 'card-queue-label'; name.textContent = label;
  const value = document.createElement('span'); value.className = 'card-queue-value'; value.append(...content);
  item.append(name, value);
  return item;
}

function renderQueue(card, application) {
  const summary = queueSummary(application, { locale: state.locale, timeZone: state.timezone });
  const line = card.querySelector('.card-queue');
  const skip = card.querySelector('.card-skip');
  line.hidden = !summary;
  skip.hidden = !summary?.skipReason;
  if (!summary) return;
  line.setAttribute('aria-label', t('queueFacts'));
  const fit = line.querySelector('.fit-badge');
  fit.className = `fit-badge fit-${summary.fit.level}`;
  fit.textContent = summary.fit.label;
  if (summary.fit.note) fit.title = summary.fit.note; else fit.removeAttribute('title');

  const facts = [];
  if (summary.deadline.at || summary.deadline.status || summary.deadline.review) {
    const content = [];
    if (summary.deadline.at) {
      const time = document.createElement('time'); time.dateTime = summary.deadline.at;
      time.textContent = formatDeadline(summary.deadline.at, { compact: true, zone: true });
      content.push(time);
    }
    if (summary.deadline.status && (summary.deadline.at || !summary.deadline.review)) content.push(deadlineBadge(summary.deadline.status, summary.deadline.hint));
    if (summary.deadline.review) content.push(renderDeadlineReview(summary.deadline.review));
    facts.push(queueFact('queue-deadline', t('deadline'), ...content));
  }
  if (summary.location) facts.push(queueFact('queue-location', t('location'), summary.location));
  if (summary.source) facts.push(queueFact('queue-source', t('source'), summary.source));
  const check = document.createElement('li');
  check.className = `card-queue-fact queue-check is-${summary.check.state}`;
  check.textContent = summary.check.at ? `${summary.check.label} · ${formatDate(summary.check.at)}` : summary.check.label;
  facts.push(check);
  line.querySelector('.card-queue-facts').replaceChildren(...facts);

  if (summary.skipReason) {
    setText(skip, '.card-skip-label', t('skipReason'));
    setText(skip, '.card-skip-reason', summary.skipReason);
  }
}

function renderCard(application) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector('.application-card');
  const group = applicationGroup(application);
  card.dataset.applicationId = application.id;
  card.dataset.group = group;
  setText(card, '.company-avatar', initials(application.company));
  setText(card, '.company', application.company);
  setText(card, '.job-id', application.externalId ? `#${application.externalId}` : application.id);
  setText(card, '.role', application.role);
  const status = card.querySelector('.status'); status.className = `status status-${group}`; status.textContent = statusLabel(application.status);
  renderQueue(card, application);
  setText(card, '[data-field-label="stage"]', t('currentStage'));
  setText(card, '[data-field-label="applied"]', t('appliedDate'));
  setText(card, '[data-field-label="latest"]', t('latestUpdate'));
  setText(card, '.stage', application.stage || t('noStage'));
  setText(card, '.applied', formatDate(application.appliedAt));
  const recent = latestEvent(application);
  setText(card, '.latest', recent ? [recent.title, recent.note].filter(Boolean).join(': ') : t('noUpdate'));
  setText(card, '.next-action-label', t('suggestedNext'));
  setText(card, '.next-action-copy', suggestedNextAction(application, state.locale));
  setText(card, '.details-label', t('details'));
  setText(card, '.history-title', t('history'));
  setText(card, '.history-note', t('historyNote'));
  setText(card, '.materials-title', t('materials'));
  setText(card, '.materials-note', t('materialsNote'));
  renderCardTasks(card, application);
  renderTimeline(card.querySelector('.timeline'), application);
  renderMaterials(card.querySelector('.material-list'), application);
  const jobLink = card.querySelector('.job-link');
  if (application.jobUrl) { jobLink.href = application.jobUrl; jobLink.textContent = t('openJob'); jobLink.hidden = false; }
  setText(card, '.record-id', `${t('record')}: ${application.id}`);
  setText(card, '.updated-at', `${t('updated')}: ${formatDate(application.updatedAt, { includeTime: true })}`);
  return fragment;
}

function applyLocale() {
  document.documentElement.lang = state.locale;
  document.title = state.locale === 'zh-CN' ? 'CAREER JOURNAL · 求职记录' : 'CAREER JOURNAL';
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  elements.languageToggle.querySelector('span').textContent = state.locale === 'en' ? '中文' : 'EN';
  elements.languageToggle.setAttribute('aria-label', t('languageLabel'));
  document.querySelector('.stats').setAttribute('aria-label', state.locale === 'zh-CN' ? '申请统计' : 'Application summary');
  document.querySelector('.filters').setAttribute('aria-label', state.locale === 'zh-CN' ? '申请状态筛选' : 'Application status filters');
}

function render() {
  applyLocale();
  const stats = applicationStats(state.applications);
  for (const key of ['applied', 'waiting', 'interview', 'closed', 'preparing']) {
    document.querySelector(`#stat-${key}`).textContent = stats[key];
    document.querySelector(`[data-stat="${key}"]`).setAttribute('aria-label', t('statCardLabel')(key, stats[key]));
  }
  const filterCounts = {
    all: filterApplications(state.applications).length, sent: stats.applied, waiting: stats.waiting, interview: stats.interview, closed: stats.closed, preparing: stats.preparing,
    tasks: state.applications.filter(hasOpenTask).length, queue: state.applications.filter(isQueued).length,
  };
  for (const [key, value] of Object.entries(filterCounts)) document.querySelector(`[data-count="${key}"]`).textContent = value;
  renderTasksCard();
  renderToApply();
  renderTasks();
  const roleView = hasRoleControls(state.group);
  elements.roleControls.hidden = !roleView;
  if (roleView) {
    const counts = fitCounts(filterApplications(state.applications, { group: state.group, query: elements.search.value }));
    for (const [key, value] of Object.entries(counts)) document.querySelector(`[data-fit-count="${key}"]`).textContent = value;
    document.querySelectorAll('[data-sort]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.sort === state.sort)));
    document.querySelectorAll('[data-fit]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.fit === state.fit)));
  }
  const visible = filterApplications(state.applications, { group: state.group, query: elements.search.value, sort: state.sort, fit: state.fit });
  elements.list.replaceChildren(...visible.map(renderCard));
  elements.empty.hidden = visible.length !== 0;
  elements.resultCount.textContent = t('results')(visible.length, state.applications.length);
  if (state.generatedAt) elements.generatedAt.textContent = t('generated')(formatDate(state.generatedAt, { includeTime: true }));
}

async function load() {
  elements.loading.hidden = false; elements.error.hidden = true; elements.empty.hidden = true;
  try {
    const response = await fetch('/api/dashboard', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.applications = payload.applications ?? [];
    state.timezone = payload.timezone ?? 'UTC';
    state.generatedAt = payload.generatedAt ?? null;
    render();
  } catch (error) {
    elements.list.replaceChildren(); elements.error.hidden = false; elements.errorMessage.textContent = error.message;
  } finally { elements.loading.hidden = true; }
}

elements.search.addEventListener('input', render);
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  state.group = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === button)));
  render();
}));
document.querySelectorAll('[data-sort]').forEach((button) => button.addEventListener('click', () => {
  state.sort = button.dataset.sort;
  saveChoice('career-journal-role-sort', state.sort);
  render();
}));
document.querySelectorAll('[data-fit]').forEach((button) => button.addEventListener('click', () => {
  state.fit = button.dataset.fit;
  saveChoice('career-journal-role-fit', state.fit);
  render();
}));
function scrollBehavior() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; } catch { return 'smooth'; }
}

// A summary card applies its list filter exactly as the filter button does,
// then brings the list into view.
document.querySelectorAll('[data-stat]').forEach((card) => card.addEventListener('click', () => {
  document.querySelector(`[data-filter="${statFilter(card.dataset.stat)}"]`).click();
  document.querySelector('.applications-section').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
}));
// A card with a scroll target leaves the list filter alone: it brings that
// section into view and moves focus to its heading.
document.querySelectorAll('[data-scroll-target]').forEach((card) => card.addEventListener('click', () => {
  const heading = document.getElementById(card.dataset.scrollTarget);
  (heading.closest('section') ?? heading).scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  heading.focus({ preventScroll: true });
}));
elements.languageToggle.addEventListener('click', () => {
  state.locale = state.locale === 'en' ? 'zh-CN' : 'en';
  try { localStorage.setItem('career-journal-locale', state.locale); } catch {}
  render();
});
document.querySelector('#retry').addEventListener('click', load);

load();
