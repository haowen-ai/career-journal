import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/store.mjs';
import { openDatabase, openReadOnlyDatabase, migrate, pendingMigrationError, assertSchemaNotNewer } from '../storage/database.mjs';

const CHECKOUT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Resolve existing ancestors too, so a nonexistent child of a symlink cannot bypass the guard.
function physicalPath(value) {
  const absolute = path.resolve(value);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(physicalPath(parent), path.basename(absolute));
}
export function assertHomeOutsideCheckout(home, checkoutRoot = CHECKOUT_ROOT) {
  const relative = path.relative(physicalPath(checkoutRoot), physicalPath(home));
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('Data home must be outside the code checkout');
  }
}

export async function openHomeDatabase(home) {
  assertHomeOutsideCheckout(home);
  const root = path.resolve(home);
  const config = await loadConfig(root);
  const databasePath = path.resolve(root, config.data.database);
  const existed = existsSync(databasePath);
  if (existed) {
    const inspect = openReadOnlyDatabase(databasePath);
    try {
      assertSchemaNotNewer(inspect);
      const pending = migrate(inspect, { dryRun: true }).pending;
      if (pending.length) throw pendingMigrationError(pending);
    } finally { inspect.close(); }
  }
  const db = openDatabase(databasePath);
  assertSchemaNotNewer(db);
  if (!existed) migrate(db);
  return { root, config, db, databasePath, artifactRoot: path.resolve(root, config.data.artifacts) };
}
