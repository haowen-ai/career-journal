export const migration009 = {
  version: 9,
  name: 'review-lookup-indexes',
  // Per-posting lookups of user review entries and of a posting's sightings. A data home may already
  // have these indexes, created by hand under the same names.
  sql: `
    CREATE INDEX IF NOT EXISTS review_log_posting_kind_idx ON review_log(posting_id,kind);
    CREATE INDEX IF NOT EXISTS review_log_kind_idx ON review_log(kind);
    CREATE INDEX IF NOT EXISTS observation_sightings_posting_idx ON observation_sightings(posting_id,seen_at);
  `,
};
