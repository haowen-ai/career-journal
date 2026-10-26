import test from 'node:test';
import assert from 'node:assert/strict';
import { queueSummary, toApplyRow } from '../../web/dashboard-model.js';

const role = {
  id: 'example', company: 'Example', role: 'Intern', status: 'lead', events: [],
};
const review = (id, recordedAt, note) => ({ id, type: 'deadline_review', recordedAt, note });

test('a reviewed rolling deadline shows its official source in the apply row and role card', () => {
  const application = { ...role, events: [review('review', '2026-10-11T12:00:00Z',
    '截止说明：滚动招聘 · 无固定截止日\nDeadline: Rolling applications · No fixed deadline\n来源：https://example.com/careers\n核验日期：2026-10-11')] };
  for (const summary of [toApplyRow(application, { locale: 'zh-CN' }), queueSummary(application, { locale: 'zh-CN' })]) {
    assert.equal(summary.deadline.review.label, '滚动招聘 · 无固定截止日');
    assert.equal(summary.deadline.review.sourceUrl, 'https://example.com/careers');
    assert.equal(summary.deadline.at, null);
  }
  assert.equal(toApplyRow(application).deadline.review.label, 'Rolling applications · No fixed deadline');
});

test('the latest deadline review wins even when a later unrelated event exists', () => {
  const application = { ...role, events: [
    review('old', '2026-10-10T12:00:00Z', '截止说明：旧值\n来源：https://example.com/old'),
    { id: 'unrelated', type: 'application_update', recordedAt: '2026-10-12T12:00:00Z', note: '截止说明：不应采用' },
    review('new', '2026-10-11T12:00:00Z', '截止说明：官网未公布截止日\n来源：https://example.com/new'),
  ] };
  assert.equal(toApplyRow(application, { locale: 'zh-CN' }).deadline.review.label, '官网未公布截止日');
  assert.equal(toApplyRow(application, { locale: 'zh-CN' }).deadline.review.sourceUrl, 'https://example.com/new');
});

test('unsafe source links are rejected, and a date-only posting close does not invent a cutoff hour', () => {
  const application = { ...role, events: [review('review', '2026-10-11T12:00:00Z',
    '截止说明：2026-11-06 · 官网职位关闭日，时间未公布\n来源：javascript:alert(1)')] };
  const summary = toApplyRow(application, { locale: 'zh-CN' });
  assert.equal(summary.deadline.review.sourceUrl, null);
  assert.equal(summary.deadline.at, null);
  assert.equal(summary.deadline.status.state, 'none');
});

test('a verified exact deadline keeps its countdown alongside the review', () => {
  const application = { ...role, deadlineAt: '2026-11-06T05:00:00Z', events: [review('review', '2026-10-11T12:00:00Z',
    '截止说明：官网时间已确认\n来源：https://example.com/job')] };
  const summary = toApplyRow(application, { locale: 'zh-CN', now: '2026-11-05T12:00:00Z', timeZone: 'America/Chicago' });
  assert.equal(summary.deadline.at, application.deadlineAt);
  assert.equal(summary.deadline.status.state, 'today');
  assert.equal(summary.deadline.review.label, '官网时间已确认');
});
