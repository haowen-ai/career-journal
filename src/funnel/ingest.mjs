import { createHash, randomUUID } from 'node:crypto';
import { aliasesFor, canonicalUrl, resolvePosting, postingCandidates, submittedApplicationIndex, submittedDuplicate } from './identity.mjs';
import { classifyRole, CERTAIN_DROP_CODES } from './classify.mjs';
import { SIGNAL_DROP_CODES, SUBMITTED_STATUSES } from './contract.mjs';
import { redact } from '../runtime/redact.mjs';
import { assertScanOwner } from './scan-lease.mjs';
import { currentRecordReader, latestSightings } from './membership.mjs';
import { userDecided, userLoggedPostings } from '../review/ownership.mjs';
import { autoReopenAllowed } from '../review/reopen-policy.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;

// Drops that one record decides with certainty. The classifier may mark any outcome itself
// (`certainDrop: true|false`); these codes are the default when it does not.
// The classifier owns the list (company_small included: a company known to be small is a certain drop).
export const DEFAULT_CERTAIN_DROP_CODES = CERTAIN_DROP_CODES;
// Settlements that only say the posting left the board. A later listing is a relist.
const DELIST_CODES = new Set(['delisted', 'closed_verified']);

function quarantine(db, record, reason, now) {
  const payload = redact(JSON.stringify({ reason, record }));
  const id = `quarantine:${hash(payload)}`;
  db.prepare(`INSERT OR IGNORE INTO postings (id,company,title,first_seen,last_seen,listed,created_at,updated_at)
    VALUES (?,'','Quarantined record',?,?,0,?,?)`).run(id, now, now, now, now);
  if (!db.prepare("SELECT 1 FROM review_log WHERE posting_id=? AND kind='error' AND payload_json=?").get(id, payload)) {
    db.prepare("INSERT INTO review_log (posting_id,at,stage,kind,payload_json) VALUES (?,?,'scan','error',?)").run(id, now, payload);
  }
}

// The first review-worthy current record of the same posting (merge members included) from another
// source or partition, if any. Older observations do not count: the source has since changed them.
function reviewElsewhere(db, postingId, record, options, reader, cache, { fallback }) {
  const members = reader.members(postingId);
  const self = [postingId, record.source, record.partition];
  if (!reader.hasOther(members, self)) return null;
  cache.latest ??= latestSightings(db).latest;
  for (const row of reader.records(members, cache.latest, { skip: self, fallback })) {
    const other = classifyRole(JSON.parse(row.fields_json), options);
    if (other.kind === 'review') return other;
  }
  return null;
}

// Indexes an ingest needs, read once per scan run and kept current by every batch of that run.
// Batches of one run see each other's postings; another writer's change between batches can
// at most delay a maybe_same link or a same-program submission match to the next run.
export function createIngestContext(db, { policy = {} } = {}) {
  const companyAliases = policy.companyAliases;
  return {
    companyAliases,
    candidates: postingCandidates(db, { companyAliases }),
    submitted: submittedApplicationIndex(db, { companyAliases }),
    userLogged: userLoggedPostings(db),
    latest: null, // built on first need, then maintained per sighting
  };
}

function effectiveId(db, id) {
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const row = db.prepare('SELECT id,merged_into FROM postings WHERE id=?').get(id);
    if (!row) return null;
    if (!row.merged_into) return row.id;
    id = row.merged_into;
  }
  return null;
}

const isCertainDrop = (classification) => classification.kind === 'drop'
  && (classification.certainDrop ?? DEFAULT_CERTAIN_DROP_CODES.includes(classification.code));

// Read-only preflight: may this record be counted without writing a row? Only when it is a
// certain drop (or an unlisted Simplify listing) and either nothing is known about it, or it
// is a posting already settled as the same drop that no application or user decision touches.
// Everything else, including any alias owned by another posting or an unowned new alias for a
// known posting, takes the full path. With every alias owned by one posting, no identity
// conflict can arise. Returns null (full path) or { known: postingId | null }.
function countOnly(db, record, classification, context) {
  const unlistedListing = record.source === 'simplify' && record.listed === false;
  const certain = isCertainDrop(classification);
  if (!certain && !unlistedListing) return null;
  const owners = new Set();
  let unowned = 0;
  for (const { alias } of aliasesFor(record, { companyAliases: context.companyAliases })) {
    const hit = db.prepare('SELECT posting_id FROM posting_aliases WHERE alias=?').get(alias);
    if (!hit) { unowned += 1; continue; }
    owners.add(effectiveId(db, hit.posting_id) ?? hit.posting_id);
  }
  if (submittedDuplicate(db, record, { companyAliases: context.companyAliases, index: context.submitted })) return null;
  if (!owners.size) return { known: null };
  if (owners.size > 1 || unowned || !certain) return null;
  const [id] = owners;
  const posting = db.prepare('SELECT id,application_id FROM postings WHERE id=?').get(id);
  const review = db.prepare('SELECT state,decision,code,hold_owner,flags_json FROM reviews WHERE posting_id=?').get(id);
  if (!posting || posting.application_id || !review) return null;
  if (review.state !== 'done' || review.decision !== 'dropped' || review.code !== classification.code || review.hold_owner) return null;
  if (JSON.parse(review.flags_json ?? '[]').includes('manual')) return null;
  if (context.userLogged.has(id)) return null;
  return { known: id };
}

