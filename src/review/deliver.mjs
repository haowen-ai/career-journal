import { randomUUID } from 'node:crypto';
import { createApplication } from '../commands/application.mjs';
import { bindApplication, submittedApplicationIndex, submittedDuplicate } from '../funnel/identity.mjs';
import { SUBMITTED_STATUSES } from '../funnel/contract.mjs';
import { recordEvent } from '../domain/events.mjs';
import { atomic, assertFence, claimItem } from './lease.mjs';
import { userDecided } from './ownership.mjs';
import { redact } from '../runtime/redact.mjs';
import { validTimezone } from './deadline.mjs';
import { companyKey } from '../scan/dedupe.mjs';
import { reallowed, withOverrides } from './overrides.mjs';
import { companyExcluded, USER_EXCLUDED_REASON } from './excluded.mjs';
import { DIRECTION_CODE, OUT_OF_DIRECTION_CODE, directionNote, roleDirection, softwareNote, softwareOnlyRole } from './direction.mjs';
import { companySizeGate } from './company-size.mjs';
import { evaluateLimits, limitCounts, programRule, LIMIT_CODES } from './limits.mjs';
import { duplicateOfSubmitted } from './duplicate.mjs';
import { REOPEN_AUTHORIZATIONS, autoReopenAllowed } from './reopen-policy.mjs';

export const parseJson = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
export function logReview(db, postingId, { now, stage = 'deliver', kind = 'outcome', attemptId = null, payload = {} }) {
  db.prepare('INSERT INTO review_log(posting_id,at,stage,kind,attempt_id,payload_json) VALUES (?,?,?,?,?,?)')
    .run(postingId, now, stage, kind, attemptId, redact(JSON.stringify(payload)));
}

// Resolve a wall clock in an IANA zone without inventing a time for date-only cutoffs.
export function deadlineValue(deadline) {
  if (!deadline?.date) return null;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(deadline.time ?? '') || !validTimezone(deadline.tz)) return deadline.date;
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

// A company excluded by the user: the screening policy's list (a judge dependency) or
// profile/company-overrides.json (not a dependency). An override exclusion keeps the
// verdict's fields and whether it was judged eligible, so removing it can restore the lead.
function excludedVerdict(posting, verdict, policy) {
  const excluded = companyExcluded(posting.company, policy);
  if (!excluded) return null;
  return { ...verdict, decision: 'not_eligible', code: 'company_excluded',
    ...(excluded.source === 'user' ? { skipReason: USER_EXCLUDED_REASON, excluded: { ...excluded, judged: verdict.decision === 'eligible' || verdict.excluded?.judged === true } } : {}) };
}

// Program- or country-scoped quota rules of the screening policy: a blocked rule is a decision
// (not_eligible company_limit, releasable by the startup pass), never a hold. Unblocked notes join the fit note.
function companyVerdict(posting, verdict, policy) {
  const excluded = excludedVerdict(posting, verdict, policy);
  if (excluded) return excluded;
  const rule = programRule(posting.company, verdict.program, policy);
  if (rule.code) return { ...verdict, decision: 'not_eligible', code: 'company_limit', judged: verdict.decision === 'eligible', limit: rule, question: null, holdFactIds: [], nextAction: null };
  const note = rule.notes.map((item) => ` ${item}`).join('');
  return { ...verdict, fit: { ...verdict.fit, note: `${verdict.fit?.note ?? ''}${note}`.trim() } };
}

// User rule (2026-10-27): at most `max` submissions per company in any rolling `windowDays`, plus
// per-company limits and active caps (src/review/limits.mjs). Limits are review policy, not judge
// dependencies, so they are applied at delivery and by the startup pass, never by re-judging.
// User overrides (re-allowed companies, active caps, limits, aliases, company sizes) apply here, outside the judge dependencies.
export const deliveryPolicy = (inputs) => withOverrides({ ...inputs.screeningPolicy, companyCap: inputs.policy?.companyCap ?? null, direction: inputs.direction ?? null }, inputs.overrides);

