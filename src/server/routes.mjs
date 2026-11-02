import * as dashboardModel from '../../web/dashboard-model.js';
import { createApplication, listApplications } from '../commands/application.mjs';
import { recordEvent } from '../domain/events.mjs';
import { compareTasksByDue, getTask, listTasks, setTaskStatus } from '../domain/tasks.mjs';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const MAX_BODY = 1_000_000;
const execFileAsync = promisify(execFile);

const artifactContentTypes = new Map([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

export function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

export async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('Request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

// Role-queue columns (schema 5) are included by name only: the source name but
// not its source_id, and no posting text or decision trace.
const applicationSelect = `SELECT id, company, role, external_id externalId, job_url jobUrl, status,
    stage, applied_at appliedAt, created_at createdAt, updated_at updatedAt,
    source, location, posted_at postedAt, deadline_at deadlineAt, fit, fit_confidence fitConfidence,
    fit_note fitNote, verified_at verifiedAt, skip_reason skipReason FROM applications`;

function applicationDetail(db, id) {
  const application = db.prepare(`${applicationSelect} WHERE id = ?`).get(id);
  if (!application) return null;
  const events = db.prepare(`SELECT id, event_type type, occurred_at occurredAt, observed_at observedAt,
    recorded_at recordedAt, title, note, source_json source, status_after statusAfter
    FROM application_events WHERE application_id = ? ORDER BY recorded_at DESC, id`).all(id)
    .map((event) => ({ ...event, source: JSON.parse(event.source) }));
  const artifacts = db.prepare(`SELECT id, kind, lifecycle, file_name fileName, sha256, submitted_at submittedAt,
    recorded_at recordedAt, verification FROM artifacts WHERE application_id = ? ORDER BY recorded_at DESC, id`).all(id);
  const tasks = listTasks(db, { applicationId: id }).map(publicTask);
  return { ...application, events, artifacts, tasks };
}

function publicTask({ id, kind, title, platform, link, dueAt, dueNote, status, note, createdAt, updatedAt }) {
  return { id, kind, title, platform, link: link ?? null, dueAt, dueNote, status, note, createdAt, updatedAt };
}

const safeSourceKinds = new Set(['api', 'cli', 'email', 'import', 'manual', 'system', 'role-scan', 'queue-verify']);

function dashboardApplication(detail) {
  return {
    ...detail,
    events: detail.events.map(({ source, ...event }) => {
      const rawCandidate = String(source?.kind ?? source?.provider ?? '').toLowerCase();
      const candidate = rawCandidate === 'user' ? 'manual' : rawCandidate;
      return { ...event, sourceKind: safeSourceKinds.has(candidate) ? candidate : 'other' };
    }),
  };
}

function dashboardApplications(db) {
  const visible = "status != 'withdrawn' OR applied_at IS NOT NULL";
  const applications = db.prepare(`${applicationSelect} WHERE ${visible}
    ORDER BY company COLLATE NOCASE, role COLLATE NOCASE, id`).all();
  if (!applications.length) return [];
  const retainedIds = `SELECT id FROM applications WHERE ${visible}`;
  const details = new Map(applications.map((application) => [application.id,
    { ...application, events: [], artifacts: [], tasks: [] }]));
  const events = db.prepare(`SELECT application_id applicationId, id, event_type type, occurred_at occurredAt,
    observed_at observedAt, recorded_at recordedAt, title, note, source_json source, status_after statusAfter
    FROM application_events WHERE application_id IN (${retainedIds}) ORDER BY recorded_at DESC, id`).all();
  for (const { applicationId, source, ...event } of events) {
    details.get(applicationId).events.push({ ...event, source: JSON.parse(source) });
  }
  const artifacts = db.prepare(`SELECT application_id applicationId, id, kind, lifecycle, file_name fileName,
    sha256, submitted_at submittedAt, recorded_at recordedAt, verification
    FROM artifacts WHERE application_id IN (${retainedIds}) ORDER BY recorded_at DESC, id`).all();
  for (const { applicationId, ...artifact } of artifacts) details.get(applicationId).artifacts.push(artifact);
  const tasks = db.prepare(`SELECT application_id applicationId, id, kind, title, platform, link, due_at dueAt,
    due_note dueNote, status, note, source_json source, created_at createdAt, updated_at updatedAt
    FROM application_tasks WHERE application_id IN (${retainedIds})`).all();
  for (const { applicationId, source, ...task } of tasks) {
    details.get(applicationId).tasks.push(publicTask({ ...task, source: JSON.parse(source) }));
  }
  return [...details.values()].map((detail) => dashboardApplication({
    ...detail, tasks: detail.tasks.sort(compareTasksByDue),
  }));
}

function latestApplicationTime(application) {
  const eventTime = application.events.reduce((latest, event) => {
    const value = Date.parse(event.recordedAt ?? event.observedAt ?? event.occurredAt ?? 0) || 0;
    return Math.max(latest, value);
  }, 0);
  const artifactTime = application.artifacts.reduce((latest, artifact) => {
    const recorded = Date.parse(artifact.recordedAt ?? 0) || 0;
    const submitted = Date.parse(artifact.submittedAt ?? 0) || 0;
    return Math.max(latest, recorded, submitted);
  }, 0);
  return Math.max(eventTime, artifactTime, Date.parse(application.updatedAt ?? 0) || 0);
}

async function resolveArtifactFile(artifact, artifactRoot) {
  if (!artifactRoot) {
    const error = new Error('Artifact file is unavailable');
    error.status = 404;
    throw error;
  }
  const [resolvedRoot, resolvedFile] = await Promise.all([
    realpath(path.resolve(artifactRoot)),
    realpath(path.resolve(artifact.storagePath)),
  ]);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    const error = new Error('Artifact file is unavailable');
    error.status = 404;
    throw error;
  }
  const fileStat = await stat(resolvedFile);
  if (!fileStat.isFile()) {
    const error = new Error('Artifact file is unavailable');
    error.status = 404;
    throw error;
  }
  return { resolvedFile, fileStat, fileName: String(artifact.fileName ?? 'artifact').replace(/[\r\n"]/g, '_') };
}

export async function revealInFileManager(filePath, { platform = process.platform, run = execFileAsync } = {}) {
  if (platform === 'darwin') await run('open', ['-R', filePath]);
  else if (platform === 'win32') await run('explorer.exe', ['/select,', filePath]);
  else await run('xdg-open', [path.dirname(filePath)]);
}

async function sendArtifact(response, artifact, artifactRoot) {
  try {
    const { resolvedFile, fileStat, fileName } = await resolveArtifactFile(artifact, artifactRoot);
    response.writeHead(200, {
      'content-type': artifactContentTypes.get(path.extname(fileName).toLowerCase()) ?? 'application/octet-stream',
      'content-length': fileStat.size,
      'content-disposition': `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(resolvedFile).pipe(response);
  } catch {
    sendJson(response, 404, { error: 'Artifact file is unavailable' });
  }
}

export async function handleApi(request, response, url, { db, config, artifactRoot, revealFile = revealInFileManager }) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, schemaVersion: config.schemaVersion });
    return true;
  }
  if (url.pathname === '/api/applications' && request.method === 'GET') {
    sendJson(response, 200, listApplications(db));
    return true;
  }
  if (url.pathname === '/api/dashboard' && request.method === 'GET') {
    const applications = dashboardApplications(db)
      .sort((left, right) => latestApplicationTime(right) - latestApplicationTime(left)
        || left.company.localeCompare(right.company, 'en')
        || left.role.localeCompare(right.role, 'en'));
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      timezone: config.timezone,
      applications,
    });
    return true;
  }
  if (request.method === 'GET' && ['/api/dashboard/page', '/api/dashboard/summary'].includes(url.pathname)) {
    sendJson(response, 200, url.pathname.endsWith('/page')
      ? dashboardPage(db, url.searchParams)
      : dashboardSummary(db, { timeZone: config.timezone }));
    return true;
  }
  const artifactMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/file$/);
  if (artifactMatch && request.method === 'GET') {
    const artifact = db.prepare('SELECT file_name fileName, storage_path storagePath FROM artifacts WHERE id = ?')
      .get(decodeURIComponent(artifactMatch[1]));
    if (!artifact) sendJson(response, 404, { error: 'Artifact not found' });
    else await sendArtifact(response, artifact, artifactRoot);
    return true;
  }
  const revealMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/reveal$/);
  if (revealMatch && request.method === 'POST') {
    const artifact = db.prepare('SELECT file_name fileName, storage_path storagePath FROM artifacts WHERE id = ?')
      .get(decodeURIComponent(revealMatch[1]));
    if (!artifact) sendJson(response, 404, { error: 'Artifact not found' });
    else {
      const { resolvedFile } = await resolveArtifactFile(artifact, artifactRoot);
      await revealFile(resolvedFile);
      sendJson(response, 200, { ok: true });
    }
    return true;
  }
  const taskStatusMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (taskStatusMatch && request.method === 'POST') {
    const taskId = decodeURIComponent(taskStatusMatch[1]);
    const input = await readJson(request);
    if (!getTask(db, taskId)) sendJson(response, 404, { error: 'Task not found' });
    else sendJson(response, 200, { ok: true, task: publicTask(setTaskStatus(db, taskId, input?.status)) });
    return true;
  }
  if (url.pathname === '/api/applications' && request.method === 'POST') {
    sendJson(response, 201, createApplication(db, await readJson(request)));
    return true;
  }
  const eventMatch = url.pathname.match(/^\/api\/applications\/([^/]+)\/events$/);
  if (eventMatch && request.method === 'POST') {
    const input = await readJson(request);
    sendJson(response, 200, recordEvent(db, { ...input, applicationId: decodeURIComponent(eventMatch[1]) }));
    return true;
  }
  const detailMatch = url.pathname.match(/^\/api\/applications\/([^/]+)$/);
  if (detailMatch && request.method === 'GET') {
    const detail = applicationDetail(db, decodeURIComponent(detailMatch[1]));
    if (!detail) sendJson(response, 404, { error: 'Application not found' });
    else sendJson(response, 200, detail);
    return true;
  }
  return false;
}

const dashboardSqlReady = new WeakSet();
const visibleDashboard = "status != 'withdrawn' OR applied_at IS NOT NULL";

function dashboardSqlFunctions(db) {
  if (dashboardSqlReady.has(db)) return;
  // SQLite's date parser is not Date.parse. Run the exact JS conversion inside
  // the aggregates, so offsets, invalid values and null fallbacks stay identical.
  db.function('dashboard_time', { deterministic: true }, (value) => Date.parse(value ?? 0) || 0);
  db.function('dashboard_submitted_status', { deterministic: true }, (status) => Number(dashboardModel.wasApplied({ status })));
  db.aggregate('dashboard_review', {
    start: 'null',
    step: (previous, id, note, observedAt, recordedAt) => {
      const current = { id, type: 'deadline_review', note, observedAt, recordedAt };
      const old = JSON.parse(previous);
      return !old || dashboardModel.compareEventsNewestFirst(current, old) < 0 ? JSON.stringify(current) : previous;
    },
  });
  dashboardSqlReady.add(db);
}

// Exact index contract: company/role/externalId/id for search; status,
// appliedAt/skipReason and submitted/open aggregates for groups/stats; fit,
// deadlineAt/postedAt/createdAt for role ordering; latestActivity for the old
// route's default order. No event text, source JSON or artifact detail is read.
export function dashboardIndex(db) {
  dashboardSqlFunctions(db);
  const rows = db.prepare(`WITH
    e AS (SELECT application_id, MAX(dashboard_time(COALESCE(recorded_at, observed_at, occurred_at))) activity,
      MAX(event_type = 'application_submitted' OR dashboard_submitted_status(status_after)) submitted
      FROM application_events GROUP BY application_id),
    r AS (SELECT application_id, MAX(MAX(dashboard_time(recorded_at), dashboard_time(submitted_at))) activity,
      MAX(lifecycle = 'submitted') submitted FROM artifacts GROUP BY application_id),
    t AS (SELECT application_id, SUM(status = 'open') open FROM application_tasks GROUP BY application_id)
    SELECT a.id, company, role, external_id externalId, status, applied_at appliedAt,
      created_at createdAt, skip_reason skipReason, fit, posted_at postedAt, deadline_at deadlineAt,
      COALESCE(e.submitted, 0) OR COALESCE(r.submitted, 0) submitted,
      COALESCE(t.open, 0) open,
      MAX(0, dashboard_time(updated_at), COALESCE(e.activity, 0), COALESCE(r.activity, 0)) latestActivity
    FROM applications a LEFT JOIN e ON e.application_id = a.id
    LEFT JOIN r ON r.application_id = a.id LEFT JOIN t ON t.application_id = a.id
    WHERE ${visibleDashboard} ORDER BY company COLLATE NOCASE, role COLLATE NOCASE, a.id`).all();
  return rows.map(({ submitted, open, ...row }) => ({ ...row,
    events: submitted ? [{ type: 'application_submitted' }] : [],
    tasks: open ? [{ status: 'open' }] : [],
  })).sort((left, right) => right.latestActivity - left.latestActivity
    || left.company.localeCompare(right.company, 'en') || left.role.localeCompare(right.role, 'en'));
}

const pageChildren = {
  events: { table: 'application_events', order: 'recorded_at DESC, id', fields: {
    id: 'id', type: 'event_type', occurredAt: 'occurred_at', observedAt: 'observed_at', recordedAt: 'recorded_at',
    title: 'title', note: 'note', source: 'source_json', statusAfter: 'status_after',
  } },
  artifacts: { table: 'artifacts', order: 'recorded_at DESC, id', fields: {
    id: 'id', kind: 'kind', lifecycle: 'lifecycle', fileName: 'file_name', sha256: 'sha256',
    submittedAt: 'submitted_at', recordedAt: 'recorded_at', verification: 'verification',
  } },
  tasks: { table: 'application_tasks', order: 'rowid', fields: {
    id: 'id', kind: 'kind', title: 'title', platform: 'platform', link: 'link', dueAt: 'due_at',
    dueNote: 'due_note', status: 'status', note: 'note', createdAt: 'created_at', updatedAt: 'updated_at',
  } },
};

export function dashboardPageDetails(db, ids) {
  if (!ids.length) return [];
  // Each child is restricted to selected IDs BEFORE aggregation. Joining the
  // three grouped results cannot multiply child rows. json(?) avoids bind caps.
  const groups = Object.entries(pageChildren).map(([name, { table, order, fields }]) => `page_${name} AS (
    SELECT application_id, json_group_array(json_object(${Object.entries(fields).map(([key, column]) => `'${key}', ${column}`).join(', ')})) items
    FROM (SELECT * FROM ${table} WHERE application_id IN (SELECT value FROM selected) ORDER BY ${order})
    GROUP BY application_id)`);
  const result = db.prepare(`WITH selected AS (SELECT value FROM json_each(?)), ${groups.join(', ')}
    SELECT a.*, COALESCE(page_events.items, '[]') events, COALESCE(page_artifacts.items, '[]') artifacts,
      COALESCE(page_tasks.items, '[]') tasks FROM (${applicationSelect} WHERE id IN (SELECT value FROM selected)) a
    LEFT JOIN page_events ON page_events.application_id = a.id LEFT JOIN page_artifacts ON page_artifacts.application_id = a.id
    LEFT JOIN page_tasks ON page_tasks.application_id = a.id`).all(JSON.stringify(ids));
  const byId = new Map(result.map((row) => {
    const application = dashboardApplication({ ...row,
      events: JSON.parse(row.events).map((event) => ({ ...event, source: JSON.parse(event.source) })),
      artifacts: JSON.parse(row.artifacts),
      // Keep the existing API's child-array comparator and order, including its
      // locale behavior; only dashboard filtering/search was narrowed to en.
      tasks: JSON.parse(row.tasks).sort(compareTasksByDue),
    });
    return [application.id, application];
  }));
  return ids.map((id) => byId.get(id));
}

function positivePage(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export function dashboardPage(db, params, { now = Date.now() } = {}) {
  const applications = dashboardIndex(db);
  const group = params.get('group') || 'all';
  const query = params.get('query') || '';
  const sort = params.get('sort') || null;
  const fit = params.get('fit') || 'all';
  const counts = dashboardModel.fitCounts(dashboardModel.filterApplications(applications, { group, query, now }));
  const filtered = dashboardModel.filterApplications(applications, { group, query, sort, fit, now });
  const pageSize = Math.min(200, positivePage(params.get('pageSize'), 50));
  const page = Math.min(positivePage(params.get('page'), 1), Math.max(1, Math.ceil(filtered.length / pageSize)));
  const ids = filtered.slice((page - 1) * pageSize, page * pageSize).map((item) => item.id);
  return { total: filtered.length, page, pageSize, fitCounts: counts, applications: dashboardPageDetails(db, ids) };
}

export function dashboardSummary(db, { now = Date.now(), timeZone = 'UTC' } = {}) {
  const index = dashboardIndex(db);
  // Summary widgets explicitly need complete public task rows and the latest
  // deadline review, but never source JSON, other events or artifact details.
  const tasks = db.prepare(`SELECT application_id applicationId, id, kind, title, platform, link, due_at dueAt,
    due_note dueNote, status, note, created_at createdAt, updated_at updatedAt FROM application_tasks
    WHERE application_id IN (SELECT id FROM applications WHERE ${visibleDashboard}) AND status IN ('open', 'done')`).all();
  const taskMap = new Map();
  for (const { applicationId, ...task } of tasks) {
    if (!taskMap.has(applicationId)) taskMap.set(applicationId, []);
    taskMap.get(applicationId).push(publicTask(task));
  }
  const taskApplications = index.map((item) => ({ ...item, tasks: (taskMap.get(item.id) ?? []).sort(compareTasksByDue) }));
  const waiting = db.prepare(`WITH reviews AS (
    SELECT application_id, dashboard_review(id, note, observed_at, recorded_at) review FROM application_events
    WHERE event_type = 'deadline_review' AND application_id IN (
      SELECT id FROM applications WHERE ${visibleDashboard} AND lower(status) IN ('lead', 'prepared') AND skip_reason IS NULL)
    GROUP BY application_id)
    SELECT a.id, company, role, status, skip_reason skipReason, fit, fit_note fitNote, location,
      deadline_at deadlineAt, posted_at postedAt, created_at createdAt, verified_at verifiedAt, job_url jobUrl,
      reviews.review FROM applications a LEFT JOIN reviews ON reviews.application_id = a.id
    WHERE (${visibleDashboard}) AND lower(status) IN ('lead', 'prepared') AND skip_reason IS NULL`).all();
  const waitingMap = new Map(waiting.map(({ review, ...item }) => [item.id, { ...item, events: review ? [JSON.parse(review)] : [] }]));
  const orderedWaiting = index.filter((item) => waitingMap.has(item.id)).map((item) => waitingMap.get(item.id));
  const stats = dashboardModel.applicationStats(index);
  const groups = Object.fromEntries(['all', 'sent', 'waiting', 'interview', 'closed', 'preparing', 'skipped', 'tasks', 'queue']
    .map((group) => [group, dashboardModel.filterApplications(index, { group, now }).length]));
  return { generatedAt: new Date(now).toISOString(), timezone: timeZone, total: index.length, stats, groups,
    taskCardSummary: dashboardModel.taskCardSummary(taskApplications, { now, timeZone }),
    taskQueue: dashboardModel.taskQueue(taskApplications),
    toApplyQueue: dashboardModel.toApplyQueue(orderedWaiting, { now, timeZone }),
  };
}
