import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { needsFromVerdict, tabTitle } from '../apply/tab-title.mjs';
import { recordEvent } from '../domain/events.mjs';
import { normalizeDueAt } from '../domain/tasks.mjs';
import { SUBMITTED_STATUSES } from '../funnel/contract.mjs';
import { openHomeDatabase } from '../runtime/home.mjs';
import { DUPLICATE_THRESHOLD, canonicalUrl, companyKey, requisitionKey, requisitionLocation, titleSimilarity } from '../scan/dedupe.mjs';
import { rankLocation } from '../scan/filter.mjs';
import { scoreFit } from '../scan/fit.mjs';
import { loadScanProfile } from '../scan/profile-input.mjs';
import { DIRECTION_CODE, OUT_OF_DIRECTION_CODE, directionNote, loadDirectionRules, roleDirection, softwareNote, softwareOnlyRole } from '../review/direction.mjs';
import { readFile } from 'node:fs/promises';
import { companyExcluded } from '../review/excluded.mjs';
import { companySizeGate } from '../review/company-size.mjs';
import { evaluateLimits, limitCounts } from '../review/limits.mjs';
import { duplicateOfSubmitted, submittedApplications } from '../review/duplicate.mjs';
import { loadUserOverrides, withOverrides } from '../review/overrides.mjs';
import { deliver, restoredVerdict } from '../review/deliver.mjs';
import { claimItem } from '../review/lease.mjs';
import { submittedApplicationIndex, submittedDuplicate } from '../funnel/identity.mjs';
import { configuredDecisionAdapters } from './email.mjs';
import { profileOption } from './scan.mjs';

const usage = 'Usage: career-journal queue list [--json] [--profile <path>] | queue siblings --id <application> | --url <job link> [--json] [--profile <path>] | queue verify --id <application> --result ok|skip --reason <text> [--deadline <iso>] [--actor user|apply|audit] [--code <code> (with --actor audit)] | queue score [--all] [--limit <n>] [--dry-run] [--json] [--profile <path>] | queue rescreen [--apply] [--json]';
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

// ------------------------------------------------------------- program siblings
// One program posted as several requisitions (often one per office) is one program: applications of one company with
// the same title. Each member's office is its requisition's own office when the link names one (Workday), else its
// stored locations. The representative is a submitted member inside the area, else the best in-area member (open first,
// then location rank, then fit); an out-of-area member never represents the program, even a submitted one.

const memberSelect = 'SELECT id, company, role, job_url jobUrl, status, applied_at appliedAt, location, fit, skip_reason skipReason FROM applications';
const OPEN_STATUSES = new Set(['lead', 'prepared']);
// A profile defines an area only when it lists search locations (queue list also passes a bare { timezone }).
const hasArea = (profile) => Boolean(profile?.search?.locations?.length);

function programMember(row, profile) {
  const office = requisitionLocation(row.jobUrl);
  const locations = office ? [office] : String(row.location ?? '').split(/\s*;\s*/).filter(Boolean);
  const ranked = hasArea(profile) && locations.length ? rankLocation({ title: row.role ?? '', locations }, profile) : null;
  const requisition = requisitionKey(row.jobUrl);
  return {
    id: row.id, role: row.role, jobUrl: row.jobUrl, requisition: requisition ? requisition.split(':').at(-1) : null,
    location: locations.join('; ') || null, inArea: ranked ? ranked.ok : null, locRank: ranked?.locRank ?? null,
    status: row.status, fit: row.fit ?? null, skipReason: row.skipReason ?? null,
    submitted: SUBMITTED_STATUSES.includes(row.status) || Boolean(row.appliedAt),
  };
}

function memberOrder(left, right) {
  const area = (member) => (member.inArea === true ? 0 : member.inArea === null ? 1 : 2);
  return area(left) - area(right)
    || Number(!OPEN_STATUSES.has(left.status)) - Number(!OPEN_STATUSES.has(right.status))
    || last(left.locRank) - last(right.locRank)
    || last(FIT_ORDER[left.fit]) - last(FIT_ORDER[right.fit])
    || String(left.id).localeCompare(String(right.id));
}

function describeMember(member) {
  return `${member.id} (${[member.requisition, member.location ?? 'location unknown', member.status].filter(Boolean).join(', ')})`;
}

