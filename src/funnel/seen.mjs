// Seen listings and list baselines (plan 2026-11-14 v2, incremental nightly; tables in migration 010).
//
// Every scan records the listing key (src/scan/listing-key.mjs) of each row it processes. A list (source +
// partition) gets a baseline when a scan finishes with that list read (ok, empty or partial) and its rows recorded.
// From the next scan on, if incremental scanning is enabled, a row whose key that list already recorded is skipped
// before classification. A scan that dies partway records the ids it wrote but no baseline, so a list never
// starts skipping on the strength of an unfinished run.
const keyOf = (source, partition) => `${source}\0${partition}`;
const BASELINE_STATUSES = new Set(['ok', 'empty', 'partial']);

// config.json `scan.incremental.enabled` (default true: a fresh home starts baseline-pending, see above).
export function incrementalSettings(config = {}) {
  const settings = config?.scan?.incremental ?? {};
  if (settings.enabled != null && typeof settings.enabled !== 'boolean') throw new Error('config scan.incremental.enabled must be true or false');
  return { enabled: settings.enabled !== false };
}

export function baselinedLists(db) {
  return new Set(db.prepare('SELECT source,partition FROM seen_baselines').all().map((row) => keyOf(row.source, row.partition)));
}

export const listKey = keyOf;

// { partition: Set(listing ids) } for the baselined lists of one source, or null when there are none.
export function knownListingsOf(db, source, baselines) {
  const partitions = [...baselines].filter((key) => key.startsWith(`${source}\0`)).map((key) => key.slice(source.length + 1));
  if (!partitions.length) return null;
  const read = db.prepare('SELECT listing_id FROM seen_ids WHERE source=? AND partition=?');
  return Object.fromEntries(partitions.map((partition) => [partition, new Set(read.all(source, partition).map((row) => row.listing_id))]));
}

// Called inside the scan's final transaction. `sources` are the assessed source rows; `ingested` the keys of the
// lists whose batches this run wrote. A list read with no rows needs no batch.
export function recordBaselines(db, { runId, now, sources, ingested }) {
  const write = db.prepare(`INSERT INTO seen_baselines (source,partition,run_id,completed_at) VALUES (?,?,?,?)
    ON CONFLICT(source,partition) DO UPDATE SET run_id=excluded.run_id,completed_at=excluded.completed_at`);
  let recorded = 0;
  for (const item of sources) {
    if (!item.partition || item.partition === 'all' || !BASELINE_STATUSES.has(item.status)) continue;
    if (!ingested.has(keyOf(item.source, item.partition)) && Number(item.rawCount ?? item.count ?? 0) > 0) continue;
    write.run(item.source, item.partition, runId, now);
    recorded += 1;
  }
  return recorded;
}

// The listing urls a list has recorded, for a browser read that wants to skip opening known postings.
export function knownListingUrls(db, { source, partition }) {
  return db.prepare('SELECT listing_id,url FROM seen_ids WHERE source=? AND partition=? ORDER BY listing_id').all(source, partition).map((row) => ({ id: row.listing_id, url: row.url }));
}
