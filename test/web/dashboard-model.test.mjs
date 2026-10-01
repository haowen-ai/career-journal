import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationGroup,
  applicationStats,
  compareEventsNewestFirst,
  compareQueueApplications,
  compareTasksByDue,
  filterApplications,
  fitLabel,
  fitLevel,
  hasOpenTask,
  isQueued,
  latestEvent,
  materialKindLabel,
  openTasks,
  postingCheckLabel,
  queueApplications,
  queueSummary,
  sourceName,
  suggestedNextAction,
  taskDeadlineLabel,
  taskDeadlineStatus,
  taskKindLabel,
  taskQueue,
  verificationLabel,
} from '../../web/dashboard-model.js';
import { compareQueueItems } from '../../src/commands/queue.mjs';

const application = (overrides = {}) => ({
  id: 'sample-role', company: 'Sample Labs', role: 'AI Engineer', status: 'lead',
  stage: null, appliedAt: null, events: [], artifacts: [], ...overrides,
});

test('groups every supported status for the five-card dashboard summary', () => {
  const applications = [
    application({ id: 'lead', status: 'lead' }),
    application({ id: 'prepared', status: 'prepared' }),
    application({ id: 'applied', status: 'applied', appliedAt: '2026-09-01' }),
    application({ id: 'assessment', status: 'assessment' }),
    application({ id: 'interview', status: 'interview' }),
    application({ id: 'offer', status: 'offer' }),
    application({ id: 'rejected', status: 'rejected' }),
    application({ id: 'accepted', status: 'accepted' }),
    application({ id: 'withdrawn-before-submit', status: 'withdrawn' }),
    application({ id: 'withdrawn-after-submit', status: 'withdrawn', events: [{ type: 'application_submitted' }] }),
    application({ id: 'withdrawn-after-status', status: 'withdrawn', events: [{ type: 'application_update', statusAfter: 'applied' }] }),
  ];
  assert.equal(applicationGroup(applications[0]), 'preparing');
  assert.equal(applicationGroup(applications[2]), 'waiting');
  assert.equal(applicationGroup(applications[4]), 'interview');
  assert.equal(applicationGroup(applications[6]), 'closed');
  assert.deepEqual(applicationStats(applications), {
    applied: 8,
    waiting: 2,
    interview: 2,
    closed: 5,
    preparing: 2,
  });
});

test('filters by semantic group and normalized company, role, or identifier text', () => {
  const applications = [
    application({ id: 'northstar-ai-101', company: 'Northstar AI', role: 'Solutions Engineer', status: 'applied' }),
    application({ id: 'helix-labs-202', company: 'Helix Labs', role: 'Data Scientist', externalId: 'HL-2087', status: 'interview' }),
    application({ id: 'orbit-303', company: 'Orbit Systems', role: 'Product Analyst', status: 'rejected' }),
  ];
  assert.deepEqual(filterApplications(applications, { group: 'all', query: '  HELIX ' }).map((item) => item.id), ['helix-labs-202']);
  assert.deepEqual(filterApplications(applications, { group: 'interview', query: '#HL-2087' }).map((item) => item.id), ['helix-labs-202']);
  assert.deepEqual(filterApplications(applications, { group: 'interview', query: '' }).map((item) => item.id), ['helix-labs-202']);
  assert.deepEqual(filterApplications(applications, { group: 'closed', query: 'orbit-303' }).map((item) => item.id), ['orbit-303']);
});

test('uses the latest recorded event and keeps suggested actions clearly derived from status', () => {
  const item = application({
    status: 'assessment',
    events: [
      { id: 'older', title: 'Application received', recordedAt: '2026-09-01T12:00:00Z' },
      { id: 'newer', title: 'Assessment invited', recordedAt: '2026-09-03T12:00:00Z' },
    ],
  });
  assert.equal(latestEvent(item).id, 'newer');
  assert.equal(suggestedNextAction(item, 'en'), 'Review the assessment instructions and deadline');
  assert.equal(suggestedNextAction(item, 'zh-CN'), '查看测评要求和截止时间');
  const tied = [
    { id: 'b', recordedAt: '2026-09-03T12:00:00Z' },
    { id: 'a', recordedAt: '2026-09-03T12:00:00Z' },
  ].sort(compareEventsNewestFirst);
  assert.deepEqual(tied.map((event) => event.id), ['a', 'b']);
  assert.equal(latestEvent({ events: tied }).id, 'a');
});

test('localizes known material and verification enums without inventing unknown labels', () => {
  assert.equal(materialKindLabel('resume', 'zh-CN'), '简历');
  assert.equal(materialKindLabel('cover-letter', 'zh-CN'), '求职信');
  assert.equal(materialKindLabel('cover_letter', 'en'), 'Cover letter');
  assert.equal(verificationLabel('passed', 'zh-CN'), '通过');
  assert.equal(verificationLabel('pending', 'en'), 'Pending');
  assert.equal(materialKindLabel('writing_sample', 'zh-CN'), 'writing_sample');
});

