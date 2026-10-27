export const migration007 = {
  version: 7,
  name: 'posting-merge-index',
  sql: 'CREATE INDEX IF NOT EXISTS postings_merged_idx ON postings(merged_into);',
};
