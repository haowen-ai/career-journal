import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, workspaceDirectory } from '../config/store.mjs';
import { createBackup } from '../commands/backup.mjs';
import { resolveMaterialPath } from '../domain/profile.mjs';

// Never follow symlinks in managed trees, including a symlink at the root.
export async function inventory(directory) {
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (info.isSymbolicLink()) return [];
  if (info.isFile()) return [{ path: directory, bytes: info.size, mtime: info.mtimeMs, inode: info.ino }];
  if (!info.isDirectory()) return [];
  const files = [];
  for (const entry of await readdir(directory)) files.push(...await inventory(path.join(directory, entry)));
  return files;
}

export function tableBytes(db, table, where = '1=1') {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
  if (!columns.length) return 0;
  const size = columns.map(({ name }) => `COALESCE(length(CAST("${name}" AS BLOB)), 0)`).join(' + ');
  return db.prepare(`SELECT COALESCE(SUM(${size}), 0) bytes FROM "${table}" WHERE ${where}`).get().bytes;
}

export async function measureStorage(home, db) {
  const directory = await realpath(workspaceDirectory(home));
  const config = await loadConfig(home);
  const size = async (file) => (await inventory(file)).reduce((sum, item) => sum + item.bytes, 0);
  let reviewPolicy = {};
  try { reviewPolicy = JSON.parse(await readFile(path.join(directory, 'profile', 'review-policy.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const workFiles = new Map();
  let roots = reviewPolicy.retention?.workPaths ?? [];
  try { roots = JSON.parse(await readFile(path.join(directory, 'retention-roots.json'), 'utf8')).workPaths; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const root of roots) {
    for (const file of await inventory(path.resolve(home, root))) workFiles.set(file.path, file);
  }
  // Configured work roots may contain reports; count each byte only once.
  const reports = await inventory(path.join(directory, 'reports'));
  for (const file of reports) workFiles.delete(file.path);
  const permanent = {
    applications: ['applications', 'postings', 'posting_aliases', 'posting_links', 'reviews', 'artifacts']
      .reduce((sum, table) => sum + tableBytes(db, table), 0)
      + tableBytes(db, 'review_log', "kind IN ('user','delivery')"),
    events: tableBytes(db, 'application_events'),
  };
  const snapshots = tableBytes(db, 'snapshots');
  const attempts = tableBytes(db, 'attempts');
  const runs = tableBytes(db, 'runs');
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  const database = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
  // Payload categories below are logical row bytes. The residual includes
  // database overhead, free pages and the actual WAL/SHM files, not just live rows.
  const allocatedBytes = database
    ? await size(database) + await size(`${database}-wal`) + await size(`${database}-shm`)
    : db.prepare('PRAGMA page_count').get().page_count * pageSize;
  const operational = {
    db: Math.max(0, allocatedBytes - permanent.applications - permanent.events - snapshots - attempts - runs),
    snapshots,
    attempts: attempts + await size(path.join(directory, 'attempts')),
    runs: runs + await size(path.join(directory, 'runs')),
    work: [...workFiles.values()].reduce((sum, file) => sum + file.bytes, 0),
    reports: reports.reduce((sum, file) => sum + file.bytes, 0),
    backups: await size(path.join(directory, 'backups')),
  };
  const permanentFiles = new Map();
  for (const root of [path.join(directory, 'profile'), path.resolve(home, config.data.artifacts), path.join(directory, 'config.json')]) {
    for (const file of await inventory(root)) permanentFiles.set(await realpath(file.path), file.bytes);
  }
  const materialFiles = new Set();
  try {
    const profile = JSON.parse(await readFile(path.join(directory, 'profile', 'profile.json'), 'utf8'));
    for (const field of ['resumePath', 'transcriptPath']) {
      if (profile.materials?.[field]) materialFiles.add(resolveMaterialPath(profile.materials[field]));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of materialFiles) {
    for (const item of await inventory(file)) permanentFiles.set(await realpath(item.path), item.bytes);
  }
  permanent.applications += [...permanentFiles.values()].reduce((sum, bytes) => sum + bytes, 0);
  return { operational, permanent, total: [...Object.values(operational), ...Object.values(permanent)].reduce((sum, n) => sum + n, 0) };
}

export async function rotateBackups(home, { now, policy }) {
  const keep = policy.backupsKeep ?? 4;
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('Invalid retention.backupsKeep');
  const directory = path.join(workspaceDirectory(home), 'backups', 'weekly');
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid backup date');
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const week = date.toISOString().slice(0, 10);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  const backups = entries.filter((entry) => entry.isDirectory() && /^weekly-\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name).sort();
  const name = `weekly-${week}`;
  let created = null;
  if (!backups.includes(name)) {
    created = path.join(directory, name);
    await createBackup(home, created, { now });
    backups.push(name);
    backups.sort();
  }
  const removed = [];
  while (backups.length > keep) {
    const oldest = path.join(directory, backups.shift());
    await rm(oldest, { recursive: true });
    removed.push(oldest);
  }
  return { created, removed };
}
