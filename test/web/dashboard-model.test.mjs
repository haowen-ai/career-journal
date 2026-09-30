import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationGroup,
  applicationStats,
  compareEventsNewestFirst,
  compareTasksByDue,
  filterApplications,
  hasOpenTask,
  latestEvent,
  materialKindLabel,
  openTasks,
  suggestedNextAction,
  taskDeadlineLabel,
  taskDeadlineStatus,
  taskKindLabel,
  taskQueue,
  verificationLabel,
} from '../../web/dashboard-model.js';

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
