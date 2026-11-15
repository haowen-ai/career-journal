// Seen listings and list baselines (plan 2026-11-14 v2, incremental nightly; tables in migration 010).
//
// Every scan records the listing key (src/scan/listing-key.mjs) of each row it processes. A list (source +
// partition) gets a baseline when a scan finishes with that list read (ok, empty or partial) and its rows recorded.
// From the next scan on, if incremental scanning is enabled, a row whose key that list already recorded is skipped
// before classification. A scan that dies partway records the ids it wrote but no baseline, so a list never
// starts skipping on the strength of an unfinished run.
const keyOf = (source, partition) => `${source}\0${partition}`;
const BASELINE_STATUSES = new Set(['ok', 'empty', 'partial']);

import { DEFAULT_INCREMENTAL } from '../config/defaults.mjs';

// config.json `scan.incremental` (defaults: DEFAULT_INCREMENTAL; enabled, so a fresh home starts baseline-pending).
export function incrementalSettings(config = {}) {
  const settings = config?.scan?.incremental ?? {};
  if (settings.enabled != null && typeof settings.enabled !== 'boolean') throw new Error('config scan.incremental.enabled must be true or false');
  const early = settings.earlyStop ?? {};
  const providers = early.providers ?? DEFAULT_INCREMENTAL.earlyStop.providers;
  const marginHours = early.marginHours ?? DEFAULT_INCREMENTAL.earlyStop.marginHours;
  if (!Array.isArray(providers) || !providers.every((id) => typeof id === 'string')) throw new Error('config scan.incremental.earlyStop.providers must be a list of provider ids');
  if (!(Number.isFinite(marginHours) && marginHours >= 0)) throw new Error('config scan.incremental.earlyStop.marginHours must be a number of hours >= 0');
  return { enabled: settings.enabled !== false, earlyStop: { providers: [...providers], marginHours } };
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

// Watermarks (plan v3.1 step 8'): { partition: ISO } of one source's baselined lists, or null when there are none.
export function watermarksOf(db, source, baselines) {
  const rows = db.prepare('SELECT partition,completed_at FROM list_watermarks WHERE source=?').all(source)
    .filter((row) => baselines.has(keyOf(source, row.partition)));
  return rows.length ? Object.fromEntries(rows.map((row) => [row.partition, row.completed_at])) : null;
}

const WATERMARK_COLLECTIONS = new Set(['complete', 'early_stopped']);
// Inside the scan's final transaction, after every batch of the run was committed with its seen ids: a list whose
// provider reported complete or early_stopped for every search stream (and that is neither failed nor truncated)
// moves its watermark to the run's start. page_failed, ceiling, an error or a missing status keep the old one.
export function advanceWatermarks(db, { runId, startedAt, sources, ingested }) {
  const write = db.prepare(`INSERT INTO list_watermarks (source,partition,completed_at,run_id) VALUES (?,?,?,?)
    ON CONFLICT(source,partition) DO UPDATE SET completed_at=excluded.completed_at,run_id=excluded.run_id`);
  let advanced = 0;
  for (const item of sources) {
    if (!WATERMARK_COLLECTIONS.has(item.collection) || item.truncated || item.capDetected || !['ok', 'empty'].includes(item.status)) continue;
    if (!ingested.has(keyOf(item.source, item.partition)) && Number(item.rawCount ?? item.count ?? 0) > 0) continue;
    write.run(item.source, item.partition, startedAt, runId);
    advanced += 1;
  }
  return advanced;
}

// The listing urls a list has recorded, for a browser read that wants to skip opening known postings.
export function knownListingUrls(db, { source, partition }) {
  return db.prepare('SELECT listing_id,url FROM seen_ids WHERE source=? AND partition=? ORDER BY listing_id').all(source, partition).map((row) => ({ id: row.listing_id, url: row.url }));
}