// rows: every application of the program, the subject included. Returns null for a lone application.
export function programView(subjectId, rows, profile = null) {
  if (rows.length < 2) return null;
  const members = rows.map((row) => programMember(row, profile)).sort(memberOrder);
  // With a profile only a member known to be in the area represents the program; a submission outside the area (or
  // with no known office) does not cover it. Without a profile nothing is known and the order alone decides.
  const eligible = (member) => (hasArea(profile) ? member.inArea === true : member.inArea !== false);
  const submitted = members.find((member) => member.submitted && eligible(member));
  const outsideSubmitted = members.filter((member) => member.submitted && !eligible(member));
  const best = members[0];
  const representative = submitted ?? (eligible(best) ? best : null);
  const subject = members.find((member) => member.id === subjectId);
  const others = members.filter((member) => member.id !== subjectId).map(describeMember).join('; ');
  const outside = outsideSubmitted.length && !submitted
    ? `; ${outsideSubmitted.map(describeMember).join('; ')} was submitted but is outside the profile area or its office is unknown` : '';
  let note;
  if (!representative) note = `same program, no requisition in the profile area: ${others}`;
  else if (representative.id === subjectId) note = `represents its program; same program also posted as ${others}${outside}`;
  else if (submitted) note = `same program already submitted as ${describeMember(submitted)}; do not apply again`;
  else if (subject?.inArea === false) note = `office ${subject.location} is outside the profile area; same program in area: apply via ${describeMember(representative)}`;
  else note = `same program; apply via ${describeMember(representative)}${outside}`;
  return { representative: representative?.id ?? null, ok: representative?.id === subjectId, note, members };
}

function programIndex(db) {
  const byCompany = new Map();
  for (const row of db.prepare(memberSelect).all()) {
    const key = companyKey(row.company);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(row);
  }
  return (row) => (byCompany.get(companyKey(row.company)) ?? [])
    .filter((other) => other.id === row.id || titleSimilarity(other.role, row.role) >= DUPLICATE_THRESHOLD);
}

// The program view of any application, by id or by job link (any status), for picking an apply batch.
export function programSiblings(db, { id = null, url = null } = {}, profile = null) {
  let subject = id ? db.prepare(`${memberSelect} WHERE id = ?`).get(id) : null;
  if (!subject && url) {
    const requisition = requisitionKey(url);
    const link = canonicalUrl(url);
    subject = db.prepare(memberSelect).all().find((row) => (requisition && requisitionKey(row.jobUrl) === requisition)
      || (link && canonicalUrl(row.jobUrl) === link)) ?? null;
  }
  if (!subject) throw new Error('Application not found');
  const view = programView(subject.id, programIndex(db)(subject), profile);
  return { id: subject.id, company: subject.company, role: subject.role, ...(view ?? {
    representative: subject.id, ok: true, note: 'no other requisition of this program', members: [programMember(subject, profile)],
  }) };
}

