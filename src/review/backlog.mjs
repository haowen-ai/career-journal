// Explicit maintenance commands that replace automatic re-judging (decide once):
//   rejudgeReviews   `review rejudge`        reopen settled automated work on purpose, with a durable authorization
//   settleBacklog    `review settle-backlog` return provably settled rows that automatic passes re-queued
//   holdReview       `review hold`           park a review the browser cannot read (sign-in wall)
// All three are dry-run by default where they change many rows, print counts by class, never touch
// user-owned rows (user skips, prepared/submitted applications, user log entries), and write through a
// claimed item fence in short transactions.
import { classifyRole } from '../funnel/classify.mjs';
import { SIGNAL_DROP_CODES } from '../funnel/contract.mjs';
import { currentRecordReader, latestSightings } from '../funnel/membership.mjs';
import { companyKey } from '../scan/dedupe.mjs';
import { deliver, logReview, parseJson } from './deliver.mjs';
import { atomic, claimItem } from './lease.mjs';
import { reviewOwnershipJoins, userDecisionSql } from './ownership.mjs';

const BATCH = 500;
const bump = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
const object = (value) => { const parsed = parseJson(value, null); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; };

// The durable rejudge authorization. `review rejudge --apply` writes it into the review's evidence_json;
// deliver() (and the worker) read it from there:
//   reviews.evidence_json.$.reopenAuthorization = { authorization: 'rejudge', at, selector, fresh: true }
// - authorization 'rejudge' is the value autoReopenAllowed() accepts; deliver() may restore a withdrawn
//   application to lead only when the review it delivers carries it (parseJson(review.evidence_json)
//   .reopenAuthorization?.authorization === 'rejudge', read from the row BEFORE delivery).
// - fresh: true makes the worker ignore judgments cached before the rejudge, so new checks actually run.
// - It is single-use: the worker removes it in the same transaction that delivers the new verdict.
// A review_log row (kind 'replan', payload.action 'rejudge') records every authorization as well.
export const REJUDGE_AUTHORIZATION = 'rejudge';
export const reopenAuthorizationOf = (review) => object(review?.evidence_json)?.reopenAuthorization ?? null;

function ownershipClass(row) {
  if (row.user_decided || row.code === 'superseded_by_user') return 'user_owned';
  if (row.state === 'leased' && row.lease_until && row.lease_until > row.now_iso) return 'leased';
  if (row.merged_into) return 'merged';
  return null;
}

// --code a,b [--company X] [--since D]   settled automated rejections with those codes (not_eligible or dropped)
// --leads                                current leads (eligible, application status lead)
// --posting id[,id]                      explicit settled reviews
// since compares the posting's first sighting (reviews.first_seen) with the given date.
export function rejudgeReviews(db, { codes = null, leads = false, postings = null, company = null, since = null, companyAliases = {}, now, apply = false }) {
  const selectors = [codes ? 'code' : null, leads ? 'leads' : null, postings ? 'posting' : null].filter(Boolean);
  if (selectors.length !== 1) throw new Error('Usage: career-journal review rejudge (--code <code>[,…] | --leads | --posting <id>[,…]) [--company <name>] [--since <date>] [--apply]');
  if (since !== null && !Number.isFinite(Date.parse(since))) throw new Error('--since requires a date');
  const where = codes ? `r.state='done' AND r.decision IN ('not_eligible','dropped') AND r.code IN (SELECT value FROM json_each(:list))`
    : leads ? `r.state='done' AND r.decision='eligible' AND a.status='lead'`
      : `r.posting_id IN (SELECT value FROM json_each(:list))`;
  const rows = db.prepare(`SELECT r.posting_id,r.state,r.decision,r.code,r.first_seen,r.lease_until,r.evidence_json,p.company,p.merged_into,
      ${userDecisionSql} user_decided
    FROM reviews r JOIN postings p ON p.id=r.posting_id ${reviewOwnershipJoins}
    WHERE ${where} ORDER BY r.first_seen,r.posting_id`).all(...(leads ? [] : [{ list: JSON.stringify(codes ?? postings) }]));
  const report = { dryRun: !apply, selector: selectors[0], selected: 0, byCode: {}, skipped: {}, requeued: 0 };
  if (postings) for (const id of postings) if (!rows.some((row) => row.posting_id === id)) bump(report.skipped, 'unknown_posting');
  const wanted = company ? companyKey(company, companyAliases) : null;
  const chosen = [];
  for (const row of rows) {
    if (wanted && companyKey(row.company, companyAliases) !== wanted) continue;
    if (since && !(Date.parse(row.first_seen) >= Date.parse(since))) continue;
    const skip = ownershipClass({ ...row, now_iso: now }) ?? (postings && !['done', 'held'].includes(row.state) ? 'already_open' : null);
    if (skip) { bump(report.skipped, skip); continue; }
    chosen.push(row);
    report.selected += 1;
    bump(report.byCode, row.decision === 'eligible' ? 'lead' : row.code ?? row.decision ?? 'none');
  }
  if (!apply) return report;
  const owner = 'review-rejudge';
  for (let start = 0; start < chosen.length; start += BATCH) {
    atomic(db, () => {
      for (const row of chosen.slice(start, start + BATCH)) {
        const current = db.prepare(`SELECT r.*,${userDecisionSql} user_decided FROM reviews r JOIN postings p ON p.id=r.posting_id ${reviewOwnershipJoins} WHERE r.posting_id=?`).get(row.posting_id);
        if (!current || current.user_decided || current.state !== row.state) { bump(report.skipped, 'changed'); continue; }
        const fence = claimItem(db, row.posting_id, { owner, now });
        if (!fence) { bump(report.skipped, 'leased'); continue; }
        const evidence = object(current.evidence_json) ?? {};
        // Cached envelopes would replay the old answer; the raw judgments stay in review_log as history.
        const { judgments: _j, forcedDecision: _f, ...kept } = evidence;
        kept.reopenAuthorization = { authorization: REJUDGE_AUTHORIZATION, at: now, selector: report.selector, fresh: true,
          ...(codes ? { codes } : {}), ...(company ? { company } : {}), ...(since ? { since } : {}) };
        db.prepare(`UPDATE reviews SET state='due',stage='fetch',next_due=?,hold_owner=NULL,hold_since=NULL,lease_owner=NULL,lease_until=NULL,
          evidence_json=?,updated_at=? WHERE posting_id=? AND lease_owner=? AND lease_generation=?`)
          .run(now, JSON.stringify(kept), now, row.posting_id, fence.owner, fence.generation);
        logReview(db, row.posting_id, { now, stage: 'fetch', kind: 'replan', payload: { action: 'rejudge', authorization: REJUDGE_AUTHORIZATION,
          selector: report.selector, previous: { state: current.state, decision: current.decision, code: current.code } } });
        report.requeued += 1;
      }
    });
  }
  return report;
}

