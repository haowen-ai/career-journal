import { randomUUID } from 'node:crypto';
import { companyKey, titleSimilarity } from '../scan/dedupe.mjs';
import { SUBMITTED_STATUSES } from '../funnel/contract.mjs';
import { recordEvent } from '../domain/events.mjs';
import { redact } from '../runtime/redact.mjs';
import { atomic, assertFence, claimItem } from './lease.mjs';

// A cross-ATS repost of a role already submitted: separate postings (identities are never merged),
// but the later one is settled not_eligible duplicate_submitted, linked to the submitted application.
// All must hold:
//   - the other application has submission evidence (applied_at, a submitted status, or a submitted
//     event); a merely withdrawn application is not evidence;
//   - same company through the alias map, same normalized title (equal title tokens) of the trusted official titles:
//     each side's latest official snapshot title (fields_json.title); a side without one falls back to its posting
//     title (the new posting) or the application's role (the submitted side). Plan 2026-11-10 (root cause 3): the
//     submitted row's role is often a board's shortened title ("Data Scientist Intern" for the official
//     "Data Scientist Intern - Summer 2027"), which skipped the text comparison;
//   - official text similarity >= threshold (word 3-gram Jaccard over the latest snapshots of both);
//   - season/year tokens compatible (equal, or absent on one side);
//   - location sets overlapping when both are known;
//   - never when both carry authoritative requisition ids of the same ATS tenant that differ.
export const DUPLICATE_TEXT_THRESHOLD = 0.9;
const SUBMISSION_EVENTS = ['submitted', 'application_submitted'];

