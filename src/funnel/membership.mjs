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