// Same rule as `review reclassify`: the most complete source decides, and a signal drop needs every source to agree.
const DESCRIPTION_RANK = { full: 2, tags: 1 };
const completeness = (observation) => {
  const parts = parseJson(observation.completeness_json);
  return (DESCRIPTION_RANK[parts.description] ?? 0) + (parts.locations === 'complete') + (parts.arrangement === 'known') + (parts.employment_type === 'explicit');
};
function classifyPosting(observations, options) {
  const [primary, ...others] = observations.toSorted((a, b) => completeness(b) - completeness(a))
    .map((observation) => classifyRole(JSON.parse(observation.fields_json), options));
  if (!SIGNAL_DROP_CODES.includes(primary.code)) return primary;
  return others.find((result) => result.kind === 'review') ?? primary;
}

// Rows a run re-queued although they were settled (refresh, replan, startup passes). A row returns to done
// with its ORIGINAL decision, code, evidence and dependency hashes only when its previous automated
// settlement is provable; every other row stays due and is judged by normal runs.
//   exploration lanes (no_student_signal / out_of_direction): re-run the classifier; a drop settles as that
//     deterministic drop, a now-reviewable posting stays due.
//   others: previous decision not_eligible / dropped / reused, or eligible whose application is not a lead;
//     evidence is a JSON object; a judged decision has a code and a valid snapshot; not user-owned, not
//     superseded_by_user, not held, no identity conflict, no pending rejudge authorization.
export function settleBacklog(db, { policy, profile, now, apply = false }) {
  const report = { dryRun: !apply, scanned: 0, settle: {}, stay: {}, settled: 0 };
  const rows = db.prepare(`SELECT r.posting_id,r.state,r.decision,r.code,r.lane,r.evidence_json,r.lease_owner,r.lease_until,r.updated_at,
      p.merged_into,p.listed,a.status application_status,${userDecisionSql} user_decided,
      EXISTS(SELECT 1 FROM snapshots s WHERE s.posting_id=r.posting_id AND s.identity_ok=1 AND s.text IS NOT NULL) has_snapshot,
      EXISTS(SELECT 1 FROM posting_links l WHERE l.kind='conflict' AND (l.left_id=r.posting_id OR l.right_id=r.posting_id)) conflicted
    FROM reviews r JOIN postings p ON p.id=r.posting_id ${reviewOwnershipJoins}
    WHERE r.state='due' ORDER BY r.first_seen,r.posting_id`).all();
  let reader; let latest;
  const plans = [];
  for (const row of rows) {
    report.scanned += 1;
    const evidence = object(row.evidence_json);
    const stay = (reason) => bump(report.stay, reason);
    if (row.user_decided || row.code === 'superseded_by_user') { stay('user_owned'); continue; }
    if (row.lease_owner && row.lease_until > now) { stay('leased'); continue; }
    if (row.merged_into) { stay('merged'); continue; }
    if (row.conflicted) { stay('conflict'); continue; }
    if (evidence?.reopenAuthorization) { stay('rejudge_authorized'); continue; }
    if (SIGNAL_DROP_CODES.includes(row.lane)) {
      if (!reader) { reader = currentRecordReader(db); ({ latest } = latestSightings(db)); }
      const observations = reader.records(reader.members(row.posting_id), latest, { fallback: true });
      if (!observations.length) { stay('exploration_no_observation'); continue; }
      const delisted = !row.listed && observations.every((item) => !item.listed);
      const result = delisted ? { kind: 'drop', code: 'delisted' } : classifyPosting(observations, { policy, profile });
      if (result.kind !== 'drop') { stay('exploration_reviewable'); continue; }
      plans.push({ row, decision: 'dropped', code: result.code, kind: 'exploration_drop' });
      bump(report.settle, 'exploration_drop');
      continue;
    }
    if (row.decision === null) { stay('never_decided'); continue; }
    if (row.decision === 'unclear') { stay('unclear'); continue; }
    if (row.decision === 'eligible' && row.application_status === 'lead') { stay('open_lead'); continue; }
    if (!evidence) { stay('evidence_missing'); continue; }
    const judged = ['not_eligible', 'eligible'].includes(row.decision);
    if (row.decision === 'not_eligible' && !row.code) { stay('code_missing'); continue; }
    if (judged && !row.has_snapshot) { stay('no_snapshot'); continue; }
    plans.push({ row, decision: row.decision, code: row.code, kind: `previous_${row.decision}` });
    bump(report.settle, `previous_${row.decision}`);
  }
  if (!apply) return report;
  const owner = 'review-settle-backlog';
  for (let start = 0; start < plans.length; start += BATCH) {
    atomic(db, () => {
      for (const { row, decision, code, kind } of plans.slice(start, start + BATCH)) {
        // Re-check inside the write: nothing may have moved since the read.
        const current = db.prepare(`SELECT r.state,r.updated_at,${userDecisionSql} user_decided FROM reviews r JOIN postings p ON p.id=r.posting_id ${reviewOwnershipJoins} WHERE r.posting_id=?`).get(row.posting_id);
        if (current?.state !== 'due' || current.updated_at !== row.updated_at || current.user_decided) { bump(report.stay, 'changed'); continue; }
        const fence = claimItem(db, row.posting_id, { owner, now });
        if (!fence) { bump(report.stay, 'leased'); continue; }
        db.prepare(`UPDATE reviews SET state='done',stage='deliver',decision=?,code=?,next_due=NULL,hold_owner=NULL,hold_since=NULL,
          lease_owner=NULL,lease_until=NULL,updated_at=? WHERE posting_id=? AND lease_owner=? AND lease_generation=?`)
          .run(decision, code, now, row.posting_id, fence.owner, fence.generation);
        logReview(db, row.posting_id, { now, payload: { action: 'backlog_settled', class: kind, decision, code } });
        report.settled += 1;
      }
    });
  }
  return report;
}

