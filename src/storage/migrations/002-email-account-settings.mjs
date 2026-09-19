export const migration002 = {
  version: 2,
  name: 'email-account-settings',
  sql: `
    ALTER TABLE email_accounts ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE email_accounts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE email_accounts ADD COLUMN last_run_id TEXT;
    ALTER TABLE email_accounts ADD COLUMN last_batch_hash TEXT;
    ALTER TABLE email_accounts ADD COLUMN last_fetched_at TEXT;
  `,
};
