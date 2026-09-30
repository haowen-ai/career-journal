import { createHash } from 'node:crypto';

export const taskKinds = Object.freeze(['assessment', 'interview', 'other']);
export const taskStatuses = Object.freeze(['open', 'done']);

const isoWithOffset = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/;
const comparedFields = ['kind', 'title', 'platform', 'dueAt', 'dueNote', 'status', 'note'];

const taskSelect = `SELECT t.id, t.application_id applicationId, a.company, a.role, t.kind, t.title, t.platform,
  t.due_at dueAt, t.due_note dueNote, t.status, t.note, t.source_json source, t.created_at createdAt, t.updated_at updatedAt
  FROM application_tasks t JOIN applications a ON a.id = t.application_id`;

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function text(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be text`);
  return value.trim();
}

function optionalText(value, name) {
  return value === null ? null : text(value, name) || null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function taskStatus(value) {
  if (!taskStatuses.includes(value)) throw new Error(`Task status must be ${taskStatuses.join(' or ')}`);
  return value;
}

export function taskKind(value) {
  const kind = required(value, 'task.kind');
  if (!taskKinds.includes(kind)) throw new Error(`Task kind must be one of: ${taskKinds.join(', ')}`);
  return kind;
}

export function normalizeDueAt(value) {
  if (value == null) return null;
  const message = 'task.dueAt must be an ISO 8601 timestamp with a UTC offset, such as 2026-10-01T23:59:00-07:00';
  if (typeof value !== 'string') throw new Error(message);
  const candidate = value.trim();
  const match = candidate.match(isoWithOffset);
  if (!match) throw new Error(message);
  const [, year, month, day, hour, minute, second = '00', offset, offsetHours, offsetMinutes] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  const calendarOk = date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    && date.getUTCSeconds() === Number(second);
  const offsetOk = offset === 'Z' || (Number(offsetHours) <= 14 && Number(offsetMinutes) <= 59);
  if (!calendarOk || !offsetOk || Number.isNaN(Date.parse(candidate))) throw new Error(message);
  return candidate;
}

export function deriveTaskId(applicationId, kind, title) {
  const normalizedTitle = String(title).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  return createHash('sha256').update(`${applicationId}\0${kind}\0${normalizedTitle}`).digest('hex').slice(0, 32);
}

function dueTime(task) {
  const value = Date.parse(task?.dueAt ?? '');
  return Number.isNaN(value) ? null : value;
}

export function compareTasksByDue(left, right) {
  const leftDue = dueTime(left);
  const rightDue = dueTime(right);
  if (leftDue !== rightDue) {
    if (leftDue === null) return 1;
    if (rightDue === null) return -1;
    return leftDue - rightDue;
  }
  return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
    || String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

function taskFromRow(row) {
  if (!row) return null;
  return { ...row, source: JSON.parse(row.source) };
}

export function getTask(db, id) {
  return taskFromRow(db.prepare(`${taskSelect} WHERE t.id = ?`).get(id));
}

export function listTasks(db, { status = null, applicationId = null } = {}) {
  if (status != null) taskStatus(status);
  return db.prepare(`${taskSelect} WHERE (? IS NULL OR t.status = ?) AND (? IS NULL OR t.application_id = ?)`)
    .all(status, status, applicationId, applicationId)
    .map(taskFromRow)
    .sort(compareTasksByDue);
}

export function upsertTask(db, input, now = new Date().toISOString()) {
  const applicationId = required(input.applicationId, 'task.applicationId');
  if (!db.prepare('SELECT 1 FROM applications WHERE id = ?').get(applicationId)) throw new Error(`Unknown application: ${applicationId}`);
  const kind = taskKind(input.kind);
  const title = required(input.title, 'task.title');
  const id = input.id === undefined ? deriveTaskId(applicationId, kind, title) : required(input.id, 'task.id');
  const existing = getTask(db, id);
  if (existing && existing.applicationId !== applicationId) throw new Error(`Task id conflict: ${id} belongs to application ${existing.applicationId}`);
  if (input.source !== undefined && (!input.source || typeof input.source !== 'object' || Array.isArray(input.source))) throw new Error('task.source must be an object');
  const next = {
    kind,
    title,
    platform: input.platform === undefined ? (existing?.platform ?? null) : optionalText(input.platform, 'task.platform'),
    dueAt: input.dueAt === undefined ? (existing?.dueAt ?? null) : normalizeDueAt(input.dueAt),
    dueNote: input.dueNote === undefined ? (existing?.dueNote ?? '') : text(input.dueNote, 'task.dueNote'),
    status: input.status === undefined ? (existing?.status ?? 'open') : taskStatus(input.status),
    note: input.note === undefined ? (existing?.note ?? '') : text(input.note, 'task.note'),
    source: canonical(input.source === undefined ? (existing?.source ?? { kind: 'user' }) : input.source),
  };
  if (existing) {
    const unchanged = comparedFields.every((field) => existing[field] === next[field])
      && JSON.stringify(canonical(existing.source)) === JSON.stringify(next.source);
    if (unchanged) return existing;
    db.prepare(`UPDATE application_tasks SET kind = ?, title = ?, platform = ?, due_at = ?, due_note = ?, status = ?,
      note = ?, source_json = ?, updated_at = ? WHERE id = ?`)
      .run(next.kind, next.title, next.platform, next.dueAt, next.dueNote, next.status, next.note, JSON.stringify(next.source), now, id);
  } else {
    db.prepare(`INSERT INTO application_tasks
      (id, application_id, kind, title, platform, due_at, due_note, status, note, source_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, applicationId, next.kind, next.title, next.platform, next.dueAt, next.dueNote, next.status, next.note, JSON.stringify(next.source), now, now);
  }
  return getTask(db, id);
}

export function setTaskStatus(db, id, status, now = new Date().toISOString()) {
  const next = taskStatus(status);
  const taskId = required(id, 'task.id');
  const existing = getTask(db, taskId);
  if (!existing) throw new Error(`Unknown task: ${taskId}`);
  if (existing.status === next) return existing;
  db.prepare('UPDATE application_tasks SET status = ?, updated_at = ? WHERE id = ?').run(next, now, taskId);
  return getTask(db, taskId);
}