const task = (overrides = {}) => ({
  id: 'task', kind: 'assessment', title: 'Online assessment', platform: null, dueAt: null, dueNote: '',
  status: 'open', note: '', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ...overrides,
});

test('filters to applications with at least one open task and combines with search', () => {
  const applications = [
    application({ id: 'open-oa', company: 'Northstar AI', status: 'assessment', tasks: [task({ id: 'a' })] }),
    application({ id: 'done-only', company: 'Helix Labs', status: 'interview', tasks: [task({ id: 'b', status: 'done' })] }),
    application({ id: 'no-tasks', company: 'Orbit Systems', status: 'applied' }),
    application({ id: 'mixed', company: 'Northwind', status: 'interview', tasks: [task({ id: 'c', status: 'done' }), task({ id: 'd', kind: 'interview' })] }),
  ];
  assert.equal(hasOpenTask(applications[0]), true);
  assert.equal(hasOpenTask(applications[1]), false);
  assert.equal(hasOpenTask(applications[2]), false);
  assert.deepEqual(filterApplications(applications, { group: 'tasks', query: '' }).map((item) => item.id), ['open-oa', 'mixed']);
  assert.deepEqual(filterApplications(applications, { group: 'tasks', query: 'northw' }).map((item) => item.id), ['mixed']);
  assert.deepEqual(filterApplications(applications, { group: 'tasks', query: 'helix' }).map((item) => item.id), []);
  assert.deepEqual(filterApplications(applications, { group: 'interview', query: '' }).map((item) => item.id), ['done-only', 'mixed']);
  assert.equal(applicationGroup(applications[0]), 'waiting');
});

test('sorts open tasks by absolute deadline with missing deadlines last and splits completed tasks', () => {
  const applications = [
    application({ id: 'acme', company: 'Acme', role: 'Intern', tasks: [
      task({ id: 'none', dueAt: null }),
      task({ id: 'pacific', dueAt: '2026-10-01T09:00:00-07:00' }),
      task({ id: 'done-old', status: 'done', updatedAt: '2026-09-10T00:00:00Z' }),
    ] }),
    application({ id: 'beta', company: 'Beta', role: 'Analyst', tasks: [
      task({ id: 'utc', dueAt: '2026-10-01T12:00:00Z' }),
      task({ id: 'done-new', status: 'done', updatedAt: '2026-09-12T00:00:00Z' }),
    ] }),
  ];
  assert.deepEqual(openTasks(applications[0]).map((item) => item.id), ['pacific', 'none']);
  const queue = taskQueue(applications);
  assert.deepEqual(queue.open.map((item) => item.id), ['utc', 'pacific', 'none']);
  assert.deepEqual(queue.done.map((item) => item.id), ['done-new', 'done-old']);
  assert.deepEqual([queue.open[0].applicationId, queue.open[0].company, queue.open[0].role], ['beta', 'Beta', 'Analyst']);
  assert.deepEqual(taskQueue([]), { open: [], done: [] });
  const tied = [task({ id: 'b', dueAt: '2026-10-01T00:00:00Z' }), task({ id: 'a', dueAt: '2026-10-01T00:00:00Z' })].sort(compareTasksByDue);
  assert.deepEqual(tied.map((item) => item.id), ['a', 'b']);
});

test('describes deadlines in workspace calendar days with a warning under three days', () => {
  const now = Date.parse('2026-09-29T21:00:00-05:00');
  const timeZone = 'America/Chicago';
  const status = (dueAt) => taskDeadlineStatus(task({ dueAt }), { now, timeZone });
  assert.deepEqual(status(null), { state: 'none', daysLeft: null, urgent: false });
  assert.deepEqual(status('2026-09-29T20:00:00-05:00'), { state: 'overdue', daysLeft: null, urgent: true });
  assert.deepEqual(status('2026-09-29T23:30:00-05:00'), { state: 'today', daysLeft: 0, urgent: true });
  assert.deepEqual(status('2026-09-30T00:30:00-05:00'), { state: 'upcoming', daysLeft: 1, urgent: true });
  assert.deepEqual(status('2026-10-01T23:59:00-05:00'), { state: 'upcoming', daysLeft: 2, urgent: true });
  assert.deepEqual(status('2026-10-02T00:00:00-05:00'), { state: 'upcoming', daysLeft: 3, urgent: false });
  assert.deepEqual(taskDeadlineStatus(task({ dueAt: '2026-09-30T03:00:00Z' }), { now, timeZone: 'UTC' }), { state: 'today', daysLeft: 0, urgent: true });

  assert.equal(taskDeadlineLabel(status('2026-09-29T23:30:00-05:00'), 'en'), 'Due today');
  assert.equal(taskDeadlineLabel(status('2026-09-30T00:30:00-05:00'), 'en'), '1 day left');
  assert.equal(taskDeadlineLabel(status('2026-10-02T09:00:00-05:00'), 'en'), '3 days left');
  assert.equal(taskDeadlineLabel(status('2026-10-02T09:00:00-05:00'), 'zh-CN'), '还剩 3 天');
  assert.equal(taskDeadlineLabel(status('2026-09-28T09:00:00-05:00'), 'en'), 'Overdue');
  assert.equal(taskDeadlineLabel(status('2026-09-28T09:00:00-05:00'), 'zh-CN'), '已过期');
  assert.equal(taskDeadlineLabel(status('2026-09-29T23:30:00-05:00'), 'zh-CN'), '今天截止');
  assert.equal(taskDeadlineLabel(status(null), 'en'), 'No deadline');
  assert.equal(taskDeadlineLabel(status(null), 'zh-CN'), '无截止时间');
});

