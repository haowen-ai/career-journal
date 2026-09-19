import path from 'node:path';
import { loadConfig } from '../config/store.mjs';
import { openDatabase, migrate } from '../storage/database.mjs';

export async function openHomeDatabase(home) {
  const root = path.resolve(home);
  const config = await loadConfig(root);
  const databasePath = path.resolve(root, config.data.database);
  const db = openDatabase(databasePath);
  migrate(db);
  return { root, config, db, databasePath, artifactRoot: path.resolve(root, config.data.artifacts) };
}

