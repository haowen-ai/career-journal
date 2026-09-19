import { createHash } from 'node:crypto';
import { openHomeDatabase } from '../runtime/home.mjs';
import { applicationStatuses } from '../domain/status-machine.mjs';

const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};

const slug = (value) => value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'application';

function safeUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Job URL must use http(s) without credentials');
  return url.href;
}

export function createApplication(db, input, now = new Date().toISOString()) {
  const company = required(input.company, 'company');
  const role = required(input.role, 'role');
  const externalId = input.externalId ? String(input.externalId).trim() : null;
  const existing = db.prepare(`SELECT * FROM applications WHERE company = ? AND role = ?
    AND ((external_id IS NULL AND ? IS NULL) OR external_id = ?)`)
    .get(company, role, externalId, externalId);
  if (existing) return existing;
  const status = input.status ?? 'lead';
  if (!applicationStatuses.includes(status)) throw new Error(`Unknown application status: ${status}`);
  const base = slug([company, role, externalId].filter(Boolean).join('-'));
  let id = base;
  if (db.prepare('SELECT 1 FROM applications WHERE id = ?').get(id)) {
    id = `${base.slice(0, 51)}-${createHash('sha256').update(`${company}\0${role}\0${externalId ?? ''}`).digest('hex').slice(0, 8)}`;
  }
  db.prepare(`INSERT INTO applications
    (id, company, role, external_id, job_url, status, stage, applied_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, company, role, externalId, safeUrl(input.jobUrl), status, input.stage ?? null, input.appliedAt ?? null, now, now);
  return db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
}

export function listApplications(db) {
  return db.prepare(`SELECT id, company, role, external_id externalId, job_url jobUrl, status, stage,
    applied_at appliedAt, created_at createdAt, updated_at updatedAt
    FROM applications ORDER BY company COLLATE NOCASE, role COLLATE NOCASE, id`).all();
}

export async function applicationCommand(parsed, io) {
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    if (parsed.subcommand === 'add') {
      const record = createApplication(context.db, {
        company: parsed.options.company, role: parsed.options.role, externalId: parsed.options['external-id'],
        jobUrl: parsed.options['job-url'], status: parsed.options.status, appliedAt: parsed.options['applied-at'],
      });
      io.out(JSON.stringify(record));
      return 0;
    }
    if (parsed.subcommand === 'list') {
      const records = listApplications(context.db);
      if (parsed.options.json) io.out(JSON.stringify(records, null, 2));
      else for (const item of records) io.out(`${item.id}\t${item.company}\t${item.role}\t${item.status}`);
      return 0;
    }
    if (parsed.subcommand === 'show') {
      const record = context.db.prepare('SELECT * FROM applications WHERE id = ?').get(required(parsed.options.id ?? parsed.positionals[0], 'id'));
      if (!record) throw new Error('Application not found');
      const events = context.db.prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY recorded_at, id').all(record.id);
      const artifacts = context.db.prepare('SELECT * FROM artifacts WHERE application_id = ? ORDER BY recorded_at, id').all(record.id);
      io.out(JSON.stringify({ ...record, events, artifacts }, null, 2));
      return 0;
    }
    throw new Error('Usage: career-journal application add|list|show');
  } finally { context.db.close(); }
}

