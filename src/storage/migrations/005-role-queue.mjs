export const migration005 = {
  version: 5,
  name: 'role-queue',
  sql: `
    ALTER TABLE applications ADD COLUMN source TEXT;
    ALTER TABLE applications ADD COLUMN source_id TEXT;
    ALTER TABLE applications ADD COLUMN location TEXT;
    ALTER TABLE applications ADD COLUMN posted_at TEXT;
    ALTER TABLE applications ADD COLUMN deadline_at TEXT;
    ALTER TABLE applications ADD COLUMN fit TEXT;
    ALTER TABLE applications ADD COLUMN fit_confidence REAL;
    ALTER TABLE applications ADD COLUMN fit_note TEXT;
    ALTER TABLE applications ADD COLUMN verified_at TEXT;
    ALTER TABLE applications ADD COLUMN skip_reason TEXT;
    CREATE INDEX applications_source_idx ON applications(source, source_id);
  `,
};
