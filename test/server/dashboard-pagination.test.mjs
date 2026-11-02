import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate } from '../../src/storage/database.mjs';
import { dashboardIndex, dashboardPage, dashboardPageDetails, dashboardSummary, handleApi } from '../../src/server/routes.mjs';
import * as model from '../../web/dashboard-model.js';
import { createDashboardLoader } from '../../web/dashboard-loader.js';

const now = Date.parse('2026-11-02T18:00:00Z');
const timeZone = 'America/Chicago';
const options = { now, timeZone };
const params = (value) => new URLSearchParams(value);

async function fixture(t, count = 37) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dashboard-page-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  migrate(db);
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const statuses = ['lead', 'prepared', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'accepted', 'declined', 'unknown'];
  const deadlines = [null, 'bad date', '2026-11-01T12:00:00-06:00', '2026-11-01T11:59:59-06:00',
    '2026-11-02T12:00:00-06:00', '2026-11-03T00:01:00+09:00', '2026-11-04T23:59:00-06:00', '2026-11-09', '2026-12-01'];
  const companies = ['Écho', 'echo', 'İSTANBUL', '中文', '100%_literal', 'Acme', 'Alpha'];
  const insert = db.prepare(`INSERT INTO applications (id,company,role,external_id,status,applied_at,created_at,updated_at,
    skip_reason,fit,deadline_at,posted_at,fit_note,location,verified_at,job_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < count; i++) {
    insert.run(`app-${i}`, companies[i % companies.length], i % 2 ? 'Engineer %_' : 'Analyst Δ', `REQ-${i}`,
      statuses[i % statuses.length], i % 3 === 0 ? '2026-10-10' : null,
      '2026-10-01T00:00:00Z', i % 2 ? '2026-10-02T03:00:00+03:00' : '2026-10-02T00:00:00Z',
      i % 13 === 1 ? 'held' : null, ['high', 'medium', 'low', null, 'HIGH', 'unknown'][i % 6], deadlines[i % deadlines.length],
      i % 3 ? '2026-10-01T01:00:00+01:00' : 'invalid', 'Fit evidence', 'Remote', i % 2 ? '2026-10-31' : null, 'https://example.org/role');
    for (let j = 0; j < 3; j++) {
      db.prepare(`INSERT INTO application_events (id,application_id,event_type,observed_at,recorded_at,title,note,source_json,status_after,content_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`evt-${i}-${j}`, `app-${i}`, j === 0 || (j === 1 && i % 4 === 0) ? 'deadline_review' : i % 7 === 0 ? 'application_submitted' : 'note',
        '2026-10-30T00:00:00Z', j === 0 ? '2026-10-30T00:00:00Z' : '2026-10-31T02:00:00+02:00', 'Event',
        j === 0 ? '截止说明：官方未写截止\nDeadline: No cutoff listed\n来源：https://example.org/deadline' : j === 1 ? 'Deadline: Latest review\n来源：https://example.org/latest' : 'Private detail',
        JSON.stringify({ kind: j ? 'secret-provider' : 'user', private: 'must not leak' }), i % 9 === 0 ? 'applied' : null, `hash-${i}-${j}`);
      db.prepare(`INSERT INTO artifacts (id,application_id,kind,lifecycle,file_name,storage_path,sha256,submitted_at,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(`art-${i}-${j}`, `app-${i}`, 'resume', i % 8 === 0 ? 'submitted' : 'draft', 'resume.txt', '/private/unused',
        `digest-${i}-${j}`, j ? null : '2026-10-31T00:00:00-05:00', '2026-10-30T00:00:00Z');
      db.prepare(`INSERT INTO application_tasks (id,application_id,kind,title,due_at,status,note,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(`task-${i}-${j}`, `app-${i}`, 'assessment', 'Assessment', deadlines[(i + j) % deadlines.length],
        j === 2 ? 'done' : 'open', 'Task detail', '2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z');
    }
  }
  return db;
}

async function api(db, pathname) {
  let body;
  let status;
  await handleApi({ method: 'GET' }, { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } },
    new URL(pathname, 'http://localhost'), { db, config: { timezone: timeZone } });
  assert.equal(status, 200);
  return body;
}