// With role-direction rules, a lead whose title is out of direction (block list) is flagged and listed after every
// in-direction lead: leads added by hand never pass the delivery filter. Borderline titles are not demoted here.
export function listQueue(db, profile = null, { direction = null } = {}) {
  const statuses = ['prepared', ...SUBMITTED_STATUSES];
  const companyLoads = new Map();
  for (const { company, count } of db.prepare(`SELECT company, COUNT(*) count FROM applications
    WHERE status IN (${statuses.map(() => '?').join(',')}) GROUP BY company`).all(...statuses)) {
    const key = companyKey(company);
    companyLoads.set(key, (companyLoads.get(key) ?? 0) + count);
  }
  const reviewEvidence = db.prepare(`SELECT r.evidence_json FROM postings p JOIN reviews r ON r.posting_id = p.id
    WHERE p.application_id = ? AND p.merged_into IS NULL ORDER BY r.updated_at DESC, p.id LIMIT 1`);
  const programOf = programIndex(db);
  return db.prepare(`${queueSelect} WHERE status = 'lead' AND skip_reason IS NULL`).all()
    .map((row) => {
      const evidence = JSON.parse(reviewEvidence.get(row.id)?.evidence_json ?? '{}');
      const program = programView(row.id, programOf(row), profile);
      const item = {
        ...row,
        locRank: locationRank(row.location, profile),
        companyLoad: companyLoads.get(companyKey(row.company)) ?? 0,
        tabHint: tabTitle({ company: row.company, needs: needsFromVerdict(evidence?.needs) }),
        ...(program ? { program: { representative: program.representative, members: program.members }, programOk: program.ok, programNote: program.note } : {}),
      };
      if (!direction) return item;
      const labelled = Object.hasOwn(evidence, 'function');
      const result = roleDirection(row.role, direction, { functionValue: evidence.function, company: row.company });
      // A blocked title, a neutral one under neutral 'deny', or a requireAllow title whose stored label is not allowed
      // (an unlabelled older lead is not flagged, as in the startup pass).
      const out = !result.ok && (['block', 'neutral'].includes(result.reason) || result.reason === 'require_allow' && labelled);
      // A lead the judge labelled pure software engineering (the stored function label).
      const software = !out && result.ok && softwareOnlyRole(row.role, evidence.function, direction, { company: row.company });
      return { ...item, directionOk: !out && !software,
        directionReason: out ? `${DIRECTION_CODE}: ${directionNote(result)}` : software ? `${OUT_OF_DIRECTION_CODE}: ${softwareNote(evidence.function)}` : null };
    })
    .sort((left, right) => (left.directionOk === false) - (right.directionOk === false)
      || (left.programOk === false) - (right.programOk === false) || compareInTimezone(left, right, profile?.timezone));
}

