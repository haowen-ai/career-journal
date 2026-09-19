import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { migration001 } from './migrations/001-initial.mjs';

const migrations = [migration001];

export function openDatabase(file) {
  const resolved = file === ':memory:' ? file : path.resolve(file);
  if (resolved !== ':memory:') mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return db;
}

function appliedVersions(db) {
  const exists = db.prepare("SELECT 1 value FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!exists) return new Set();
  return new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
}

export function migrate(db, { dryRun = false } = {}) {
  const existing = appliedVersions(db);
  const pending = migrations.filter((item) => !existing.has(item.version));
  if (dryRun) return { pending: pending.map((item) => item.version), applied: [] };
  const applied = [];
  for (const item of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );`);
      db.exec(item.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(item.version, item.name, new Date().toISOString());
      db.exec('COMMIT');
      applied.push(item.version);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return { pending: [], applied };
}

