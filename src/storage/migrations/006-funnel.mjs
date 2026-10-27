import { REVIEW_STAGES, REVIEW_STATES, DECISIONS, LANES, RUN_KINDS, PARTITION_STATUS } from '../../funnel/contract.mjs';

const values = (items) => items.map((item) => `'${item}'`).join(',');
export const migration006 = {
  version: 6,
  name: 'funnel',
  sql: `
    ALTER TABLE applications ADD COLUMN skip_owner TEXT CHECK (skip_owner IN ('review','user','legacy'));
    ALTER TABLE applications ADD COLUMN deadline_precision TEXT CHECK (deadline_precision IN ('datetime','date'));
    ALTER TABLE applications ADD COLUMN deadline_source TEXT CHECK (deadline_source IN ('review','user','legacy'));
    ALTER TABLE applications ADD COLUMN posting_end_at TEXT;
    UPDATE applications SET skip_owner = 'legacy' WHERE skip_reason IS NOT NULL;
    CREATE TRIGGER applications_legacy_scan_guard BEFORE INSERT ON applications
      WHEN NEW.external_id GLOB '[a-z]*:*' AND NEW.external_id NOT GLOB 'posting:*'
      BEGIN SELECT RAISE(ABORT, 'legacy scan writer blocked by schema 6'); END;
    CREATE TABLE postings (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, canonical_url TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, listed INTEGER NOT NULL DEFAULT 1,
      availability TEXT NOT NULL DEFAULT 'open' CHECK (availability IN ('open','unavailable','closed_claimed','closed_verified')),
      application_id TEXT REFERENCES applications(id), merged_into TEXT REFERENCES postings(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX postings_application_idx ON postings(application_id);
    CREATE TABLE posting_aliases (
      alias TEXT PRIMARY KEY, posting_id TEXT NOT NULL REFERENCES postings(id),
      kind TEXT NOT NULL CHECK (kind IN ('source','req','company_req','url')), created_at TEXT NOT NULL
    );
    CREATE INDEX posting_aliases_posting_idx ON posting_aliases(posting_id);
    CREATE TABLE posting_links (
      left_id TEXT NOT NULL REFERENCES postings(id), right_id TEXT NOT NULL REFERENCES postings(id),
      kind TEXT NOT NULL CHECK (kind IN ('maybe_same','conflict')), reason TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (left_id,right_id,kind)
    );
    CREATE TABLE observations (
      id TEXT PRIMARY KEY, posting_id TEXT NOT NULL REFERENCES postings(id), source TEXT NOT NULL,
      source_id TEXT, partition TEXT NOT NULL, first_run_id TEXT NOT NULL, observed_at TEXT NOT NULL,
      fields_json TEXT NOT NULL DEFAULT '{}', completeness_json TEXT NOT NULL DEFAULT '{}',
      listed INTEGER NOT NULL DEFAULT 1, content_hash TEXT NOT NULL, UNIQUE(posting_id,source,content_hash)
    );
    CREATE TABLE observation_sightings (
      run_id TEXT NOT NULL, posting_id TEXT NOT NULL REFERENCES postings(id),
      observation_id TEXT NOT NULL REFERENCES observations(id), source TEXT NOT NULL, partition TEXT NOT NULL,
      seen_at TEXT NOT NULL, PRIMARY KEY (run_id,posting_id,source,partition)
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN (${values(RUN_KINDS)})), parent_run_id TEXT,
      owner TEXT NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running','ok','partial','failed','interrupted')), receipt_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE run_sources (
      run_id TEXT NOT NULL, source TEXT NOT NULL, partition TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (${values(PARTITION_STATUS)})), count INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, expected INTEGER NOT NULL DEFAULT 0,
      detail TEXT, baseline INTEGER, alert TEXT, raw_count INTEGER NOT NULL DEFAULT 0, quarantined INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id,source,partition)
    );
    CREATE TABLE expected_partitions (
      source TEXT NOT NULL, partition TEXT NOT NULL, first_expected TEXT NOT NULL, last_expected TEXT NOT NULL,
      retired_at TEXT, PRIMARY KEY (source,partition)
    );
    CREATE TABLE source_samples (
      partition TEXT NOT NULL, sampled_at TEXT NOT NULL, board_count INTEGER, census_count INTEGER,
      status TEXT NOT NULL, PRIMARY KEY (partition,sampled_at)
    );
    CREATE TABLE cooldowns (key TEXT PRIMARY KEY, until TEXT NOT NULL, reason TEXT NOT NULL);
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY, posting_id TEXT NOT NULL REFERENCES postings(id), content_hash TEXT NOT NULL,
      fetched_at TEXT NOT NULL, final_url TEXT, http_status INTEGER,
      method TEXT NOT NULL CHECK (method IN ('ats_api','jsonld','html','manual')), identity_ok INTEGER NOT NULL DEFAULT 0,
      identity_reason TEXT, fields_json TEXT NOT NULL DEFAULT '{}', sections_json TEXT NOT NULL DEFAULT '[]',
      text TEXT, text_pruned_at TEXT
    );
    CREATE INDEX snapshots_posting_idx ON snapshots(posting_id,fetched_at);
    CREATE TABLE reviews (
      posting_id TEXT PRIMARY KEY REFERENCES postings(id), stage TEXT NOT NULL DEFAULT 'scan' CHECK (stage IN (${values(REVIEW_STAGES)})),
      state TEXT NOT NULL DEFAULT 'due' CHECK (state IN (${values(REVIEW_STATES)})),
      decision TEXT CHECK (decision IN (${values(DECISIONS)})), code TEXT,
      lane TEXT NOT NULL DEFAULT 'new' CHECK (lane IN (${values(LANES)})), flags_json TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0, paid_attempts INTEGER NOT NULL DEFAULT 0, lost_attempts INTEGER NOT NULL DEFAULT 0,
      next_due TEXT, lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0, lease_until TEXT, last_error TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]', dep_hashes_json TEXT NOT NULL DEFAULT '{}', deadline_json TEXT NOT NULL DEFAULT '{}',
      hold_owner TEXT CHECK (hold_owner IN ('system','user')), hold_since TEXT, first_seen TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX reviews_due_idx ON reviews(state,next_due,lane);
    CREATE TABLE review_log (
      id INTEGER PRIMARY KEY, posting_id TEXT NOT NULL REFERENCES postings(id), at TEXT NOT NULL, stage TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outcome','llm_raw','error','replan','delivery','user')), attempt_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, posting_id TEXT NOT NULL REFERENCES postings(id), stage TEXT NOT NULL,
      runner TEXT NOT NULL, model TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('primary','escalation')),
      state TEXT NOT NULL CHECK (state IN ('dispatched','responded','failed','lost','adopted')),
      dispatched_at TEXT NOT NULL, finished_at TEXT, output_path TEXT,
      usage_json TEXT NOT NULL DEFAULT '{}', transport_retries INTEGER NOT NULL DEFAULT 0, error TEXT
    );
    CREATE INDEX attempts_run_idx ON attempts(run_id,state);
  `,
};