test('localizes task kinds without inventing unknown labels', () => {
  assert.equal(taskKindLabel('assessment', 'en'), 'Assessment');
  assert.equal(taskKindLabel('assessment', 'zh-CN'), '测评');
  assert.equal(taskKindLabel('interview', 'zh-CN'), '面试');
  assert.equal(taskKindLabel('other', 'en'), 'Other step');
  assert.equal(taskKindLabel('take_home', 'zh-CN'), 'take_home');
});

const lead = (id, overrides = {}) => application({
  id, company: 'Example Corp', role: `Role ${id}`, status: 'lead', source: 'greenhouse', location: null,
  postedAt: null, deadlineAt: null, fit: null, fitConfidence: null, fitNote: null, verifiedAt: null, skipReason: null,
  createdAt: '2026-09-20T00:00:00Z', ...overrides,
});

const queueFixture = () => [
  lead('low-soon', { fit: 'low', deadlineAt: '2026-10-02T23:59:00-04:00' }),
  lead('unrated', { fit: null, deadlineAt: '2026-10-01T12:00:00Z' }),
  lead('high-late', { fit: 'high', deadlineAt: '2026-10-20T23:59:00-04:00' }),
  lead('high-no-deadline-new', { fit: 'high', postedAt: '2026-09-29T10:00:00Z' }),
  lead('high-no-deadline-old', { fit: 'high', postedAt: '2026-09-20T10:00:00Z' }),
  lead('high-soon', { fit: 'high', deadlineAt: '2026-10-05T17:00:00Z' }),
  lead('medium-same-deadline-older-post', { fit: 'medium', deadlineAt: '2026-10-10T00:00:00Z', postedAt: '2026-09-01T00:00:00Z' }),
  lead('medium-same-deadline-newer-post', { fit: 'medium', deadlineAt: '2026-10-10T00:00:00Z', postedAt: '2026-09-15T00:00:00Z' }),
  lead('high-tie-b', { fit: 'high', createdAt: '2026-09-21T00:00:00Z' }),
  lead('high-tie-a', { fit: 'high', createdAt: '2026-09-21T00:00:00Z' }),
  lead('skipped', { fit: 'high', status: 'withdrawn', skipReason: 'PhD students only', verifiedAt: '2026-09-30T12:00:00Z' }),
  lead('skip-reason-but-still-lead', { fit: 'high', skipReason: 'Requires clearance' }),
  lead('prepared', { fit: 'high', status: 'prepared' }),
  lead('applied', { fit: 'high', status: 'applied', appliedAt: '2026-09-25' }),
];

test('queue filter keeps unskipped leads in the same order as queue list without a profile', () => {
  const items = queueFixture();
  const expected = [
    'high-soon', 'high-late', 'high-no-deadline-new', 'high-no-deadline-old', 'high-tie-a', 'high-tie-b',
    'medium-same-deadline-newer-post', 'medium-same-deadline-older-post', 'low-soon', 'unrated',
  ];
  assert.deepEqual(queueApplications(items).map((item) => item.id), expected);
  assert.deepEqual(filterApplications(items, { group: 'queue' }).map((item) => item.id), expected);
  // Same comparator result as `career-journal queue list` when no profile gives a location rank.
  const cli = items.filter(isQueued).map((item) => ({ ...item, locRank: null })).sort(compareQueueItems);
  assert.deepEqual(cli.map((item) => item.id), expected);
  assert.deepEqual([...items].filter(isQueued).sort(compareQueueApplications).map((item) => item.id), expected);
  assert.equal(isQueued(items.find((item) => item.id === 'skipped')), false);
  assert.equal(isQueued(items.find((item) => item.id === 'skip-reason-but-still-lead')), false);
  assert.equal(isQueued(items.find((item) => item.id === 'prepared')), false);
  assert.deepEqual(filterApplications(items, { group: 'queue', query: 'role high-no' }).map((item) => item.id), ['high-no-deadline-new', 'high-no-deadline-old']);
  assert.equal(filterApplications(items, { group: 'preparing' }).length, 12);
  assert.deepEqual(queueApplications([]), []);
});

