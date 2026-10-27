import { randomUUID } from 'node:crypto';
import { createApplication } from '../commands/application.mjs';
import { bindApplication } from '../funnel/identity.mjs';
import { SUBMITTED_STATUSES } from '../funnel/contract.mjs';
import { recordEvent } from '../domain/events.mjs';
import { atomic, assertFence } from './lease.mjs';

const key = (value) => String(value ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
export const parseJson = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
export function logReview(db, postingId, { now, stage = 'deliver', kind = 'outcome', attemptId = null, payload = {} }) {
  db.prepare('INSERT INTO review_log(posting_id,at,stage,kind,attempt_id,payload_json) VALUES (?,?,?,?,?,?)')
    .run(postingId, now, stage, kind, attemptId, JSON.stringify(payload));
}

// Resolve a wall clock in an IANA zone without inventing a time for date-only cutoffs.
export function deadlineValue(deadline) {
  if (!deadline?.date) return null;
  if (!deadline.time) return deadline.date;
  if (!deadline.tz) throw new Error('Timed cutoff requires a timezone');
  const local = `${deadline.date}T${deadline.time.length === 5 ? `${deadline.time}:00` : deadline.time}`;
  if (/^(?:Z|[+-]\d\d:\d\d)$/.test(deadline.tz)) return `${local}${deadline.tz === 'Z' ? '+00:00' : deadline.tz}`;
  const base = Date.parse(`${local}Z`);
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: deadline.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let epoch = base;
  for (let i = 0; i < 3; i += 1) {
    const p = Object.fromEntries(format.formatToParts(epoch).map((v) => [v.type, v.value]));
    const seen = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    epoch += base - seen;
  }
  const minutes = Math.round((base - epoch) / 60000);
  const offset = `${minutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
  return `${local}${offset}`;
}

function companyVerdict(posting, verdict, policy) {
  if ((policy.userExcludedCompanies ?? []).some((company) => key(company) === key(posting.company))) return { ...verdict, decision: 'not_eligible', code: 'company_excluded' };
  let note = '';
  for (const rule of policy.rules ?? []) {
    if (key(rule.company) !== key(posting.company)) continue;
    const hold = (code) => ({ ...verdict, decision: 'unclear', code, question: rule.note ?? code, nextAction: 'recheck', resetAt: rule.resetAt ?? null });
    if (rule.program || rule.countryScope) {
      if (!verdict.program) return hold('quota_unclear');
      const scope = new Set(words(`${verdict.program.name} ${verdict.program.countryScope}`));
      if (!words(`${rule.program ?? ''} ${rule.countryScope ?? ''}`).every((word) => scope.has(word))) continue;
    }
    if (rule.blockReason === 'quota-reconciliation-pending' || (rule.blocked && rule.distinctApplicationsInWindow === null)) return hold('quota_reconciliation');
    if (Number.isFinite(rule.limit) && (rule.usedConfirmed ?? rule.used ?? 0) >= rule.limit) return hold('quota_full');
    if (rule.blocked) return hold('quota_unclear');
    if (rule.note) note += ` ${rule.note}`;
  }
  return { ...verdict, fit: { ...verdict.fit, note: `${verdict.fit?.note ?? ''}${note}`.trim() } };
}

function appendEvent(db, appId, type, now, { statusAfter = null, note = '', source = {}, reviewRestore = false } = {}) {
  recordEvent(db, { id: randomUUID(), applicationId: appId, type, observedAt: now, recordedAt: now, title: type, note,
    source: { actor: 'review-worker', ...source }, statusAfter }, { withinTransaction: true, reviewRestore });
}

export function deliver(db, { postingId, verdict, fence, now, policy = {} }) {
  return atomic(db, () => {
    assertFence(db, postingId, fence);
    let posting = db.prepare('SELECT * FROM postings WHERE id=?').get(postingId);
    const review = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(postingId);
    let app = posting.application_id ? db.prepare('SELECT * FROM applications WHERE id=?').get(posting.application_id) : null;
    const oldEvidence = parseJson(review.evidence_json);
    const lastEvent = app && db.prepare('SELECT * FROM application_events WHERE application_id=? ORDER BY recorded_at DESC,rowid DESC LIMIT 1').get(app.id);
    const lastStatus = app && db.prepare('SELECT * FROM application_events WHERE application_id=? AND status_after IS NOT NULL ORDER BY recorded_at DESC,rowid DESC LIMIT 1').get(app.id);
    const automated = oldEvidence.provenance === 'automated';
    const canRestore = lastStatus && parseJson(lastStatus.source_json).actor === 'review-worker' || automated;
    const protectedApp = app && (app.applied_at || SUBMITTED_STATUSES.includes(app.status) || ['user','legacy'].includes(app.skip_owner) && !automated
      || app.status === 'withdrawn' && !canRestore || lastEvent && parseJson(lastEvent.source_json).actor === 'user' && lastEvent.recorded_at > review.updated_at);
    let value = verdict.decision === 'eligible' ? companyVerdict(posting, verdict, policy) : verdict;
    // Exclusions are rechecked at delivery even if the inputs changed while judging.
    if ((policy.userExcludedCompanies ?? []).some((c) => key(c) === key(posting.company))) value = { ...value, decision: 'not_eligible', code: 'company_excluded' };
    let action;
    let held = value.decision === 'unclear';
    if (protectedApp) { action = 'superseded_by_user'; held = false; }
    else if (app?.status === 'prepared') { action = 'prepared'; held = false; }
    else {
      if (!app && value.decision !== 'not_eligible' && value.decision !== 'dropped') {
        app = createApplication(db, { company: posting.company, role: posting.title, jobUrl: /^https?:/.test(posting.canonical_url) ? posting.canonical_url : `https://${posting.canonical_url}`, externalId: `posting:${postingId}` }, now);
        const bound = bindApplication(db, app.id, { now });
        if (bound.action === 'conflict' || bound.postingId !== postingId) throw new Error('Delivery identity conflict');
        db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, postingId);
        action = 'created';
      }
      if (app) {
        if (value.decision === 'eligible') {
          const restored = app.status === 'withdrawn';
          appendEvent(db, app.id, restored ? 'review_restored' : 'review_delivered', now, { statusAfter: restored ? 'lead' : null, reviewRestore: restored, source: { postingId, automatedProvenance: automated } });
          db.prepare('UPDATE applications SET skip_reason=NULL,skip_owner=NULL WHERE id=?').run(app.id);
          action = restored ? 'restored' : action ?? (app.skip_reason ? 'unhidden' : 'updated');
        } else if (held) {
          const reason = `待核: ${value.code ?? 'user_review'} — ${value.question ?? value.nextAction ?? ''}`;
          if (app.status !== 'withdrawn') db.prepare("UPDATE applications SET skip_reason=?,skip_owner='review' WHERE id=?").run(reason, app.id);
          appendEvent(db, app.id, 'review_held', now, { note: reason, source: { postingId } });
          action = 'hidden';
        } else {
          if (app.status !== 'withdrawn') appendEvent(db, app.id, 'review_withdrawn', now, { statusAfter: 'withdrawn', note: value.code ?? '', source: { postingId, evidence: value.evidence ?? [] } });
          db.prepare("UPDATE applications SET skip_reason=?,skip_owner='review' WHERE id=?").run(value.code ?? 'not_eligible', app.id);
          action = 'withdrawn';
        }
        const deadline = value.deadline ?? { kind: 'none' };
        const cutoff = deadline.kind === 'cutoff' ? deadlineValue(deadline) : null;
        const end = deadline.kind === 'posting_end' ? deadlineValue(deadline) : null;
        db.prepare(`UPDATE applications SET fit=?,fit_note=?,location=?,verified_at=?,updated_at=?,posting_end_at=?,
          deadline_at=CASE WHEN deadline_source IS NULL OR deadline_source='review' THEN ? ELSE deadline_at END,
          deadline_precision=CASE WHEN deadline_source IS NULL OR deadline_source='review' THEN ? ELSE deadline_precision END,
          deadline_source=CASE WHEN deadline_source IS NULL OR deadline_source='review' THEN ? ELSE deadline_source END WHERE id=?`)
          .run(value.fit?.level ?? app.fit, value.fit?.note ?? app.fit_note, value.location?.display ?? app.location, now, now, end,
            cutoff, cutoff ? (deadline.time ? 'datetime' : 'date') : null, cutoff ? 'review' : null, app.id);
      } else action = 'no_application';
    }
    const evidence = { ...oldEvidence, evidence: value.evidence ?? [], needs: value.needs ?? {}, fit: value.fit ?? null, deadline: value.deadline ?? { kind: 'none' },
      program: value.program ?? null, location: value.location ?? null, factsUsed: value.factsUsed ?? [], question: value.question ?? null };
    const userHold = held && !['unavailable','quota_full','quota_reconciliation'].includes(value.code);
    db.prepare(`UPDATE reviews SET state=?,decision=?,code=?,evidence_json=?,deadline_json=?,hold_owner=?,hold_since=?,next_due=?,stage='deliver',
      lease_owner=NULL,lease_until=NULL,updated_at=? WHERE posting_id=? AND lease_owner=? AND lease_generation=?`)
      .run(held ? 'held' : 'done', value.decision, protectedApp ? 'superseded_by_user' : value.code ?? null, JSON.stringify(evidence), JSON.stringify(value.deadline ?? {}),
        held ? (userHold ? 'user' : 'system') : null, held ? now : null, held ? value.resetAt ?? review.next_due : null, now, postingId, fence.owner, fence.generation);
    logReview(db, postingId, { now, kind: 'delivery', payload: { action, applicationId: app?.id ?? null, verdict: value } });
    const committed = db.prepare('SELECT state FROM reviews WHERE posting_id=?').get(postingId);
    if (committed.state !== (held ? 'held' : 'done')) throw new Error('Delivery readback mismatch');
    return { action, applicationId: app?.id ?? null };
  });
}