// Decide once (P4): a withdrawn application becomes a lead again only with an explicit authorization stored on
// the review being delivered: `review rejudge --apply` writes evidence_json.reopenAuthorization.authorization
// ('rejudge'), and the scan marks a relisted posting with the flag 'authorization:relist'. Both are single-use:
// deliver() drops them from what it writes. Anything else is no authorization.
export const RELIST_FLAG = 'authorization:relist';
export function storedReopenAuthorization(db, review) { // eslint-disable-line no-unused-vars
  if (!review) return null;
  const stored = parseJson(review.evidence_json)?.reopenAuthorization?.authorization;
  if (REOPEN_AUTHORIZATIONS.includes(stored)) return stored;
  const flags = parseJson(review.flags_json, []);
  return Array.isArray(flags) && flags.includes(RELIST_FLAG) ? 'relist' : null;
}
export const RELIST_REASONS = Object.freeze(['delisted', 'closed_verified', 'unavailable']);
// A cap release restores only the cap's own withdrawal: the skip reason is a limit code and so is the note of the
// withdrawal event that set it.
function restoreAuthorized(app, authorization, withdrawal = null) {
  if (!REOPEN_AUTHORIZATIONS.includes(authorization)) return false;
  if (authorization === 'cap_release') return app.skip_owner === 'review' && LIMIT_CODES.includes(app.skip_reason)
    && (!withdrawal || withdrawal.status_after !== 'withdrawn' || withdrawal.note === app.skip_reason);
  if (authorization === 'relist') return app.skip_owner === 'review' && RELIST_REASONS.includes(app.skip_reason);
  return app.skip_owner !== 'user' && app.skip_owner !== 'legacy';
}
// The exact suppression annotateMail writes; mail unhide clears only this one.
export const MAIL_SUPPRESSION = 'already_applied_mail 邮件确认';

// Holds that ask the user (or the forced model decision) a question about the posting.
export const MODEL_HOLD_CODES = Object.freeze(['missing_fact', 'requirement_unclear', 'user_review', 'term_or_area']);
const QUESTION_HOLD_CODES = Object.freeze([...MODEL_HOLD_CODES, 'browser_review']);

// A question hold is released only by an answer: the user's resolve (explicit), or a fresh judge verdict with
// decision eligible. A verdict replayed from stored judgments (redecide, decision-code replay, hold release) is
// not an answer, and neither is an inferred term against the term_or_area question; a forced model decision is.
export function heldReleaseBlock(review, verdict, { fresh = false, explicit = false } = {}) {
  if (explicit || verdict?.decision !== 'eligible') return null;
  if (review?.decision !== 'unclear' || !QUESTION_HOLD_CODES.includes(review.code)) return null;
  if (!fresh) return 'replayed';
  if (verdict.modelDecision) return null;
  return review.code === 'term_or_area' && (verdict.flags ?? []).includes('term_inferred') ? 'inferred_term' : null;
}
export function keepHold(review, verdict, { escalate = false } = {}) {
  const evidence = parseJson(review.evidence_json);
  return { ...verdict, decision: 'unclear', code: review.code, escalate, nextAction: 'user_review',
    question: evidence.question ?? verdict.question ?? null, holdFactIds: evidence.holdFactIds ?? [],
    flags: [...new Set([...(verdict.flags ?? []), 'hold_kept'])] };
}

function appendEvent(db, appId, type, now, { statusAfter = null, note = '', source = {}, reviewRestore = false, liftedRule = false } = {}) {
  recordEvent(db, { id: randomUUID(), applicationId: appId, type, observedAt: now, recordedAt: now, title: type, note,
    source: { actor: 'review-worker', ...source }, statusAfter }, { withinTransaction: true, reviewRestore, liftedRule });
}

// Codes the gate settles automatically; each keeps the verdict's fields so a release can restore it.
export const GATE_CODES = Object.freeze(['company_cap', 'company_limit', 'company_small', 'duplicate_submitted']);
const isUserActor = (actor) => actor === 'user' || actor === 'apply';

