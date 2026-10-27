import { createHash, randomUUID } from 'node:crypto';
import { needsFromVerdict, tabTitle } from '../apply/tab-title.mjs';
import { recordEvent } from '../domain/events.mjs';
import { normalizeDueAt } from '../domain/tasks.mjs';
import { SUBMITTED_STATUSES } from '../funnel/contract.mjs';
import { openHomeDatabase } from '../runtime/home.mjs';
import { companyKey } from '../scan/dedupe.mjs';
import { rankLocation } from '../scan/filter.mjs';
import { scoreFit } from '../scan/fit.mjs';
import { loadScanProfile } from '../scan/profile-input.mjs';
import { configuredDecisionAdapters } from './email.mjs';
import { profileOption } from './scan.mjs';

const usage = 'Usage: career-journal queue list [--json] [--profile <path>] | queue verify --id <application> --result ok|skip --reason <text> [--deadline <iso>] | queue score [--all] [--limit <n>] [--dry-run] [--json] [--profile <path>]';
const FIT_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

const queueSelect = `SELECT id, company, role, job_url jobUrl, status, source, source_id sourceId, location,
  posted_at postedAt, deadline_at deadlineAt, deadline_precision deadlinePrecision, posting_end_at postingEndAt,
  fit, fit_confidence fitConfidence, fit_note fitNote,
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

// Only the sorting key gains an end-of-day time. The stored/displayed cutoff
// stays date-only; Intl uses the host timezone for callers without a config.
function cutoffTime(value, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return time(value);
  const wallClock = time(`${value}T23:59:59Z`);
  if (wallClock === null) return null;
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let instant = wallClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(format.formatToParts(instant).map(({ type, value: part }) => [type, part]));
    const seen = time(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const correction = wallClock - seen;
    instant += correction;
    if (correction === 0) break;
  }
  return instant + 999;
}

// Fit, cutoff, location, company load, newest posting, creation time, id.
function compareInTimezone(left, right, timezone) {
  return last(FIT_ORDER[left.fit]) - last(FIT_ORDER[right.fit])
    || last(cutoffTime(left.deadlineAt, timezone)) - last(cutoffTime(right.deadlineAt, timezone))
    || last(left.locRank) - last(right.locRank)
    || (left.companyLoad ?? 0) - (right.companyLoad ?? 0)
    || (time(right.postedAt) ?? Number.NEGATIVE_INFINITY) - (time(left.postedAt) ?? Number.NEGATIVE_INFINITY)
    || String(left.createdAt).localeCompare(String(right.createdAt))
    || String(left.id).localeCompare(String(right.id));
}

export function compareQueueItems(left, right) {
  return compareInTimezone(left, right);
}

export function listQueue(db, profile = null) {
  const statuses = ['prepared', ...SUBMITTED_STATUSES];
  const companyLoads = new Map();
  for (const { company, count } of db.prepare(`SELECT company, COUNT(*) count FROM applications
    WHERE status IN (${statuses.map(() => '?').join(',')}) GROUP BY company`).all(...statuses)) {
    const key = companyKey(company);
    companyLoads.set(key, (companyLoads.get(key) ?? 0) + count);
  }
  const reviewEvidence = db.prepare(`SELECT r.evidence_json FROM postings p JOIN reviews r ON r.posting_id = p.id
    WHERE p.application_id = ? AND p.merged_into IS NULL ORDER BY r.updated_at DESC, p.id LIMIT 1`);
  return db.prepare(`${queueSelect} WHERE status = 'lead' AND skip_reason IS NULL`).all()
    .map((row) => {
      const evidence = JSON.parse(reviewEvidence.get(row.id)?.evidence_json ?? '{}');
      return {
        ...row,
        locRank: locationRank(row.location, profile),
        companyLoad: companyLoads.get(companyKey(row.company)) ?? 0,
        tabHint: tabTitle({ company: row.company, needs: needsFromVerdict(evidence?.needs) }),
      };
    })
    .sort((left, right) => compareInTimezone(left, right, profile?.timezone));
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
    const funnel = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reviews'").get();
    const actor = input.actor === 'review-worker' ? 'review-worker' : 'user';
    if (funnel) {
      db.prepare('UPDATE applications SET skip_owner=?,deadline_source=CASE WHEN ? IS NOT NULL THEN ? ELSE deadline_source END,deadline_precision=CASE WHEN ? IS NOT NULL THEN ? ELSE deadline_precision END WHERE id=?')
        .run(skip ? (actor === 'user' ? 'user' : 'review') : null, deadline, actor === 'user' ? 'user' : 'review', deadline, 'datetime', id);
      for (const posting of db.prepare('SELECT id FROM postings WHERE application_id=?').all(id)) {
        db.prepare("UPDATE reviews SET state='done',decision=?,code=?,hold_owner=NULL,hold_since=NULL,next_due=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE posting_id=?")
          .run(skip ? 'not_eligible' : 'eligible', skip ? 'user_declined' : null, now, posting.id);
        db.prepare("INSERT INTO review_log(posting_id,at,stage,kind,payload_json) VALUES (?,?,'deliver',?,?)")
          .run(posting.id, now, actor === 'user' ? 'user' : 'delivery', JSON.stringify({ actor, result, reason }));
      }
    }
    recordEvent(db, {
      id: randomUUID(),
      applicationId: id,
      type: skip ? 'queue_skipped' : 'queue_verified',
      occurredAt: null,
      observedAt: now,
      recordedAt: now,
      title: skip ? 'Skipped after posting check' : 'Posting checked',
      note: reason,
      source: { kind: 'queue-verify', actor, result, reason, ...(deadline ? { deadline } : {}) },
      statusAfter: skip ? 'withdrawn' : null,
    }, { withinTransaction: true });
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return db.prepare(`${queueSelect} WHERE id = ?`).get(id);
}

function positiveLimit(value) {
  if (value === undefined) return null;
  const limit = Number(value);
  if (typeof value !== 'string' || !Number.isInteger(limit) || limit < 1 || value.trim() !== String(limit)) throw new Error('--limit must be a positive whole number');
  return limit;
}

// Scores fit for queued roles that have none, such as leads recorded before 2.0 or added by hand, with the
// same Jev → structured LLM → rule chain as a scan. --all rescores every queued role. A dry run uses the
// local rule only and writes nothing.
export async function scoreQueuedRoles(db, profile, adapters = {}, { all = false, limit = null, dryRun = false, now = new Date().toISOString() } = {}) {
  const rows = db.prepare(`${queueSelect} WHERE status IN ('lead', 'prepared') AND skip_reason IS NULL${all ? '' : ' AND fit IS NULL'}
    ORDER BY created_at, id`).all();
  const selected = limit ? rows.slice(0, limit) : rows;
  const results = [];
  for (const row of selected) {
    const role = {
      source: row.source ?? 'journal',
      sourceId: row.sourceId ?? row.id,
      company: row.company,
      title: row.role,
      locations: row.location ? row.location.split('; ') : [],
      url: row.jobUrl,
      categories: [],
      description: '',
    };
    const fit = await scoreFit(role, profile, adapters, { rulesOnly: dryRun });
    if (!dryRun) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE applications SET fit = ?, fit_confidence = ?, fit_note = ?, updated_at = ? WHERE id = ?')
          .run(fit.fit, fit.confidence, fit.note, now, row.id);
        const traceId = `fit-score-${createHash('sha256').update(`${row.id}\0${now}`).digest('hex').slice(0, 16)}`;
        db.prepare(`INSERT OR REPLACE INTO decision_traces
          (id, application_id, engine, mode, decision_json, confidence, applied, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(traceId, row.id, fit.engine, 'role-fit', JSON.stringify({
            fit: fit.fit,
            confidence: fit.confidence,
            ruleBased: fit.ruleBased,
            note: fit.note,
            jevAttempted: fit.jevAttempted ?? false,
            jevOutcome: fit.jevOutcome ?? 'not-enabled',
            rescored: true,
          }), fit.confidence, fit.applied ? 1 : 0, now);
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    }
    results.push({ id: row.id, company: row.company, role: row.role, previousFit: row.fit ?? null, fit: fit.fit, fitConfidence: fit.confidence, fitNote: fit.note });
  }
  return { dryRun, remaining: rows.length - selected.length, scored: results.length, results };
}

