export const migration003 = {
  version: 3,
  name: 'application-tasks',
  sql: `
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('assessment', 'interview', 'other')),
      title TEXT NOT NULL,
      platform TEXT,
      due_at TEXT,
      due_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('open', 'done')) DEFAULT 'open',
      note TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX application_tasks_status_due_idx ON application_tasks(status, due_at);
  `,
};
