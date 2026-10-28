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

const key = (value) => String(value ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
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

// User rule (2026-10-27): at most `max` submissions per company in any rolling
// `windowDays`. The cap is review policy, not a judge dependency, so it is
// applied at delivery and by the startup pass, never by re-judging.
const CAP_STATUSES = ['applied', 'assessment', 'interview', 'rejected', 'offer'];
const capOf = (value) => (Number.isInteger(value?.max) && value.max > 0 && Number(value?.windowDays) > 0 ? value : null);
export const deliveryPolicy = (inputs) => ({ ...inputs.screeningPolicy, companyCap: inputs.policy?.companyCap ?? null });

// Submission date: applied_at, else the latest 'submitted' event, else updated_at.
export function companySubmissions(db, { now, cap, companyAliases }) {
  const counts = new Map();
  if (!capOf(cap)) return counts;
  const since = Date.parse(now) - cap.windowDays * 86_400_000;
  for (const app of db.prepare(`SELECT a.id,a.company,COALESCE(NULLIF(a.applied_at,''),(SELECT e.occurred_at FROM application_events e
      WHERE e.application_id=a.id AND e.event_type='submitted' AND COALESCE(e.occurred_at,'')<>'' ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1),a.updated_at) submitted_at
      FROM applications a WHERE a.status IN (${CAP_STATUSES.map(() => '?').join(',')})`).all(...CAP_STATUSES)) {
    if (!(Date.parse(app.submitted_at) > since)) continue;
    const company = companyKey(app.company, companyAliases);
    const entry = counts.get(company) ?? { count: 0, applicationIds: [] };
    entry.count += 1; entry.applicationIds.push(app.id);
    counts.set(company, entry);
  }
  return counts;
}
function companyCapped(db, company, { now, policy, counts }) {
  const cap = capOf(policy.companyCap);
  if (!cap) return null;
  counts ??= companySubmissions(db, { now, cap, companyAliases: policy.companyAliases });
  const entry = counts.get(companyKey(company, policy.companyAliases));
  return entry && entry.count >= cap.max ? { ...entry, max: cap.max, windowDays: cap.windowDays } : null;
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
    const duplicate = submittedDuplicate(db, posting, { companyAliases: policy.companyAliases });
    const oldEvidence = parseJson(review.evidence_json);
    const lastEvent = app && db.prepare('SELECT * FROM application_events WHERE application_id=? ORDER BY recorded_at DESC,rowid DESC LIMIT 1').get(app.id);
    const lastStatus = app && db.prepare('SELECT * FROM application_events WHERE application_id=? AND status_after IS NOT NULL ORDER BY recorded_at DESC,rowid DESC LIMIT 1').get(app.id);
    const automated = oldEvidence.provenance === 'automated';
    const isUserEvent = (event) => {
      if (!event) return false;
      const source = parseJson(event.source_json);
      return source.actor === 'user' || source.actor !== 'review-worker'
        && (['user','manual','event-command'].includes(source.kind) || /^(?:manual_|user_)/.test(event.event_type));
    };
    const userWithdrawal = app?.status === 'withdrawn' && isUserEvent(lastStatus);
    const reviewOwned = !userWithdrawal && (lastStatus && parseJson(lastStatus.source_json).actor === 'review-worker' || automated || oldEvidence.systemReview === true);
    const canRestore = !duplicate && review.code !== 'already_submitted' && reviewOwned;
    const stageStart = parseJson(review.dep_hashes_json).stageStartedAt ?? review.updated_at;
    const protectedApp = app && (app.applied_at || SUBMITTED_STATUSES.includes(app.status) || ['user','legacy'].includes(app.skip_owner)
      || app.status === 'withdrawn' && !canRestore && !(duplicate && reviewOwned) || isUserEvent(lastEvent) && lastEvent.recorded_at > stageStart);
    let value = verdict.decision === 'eligible' ? companyVerdict(posting, verdict, policy) : verdict;
    // Exclusions are rechecked at delivery even if the inputs changed while judging.
    if ((policy.userExcludedCompanies ?? []).some((c) => key(c) === key(posting.company))) value = { ...value, decision: 'not_eligible', code: 'company_excluded' };
    // Exploration never creates a user question, including delivery-time holds
    // such as company quotas. Keep the sampled lane as the negative reason.
    // A cap settlement keeps its own code so the startup pass can restore it.
    if (['no_student_signal', 'out_of_direction'].includes(review.lane) && value.code !== 'company_cap') {
      value = value.decision === 'eligible'
        ? { ...value, flags: [...new Set([...(value.flags ?? []), 'found_by_sampling'])] }
        : { ...value, decision: 'not_eligible', code: review.lane, question: null, holdFactIds: [], nextAction: null };
    }
    // This guard also wins over eligible verdicts, quotas and exploration lanes.
    // It never merges postings or writes to the submitted application.
    if (duplicate) value = { decision: 'not_eligible', code: 'already_submitted', evidence: [duplicate] };
    const capped = !duplicate && (value.decision === 'eligible' || value.code === 'company_cap') && companyCapped(db, posting.company, { now, policy });
    // The cap keeps the eligible verdict's fields so the startup pass can restore it without a model call.
    if (capped) value = { ...value, decision: 'not_eligible', code: 'company_cap', judged: value.decision === 'eligible' };
    const capOwned = duplicate || value.code === 'company_cap';
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
          appendEvent(db, app.id, restored ? 'review_restored' : 'review_delivered', now, { statusAfter: restored ? 'lead' : null, reviewRestore: restored,
            source: { postingId, automatedProvenance: automated, ...(oldEvidence.systemReview ? { systemReview: true, provenance: oldEvidence.provenance } : {}) } });
          db.prepare('UPDATE applications SET skip_reason=NULL,skip_owner=NULL WHERE id=?').run(app.id);
          action = restored ? 'restored' : action ?? (app.skip_reason ? 'unhidden' : 'updated');
        } else if (held) {
          const reason = `待核: ${value.code ?? 'user_review'} — ${value.question ?? value.nextAction ?? ''}`;
          if (app.status !== 'withdrawn') db.prepare("UPDATE applications SET skip_reason=?,skip_owner='review' WHERE id=?").run(reason, app.id);
          appendEvent(db, app.id, 'review_held', now, { note: reason, source: { postingId } });
          action = 'hidden';
        } else {
          if (app.status !== 'withdrawn') appendEvent(db, app.id, 'review_withdrawn', now, { statusAfter: 'withdrawn', note: value.code ?? '',
            source: { postingId, evidence: value.evidence ?? [], ...(capOwned ? { automatedProvenance: true } : {}) } });
          db.prepare("UPDATE applications SET skip_reason=?,skip_owner='review' WHERE id=?").run(value.code ?? 'not_eligible', app.id);
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
    if (value.code === 'company_cap') {
      evidence.companyCap = { provenance: oldEvidence.companyCap?.provenance ?? oldEvidence.provenance ?? null, judged: value.judged === true,
        ...(capped ? { count: capped.count, max: capped.max, windowDays: capped.windowDays, applicationIds: capped.applicationIds } : {}) };
      evidence.provenance = 'automated';
    } else if (oldEvidence.companyCap) {
      if (oldEvidence.companyCap.provenance) evidence.provenance = oldEvidence.companyCap.provenance; else delete evidence.provenance;
      delete evidence.companyCap;
    }
    if (duplicate) evidence.provenance = 'automated';
    if (value.modelDecision) evidence.modelDecision = value.modelDecision;
    else delete evidence.modelDecision;
    if (value.jev) evidence.jev = value.jev;
    const userHold = held && !['unavailable','quota_full','quota_reconciliation'].includes(value.code);
    db.prepare('UPDATE reviews SET flags_json=? WHERE posting_id=?')
      .run(JSON.stringify([...new Set([...parseJson(review.flags_json, []).filter((flag) => !['term_inferred', 'model_decided', 'disputed', 'jev_decided'].includes(flag)), ...(value.flags ?? [])])]), postingId);
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
// Claim only duplicates and settle them through the normal fenced event writer;
// unchanged reviews are never requeued for a paid judgment.
export function suppressSubmittedDuplicates(db, { now, policy = {}, owner = 'review-dedupe' }) {
  return atomic(db, () => {
    const index = submittedApplicationIndex(db, { companyAliases: policy.companyAliases });
    let suppressed = 0;
    for (const posting of db.prepare(`SELECT p.*,r.posting_id,r.state,r.code,a.status application_status
      FROM postings p JOIN reviews r ON r.posting_id=p.id LEFT JOIN applications a ON a.id=p.application_id
      WHERE p.merged_into IS NULL`).all()) {
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
const restoredVerdict = (review, evidence) => ({ decision: 'eligible', code: null, evidence: evidence.evidence ?? [], needs: evidence.needs ?? {},
  fit: evidence.fit ?? null, deadline: evidence.deadline ?? { kind: 'none' }, program: evidence.program ?? null, location: evidence.location ?? null,
  factsUsed: evidence.factsUsed ?? [], flags: parseJson(review.flags_json, []), ...(evidence.modelDecision ? { modelDecision: evidence.modelDecision } : {}),
  ...(evidence.jev ? { jev: evidence.jev } : {}) });

export function applyCompanyCap(db, { now, policy = {}, owner = 'review-company-cap' }) {
  return atomic(db, () => {
    const cap = capOf(policy.companyCap);
    const counts = companySubmissions(db, { now, cap, companyAliases: policy.companyAliases });
    let capped = 0; let restored = 0;
    for (const row of db.prepare(`SELECT p.*,r.posting_id,r.state,r.decision,r.code,r.flags_json,r.evidence_json,r.dep_hashes_json,a.status application_status,a.skip_reason application_skip
      FROM postings p JOIN reviews r ON r.posting_id=p.id LEFT JOIN applications a ON a.id=p.application_id
      WHERE p.merged_into IS NULL AND (r.state='due' OR r.state='done' AND (r.code='company_cap' OR r.decision='eligible'))`).all()) {
      if (userDecided(db, row)) continue;
      const over = companyCapped(db, row.company, { now, policy, counts });
      const evidence = parseJson(row.evidence_json);
      if (row.code === 'company_cap') {
        // A freshness refresh or replan re-queues capped reviews; while the cap
        // holds, settle them again instead of paying to re-judge. A replan's
        // invalidation means the kept verdict is stale, so it must be re-judged.
        const judged = evidence.companyCap?.judged === true && !parseJson(row.dep_hashes_json).invalidated;
        if (over) {
          if (row.state === 'due') {
            db.prepare(`UPDATE reviews SET state='done',stage='deliver',next_due=NULL,evidence_json=?,updated_at=? WHERE posting_id=? AND state='due' AND code='company_cap'`)
              .run(JSON.stringify({ ...evidence, companyCap: { ...evidence.companyCap, judged } }), now, row.id);
            logReview(db, row.id, { now, payload: { action: 'company_cap_settled', judged } });
          }
          continue;
        }
        if (judged) {
          const fence = claimItem(db, row.id, { owner, now });
          if (!fence) continue;
          deliver(db, { postingId: row.id, fence, now, policy, verdict: restoredVerdict(row, evidence) });
        } else {
          db.prepare(`UPDATE reviews SET state='due',stage='fetch',decision=NULL,code=NULL,next_due=?,hold_owner=NULL,hold_since=NULL,updated_at=?
            WHERE posting_id=? AND state IN ('due','done') AND code='company_cap'`).run(now, now, row.id);
          logReview(db, row.id, { now, stage: 'fetch', payload: { action: 'company_cap_restored', judged: false } });
        }
        restored += 1;
        continue;
      }
      if (!over) continue;
      // Only visible eligible leads; hidden ones keep their own reason.
      if (row.state === 'done' && row.application_id && (row.application_status !== 'lead' || row.application_skip)) continue;
      const fence = claimItem(db, row.id, { owner, now });
      if (!fence) continue;
      deliver(db, { postingId: row.id, fence, now, policy, verdict: row.state === 'done' ? restoredVerdict(row, evidence) : { decision: 'not_eligible', code: 'company_cap' } });
      capped += 1;
    }
    return { capped, restored };
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