test('labels fit, posting checks, and source names in both languages', () => {
  assert.equal(fitLevel('HIGH'), 'high');
  assert.equal(fitLevel('excellent'), 'none');
  assert.equal(fitLevel(null), 'none');
  assert.equal(fitLabel('high', 'en'), 'High fit');
  assert.equal(fitLabel('medium', 'en'), 'Medium fit');
  assert.equal(fitLabel('low', 'en'), 'Low fit');
  assert.equal(fitLabel(null, 'en'), 'Fit not rated');
  assert.equal(fitLabel('high', 'zh-CN'), '高匹配');
  assert.equal(fitLabel('medium', 'zh-CN'), '中匹配');
  assert.equal(fitLabel('low', 'zh-CN'), '低匹配');
  assert.equal(fitLabel(undefined, 'zh-CN'), '未评匹配度');
  assert.equal(postingCheckLabel({ verifiedAt: '2026-09-30T12:00:00Z' }, 'en'), 'Verified');
  assert.equal(postingCheckLabel({ verifiedAt: null }, 'en'), 'Not yet verified');
  assert.equal(postingCheckLabel({ verifiedAt: '2026-09-30T12:00:00Z' }, 'zh-CN'), '已核实');
  assert.equal(postingCheckLabel({}, 'zh-CN'), '尚未核实');
  assert.equal(sourceName('greenhouse'), 'Greenhouse');
  assert.equal(sourceName('simplify'), 'SimplifyJobs');
  assert.equal(sourceName('custom-board'), 'custom-board');
  assert.equal(sourceName(null), null);
});

test('summarizes queue facts for preparing cards and skip reasons for withdrawn ones', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const timeZone = 'America/New_York';
  const verified = queueSummary(lead('verified', {
    fit: 'high', fitNote: 'Rule-based fit: primary direction in the title', deadlineAt: '2026-10-02T23:59:00-04:00',
    location: 'New York, NY', verifiedAt: '2026-10-01T09:00:00Z',
  }), { locale: 'en', now, timeZone });
  assert.deepEqual(verified, {
    queued: true,
    fit: { level: 'high', label: 'High fit', note: 'Rule-based fit: primary direction in the title' },
    deadline: { at: '2026-10-02T23:59:00-04:00', status: { state: 'upcoming', daysLeft: 1, urgent: true }, hint: '1 day left' },
    location: 'New York, NY',
    source: 'Greenhouse',
    check: { state: 'verified', at: '2026-10-01T09:00:00Z', label: 'Verified' },
    skipReason: null,
  });

  const manual = queueSummary(application({ id: 'manual', status: 'prepared' }), { locale: 'zh-CN', now, timeZone });
  assert.deepEqual(manual, {
    queued: false,
    fit: { level: 'none', label: '未评匹配度', note: null },
    deadline: { at: null, status: { state: 'none', daysLeft: null, urgent: false }, hint: '无截止时间' },
    location: null,
    source: null,
    check: { state: 'unverified', at: null, label: '尚未核实' },
    skipReason: null,
  });

  const overdue = queueSummary(lead('overdue', { fit: 'medium', deadlineAt: '2026-09-30T23:59:00-04:00' }), { locale: 'zh-CN', now, timeZone });
  assert.equal(overdue.deadline.hint, '已过期');
  assert.equal(overdue.fit.label, '中匹配');

  const skipped = queueSummary(lead('skipped', {
    status: 'withdrawn', fit: 'low', skipReason: '  PhD students only  ', deadlineAt: '2026-10-15T23:59:00-04:00', verifiedAt: '2026-09-30T12:00:00Z',
  }), { locale: 'en', now, timeZone });
  assert.equal(skipped.queued, false);
  assert.equal(skipped.skipReason, 'PhD students only');
  assert.deepEqual(skipped.deadline, { at: '2026-10-15T23:59:00-04:00', status: null, hint: null });
  assert.equal(skipped.check.label, 'Verified');

  assert.equal(queueSummary(lead('applied', { status: 'applied', fit: 'high' }), { now, timeZone }), null);
  assert.equal(queueSummary(lead('withdrawn-by-user', { status: 'withdrawn' }), { now, timeZone }), null);
  assert.equal(queueSummary(lead('bad-deadline', { deadlineAt: 'soon' }), { now, timeZone }).deadline.at, null);
});
