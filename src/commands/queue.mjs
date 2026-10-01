import { randomUUID } from 'node:crypto';
import { recordEvent } from '../domain/events.mjs';
import { normalizeDueAt } from '../domain/tasks.mjs';
import { openHomeDatabase } from '../runtime/home.mjs';
import { rankLocation } from '../scan/filter.mjs';
import { loadScanProfile } from '../scan/profile-input.mjs';
import { profileOption } from './scan.mjs';

const usage = 'Usage: career-journal queue list [--json] [--profile <path>] | queue verify --id <application> --result ok|skip --reason <text> [--deadline <iso>]';
const FIT_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

const queueSelect = `SELECT id, company, role, job_url jobUrl, status, source, source_id sourceId, location,
  posted_at postedAt, deadline_at deadlineAt, fit, fit_confidence fitConfidence, fit_note fitNote,
  verified_at verifiedAt, skip_reason skipReason, created_at createdAt, updated_at updatedAt
  FROM applications`;

function last(value) {
  return value == null ? Number.POSITIVE_INFINITY : value;
}

function time(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

export function locationRank(location, profile) {
  if (!profile || !location) return null;
  return rankLocation({ locations: String(location).split(/\s*;\s*/).filter(Boolean) }, profile).locRank ?? null;
}

// Queue order: fit (high first), then the earliest deadline, then the best
// location rank, then the most recently posted role.
export function compareQueueItems(left, right) {
  return last(FIT_ORDER[left.fit]) - last(FIT_ORDER[right.fit])
    || last(time(left.deadlineAt)) - last(time(right.deadlineAt))
    || last(left.locRank) - last(right.locRank)
    || (time(right.postedAt) ?? Number.NEGATIVE_INFINITY) - (time(left.postedAt) ?? Number.NEGATIVE_INFINITY)
    || String(left.createdAt).localeCompare(String(right.createdAt))
    || String(left.id).localeCompare(String(right.id));
}

export function listQueue(db, profile = null) {
  return db.prepare(`${queueSelect} WHERE status = 'lead' AND skip_reason IS NULL`).all()
    .map((row) => ({ ...row, locRank: locationRank(row.location, profile) }))
    .sort(compareQueueItems);
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function verifyQueuedRole(db, input, now = new Date().toISOString()) {
  const id = required(input.id, 'id');
  const result = required(input.result, 'result');
  if (!['ok', 'skip'].includes(result)) throw new Error('result must be ok or skip');
  const reason = required(input.reason, 'reason');
  let deadline = null;
  if (input.deadline != null && input.deadline !== true) {
    try { deadline = normalizeDueAt(String(input.deadline)); }
    catch { throw new Error('deadline must be an ISO 8601 timestamp with a UTC offset, such as 2026-10-15T23:59:00-04:00'); }
  } else if (input.deadline === true) throw new Error('--deadline requires a timestamp');
  const application = db.prepare('SELECT id, status FROM applications WHERE id = ?').get(id);
  if (!application) throw new Error('Application not found');
  if (application.status !== 'lead') throw new Error(`Application ${id} is not in the queue (status ${application.status})`);
  const skip = result === 'skip';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE applications SET verified_at = ?, deadline_at = COALESCE(?, deadline_at), skip_reason = ?, updated_at = ?
      WHERE id = ?`).run(now, deadline, skip ? reason : null, now, id);
    recordEvent(db, {
      id: randomUUID(),
      applicationId: id,
      type: skip ? 'queue_skipped' : 'queue_verified',
      occurredAt: null,
      observedAt: now,
      recordedAt: now,
      title: skip ? 'Skipped after posting check' : 'Posting checked',
      note: reason,
      source: { kind: 'queue-verify', result, reason, ...(deadline ? { deadline } : {}) },
      statusAfter: skip ? 'withdrawn' : null,
    }, { withinTransaction: true });
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return db.prepare(`${queueSelect} WHERE id = ?`).get(id);
}

async function queueProfile(home, parsed) {
  const explicit = profileOption(parsed);
  try { return await loadScanProfile(home, { path: explicit }); }
  catch (error) {
    if (!explicit && /No search profile found/.test(error.message)) return null;
    throw error;
  }
}

export async function queueCommand(parsed, io) {
  if (!['list', 'verify'].includes(parsed.subcommand)) throw new Error(usage);
  const home = parsed.options.home ?? process.cwd();
  const profile = parsed.subcommand === 'list' ? await queueProfile(home, parsed) : null;
  const context = await openHomeDatabase(home);
  try {
    if (parsed.subcommand === 'list') {
      const items = listQueue(context.db, profile);
      if (parsed.options.json) io.out(JSON.stringify(items, null, 2));
      else for (const item of items) {
        io.out([item.fit ?? '-', item.deadlineAt ?? '-', item.location ?? '-', item.company, item.role, item.id].join('\t'));
      }
      return 0;
    }
    const record = verifyQueuedRole(context.db, {
      id: parsed.options.id ?? parsed.positionals[0],
      result: parsed.options.result,
      reason: parsed.options.reason,
      deadline: parsed.options.deadline,
    });
    io.out(JSON.stringify(record));
    return 0;
  } finally { context.db.close(); }
}
