import {
  applicationGroup,
  applicationStats,
  compareEventsNewestFirst,
  filterApplications,
  latestEvent,
  materialKindLabel,
  suggestedNextAction,
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
    submitted: 'Submitted', draft: 'Draft', verified: 'Verification', checksum: 'SHA-256', openMaterial: 'Open file', results: (visible, total) => `${visible} of ${total}`,
    generated: (value) => `Dashboard updated ${value}`, languageLabel: 'Switch dashboard language to Chinese',
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
    verified: '验证状态', checksum: 'SHA-256', openMaterial: '打开文件', results: (visible, total) => `显示 ${visible} / ${total} 条`,
    generated: (value) => `看板更新于 ${value}`, languageLabel: '将看板语言切换为英文',
  },
};

const statusCopy = {
  en: { lead: 'Lead', prepared: 'Prepared', applied: 'Applied', assessment: 'Assessment', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn', accepted: 'Accepted', declined: 'Declined' },
  'zh-CN': { lead: '待评估', prepared: '材料已准备', applied: '已投递', assessment: '测评中', interview: '面试中', offer: '已获 Offer', rejected: '被拒绝', withdrawn: '已撤回', accepted: '已接受', declined: '已婉拒' },
};

const sourceCopy = {
  en: { api: 'API', cli: 'CLI', email: 'Email', import: 'Import', manual: 'Manual', system: 'System', other: 'Other' },
  'zh-CN': { api: 'API', cli: '命令行', email: '邮件', import: '导入', manual: '手动记录', system: '系统', other: '其他' },
};

const state = { applications: [], group: 'all', locale: initialLocale(), timezone: 'UTC', generatedAt: null };
const elements = {
  search: document.querySelector('#search'), list: document.querySelector('#applications'), empty: document.querySelector('#empty'),
  loading: document.querySelector('#loading'), error: document.querySelector('#error'), errorMessage: document.querySelector('#error-message'),
  resultCount: document.querySelector('#result-count'), template: document.querySelector('#application-template'),
  languageToggle: document.querySelector('#language-toggle'), generatedAt: document.querySelector('#generated-at'),
};

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
    card.append(openLink);
    container.append(card);
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
  for (const key of ['applied', 'waiting', 'interview', 'closed', 'preparing']) document.querySelector(`#stat-${key}`).textContent = stats[key];
  const filterCounts = { all: state.applications.length, waiting: stats.waiting, interview: stats.interview, closed: stats.closed, preparing: stats.preparing };
  for (const [key, value] of Object.entries(filterCounts)) document.querySelector(`[data-count="${key}"]`).textContent = value;
  const visible = filterApplications(state.applications, { group: state.group, query: elements.search.value });
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
elements.languageToggle.addEventListener('click', () => {
  state.locale = state.locale === 'en' ? 'zh-CN' : 'en';
  try { localStorage.setItem('career-journal-locale', state.locale); } catch {}
  render();
});
document.querySelector('#retry').addEventListener('click', load);

load();
