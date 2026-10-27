import { createHash, randomUUID } from 'node:crypto';
import { canonicalUrl, resolvePosting, postingCandidates } from './identity.mjs';
import { classifyRole } from './classify.mjs';
import { SUBMITTED_STATUSES } from './contract.mjs';
import { redact } from '../runtime/redact.mjs';
import { assertScanOwner } from './scan-lease.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;

function quarantine(db, record, reason, now) {
  const payload = redact(JSON.stringify({ reason, record }));
  const id = `quarantine:${hash(payload)}`;
  db.prepare(`INSERT OR IGNORE INTO postings (id,company,title,first_seen,last_seen,listed,created_at,updated_at)
    VALUES (?,'','Quarantined record',?,?,0,?,?)`).run(id, now, now, now, now);
  if (!db.prepare("SELECT 1 FROM review_log WHERE posting_id=? AND kind='error' AND payload_json=?").get(id, payload)) {
    db.prepare("INSERT INTO review_log (posting_id,at,stage,kind,payload_json) VALUES (?,?,'scan','error',?)").run(id, now, payload);
  }
}

export function ingestBatch(db, { runId, source, partition, records, now, policy = {}, profile, runOwner }) {
  const counts = { observed: 0, newPostings: 0, reused: 0, dropped: {}, review: 0, quarantined: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (runOwner) assertScanOwner(db, runId, runOwner);
    // Read once per batch and keep newly created/merged identities in the map.
    const candidates = postingCandidates(db, { companyAliases: policy.companyAliases });
    for (const raw of records) {
      counts.observed += 1;
      const record = { ...raw, source: raw?.source ?? source, partition };
      const invalid = record.invalid || (!record.title?.trim() ? 'missing title' : !canonicalUrl(record.url) ? 'missing http(s) URL' : null);
      if (invalid) { quarantine(db, record, invalid, now); counts.quarantined += 1; continue; }
      const classification = classifyRole(record, { policy, profile });
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
      db.prepare(`INSERT OR IGNORE INTO observation_sightings (run_id,posting_id,observation_id,source,partition,seen_at) VALUES (?,?,?,?,?,?)`)
        .run(runId, id, observation.id, record.source, partition, now);
      const result = classifyRole(record, { policy, profile, identity: {
        submitted: application && (SUBMITTED_STATUSES.includes(application.status) || Boolean(application.applied_at)),
        userDeclined: application?.status === 'withdrawn' && application.skip_owner === 'user',
      } });
      if (result.kind === 'reuse') counts.reused += 1;
      else if (result.kind === 'drop') counts.dropped[result.code] = (counts.dropped[result.code] ?? 0) + 1;
      else counts.review += 1;
      for (const linked of resolved.links) result.flags.push(`maybe_same:${linked.postingId}`);
      const old = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(id);
      const reappeared = Date.parse(now) - Date.parse(posting.last_seen) >= (policy.freshness?.reappearAfterDays ?? 14) * 86_400_000;
      const protectedApp = application && (application.status === 'prepared' || application.skip_owner === 'user');
      const renew = old && old.state !== 'leased' && old.hold_owner !== 'user' && !protectedApp
        && (changed || (!posting.listed && record.listed !== false) || reappeared);
      // Keep unlisted observations in conservation, without creating work for a
      // posting that has never had a review. A later listing can open it normally.
      const canOpen = record.listed !== false || result.kind !== 'review';
      if ((!old && canOpen) || (old && old.code !== 'identity_conflict' && (result.kind === 'reuse' || renew))) {
        const state = result.kind === 'review' ? 'due' : 'done';
        const decision = result.kind === 'review' ? null : result.kind === 'reuse' ? 'reused' : 'dropped';
        db.prepare(`INSERT INTO reviews (posting_id,stage,state,decision,code,lane,flags_json,next_due,first_seen,updated_at)
          VALUES (?,'fetch',?,?,?,?,?,?,?,?) ON CONFLICT(posting_id) DO UPDATE SET stage='fetch',state=excluded.state,
          decision=excluded.decision,code=excluded.code,lane=excluded.lane,flags_json=excluded.flags_json,next_due=excluded.next_due,
          lease_owner=NULL,lease_until=NULL,hold_owner=NULL,hold_since=NULL,updated_at=excluded.updated_at`)
          .run(id, state, decision, result.code, result.lane, JSON.stringify(result.flags), state === 'due' ? now : null, posting.first_seen, now);
      }
      db.prepare('UPDATE postings SET last_seen=?,listed=?,updated_at=? WHERE id=?').run(now, record.listed === false ? 0 : 1, now, id);
    }
    db.exec('COMMIT');
    return counts;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
