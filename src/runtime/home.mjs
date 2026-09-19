import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config/store.mjs';
import { openDatabase, openReadOnlyDatabase, migrate, pendingMigrationError } from '../storage/database.mjs';

export async function openHomeDatabase(home) {
  const root = path.resolve(home);
  const config = await loadConfig(root);
  const databasePath = path.resolve(root, config.data.database);
  const existed = existsSync(databasePath);
  if (existed) {
    const inspect = openReadOnlyDatabase(databasePath);
    try {
      const pending = migrate(inspect, { dryRun: true }).pending;
      if (pending.length) throw pendingMigrationError(pending);
    } finally { inspect.close(); }
  }
  const db = openDatabase(databasePath);
  if (!existed) migrate(db);
  return { root, config, db, databasePath, artifactRoot: path.resolve(root, config.data.artifacts) };
}
