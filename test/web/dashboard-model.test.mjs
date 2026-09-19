import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationGroup,
  applicationStats,
  compareEventsNewestFirst,
  filterApplications,
  latestEvent,
  materialKindLabel,
  suggestedNextAction,
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
