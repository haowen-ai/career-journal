export const migration010 = {
  version: 10,
  name: 'seen-listings',
  // Plan 2026-11-14 v2 (incremental nightly). seen_ids: every listing a scan has processed, by source, list
  // (partition) and the board's own listing id. seen_baselines: a list whose every row was recorded by a scan
  // that finished with the list read; only such a list skips its known listings. list_watermarks (v3.1): the start
  // time of the last run that read a list to its end or to a proven early stop, with its rows persisted; the next
  // run may stop paging that list early (Oracle Cloud, Taleo). run_sources.collection_mode: 'full' or
  // 'early_stopped'; an early-stopped read is left out of every count comparison and baseline.
  sql: `
    CREATE TABLE IF NOT EXISTS seen_ids (
      source TEXT NOT NULL, partition TEXT NOT NULL, listing_id TEXT NOT NULL,
      url TEXT, first_seen_at TEXT NOT NULL, first_run_id TEXT,
      PRIMARY KEY (source, partition, listing_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS seen_baselines (
      source TEXT NOT NULL, partition TEXT NOT NULL, run_id TEXT NOT NULL, completed_at TEXT NOT NULL,
      PRIMARY KEY (source, partition)
    );
    CREATE TABLE IF NOT EXISTS list_watermarks (
      source TEXT NOT NULL, partition TEXT NOT NULL, completed_at TEXT NOT NULL, run_id TEXT NOT NULL,
      PRIMARY KEY (source, partition)
    );
    ALTER TABLE run_sources ADD COLUMN collection_mode TEXT NOT NULL DEFAULT 'full' CHECK (collection_mode IN ('full','early_stopped'));
  `,
};