export const VERIFY_ACTORS = Object.freeze(['user', 'review-worker', 'apply', 'audit']);

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
  const skip = result === 'skip';
  // Who decided: the user (default), the review worker, an apply session (terminal like the user) or an
  // automated audit (review-owned, code from --code; an explicit rejudge may re-queue it, a normal run never restores it).
  const actor = input.actor == null ? 'user' : String(input.actor);
  if (!VERIFY_ACTORS.includes(actor)) throw new Error(`actor must be one of ${VERIFY_ACTORS.join(', ')}`);
  const code = input.code == null || input.code === true ? null : String(input.code).trim();
  if (actor === 'audit' && skip && !/^[a-z][a-z0-9_]*$/.test(code ?? '')) throw new Error('--actor audit needs --code <code> (lowercase letters, digits and _)');
  if (code && actor !== 'audit') throw new Error('--code is only for --actor audit');
  const userOwned = actor === 'user' || actor === 'apply';
  const application = db.prepare('SELECT id, status FROM applications WHERE id = ?').get(id);
  if (!application) throw new Error('Application not found');
  if (application.status !== 'lead') throw new Error(`Application ${id} is not in the queue (status ${application.status})`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE applications SET verified_at = ?, deadline_at = COALESCE(?, deadline_at), skip_reason = ?, updated_at = ?
      WHERE id = ?`).run(now, deadline, skip ? reason : null, now, id);
    const funnel = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reviews'").get();
    if (funnel) {
      db.prepare('UPDATE applications SET skip_owner=?,deadline_source=CASE WHEN ? IS NOT NULL THEN ? ELSE deadline_source END,deadline_precision=CASE WHEN ? IS NOT NULL THEN ? ELSE deadline_precision END WHERE id=?')
        .run(skip ? (userOwned ? 'user' : 'review') : null, deadline, userOwned ? 'user' : 'review', deadline, 'datetime', id);
      for (const posting of db.prepare('SELECT id FROM postings WHERE application_id=?').all(id)) {
        db.prepare("UPDATE reviews SET state='done',decision=?,code=?,hold_owner=NULL,hold_since=NULL,next_due=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE posting_id=?")
          .run(skip ? 'not_eligible' : 'eligible', skip ? (actor === 'audit' ? code : 'user_declined') : null, now, posting.id);
        if (skip && actor === 'audit') {
          db.prepare("UPDATE reviews SET evidence_json=json_set(COALESCE(NULLIF(evidence_json,''),'{}'),'$.provenance','automated','$.audit',json(?)) WHERE posting_id=?")
            .run(JSON.stringify({ code, reason, at: now }), posting.id);
        }
        db.prepare("INSERT INTO review_log(posting_id,at,stage,kind,payload_json) VALUES (?,?,'deliver',?,?)")
          .run(posting.id, now, userOwned ? 'user' : 'delivery', JSON.stringify({ actor, result, reason, ...(code ? { code } : {}) }));
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
      source: { kind: 'queue-verify', actor, result, reason, ...(code ? { code } : {}), ...(deadline ? { deadline } : {}) },
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

// ------------------------------------------------------------- rescreen
// The deterministic gate rules applied to current leads: exclusions, company size, company limits/cap and
// duplicates of a submitted application. A dry run (default) lists violators; --apply withdraws them through
// delivery (review-owned, automated, releasable like any gate settlement). An unknown company size is listed,
// never withdrawn: its size is decided by the review run.
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export async function gatePolicy(home) {
  const profileDir = path.join(path.resolve(home), '.career-journal', 'profile');
  const [screening, reviewPolicy, overrides, direction] = await Promise.all([readJson(path.join(profileDir, 'screening-policy.json')),
    readJson(path.join(profileDir, 'review-policy.json')), loadUserOverrides(profileDir), loadDirectionRules(profileDir)]);
  return withOverrides({ ...screening, companyCap: reviewPolicy.companyCap ?? null, direction }, overrides);
}

export function rescreenLeads(db, { policy = {}, now = new Date().toISOString(), apply = false, owner = 'queue-rescreen' } = {}) {
  const counts = limitCounts(db);
  const index = submittedApplicationIndex(db, { companyAliases: policy.companyAliases });
  const submitted = submittedApplications(db);
  const results = [];
  const leads = db.prepare("SELECT * FROM applications WHERE status='lead' AND COALESCE(skip_owner,'review')='review' ORDER BY company,id").all();
  for (const app of leads) {
    const posting = db.prepare('SELECT p.*,r.state review_state,r.evidence_json,r.flags_json,r.decision review_decision FROM postings p LEFT JOIN reviews r ON r.posting_id=p.id WHERE p.application_id=? AND p.merged_into IS NULL ORDER BY (r.posting_id IS NULL),p.created_at LIMIT 1').get(app.id);
    const evidence = (() => { try { return JSON.parse(posting?.evidence_json ?? '{}'); } catch { return {}; } })();
    let violation = null;
    const excluded = companyExcluded(app.company, policy);
    const size = companySizeGate(app.company, policy.companySizes);
    if (excluded) violation = { code: 'company_excluded', detail: excluded.match };
    else if (size === 'small') violation = { code: 'company_small', detail: app.company };
    if (!violation) {
      const limit = evaluateLimits(app.company, { policy, now, counts, program: evidence.program, exclude: app.id });
      if (limit) violation = { code: limit.code, detail: `${limit.count}/${limit.max ?? '-'} ${limit.kind}${limit.windowDays ? ` ${limit.windowDays}d` : ''}${limit.cycleStart ? ` since ${limit.cycleStart}` : ''}${limit.reason ? ` ${limit.reason}` : ''}`,
        applicationIds: limit.applicationIds, ...(limit.flaggedDates?.length ? { flaggedDates: limit.flaggedDates } : {}) };
    }
    if (!violation) {
      const record = posting ?? { id: null, company: app.company, title: app.role, url: app.job_url, application_id: app.id };
      const same = submittedDuplicate(db, posting ?? { company: app.company, title: app.role, url: app.job_url }, { companyAliases: policy.companyAliases, index });
      const repost = !same && posting ? duplicateOfSubmitted(db, record, { companyAliases: policy.companyAliases, candidates: submitted }) : null;
      if (same && same.applicationId !== app.id) violation = { code: 'already_submitted', detail: same.match, applicationIds: [same.applicationId] };
      else if (repost) violation = { code: 'duplicate_submitted', detail: `${repost.match} ${repost.similarity}`, applicationIds: [repost.applicationId] };
    }
    if (!violation && size === 'unknown') { results.push({ applicationId: app.id, company: app.company, role: app.role, code: 'company_size_unknown', action: 'listed' }); continue; }
    if (!violation) continue;
    let action = 'would_withdraw';
    if (apply) {
      if (posting?.review_state) {
        const fence = claimItem(db, posting.id, { owner, now });
        if (!fence) action = 'busy';
        else {
          const row = { ...posting, flags_json: posting.flags_json ?? '[]' };
          const verdict = posting.review_decision === 'eligible' || evidence.fit ? restoredVerdict(row, evidence) : { decision: 'not_eligible', code: violation.code };
          action = deliver(db, { postingId: posting.id, fence, now, policy, verdict }).action;
        }
      } else {
        db.exec('BEGIN IMMEDIATE');
        try {
          recordEvent(db, { id: randomUUID(), applicationId: app.id, type: 'review_withdrawn', observedAt: now, recordedAt: now, title: 'review_withdrawn', note: violation.code,
            source: { actor: 'review-worker', kind: 'queue-rescreen', code: violation.code, automatedProvenance: true }, statusAfter: 'withdrawn' }, { withinTransaction: true });
          db.prepare("UPDATE applications SET skip_reason=?,skip_owner='review',updated_at=? WHERE id=?").run(violation.code, now, app.id);
          db.exec('COMMIT');
          action = 'withdrawn';
        } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
      }
    }
    results.push({ applicationId: app.id, company: app.company, role: app.role, ...violation, action });
  }
  return { dryRun: !apply, leads: leads.length, violations: results.filter((item) => item.code !== 'company_size_unknown').length, results };
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
  if (!['list', 'siblings', 'verify', 'score', 'rescreen'].includes(parsed.subcommand)) throw new Error(usage);
  const home = parsed.options.home ?? process.cwd();
  const profile = ['verify', 'rescreen'].includes(parsed.subcommand) ? null : await queueProfile(home, parsed);
  if (parsed.subcommand === 'score' && !profile) throw new Error('queue score needs the search profile; complete the profile interview first, or pass --profile <path>.');
  const limit = parsed.subcommand === 'score' ? positiveLimit(parsed.options.limit) : null;
  const context = await openHomeDatabase(home);
  try {
    if (parsed.subcommand === 'rescreen') {
      const summary = rescreenLeads(context.db, { policy: await gatePolicy(home), apply: parsed.options.apply === true });
      if (parsed.options.json) io.out(JSON.stringify(summary, null, 2));
      else {
        for (const item of summary.results) io.out([item.action, item.code, item.company, item.role, item.applicationId, item.detail ?? ''].join('\t'));
        io.out(`${summary.violations} of ${summary.leads} leads violate a gate rule${summary.dryRun ? ' (dry run, nothing written; --apply withdraws them)' : ''}`);
      }
      return 0;
    }
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
    if (parsed.subcommand === 'siblings') {
      const id = parsed.options.id ?? parsed.positionals[0] ?? null;
      const url = typeof parsed.options.url === 'string' ? parsed.options.url : null;
      if (!id && !url) throw new Error(usage);
      const view = programSiblings(context.db, { id, url }, profile);
      if (parsed.options.json) io.out(JSON.stringify(view, null, 2));
      else {
        io.out(`${view.company}\t${view.role}\t${view.note}`);
        for (const member of view.members) {
          const area = member.inArea === true ? 'in area' : member.inArea === false ? 'OUT OF AREA' : 'area unknown';
          io.out([member.id === view.representative ? '*' : '-', member.requisition ?? '-', member.location ?? '-', area, member.status, member.fit ?? '-', member.id, member.skipReason ?? ''].join('\t'));
        }
        io.out(view.representative ? `apply via ${view.representative}` : 'no requisition of this program is in the profile area');
      }
      return 0;
    }
    if (parsed.subcommand === 'list') {
      const direction = await loadDirectionRules(path.join(path.resolve(home), '.career-journal', 'profile'));
      const items = listQueue(context.db, { ...profile, timezone: context.config.timezone }, { direction });
      if (parsed.options.json) io.out(JSON.stringify(items, null, 2));
      else for (const item of items) {
        io.out([item.fit ?? '-', item.deadlineAt ?? '-', item.location ?? '-', item.company, item.role, item.id].join('\t'));
        if (item.programNote) io.out(`\t${item.programOk === false ? 'SIBLING' : 'program'}: ${item.programNote}`);
      }
      return 0;
    }
    const record = verifyQueuedRole(context.db, {
      id: parsed.options.id ?? parsed.positionals[0],
      result: parsed.options.result,
      reason: parsed.options.reason,
      deadline: parsed.options.deadline,
      actor: parsed.options.actor,
      code: parsed.options.code,
    });
    io.out(JSON.stringify(record));
    return 0;
  } finally { context.db.close(); }
}