export function annotateMail(db, { postingId, match, messageId, subject, received, matched, now }) {
  return atomic(db, () => {
    const posting = db.prepare('SELECT application_id FROM postings WHERE id=?').get(postingId);
    if (!posting?.application_id) return;
    const app = db.prepare('SELECT * FROM applications WHERE id=?').get(posting.application_id);
    appendEvent(db, app.id, 'mail_note', now, { note: subject ?? '', source: { kind: 'mail', messageId, received, matched, match } });
    if (match === 'exact' && app.status === 'lead' && (!app.skip_owner || app.skip_owner === 'review')) {
      db.prepare("UPDATE applications SET skip_reason='already_applied_mail 邮件确认',skip_owner='review',updated_at=? WHERE id=?").run(now, app.id);
    }
  });
}
export function unhide(db, { postingId, now }) {
  return atomic(db, () => {
    const posting = db.prepare('SELECT application_id FROM postings WHERE id=?').get(postingId);
    if (!posting?.application_id) return;
    const changed = db.prepare("UPDATE applications SET skip_reason=NULL,skip_owner=NULL,updated_at=? WHERE id=? AND skip_owner='review' AND status='lead'").run(now, posting.application_id).changes;
    if (changed) appendEvent(db, posting.application_id, 'mail_unhidden', now, { source: { actor: 'user', postingId } });
  });
}