export function deliver(db, { postingId, verdict, fence, now, policy = {}, fresh = false, explicit = false, authorization = null, text = null }) {
  return atomic(db, () => {
    assertFence(db, postingId, fence);
    let posting = db.prepare('SELECT * FROM postings WHERE id=?').get(postingId);
    const review = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(postingId);
    authorization ??= storedReopenAuthorization(db, review);
    if (heldReleaseBlock(review, verdict, { fresh, explicit })) verdict = keepHold(review, verdict);
    let app = posting.application_id ? db.prepare('SELECT * FROM applications WHERE id=?').get(posting.application_id) : null;
    const duplicate = submittedDuplicate(db, posting, { companyAliases: policy.companyAliases });
    const oldEvidence = parseJson(review.evidence_json);
    const lastEvent = app && db.prepare('SELECT * FROM application_events WHERE application_id=? ORDER BY recorded_at DESC,rowid DESC LIMIT 1').get(app.id);
    const lastStatus = app && db.prepare('SELECT * FROM application_events WHERE application_id=? AND status_after IS NOT NULL ORDER BY recorded_at DESC,rowid DESC LIMIT 1').get(app.id);
    const automated = oldEvidence.provenance === 'automated';
    const isUserEvent = (event) => {
      if (!event) return false;
      const source = parseJson(event.source_json);
      return isUserActor(source.actor) || source.actor !== 'review-worker'
        && (['user','manual','event-command'].includes(source.kind) || /^(?:manual_|user_)/.test(event.event_type));
    };
    const userWithdrawal = app?.status === 'withdrawn' && isUserEvent(lastStatus);
    // A withdrawal by a company rule the user has since lifted (the company is re-allowed) is the review's to restore.
    const liftedRule = app?.status === 'withdrawn' && !userWithdrawal && reallowed(posting.company, policy)
      ? (policy.liftedSkipReasons ?? []).find((prefix) => String(app.skip_reason ?? '').startsWith(prefix)) ?? null : null;
    const reviewOwned = !userWithdrawal && (lastStatus && parseJson(lastStatus.source_json).actor === 'review-worker' || automated || oldEvidence.systemReview === true || Boolean(liftedRule));
    const canRestore = !duplicate && review.code !== 'already_submitted' && reviewOwned;
    const stageStart = parseJson(review.dep_hashes_json).stageStartedAt ?? review.updated_at;
    const protectedApp = app && (app.applied_at || SUBMITTED_STATUSES.includes(app.status) || ['user','legacy'].includes(app.skip_owner)
      || app.status === 'withdrawn' && !canRestore && !(duplicate && reviewOwned) || isUserEvent(lastEvent) && lastEvent.recorded_at > stageStart);
    let value = verdict.decision === 'eligible' ? companyVerdict(posting, verdict, policy) : verdict;
    // Exclusions are rechecked at delivery even if the inputs changed while judging.
    value = excludedVerdict(posting, value, policy) ?? value;
    // Exploration never creates a user question, including delivery-time holds
    // such as company quotas. Keep the sampled lane as the negative reason.
    // A gate settlement keeps its own code so the startup pass can restore it.
    if (['no_student_signal', 'out_of_direction'].includes(review.lane) && !LIMIT_CODES.includes(value.code)) {
      value = value.decision === 'eligible'
        ? { ...value, flags: [...new Set([...(value.flags ?? []), 'found_by_sampling'])] }
        : { ...value, decision: 'not_eligible', code: review.lane, question: null, holdFactIds: [], nextAction: null };
    }
    // User rule (2026-10-29): an eligible verdict outside the role direction (profile/role-direction.json) is
    // settled automatically, never shown or held. It keeps the verdict's fields so a rules change can restore it.
    const direction = value.decision === 'eligible' ? roleDirection(posting.title, policy.direction, { functionValue: value.functionValue, company: posting.company, aliases: policy.companyAliases }) : null;
    if (direction && !direction.ok) value = { ...value, decision: 'not_eligible', code: DIRECTION_CODE, direction: directionNote(direction) };
    // User rule (2026-10-31): a role the judge labelled pure software engineering is out of direction unless its
    // title carries an AI/ML/data signal. A missing or blank label changes nothing.
    if (value.decision === 'eligible' && softwareOnlyRole(posting.title, value.functionValue, policy.direction, { company: posting.company, aliases: policy.companyAliases })) {
      value = { ...value, decision: 'not_eligible', code: OUT_OF_DIRECTION_CODE, direction: softwareNote(value.functionValue), softwareDirection: true,
        question: null, holdFactIds: [], nextAction: null };
    }
    // Both direction settlements are automated and keep the verdict's fields, so the startup pass can restore them.
    const directionOwned = value.code === DIRECTION_CODE || value.code === OUT_OF_DIRECTION_CODE && value.softwareDirection === true;
    // This guard also wins over eligible verdicts, quotas and exploration lanes.
    // It never merges postings or writes to the submitted application.
    if (duplicate) value = { decision: 'not_eligible', code: 'already_submitted', evidence: [duplicate] };
    // A cross-ATS repost of a submitted role (src/review/duplicate.mjs): linked, never merged.
    const repost = !duplicate && value.decision === 'eligible'
      ? duplicateOfSubmitted(db, posting, { companyAliases: policy.companyAliases, text, locations: (value.location?.offices ?? []).map((office) => office.place) }) : null;
    if (repost) value = { ...value, decision: 'not_eligible', code: 'duplicate_submitted', judged: true, question: null, holdFactIds: [], nextAction: null };
    const capped = !duplicate && (value.decision === 'eligible' || LIMIT_CODES.includes(value.code))
      && evaluateLimits(posting.company, { policy, now, db, program: value.program, exclude: app?.id ?? null });
    // The cap keeps the eligible verdict's fields so the startup pass can restore it without a model call.
    if (capped) value = { ...value, decision: 'not_eligible', code: capped.code, judged: value.decision === 'eligible' || value.judged === true, question: null, holdFactIds: [], nextAction: null };
    // User rule (2026-10-20): big companies only. Known small → settled; unknown → the posting waits for the
    // company decision (ensureCompanySizes) with no decision and no application change. A user's explicit
    // resolve is not held back by a pending size decision.
    const size = value.decision === 'eligible' && !protectedApp ? companySizeGate(posting.company, policy.companySizes) : 'large';
    if (size === 'small') value = { ...value, decision: 'not_eligible', code: 'company_small', judged: true, question: null, holdFactIds: [], nextAction: null };
    if (size === 'unknown' && !explicit && app?.status !== 'prepared') {
      db.prepare(`UPDATE reviews SET state='due',stage='judge',next_due=?,lease_owner=NULL,lease_until=NULL,last_error='company_size_pending',updated_at=?
        WHERE posting_id=? AND lease_owner=? AND lease_generation=?`).run(now, now, postingId, fence.owner, fence.generation);
      logReview(db, postingId, { now, kind: 'delivery', payload: { action: 'company_size_pending', company: posting.company, applicationId: app?.id ?? null } });
      if (db.prepare('SELECT state FROM reviews WHERE posting_id=?').get(postingId).state !== 'due') throw new Error('Delivery readback mismatch');
      return { action: 'company_size_pending', applicationId: app?.id ?? null };
    }
    // P4: a withdrawn application becomes a lead again only with an authorization (rejudge, cap_release, relist).
    // A withdrawal made only because the posting closed is relisted when the posting is listed and open again.
    if (!authorization && app?.status === 'withdrawn' && RELIST_REASONS.includes(app.skip_reason) && posting.listed && posting.availability === 'open') authorization = 'relist';
    if (!protectedApp && app?.status === 'withdrawn' && value.decision === 'eligible' && !restoreAuthorized(app, authorization, lastStatus)) {
      const keptDecision = review.decision && review.decision !== 'eligible' ? review.decision : 'not_eligible';
      const keptCode = review.code ?? 'withdrawal_kept';
      db.prepare(`UPDATE reviews SET state='done',decision=?,code=?,stage='deliver',hold_owner=NULL,hold_since=NULL,next_due=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?
        WHERE posting_id=? AND lease_owner=? AND lease_generation=?`).run(keptDecision, keptCode, now, postingId, fence.owner, fence.generation);
      logReview(db, postingId, { now, kind: 'delivery', payload: { action: 'withdrawal_kept', applicationId: app.id, authorization, skipReason: app.skip_reason ?? null } });
      if (db.prepare('SELECT state FROM reviews WHERE posting_id=?').get(postingId).state !== 'done') throw new Error('Delivery readback mismatch');
      return { action: 'withdrawal_kept', applicationId: app.id };
    }
    const userExcluded = !duplicate && value.code === 'company_excluded' && Boolean(value.excluded);
    const gateOwned = !duplicate && GATE_CODES.includes(value.code);
    const capOwned = duplicate || gateOwned || directionOwned || userExcluded;
    let action;
    let held = value.decision === 'unclear';
    if (protectedApp) { action = 'superseded_by_user'; held = false; }
    else if (app?.status === 'prepared') { action = 'prepared'; held = false; }
    else {
      if (!app && value.decision !== 'not_eligible' && value.decision !== 'dropped') {
        app = createApplication(db, { company: posting.company, role: posting.title, jobUrl: /^https?:/.test(posting.canonical_url) ? posting.canonical_url : `https://${posting.canonical_url}`, externalId: `posting:${postingId}`, companyAliases: policy.companyAliases }, now);
        const bound = bindApplication(db, app.id, { now, companyAliases: policy.companyAliases });
        if (bound.action === 'conflict' || bound.postingId !== postingId) throw new Error('Delivery identity conflict');
        db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(app.id, postingId);
        action = 'created';
      }
      if (app) {
        if (value.decision === 'eligible') {
          const restored = app.status === 'withdrawn';
          appendEvent(db, app.id, restored ? 'review_restored' : 'review_delivered', now, { statusAfter: restored ? 'lead' : null, reviewRestore: restored, liftedRule: restored && Boolean(liftedRule),
            source: { postingId, automatedProvenance: automated, ...(oldEvidence.systemReview ? { systemReview: true, provenance: oldEvidence.provenance } : {}),
              ...(restored && liftedRule ? { liftedRule } : {}), ...(restored ? { authorization } : {}) } });
          db.prepare('UPDATE applications SET skip_reason=NULL,skip_owner=NULL WHERE id=?').run(app.id);
          action = restored ? 'restored' : action ?? (app.skip_reason ? 'unhidden' : 'updated');
        } else if (held) {
          const reason = `待核: ${value.code ?? 'user_review'} — ${value.question ?? value.nextAction ?? ''}`;
          if (app.status !== 'withdrawn') db.prepare("UPDATE applications SET skip_reason=?,skip_owner='review' WHERE id=?").run(reason, app.id);
          appendEvent(db, app.id, 'review_held', now, { note: reason, source: { postingId } });
          action = 'hidden';
        } else {
          if (app.status !== 'withdrawn') appendEvent(db, app.id, 'review_withdrawn', now, { statusAfter: 'withdrawn', note: value.skipReason ?? value.code ?? '',
            source: { postingId, evidence: value.evidence ?? [], ...(capOwned ? { automatedProvenance: true } : {}) } });
          // An application already withdrawn keeps its own reason: a later settlement (a cap) never takes it over.
          if (app.status !== 'withdrawn') db.prepare("UPDATE applications SET skip_reason=?,skip_owner='review' WHERE id=?").run(value.skipReason ?? value.code ?? 'not_eligible', app.id);
          action = 'withdrawn';
        }
        const deadline = value.deadline ?? { kind: 'none' };
        const cutoff = deadline.kind === 'cutoff' ? deadlineValue(deadline) : null;
        const end = deadline.kind === 'posting_end' ? deadlineValue(deadline) : null;
        db.prepare(`UPDATE applications SET fit=?,fit_note=?,location=?,verified_at=?,updated_at=?,posting_end_at=?,
          deadline_at=CASE WHEN (deadline_source IS NULL AND deadline_at IS NULL) OR deadline_source='review' THEN ? ELSE deadline_at END,
          deadline_precision=CASE WHEN (deadline_source IS NULL AND deadline_at IS NULL) OR deadline_source='review' THEN ? ELSE deadline_precision END,
          deadline_source=CASE WHEN (deadline_source IS NULL AND deadline_at IS NULL) OR deadline_source='review' THEN ? ELSE deadline_source END WHERE id=?`)
          .run(value.fit?.level ?? app.fit, value.fit?.note ?? app.fit_note, value.location?.display ?? app.location, now, now, end,
            cutoff, cutoff ? (cutoff.length > 10 ? 'datetime' : 'date') : null, cutoff ? 'review' : null, app.id);
      } else action = 'no_application';
    }
    const evidence = { ...oldEvidence, evidence: value.evidence ?? [], needs: value.needs ?? {}, fit: value.fit ?? null, deadline: value.deadline ?? { kind: 'none' },
      program: value.program ?? null, location: value.location ?? null, factsUsed: value.factsUsed ?? [], question: value.question ?? null, holdFactIds: value.holdFactIds ?? [] };
    if (LIMIT_CODES.includes(value.code)) {
      evidence.companyCap = { provenance: oldEvidence.companyCap?.provenance ?? oldEvidence.provenance ?? null, judged: value.judged === true, code: value.code,
        ...(capped ? { count: capped.count, max: capped.max, windowDays: capped.windowDays ?? null, applicationIds: capped.applicationIds, kind: capped.kind, source: capped.source,
          ...(capped.cycleStart ? { cycleStart: capped.cycleStart } : {}), ...(capped.reason ? { reason: capped.reason, program: capped.program } : {}),
          ...(capped.flaggedDates?.length ? { flaggedDates: capped.flaggedDates } : {}), ...(capped.active ? { active: true } : {}) } : {}) };
      evidence.provenance = 'automated';
    } else if (oldEvidence.companyCap) {
      if (oldEvidence.companyCap.provenance) evidence.provenance = oldEvidence.companyCap.provenance; else delete evidence.provenance;
      delete evidence.companyCap;
    }
    if (directionOwned && !duplicate) {
      evidence.roleDirection = { note: value.direction ?? null, provenance: oldEvidence.roleDirection?.provenance ?? oldEvidence.provenance ?? null,
        ...(value.softwareDirection === true ? { software: true } : {}) };
      evidence.provenance = 'automated';
    } else if (oldEvidence.roleDirection) {
      if (!LIMIT_CODES.includes(value.code)) {
        if (oldEvidence.roleDirection.provenance) evidence.provenance = oldEvidence.roleDirection.provenance; else delete evidence.provenance;
      }
      delete evidence.roleDirection;
    }
    // An override exclusion is automated and restorable once the user lifts it (startup pass).
    if (userExcluded) {
      evidence.companyExcluded = { source: 'user', match: value.excluded.match, judged: value.excluded.judged === true,
        provenance: oldEvidence.companyExcluded ? oldEvidence.companyExcluded.provenance ?? null : evidence.provenance ?? null };
      evidence.provenance = 'automated';
    } else if (oldEvidence.companyExcluded) {
      if (!LIMIT_CODES.includes(value.code) && !directionOwned && !duplicate) {
        if (oldEvidence.companyExcluded.provenance) evidence.provenance = oldEvidence.companyExcluded.provenance; else delete evidence.provenance;
      }
      delete evidence.companyExcluded;
    }
    // The judge's function label, kept so the startup pass can re-check the direction without a model call.
    if (value.functionValue !== undefined) evidence.function = value.functionValue ?? null;
    // Size and cross-ATS duplicate settlements: automated, restorable by an explicit rejudge.
    if (value.code === 'company_small' || value.code === 'duplicate_submitted') {
      evidence.gate = { code: value.code, judged: value.judged === true, provenance: oldEvidence.gate ? oldEvidence.gate.provenance ?? null : evidence.provenance ?? null,
        ...(repost ? { duplicateOf: repost } : {}) };
      evidence.provenance = 'automated';
    } else if (oldEvidence.gate) {
      if (!LIMIT_CODES.includes(value.code) && !directionOwned && !duplicate && !userExcluded) {
        if (oldEvidence.gate.provenance) evidence.provenance = oldEvidence.gate.provenance; else delete evidence.provenance;
      }
      delete evidence.gate;
    }
    if (duplicate) evidence.provenance = 'automated';
    // A stored reopen authorization is consumed by this delivery.
    delete evidence.reopenAuthorization;
    if (value.modelDecision) evidence.modelDecision = value.modelDecision;
    else delete evidence.modelDecision;
    if (value.jev) evidence.jev = value.jev;
    const userHold = held && !['unavailable','quota_full','quota_reconciliation'].includes(value.code);
    db.prepare('UPDATE reviews SET flags_json=? WHERE posting_id=?')
      .run(JSON.stringify([...new Set([...parseJson(review.flags_json, []).filter((flag) => !['term_inferred', 'model_decided', 'disputed', 'jev_decided', 'hold_kept', RELIST_FLAG].includes(flag)), ...(value.flags ?? [])])]), postingId);
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

// Reconcile legacy/delivered leads even when no fetch or cached judgment is due.

// Reconcile legacy/delivered leads even when no fetch or cached judgment is due.
// Claim only duplicates and settle them through the normal fenced event writer;
// unchanged reviews are never requeued for a paid judgment.
export function suppressSubmittedDuplicates(db, { now, policy = {}, owner = 'review-dedupe' }) {
  return atomic(db, () => {
    const index = submittedApplicationIndex(db, { companyAliases: policy.companyAliases });
    let suppressed = 0;
    // Decide once: only open work (due/held/failed reviews and visible leads) is looked at; settled history stays.
    for (const posting of db.prepare(`SELECT p.*,r.posting_id,r.state,r.code,a.status application_status
      FROM postings p JOIN reviews r ON r.posting_id=p.id LEFT JOIN applications a ON a.id=p.application_id
      WHERE p.merged_into IS NULL AND (r.state IN ('due','held','failed') OR r.decision='eligible' AND a.status='lead')`).all()) {
      if (userDecided(db, posting) || !submittedDuplicate(db, posting, { companyAliases: policy.companyAliases, index })) continue;
      if (posting.state === 'done' && posting.code === 'already_submitted'
        && (!posting.application_id || posting.application_status === 'withdrawn')) continue;
      const fence = claimItem(db, posting.id, { owner, now });
      if (!fence) continue;
      deliver(db, { postingId: posting.id, fence, now, policy, verdict: { decision: 'not_eligible', code: 'already_submitted' } });
      suppressed += 1;
    }
    return { suppressed };
  });
}

// The cap's startup pass: settle due reviews and visible eligible leads of a
// capped company without fetching or judging, and restore what it capped once
// the company is under the cap again. User decisions are never touched.
export const restoredVerdict = (review, evidence) => ({ decision: 'eligible', code: null, evidence: evidence.evidence ?? [], needs: evidence.needs ?? {},
  fit: evidence.fit ?? null, deadline: evidence.deadline ?? { kind: 'none' }, program: evidence.program ?? null, location: evidence.location ?? null,
  factsUsed: evidence.factsUsed ?? [], flags: parseJson(review.flags_json, []), ...(evidence.modelDecision ? { modelDecision: evidence.modelDecision } : {}),
  ...(evidence.jev ? { jev: evidence.jev } : {}), ...(Object.hasOwn(evidence, 'function') ? { functionValue: evidence.function } : {}) });

// Startup reconciliation and cap release, with the same evaluator as delivery (src/review/limits.mjs):
// settles due reviews and visible leads of a company over a limit, restores what a limit withdrew once
// the current rule no longer blocks it (authorization cap_release, exact skip owner and reason), and gives
// legacy quota holds a decision.
export const QUOTA_HOLD_CODES = Object.freeze(['quota_full', 'quota_reconciliation', 'quota_unclear']);
export function applyCompanyCap(db, { now, policy = {}, owner = 'review-company-cap' }) {
  return atomic(db, () => {
    const counts = limitCounts(db);
    let capped = 0; let restored = 0; let holds = 0;
    const codes = LIMIT_CODES.map((code) => `'${code}'`).join(',');
    for (const row of db.prepare(`SELECT p.*,r.posting_id,r.state,r.decision,r.code,r.flags_json,r.evidence_json,r.dep_hashes_json,a.status application_status,a.skip_reason application_skip,a.skip_owner application_skip_owner
      FROM postings p JOIN reviews r ON r.posting_id=p.id LEFT JOIN applications a ON a.id=p.application_id
      WHERE p.merged_into IS NULL AND (r.state='due' OR r.state='done' AND r.decision='eligible' AND a.status='lead'
        OR r.state='done' AND r.code IN (${codes})
        OR r.state='held' AND r.code IN (${QUOTA_HOLD_CODES.map((code) => `'${code}'`).join(',')}))`).all()) {
      if (userDecided(db, row)) continue;
      const evidence = parseJson(row.evidence_json);
      const over = evaluateLimits(row.company, { policy, now, counts, program: evidence.program, exclude: row.application_id ?? null });
      if (row.state === 'held') {
        // A quota hold from before limits became decisions: deliver its kept verdict through the gate.
        const fence = claimItem(db, row.id, { owner, now });
        if (!fence) continue;
        deliver(db, { postingId: row.id, fence, now, policy, verdict: restoredVerdict(row, evidence) });
        holds += 1;
        continue;
      }
      if (LIMIT_CODES.includes(row.code)) {
        // A freshness refresh or replan re-queues capped reviews; while the limit
        // holds, settle them again instead of paying to re-judge. A replan's
        // invalidation means the kept verdict is stale, so it must be re-judged.
        const judged = evidence.companyCap?.judged === true && !parseJson(row.dep_hashes_json).invalidated;
        if (over) {
          if (row.state === 'due') {
            db.prepare(`UPDATE reviews SET state='done',stage='deliver',decision='not_eligible',next_due=NULL,evidence_json=?,updated_at=? WHERE posting_id=? AND state='due' AND code=?`)
              .run(JSON.stringify({ ...evidence, companyCap: { ...evidence.companyCap, judged } }), now, row.id, row.code);
            logReview(db, row.id, { now, payload: { action: 'company_cap_settled', judged, code: row.code } });
          }
          continue;
        }
        // Release only what this limit withdrew: the review owns the withdrawal and its reason is exactly the code.
        if (row.application_id && row.application_status === 'withdrawn'
          && !(row.application_skip_owner === 'review' && row.application_skip === row.code)) continue;
        if (judged) {
          const fence = claimItem(db, row.id, { owner, now });
          if (!fence) continue;
          deliver(db, { postingId: row.id, fence, now, policy, authorization: 'cap_release', verdict: restoredVerdict(row, evidence) });
        } else {
          // A cap settlement is reopened only as a cap release (P4); the authorization is recorded on the row so
          // its delivery may restore the withdrawal, and in the log.
          const application = row.application_id ? { status: row.application_status } : null;
          if (!autoReopenAllowed({ review: row, application, authorization: 'cap_release' })) continue;
          const kept = { ...evidence, reopenAuthorization: { authorization: 'cap_release', at: now, code: row.code } };
          // Authorized work is not sampling: an exploration-lane row moves to the normal lane.
          db.prepare(`UPDATE reviews SET state='due',stage='fetch',decision=NULL,code=NULL,next_due=?,hold_owner=NULL,hold_since=NULL,evidence_json=?,updated_at=?,
            lane=CASE WHEN lane IN ('no_student_signal','out_of_direction') THEN 'new' ELSE lane END
            WHERE posting_id=? AND state IN ('due','done') AND code=?`).run(now, JSON.stringify(kept), now, row.id, row.code);
          logReview(db, row.id, { now, stage: 'fetch', payload: { action: 'company_cap_restored', judged: false, code: row.code, authorization: 'cap_release' } });
        }
        restored += 1;
        continue;
      }
      if (!over) continue;
      // Only visible eligible leads; hidden ones keep their own reason.
      if (row.state === 'done' && row.application_id && (row.application_status !== 'lead' || row.application_skip)) continue;
      const fence = claimItem(db, row.id, { owner, now });
      if (!fence) continue;
      deliver(db, { postingId: row.id, fence, now, policy, verdict: row.state === 'done' ? restoredVerdict(row, evidence) : { decision: 'not_eligible', code: over.code } });
      capped += 1;
    }
    return { capped, restored, holds };
  });
}

// Recovery-created system_failure holds are re-queued once; a second failure stays held and is
// reported as an external failure (returned in `external`).
export function requeueSystemFailures(db, { now }) {
  return atomic(db, () => {
    const result = { requeued: 0, external: [] };
    for (const row of db.prepare("SELECT posting_id,flags_json,last_error FROM reviews WHERE state='held' AND code='system_failure'").all()) {
      const flags = parseJson(row.flags_json, []);
      if (flags.includes('system_failure_requeued')) { result.external.push({ postingId: row.posting_id, error: row.last_error ?? 'system_failure' }); continue; }
      db.prepare(`UPDATE reviews SET state='due',code=NULL,decision=NULL,hold_owner=NULL,hold_since=NULL,next_due=?,flags_json=?,updated_at=? WHERE posting_id=? AND state='held'`)
        .run(now, JSON.stringify([...flags, 'system_failure_requeued']), now, row.posting_id);
      logReview(db, row.posting_id, { now, stage: 'fetch', payload: { action: 'system_failure_requeued' } });
      result.requeued += 1;
    }
    return result;
  });
}

export function annotateMail(db, { postingId, match, messageId, subject, received, matched, now }) {
  return atomic(db, () => {
    const posting = db.prepare('SELECT application_id FROM postings WHERE id=?').get(postingId);
    if (!posting?.application_id) return;
    const app = db.prepare('SELECT * FROM applications WHERE id=?').get(posting.application_id);
    appendEvent(db, app.id, 'mail_note', now, { note: subject ?? '', source: { kind: 'mail', messageId, received, matched, match } });
    if (match === 'exact' && app.status === 'lead' && (!app.skip_owner || app.skip_owner === 'review')) {
      db.prepare("UPDATE applications SET skip_reason=?,skip_owner='review',updated_at=? WHERE id=?").run(MAIL_SUPPRESSION, now, app.id);
    }
  });
}
export function unhide(db, { postingId, now }) {
  return atomic(db, () => {
    const posting = db.prepare('SELECT application_id FROM postings WHERE id=?').get(postingId);
    if (!posting?.application_id) return;
    // Only the exact suppression annotateMail wrote; any other review hold or system suppression stays.
    const changed = db.prepare("UPDATE applications SET skip_reason=NULL,skip_owner=NULL,updated_at=? WHERE id=? AND skip_owner='review' AND status='lead' AND skip_reason=?").run(now, posting.application_id, MAIL_SUPPRESSION).changes;
    if (changed) appendEvent(db, posting.application_id, 'mail_unhidden', now, { source: { actor: 'user', postingId } });
  });
}