const groups = ['all', 'sent', 'waiting', 'interview', 'closed', 'preparing', 'skipped', 'tasks', 'queue', 'unknown'];
test('dashboard pages equal the complete old API objects for every group × sort × fit and Unicode/literal/cross-field query', async (t) => {
  const db = await fixture(t);
  const baseline = (await api(db, '/api/dashboard')).applications;
  for (const group of groups) for (const sort of [null, ...model.ROLE_SORTS]) for (const fit of model.FIT_FILTERS) {
    for (const query of ['', 'Engineer', 'ÉCHO', 'İSTANBUL', '%_', 'Acme Analyst', '#REQ-1', '中文', 'app-1', 'missing']) {
      const expected = model.filterApplications(baseline, { group, sort, fit, query, now });
      const actual = [];
      for (let page = 1; page <= Math.max(1, Math.ceil(expected.length / 4)); page++) {
        const result = dashboardPage(db, params({ group, sort: sort ?? '', fit, query, page, pageSize: 4 }), options);
        assert.equal(result.total, expected.length);
        assert.deepEqual(result.fitCounts, model.fitCounts(model.filterApplications(baseline, { group, query, now })));
        actual.push(...result.applications);
      }
      assert.deepEqual(actual, expected, JSON.stringify({ group, sort, fit, query }));
    }
  }
});

test('dashboard summary equals global old-model statistics, full task rows and bilingual to-apply rendering', async (t) => {
  const db = await fixture(t, 63);
  const baseline = (await api(db, '/api/dashboard')).applications;
  const summary = dashboardSummary(db, options);
  assert.equal(summary.total, baseline.length);
  assert.equal(summary.generatedAt, new Date(now).toISOString());
  assert.equal(summary.timezone, timeZone);
  assert.deepEqual(summary.stats, model.applicationStats(baseline));
  for (const group of groups.filter((group) => group !== 'unknown')) {
    assert.equal(summary.groups[group], model.filterApplications(baseline, { group, now }).length);
  }
  assert.deepEqual(summary.taskQueue, model.taskQueue(baseline));
  assert.deepEqual(summary.taskCardSummary, model.taskCardSummary(baseline, options));
  const expectedQueue = model.toApplyQueue(baseline, options);
  for (const group of model.TO_APPLY_GROUPS) {
    assert.deepEqual(summary.toApplyQueue[group].map((row) => row.id), expectedQueue[group].map((row) => row.id));
    for (const locale of ['en', 'zh-CN']) assert.deepEqual(summary.toApplyQueue[group].map((row) => model.toApplyRow(row, { ...options, locale })),
      expectedQueue[group].map((row) => model.toApplyRow(row, { ...options, locale })));
  }
  assert.ok(Object.values(summary.toApplyQueue).flat().some((row) => row.events.length));
  for (const row of dashboardIndex(db)) {
    assert.ok(!('note' in row) && !('artifacts' in row) && !('fitNote' in row));
    assert.ok(row.events.every((event) => Object.keys(event).join() === 'type'));
    assert.ok(row.tasks.every((task) => Object.keys(task).join() === 'status'));
  }
});

test('dashboard pagination handles empty, last/out-of-range pages, defaults and the 200-row cap', async (t) => {
  const db = await fixture(t, 222);
  for (const [input, expected] of [[{}, 50], [{ pageSize: '999' }, 200], [{ pageSize: '-1' }, 50], [{ pageSize: '1.5' }, 50]]) {
    const result = dashboardPage(db, params(input), options);
    assert.equal(result.pageSize, expected);
    assert.equal(result.applications.length, Math.min(expected, result.total));
  }
  const empty = dashboardPage(db, params({ query: 'no such result', page: 999 }), options);
  assert.deepEqual({ ...empty, fitCounts: undefined }, { total: 0, page: 1, pageSize: 50, applications: [], fitCounts: undefined });
  const last = dashboardPage(db, params({ pageSize: 7, page: 999 }), options);
  assert.equal(last.page, Math.ceil(last.total / 7));
  assert.equal(last.applications.length, last.total % 7 || 7);
  assert.equal(dashboardPage(db, params({ page: '-4' }), options).page, 1);
  const route = await api(db, '/api/dashboard/page?group=queue&pageSize=2');
  assert.equal(route.pageSize, 2);
  assert.ok(route.applications.length <= 2);
  assert.equal((await api(db, '/api/dashboard/summary')).total, dashboardIndex(db).length);
});

