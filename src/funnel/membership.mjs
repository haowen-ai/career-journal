import { createHash } from 'node:crypto';

// Membership is durable even after individual sightings and source runs expire.
export function preservePartitions(db) {
  db.exec(`INSERT INTO posting_partitions(posting_id,source,partition,last_seen)
    SELECT posting_id,source,partition,MAX(seen_at) FROM observation_sightings
    GROUP BY posting_id,source,partition
    ON CONFLICT(posting_id,source,partition) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen)`);
}

export function postingPartitions(db, postingId) {
  return db.prepare(`WITH RECURSIVE members(id) AS (SELECT ? UNION SELECT p.id FROM postings p JOIN members m ON p.merged_into=m.id)
    SELECT source,partition,MAX(last_seen) lastSeen FROM posting_partitions
    WHERE posting_id IN (SELECT id FROM members) GROUP BY source,partition`).all(postingId);
}

const sightingKey = (source, partition) => `${source}\0${partition}`;

// The latest sighting of each source and partition, per raw posting id. Observations are
// deduplicated by content, so only sightings say what a source shows now. The table has no
// posting index: one unordered pass serves a whole batch.
export function latestSightings(db) {
  const latest = new Map();
  let maxRowid = 0;
  for (const row of db.prepare('SELECT rowid,posting_id,source,partition,observation_id,seen_at FROM observation_sightings').iterate()) {
    if (row.rowid > maxRowid) maxRowid = row.rowid;
    let keys = latest.get(row.posting_id);
    if (!keys) latest.set(row.posting_id, keys = new Map());
    const key = sightingKey(row.source, row.partition);
    const seen = keys.get(key);
    if (!seen || row.seen_at > seen.seenAt || (row.seen_at === seen.seenAt && row.rowid > seen.rowid)) {
      keys.set(key, { observationId: row.observation_id, seenAt: row.seen_at, rowid: row.rowid });
    }
  }
  return { latest, maxRowid };
}

// A posting's current source records, merge members included at any depth: each source and
// partition's latest sighting. A partition whose sightings retention removed has no current record;
// with fallback, every kept observation of that source stands in for it. Those are history, so a
// caller uses them only to keep a row that is already due, never to reopen one.
export function currentRecordReader(db) {
  const membersOf = db.prepare(`WITH RECURSIVE members(id) AS (SELECT ? UNION SELECT p.id FROM postings p JOIN members m ON p.merged_into=m.id)
    SELECT id FROM members ORDER BY id`);
  const partitionsOf = db.prepare('SELECT source,partition FROM posting_partitions WHERE posting_id=?');
  const observation = db.prepare('SELECT id,fields_json,completeness_json,listed,content_hash FROM observations WHERE id=?');
  const bySource = db.prepare('SELECT id,fields_json,completeness_json,listed,content_hash FROM observations WHERE posting_id=? AND source=?');
  return {
    members: (postingId) => membersOf.all(postingId).map((row) => row.id),
    // skip: the [postingId, source, partition] being ingested now, which is read from the record itself.
    records(members, latest, { skip, fallback = false } = {}) {
      const records = [];
      for (const member of members) {
        const own = skip && member === skip[0] ? sightingKey(skip[1], skip[2]) : null;
        const keys = latest.get(member) ?? new Map();
        for (const [key, sighting] of keys) {
          if (key === own) continue;
          const row = observation.get(sighting.observationId);
          if (row) records.push(row);
        }
        for (const { source, partition } of partitionsOf.all(member)) {
          const key = sightingKey(source, partition);
          if (fallback && key !== own && !keys.has(key)) records.push(...bySource.all(member, source));
        }
      }
      return records;
    },
    hasOther: (members, [postingId, source, partition]) => members.some((member) => partitionsOf.all(member)
      .some((row) => member !== postingId || row.source !== source || row.partition !== partition)),
  };
}

// The evidence a system drop was decided on: the content of every current source record of the posting (merge members
// included, latest actual sighting per source and partition) and their location list. Rules and config are not part of
// it, so a rule edit never changes it. Null when the posting has no current record.
export function postingEvidenceHash(db, postingId, { latest, reader = currentRecordReader(db) } = {}) {
  latest ??= latestSightings(db).latest;
  const records = reader.records(reader.members(postingId), latest);
  if (!records.length) return null;
  const contents = new Set(); const locations = new Set();
  for (const row of records) {
    contents.add(row.content_hash);
    let fields = {};
    try { fields = JSON.parse(row.fields_json); } catch { /* unreadable fields carry no locations */ }
    for (const location of Array.isArray(fields?.locations) ? fields.locations : []) {
      locations.add(typeof location === 'string' ? location.trim() : JSON.stringify(location));
    }
  }
  return createHash('sha256').update(JSON.stringify({ contents: [...contents].sort(), locations: [...locations].sort() })).digest('hex');
}

// Decide once per evidence state: a settled system drop keeps the evidence hash it was decided on in
// reviews.dep_hashes_json.settledEvidenceHash (durable; review_log is pruned). A later settlement overwrites it.
export const SETTLED_EVIDENCE_KEY = 'settledEvidenceHash';
export function settledEvidenceHash(review) {
  try {
    const value = JSON.parse(review?.dep_hashes_json ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value[SETTLED_EVIDENCE_KEY] === 'string' ? value[SETTLED_EVIDENCE_KEY] : null;
  } catch { return null; }
}
export function storeSettledEvidence(db, postingId, hash) {
  if (!hash) return;
  db.prepare(`UPDATE reviews SET dep_hashes_json=json_set(CASE WHEN json_valid(dep_hashes_json) AND json_type(dep_hashes_json)='object'
    THEN dep_hashes_json ELSE '{}' END,'$.${SETTLED_EVIDENCE_KEY}',?) WHERE posting_id=?`).run(hash, postingId);
}
