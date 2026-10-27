import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBackup } from './backup.mjs';
import { loadConfig } from '../config/store.mjs';
import { migrate, openDatabase, openReadOnlyDatabase, schemaMigrations } from '../storage/database.mjs';

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function migrateHome(home, options = {}) {
  const root = path.resolve(home);
  const config = await loadConfig(root);
  const database = path.resolve(root, config.data.database);
  const candidates = options.migrations ?? schemaMigrations;
  const existed = await exists(database);
  if (options.dryRun && !existed) return { database, pending: candidates.map((item) => item.version), applied: [], backup: null, dryRun: true };

  if (options.dryRun) {
    const db = openReadOnlyDatabase(database);
    try { return { database, ...migrate(db, { dryRun: true, migrations: candidates }), backup: null, dryRun: true }; }
    finally { db.close(); }
  }

  let backup = null;
  if (existed) {
    const inspect = openReadOnlyDatabase(database);
    let pending;
    try { pending = migrate(inspect, { dryRun: true, migrations: candidates }).pending; }
    finally { inspect.close(); }
    if (pending.length) {
      backup = path.join(path.dirname(database), 'backups', `pre-migrate-${randomUUID()}`);
      await createBackup(root, backup);
    }
  }
  await mkdir(path.dirname(database), { recursive: true, mode: 0o700 });
  let db;
  try {
    db = openDatabase(database);
    if (options.busyTimeoutMs !== undefined) db.exec(`PRAGMA busy_timeout = ${Math.max(0, Number(options.busyTimeoutMs) || 0)}`);
    const result = migrate(db, { migrations: candidates });
    db.close();
    db = null;
    return { database, ...result, backup, dryRun: false };
  } catch (error) {
    try { db?.close(); } catch {}
    throw error;
  }
}

export async function migrateCommand(parsed, io) {
  if (parsed.subcommand && !['plan', 'apply'].includes(parsed.subcommand)) throw new Error('Usage: career-journal migrate [--dry-run|--apply]');
  const apply = parsed.options.apply === true || parsed.subcommand === 'apply';
  const dryRun = parsed.options['dry-run'] === true || parsed.subcommand === 'plan' || !apply;
  const result = await migrateHome(parsed.options.home ?? process.cwd(), { dryRun });
  io.out(JSON.stringify(result, null, 2));
  return 0;
}
