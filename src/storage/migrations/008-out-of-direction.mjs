export const migration008 = {
  version: 8,
  name: 'out-of-direction',
  // SQLite cannot extend a CHECK constraint in place. Preserve every review
  // field while rebuilding the table and its due-work index transactionally.
  sql: `
    CREATE TABLE reviews_v8 (
      posting_id TEXT PRIMARY KEY REFERENCES postings(id), stage TEXT NOT NULL DEFAULT 'scan' CHECK (stage IN ('scan','fetch','check','judge','deliver')),
      state TEXT NOT NULL DEFAULT 'due' CHECK (state IN ('due','leased','held','done','failed')),
      decision TEXT CHECK (decision IN ('dropped','reused','not_eligible','eligible','unclear')), code TEXT,
      lane TEXT NOT NULL DEFAULT 'new' CHECK (lane IN ('deadline','aged','bootstrap','new','refresh','no_student_signal','out_of_direction')), flags_json TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0, paid_attempts INTEGER NOT NULL DEFAULT 0, lost_attempts INTEGER NOT NULL DEFAULT 0,
      next_due TEXT, lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0, lease_until TEXT, last_error TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]', dep_hashes_json TEXT NOT NULL DEFAULT '{}', deadline_json TEXT NOT NULL DEFAULT '{}',
      hold_owner TEXT CHECK (hold_owner IN ('system','user')), hold_since TEXT, first_seen TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO reviews_v8 SELECT * FROM reviews;
    DROP TABLE reviews;
    ALTER TABLE reviews_v8 RENAME TO reviews;
    CREATE INDEX reviews_due_idx ON reviews(state,next_due,lane);
  `,
};