const tokens = (text) => String(text ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
function shingles(text, size = 3) {
  const list = tokens(text);
  const result = new Set();
  if (list.length < size) { if (list.length) result.add(list.join(' ')); return result; }
  for (let i = 0; i + size <= list.length; i += 1) result.add(list.slice(i, i + size).join(' '));
  return result;
}
export function textSimilarity(left, right) {
  const a = shingles(left); const b = shingles(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const SEASON = /\b(spring|summer|fall|autumn|winter)\s*[-/]?\s*(20\d\d)\b/gi;
export function seasonTokens(...texts) {
  const result = new Set();
  for (const text of texts) for (const match of String(text ?? '').matchAll(SEASON)) result.add(`${match[1].toLowerCase().replace('autumn', 'fall')} ${match[2]}`);
  return result;
}
const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));
export const seasonsCompatible = (a, b) => !a.size || !b.size || sameSet(a, b);

const place = (value) => String(value ?? '').split(',')[0].normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function locationsOverlap(left, right) {
  const a = new Set(left.map(place).filter(Boolean)); const b = new Set(right.map(place).filter(Boolean));
  if (!a.size || !b.size) return true;
  return [...a].some((item) => b.has(item));
}

// Authoritative ATS requisition aliases ('req:<provider>:<tenant>:<id>') grouped by tenant scope.
function reqScopes(aliases) {
  const scopes = new Map();
  for (const { alias, kind } of aliases) {
    if (kind !== 'req') continue;
    const scope = alias.slice(0, alias.lastIndexOf(':'));
    if (!scopes.has(scope)) scopes.set(scope, new Set());
    scopes.get(scope).add(alias.slice(alias.lastIndexOf(':') + 1));
  }
  return scopes;
}
export function differentRequisitions(leftAliases, rightAliases) {
  const right = reqScopes(rightAliases);
  return [...reqScopes(leftAliases)].some(([scope, ids]) => right.has(scope) && ![...ids].some((id) => right.get(scope).has(id)));
}

const latestText = (db, postingId) => db.prepare(`SELECT text FROM snapshots WHERE posting_id=? AND identity_ok=1 AND text IS NOT NULL AND text<>''
  ORDER BY fetched_at DESC,rowid DESC LIMIT 1`).get(postingId)?.text ?? null;
// The official title of the latest identity-checked snapshot (fields_json.title), or null.
function officialTitle(db, postingId) {
  const row = db.prepare(`SELECT fields_json FROM snapshots WHERE posting_id=? AND identity_ok=1 ORDER BY fetched_at DESC,rowid DESC LIMIT 1`).get(postingId);
  try { const title = JSON.parse(row?.fields_json ?? '{}')?.title; return typeof title === 'string' && title.trim() ? title.trim() : null; } catch { return null; }
}
const aliasesOf = (db, postingId) => db.prepare('SELECT alias,kind FROM posting_aliases WHERE posting_id=?').all(postingId);
function locationsOf(db, postingId, fallback = []) {
  const row = db.prepare('SELECT fields_json FROM observations WHERE posting_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1').get(postingId);
  let list = [];
  try { list = JSON.parse(row?.fields_json ?? '{}').locations ?? []; } catch { list = []; }
  list = list.map((item) => (typeof item === 'string' ? item : item?.location ?? item?.name ?? '')).filter(Boolean);
  return list.length ? list : fallback;
}

function submittedApplications(db) {
  const evidence = new Set(db.prepare(`SELECT DISTINCT application_id FROM application_events WHERE event_type IN (${SUBMISSION_EVENTS.map(() => '?').join(',')})`)
    .all(...SUBMISSION_EVENTS).map((row) => row.application_id));
  return db.prepare('SELECT * FROM applications').all()
    .filter((app) => app.applied_at || SUBMITTED_STATUSES.includes(app.status) || evidence.has(app.id));
}

// posting: the postings row being delivered. options.text / options.locations override the stored ones
// (the snapshot just judged, the verdict's offices). Returns { applicationId, postingId, match, similarity } or null.
export function duplicateOfSubmitted(db, posting, { companyAliases, text, locations, threshold = DUPLICATE_TEXT_THRESHOLD, candidates } = {}) {
  const company = companyKey(posting.company, companyAliases);
  if (!company) return null;
  const ownText = text ?? latestText(db, posting.id);
  if (!ownText) return null;
  const ownAliases = aliasesOf(db, posting.id);
  const ownLocations = locationsOf(db, posting.id, locations ?? []);
  const ownSeasons = seasonTokens(posting.title, ownText);
  const ownTitle = (posting.id ? officialTitle(db, posting.id) : null) ?? posting.title;
  for (const app of candidates ?? submittedApplications(db)) {
    if (app.id === posting.application_id || companyKey(app.company, companyAliases) !== company) continue;
    for (const other of db.prepare('SELECT * FROM postings WHERE application_id=? AND merged_into IS NULL AND id<>?').all(app.id, posting.id)) {
      if (titleSimilarity(officialTitle(db, other.id) ?? app.role, ownTitle) < 1) continue;
      const otherText = latestText(db, other.id);
      if (!otherText) continue;
      if (differentRequisitions(ownAliases, aliasesOf(db, other.id))) continue;
      if (!seasonsCompatible(ownSeasons, seasonTokens(other.title, otherText))) continue;
      const appLocations = String(app.location ?? '').split(/\s*;\s*/).filter(Boolean);
      if (!locationsOverlap(ownLocations, locationsOf(db, other.id, appLocations))) continue;
      const similarity = textSimilarity(ownText, otherText);
      if (similarity >= threshold) return { applicationId: app.id, postingId: other.id, match: 'cross_ats_text', similarity: Math.round(similarity * 1000) / 1000 };
    }
  }
  return null;
}
export { submittedApplications };

// Plan 2026-11-10 (v4): the one-time `queue rescreen --only dedup --apply` withdraws a visible lead that is a confirmed
// duplicate (already_submitted by job id / canonical URL, or duplicate_submitted by the body rule) without delivery:
// delivery always runs the company exclusion first, which would rewrite the reason and skip the body check. Nothing
// but the dedup verdict is applied here: no exclusion, size, limit or direction gate. The withdrawal is review-owned,
// automated and fenced like a delivery: the review lease is claimed, checked and cleared inside one transaction.
// violation: { code: 'already_submitted' | 'duplicate_submitted', applicationIds: [submitted id], detail? }.
export const DEDUP_CODES = Object.freeze(['already_submitted', 'duplicate_submitted']);
export function withdrawDuplicateLead(db, { applicationId, postingId = null, violation, now, owner = 'queue-rescreen-dedup' }) {
  if (!DEDUP_CODES.includes(violation?.code)) throw new Error(`Not a dedup verdict: ${violation?.code}`);
  const code = violation.code;
  const evidence = (violation.applicationIds ?? []).map((id) => ({ applicationId: id, match: violation.detail ?? null }));
  if (db.prepare('SELECT status FROM applications WHERE id=?').get(applicationId)?.status !== 'lead') return { action: 'not_a_lead' };
  const hasReview = postingId && db.prepare('SELECT 1 FROM reviews WHERE posting_id=?').get(postingId);
  const fence = hasReview ? claimItem(db, postingId, { owner, now }) : null;
  if (hasReview && !fence) return { action: 'busy' };
  return atomic(db, () => {
    const app = db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
    if (!app || app.status !== 'lead') throw new Error(`Application ${applicationId} is not a lead`);
    if (fence) {
      assertFence(db, postingId, fence);
      const review = db.prepare('SELECT evidence_json FROM reviews WHERE posting_id=?').get(postingId);
      let old = {};
      try { old = JSON.parse(review?.evidence_json || '{}') ?? {}; } catch { old = {}; }
      const kept = { ...old, evidence, gate: { code, judged: false, provenance: old.gate ? old.gate.provenance ?? null : old.provenance ?? null, duplicateOf: evidence[0] ?? null },
        provenance: 'automated' };
      const changed = db.prepare(`UPDATE reviews SET state='done',decision='not_eligible',code=?,stage='deliver',evidence_json=?,hold_owner=NULL,hold_since=NULL,next_due=NULL,
        lease_owner=NULL,lease_until=NULL,updated_at=? WHERE posting_id=? AND lease_owner=? AND lease_generation=?`)
        .run(code, JSON.stringify(kept), now, postingId, fence.owner, fence.generation).changes;
      if (changed !== 1) throw new Error('Dedup withdrawal readback mismatch');
      db.prepare("INSERT INTO review_log(posting_id,at,stage,kind,payload_json) VALUES (?,?,'deliver','outcome',?)")
        .run(postingId, now, redact(JSON.stringify({ action: 'rescreen_dedup_withdrawn', applicationId, code, evidence })));
    }
    recordEvent(db, { id: randomUUID(), applicationId, type: 'review_withdrawn', observedAt: now, recordedAt: now, title: 'review_withdrawn', note: code,
      source: { actor: 'review-worker', kind: 'queue-rescreen-dedup', code, ...(postingId ? { postingId } : {}), evidence, automatedProvenance: true }, statusAfter: 'withdrawn' }, { withinTransaction: true });
    db.prepare("UPDATE applications SET skip_reason=?,skip_owner='review',updated_at=? WHERE id=?").run(code, now, applicationId);
    const back = db.prepare('SELECT status,skip_reason FROM applications WHERE id=?').get(applicationId);
    if (back.status !== 'withdrawn' || back.skip_reason !== code) throw new Error('Dedup withdrawal readback mismatch');
    return { action: 'withdrawn' };
  });
}
