export const migration001 = {
  version: 1,
  name: 'initial',
  sql: `
    CREATE TABLE applications (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      external_id TEXT,
      job_url TEXT,
      status TEXT NOT NULL DEFAULT 'lead',
      stage TEXT,
      applied_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company, role, external_id)
    );

    CREATE TABLE application_events (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      occurred_at TEXT,
      observed_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL,
      status_after TEXT,
      content_hash TEXT NOT NULL
    );
    CREATE INDEX application_events_application_idx ON application_events(application_id, recorded_at);

    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft', 'submitted')),
      file_name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      submitted_at TEXT,
      recorded_at TEXT NOT NULL,
      verification TEXT NOT NULL DEFAULT 'pending',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(application_id, kind, lifecycle, sha256)
    );

    CREATE TABLE email_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      address TEXT NOT NULL,
      read_only INTEGER NOT NULL DEFAULT 1,
      secret_ref TEXT,
      cursor TEXT,
      last_attempt_at TEXT,
      last_success_at TEXT,
      error TEXT
    );

    CREATE TABLE automations (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL,
      schedule TEXT NOT NULL,
      account_id TEXT,
      notification_policy TEXT NOT NULL,
      cursor TEXT,
      last_attempt_at TEXT,
      last_success_at TEXT,
      error TEXT,
      config_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE decision_traces (
      id TEXT PRIMARY KEY,
      application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      engine TEXT NOT NULL,
      mode TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      confidence REAL,
      applied INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `,
};