async function queueProfile(home, parsed) {
  const explicit = profileOption(parsed);
  try { return await loadScanProfile(home, { path: explicit }); }
  catch (error) {
    if (!explicit && /No search profile found/.test(error.message)) return null;
    throw error;
  }
}

export async function queueCommand(parsed, io, runtime = {}) {
  if (!['list', 'verify', 'score'].includes(parsed.subcommand)) throw new Error(usage);
  const home = parsed.options.home ?? process.cwd();
  const profile = parsed.subcommand === 'verify' ? null : await queueProfile(home, parsed);
  if (parsed.subcommand === 'score' && !profile) throw new Error('queue score needs the search profile; complete the profile interview first, or pass --profile <path>.');
  const limit = parsed.subcommand === 'score' ? positiveLimit(parsed.options.limit) : null;
  const context = await openHomeDatabase(home);
  try {
    if (parsed.subcommand === 'score') {
      const dryRun = Boolean(parsed.options['dry-run']);
      const adapters = dryRun ? {} : configuredDecisionAdapters(context.config, runtime.fetch ?? globalThis.fetch);
      const summary = await scoreQueuedRoles(context.db, profile, adapters, { all: Boolean(parsed.options.all), limit, dryRun });
      if (parsed.options.json) io.out(JSON.stringify(summary, null, 2));
      else {
        for (const item of summary.results) io.out([item.fit ?? '-', item.company, item.role, item.fitNote].join('\t'));
        io.out(`scored ${summary.scored}${summary.remaining ? `; ${summary.remaining} left (raise --limit or run again)` : ''}${summary.dryRun ? ' (dry run, nothing written)' : ''}`);
      }
      return 0;
    }
    if (parsed.subcommand === 'list') {
      const items = listQueue(context.db, { ...profile, timezone: context.config.timezone });
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