export function ingestBatch(db, { runId, source, partition, records, now, policy = {}, profile, runOwner, context }) {
  const startedAt = performance.now();
  const counts = { observed: 0, stored: 0, countedOnly: 0, countedOnlyBy: {}, newPostings: 0, reused: 0, dropped: {}, review: 0, quarantined: 0, elapsedMs: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (runOwner) assertScanOwner(db, runId, runOwner);
    // Built once per scan run when the caller passes a context; one batch otherwise.
    context ??= createIngestContext(db, { policy });
    const { candidates, submitted, userLogged } = context;
    const reader = currentRecordReader(db);
    const touchPartition = db.prepare(`INSERT INTO posting_partitions(posting_id,source,partition,last_seen) VALUES (?,?,?,?)
      ON CONFLICT(posting_id,source,partition) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen)`);
    for (const raw of records) {
      counts.observed += 1;
      const record = { ...raw, source: raw?.source ?? source, partition };
      const invalid = record.invalid || (!record.title?.trim() ? 'missing title' : !canonicalUrl(record.url) ? 'missing http(s) URL' : null);
      if (invalid) { quarantine(db, record, invalid, now); counts.quarantined += 1; continue; }
      const classification = classifyRole(record, { policy, profile });
      const counted = countOnly(db, record, classification, context);
      if (counted) {
        counts.countedOnly += 1;
        const key = classification.kind === 'drop' ? classification.code : 'unlisted';
        counts.countedOnlyBy[key] = (counts.countedOnlyBy[key] ?? 0) + 1;
        if (classification.kind === 'drop') counts.dropped[classification.code] = (counts.dropped[classification.code] ?? 0) + 1;
        if (counted.known) {
          // Census membership stays current without an observation or sighting row.
          touchPartition.run(counted.known, record.source, partition, now);
          db.prepare('UPDATE postings SET last_seen=?,listed=?,updated_at=? WHERE id=?').run(now, record.listed === false ? 0 : 1, now, counted.known);
        }
        continue;
      }
      counts.stored += 1;
      const resolved = resolvePosting(db, record, { now, companyAliases: policy.companyAliases, candidates, classification });
      const id = resolved.postingId;
      if (resolved.created) counts.newPostings += 1;
      const posting = db.prepare('SELECT * FROM postings WHERE id=?').get(id);
      const application = posting.application_id ? db.prepare('SELECT * FROM applications WHERE id=?').get(posting.application_id) : null;
      const fields = JSON.stringify(stable(record));
      // A partition is census membership, not a content change for a shared listing.
      const { partition: ignored, ...content } = record;
      const contentHash = hash(JSON.stringify(stable(content)));
      const previous = db.prepare('SELECT * FROM observations WHERE posting_id=? AND source=? ORDER BY observed_at DESC,rowid DESC LIMIT 1').get(id, record.source);
      const changed = previous && previous.content_hash !== contentHash;
      db.prepare(`INSERT OR IGNORE INTO observations (id,posting_id,source,source_id,partition,first_run_id,observed_at,fields_json,completeness_json,listed,content_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), id, record.source, record.sourceId ?? null, partition, runId, now, fields, JSON.stringify(record.completeness ?? {}), record.listed === false ? 0 : 1, contentHash);
      const observation = db.prepare('SELECT id FROM observations WHERE posting_id=? AND source=? AND content_hash=?').get(id, record.source, contentHash);
      const sighting = db.prepare(`INSERT OR IGNORE INTO observation_sightings (run_id,posting_id,observation_id,source,partition,seen_at) VALUES (?,?,?,?,?,?)`)
        .run(runId, id, observation.id, record.source, partition, now);
      if (sighting.changes && context.latest) {
        let keys = context.latest.get(id);
        if (!keys) context.latest.set(id, keys = new Map());
        keys.set(`${record.source}\0${partition}`, { observationId: observation.id, seenAt: now, rowid: Number(sighting.lastInsertRowid) });
      }
      const old = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(id);
      let result = classifyRole(record, { policy, profile, identity: {
        submitted: submittedDuplicate(db, record, { companyAliases: policy.companyAliases, index: submitted })
          ?? (application && (SUBMITTED_STATUSES.includes(application.status) || Boolean(application.applied_at))),
        userDeclined: application?.status === 'withdrawn' && application.skip_owner === 'user',
      } });
      // A signal drop judges one record. It never closes a posting another source calls a
      // student role, one the user added by hand, or one with a linked application.
      if (SIGNAL_DROP_CODES.includes(result.code)) {
        const other = reviewElsewhere(db, id, record, { policy, profile }, reader, context, { fallback: old?.state === 'due' });
        if (other || posting.application_id || JSON.parse(old?.flags_json ?? '[]').includes('manual')) {
          result = { ...result, kind: 'review', code: null, lane: other?.lane ?? result.lane };
        }
      }
      if (result.kind === 'reuse') counts.reused += 1;
      else if (result.kind === 'drop') counts.dropped[result.code] = (counts.dropped[result.code] ?? 0) + 1;
      else counts.review += 1;
      for (const linked of resolved.links) result.flags.push(`maybe_same:${linked.postingId}`);
      const reappeared = Date.parse(now) - Date.parse(posting.last_seen) >= (policy.freshness?.reappearAfterDays ?? 14) * 86_400_000;
      // Every sighting reclassifies for free, so a drop reopens as soon as its record classifies
      // for review (a re-allowed company, a new source's signal). A partial location list cannot
      // overrule outside_countries: it may just omit the offices that decided it. A classifier
      // drop was never judged, so this is first work, not a re-judgment.
      const reopened = old?.state === 'done' && old.decision === 'dropped' && result.kind === 'review' && record.listed !== false
        && (old.code !== 'outside_countries' || record.completeness?.locations === 'complete');
      const stillDelisted = old?.code === 'delisted' && record.listed === false;
      // Decide once: a content change, relisting or reappearance resets only open work. A
      // posting settled only because it left the board is authorized to reopen when it is back.
      const relist = Boolean(old && DELIST_CODES.has(old.code) && record.listed !== false && (!posting.listed || reappeared));
      const resetAllowed = autoReopenAllowed({ review: old, application, authorization: relist ? 'relist' : null });
      const renew = old && old.state !== 'leased' && old.hold_owner !== 'user' && !stillDelisted
        && (reopened || (resetAllowed && (changed || (!posting.listed && record.listed !== false) || reappeared)))
        && !userDecided(db, { ...old, application_id: posting.application_id }, { userLogged });
      if (renew && relist && !reopened) result.flags.push('authorization:relist');
      // Keep unlisted observations in conservation, without creating work for a
      // posting that has never had a review. A later listing can open it normally.
      const canOpen = record.listed !== false || result.kind !== 'review';
      if ((!old && canOpen) || result.code === 'already_submitted' || (old && old.code !== 'identity_conflict' && (result.kind === 'reuse' || renew))) {
        const state = result.kind === 'review' ? 'due' : 'done';
        const decision = result.kind === 'review' ? null : result.kind === 'reuse' ? 'reused' : 'dropped';
        db.prepare(`INSERT INTO reviews (posting_id,stage,state,decision,code,lane,flags_json,evidence_json,next_due,first_seen,updated_at)
          VALUES (?,'fetch',?,?,?,?,?,?,?,?,?) ON CONFLICT(posting_id) DO UPDATE SET stage='fetch',state=excluded.state,
          decision=excluded.decision,code=excluded.code,lane=excluded.lane,flags_json=excluded.flags_json,next_due=excluded.next_due,
          evidence_json=CASE WHEN excluded.code='already_submitted' THEN excluded.evidence_json ELSE reviews.evidence_json END,
          lease_owner=NULL,lease_until=NULL,hold_owner=NULL,hold_since=NULL,updated_at=excluded.updated_at`)
          .run(id, state, decision, result.code, result.lane, JSON.stringify(result.flags), JSON.stringify(result.evidence), state === 'due' ? now : null, posting.first_seen, now);
        if (renew && relist && !reopened) {
          db.prepare("INSERT INTO review_log (posting_id,at,stage,kind,payload_json) VALUES (?,?,'scan','outcome',?)")
            .run(id, now, JSON.stringify({ action: 'relisted', authorization: 'relist', previousCode: old.code }));
        }
      }
      db.prepare('UPDATE postings SET last_seen=?,listed=?,updated_at=? WHERE id=?').run(now, record.listed === false ? 0 : 1, now, id);
    }
    db.exec('COMMIT');
    counts.elapsedMs = Math.round(performance.now() - startedAt);
    return counts;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