// `review hold`: the nightly browser drain marks a page it cannot read without signing in. The review stays
// held (system-owned) with that code, its lead is hidden, no business decision is recorded, and no run
// retries or judges it; `review attach` with the page text releases it like a browser_review hold.
export const MANUAL_HOLD_CODES = Object.freeze(['external_signin_wall']);
export function holdReview(db, { postingId, code, reason, now, policy = {} }) {
  if (!MANUAL_HOLD_CODES.includes(code)) throw new Error(`--code must be one of: ${MANUAL_HOLD_CODES.join(', ')}`);
  return atomic(db, () => {
    const row = db.prepare(`SELECT r.*,${userDecisionSql} user_decided FROM reviews r JOIN postings p ON p.id=r.posting_id ${reviewOwnershipJoins} WHERE r.posting_id=?`).get(postingId);
    if (!row) throw new Error('Unknown review');
    if (row.user_decided) throw new Error('Review is owned by a user decision');
    if (!['due', 'held', 'failed'].includes(row.state) && !(row.state === 'leased' && !(row.lease_until > now))) throw new Error(`Review is ${row.state}; only open reviews can be held`);
    const fence = claimItem(db, postingId, { owner: 'review-hold', now });
    if (!fence) return { postingId, status: 'busy' };
    deliver(db, { postingId, fence, now, policy, verdict: { decision: 'unclear', code, question: `Sign-in wall: ${reason}`, nextAction: 'browser_review', holdFactIds: [] } });
    db.prepare("UPDATE reviews SET hold_owner='system',last_error=? WHERE posting_id=? AND state='held'").run(code, postingId);
    logReview(db, postingId, { now, payload: { action: 'manual_hold', code, reason } });
    const held = db.prepare('SELECT state,code FROM reviews WHERE posting_id=?').get(postingId);
    return { postingId, state: held.state, code: held.code };
  });
}