function trace(db) {
  const sql = [];
  const proxy = new Proxy(db, { get(target, name) {
    if (name === 'prepare') return (text) => { sql.push(text); return target.prepare(text); };
    const value = target[name];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db: proxy, sql };
}

test('dashboard query count stays constant and page SQL never decodes off-page details', async (t) => {
  for (const size of [3, 83]) {
    const db = await fixture(t, size);
    const tracked = trace(db);
    dashboardPage(tracked.db, params({ pageSize: 1 }), options);
    assert.equal(tracked.sql.length, 2);
    assert.match(tracked.sql[1], /json_group_array/);
    assert.match(tracked.sql[1], /WHERE application_id IN \(SELECT value FROM selected\)/);
    tracked.sql.length = 0;
    dashboardSummary(tracked.db, options);
    assert.equal(tracked.sql.length, 3);
    const selected = dashboardPage(db, params({ pageSize: 1 }), options).applications[0].id;
    db.prepare("UPDATE application_events SET source_json = 'INVALID JSON', note = 'off-page detail' WHERE application_id != ?").run(selected);
    assert.equal(dashboardPage(db, params({ pageSize: 1 }), options).applications[0].id, selected);
    assert.doesNotThrow(() => dashboardSummary(db, options));
    assert.deepEqual(dashboardPageDetails(db, []), []);
  }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('dashboard loader ignores stale success/error, invalidates on debounce and retries current-page failures', async () => {
  const pending = [], data = [], errors = [], loading = [];
  const load = createDashboardLoader({ fetchJson: (url) => { const item = { ...deferred(), url }; pending.push(item); return item.promise; },
    onData: (value) => data.push(value), onError: (value) => errors.push(value), onLoading: (value) => loading.push(value) });
  const first = load({ group: 'all' });
  const next = load({ group: 'queue', query: '%_', page: 2 });
  assert.ok(pending[3].url.includes('group=queue') && pending[3].url.includes('page=2'));
  pending[2].resolve('summary-new'); pending[3].resolve('page-new'); await next;
  pending[0].resolve('summary-old'); pending[1].resolve('page-old'); await first;
  assert.deepEqual(data, [{ summary: 'summary-new', result: 'page-new' }]);
  const staleError = load(); load.invalidate();
  pending[4].reject(new Error('stale')); pending[5].resolve('ignored'); await staleError;
  assert.equal(errors.length, 0);
  const failure = load({ page: 3 }); pending[6].reject(new Error('current')); pending[7].resolve('ignored'); await failure;
  assert.equal(errors.length, 1);
  const retry = load({ page: 3 }); pending[8].resolve('retry-summary'); pending[9].resolve({ page: 2 }); await retry;
  assert.equal(data.at(-1).result.page, 2);
  assert.equal(loading.at(-1), false);
});


test('dashboard keeps empty child arrays and empty-workspace summary without loading any details', async (t) => {
  const db = await fixture(t, 0);
  const empty = dashboardSummary(db, options);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.taskQueue, { open: [], done: [] });
  assert.deepEqual(empty.toApplyQueue, { today: [], week: [], later: [], none: [] });
  db.prepare(`INSERT INTO applications(id,company,role,status,created_at,updated_at)
    VALUES ('bare', 'Bare company', 'Engineer', 'lead', '1990-01-01', '1990-01-01')`).run();
  const baseline = (await api(db, '/api/dashboard')).applications;
  const page = dashboardPage(db, params({}), options);
  assert.deepEqual(page.applications, baseline);
  for (const key of ['events', 'artifacts', 'tasks']) assert.deepEqual(page.applications[0][key], []);
});


test('dashboard pages preserve old alphabetical order when all activity predates the Unix epoch', async (t) => {
  const db = await fixture(t, 2);
  for (const [id, company, at] of [['app-0', 'A', '1960-01-01'], ['app-1', 'Z', '1969-01-01']]) {
    db.prepare('UPDATE applications SET company = ?, updated_at = ?, skip_reason = NULL WHERE id = ?').run(company, at, id);
    db.prepare('UPDATE application_events SET recorded_at = ?, observed_at = ? WHERE application_id = ?').run(at, at, id);
    db.prepare('UPDATE artifacts SET recorded_at = ?, submitted_at = ? WHERE application_id = ?').run(at, at, id);
  }
  const baseline = (await api(db, '/api/dashboard')).applications;
  assert.deepEqual(baseline.map((row) => row.company), ['A', 'Z']);
  const pages = [1, 2].flatMap((page) => dashboardPage(db, params({ page, pageSize: 1 }), options).applications);
  assert.deepEqual(pages, baseline);
});
