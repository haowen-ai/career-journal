import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backup as backupDatabase } from 'node:sqlite';
import { loadConfig } from '../config/store.mjs';
import { openDatabase } from '../storage/database.mjs';

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|password|token|api.?key/i.test(key)) continue;
    output[key] = sanitize(item);
  }
  return output;
}

async function listFiles(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(file, base));
    else files.push(path.relative(base, file));
  }
  return files.sort();
}

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function createBackup(home, output, options = {}) {
  const root = path.resolve(home);
  const destination = path.resolve(output);
  if (await exists(destination)) throw new Error(`Backup destination already exists: ${destination}`);
  const config = await loadConfig(root);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    await writeFile(path.join(destination, 'config.json'), `${JSON.stringify(sanitize(config), null, 2)}\n`, { mode: 0o600 });
    const sourceDatabase = path.resolve(root, config.data.database);
    if (await exists(sourceDatabase)) {
      const db = openDatabase(sourceDatabase);
      try { await backupDatabase(db, path.join(destination, 'jobops.db')); }
      finally { db.close(); }
    }
    const artifactRoot = path.resolve(root, config.data.artifacts);
    if (await exists(artifactRoot) && (await stat(artifactRoot)).isDirectory()) {
      await cp(artifactRoot, path.join(destination, 'artifacts'), { recursive: true, force: false });
    }
    const files = await listFiles(destination);
    const manifest = {
      schemaVersion: 1,
      createdAt: options.now ?? new Date().toISOString(),
      sourceVersion: options.version ?? null,
      files: Object.fromEntries(await Promise.all(files.map(async (file) => [file, await digest(path.join(destination, file))]))),
      exclusions: ['credentials', 'secret references', 'environment files', 'scheduler definitions'],
    };
    await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { output: destination, manifest };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function backupCommand(parsed, io, runtime) {
  if (!['create', null].includes(parsed.subcommand)) throw new Error('Usage: jobops backup create --output <directory>');
  if (!parsed.options.output) throw new Error('backup create requires --output');
  const result = await createBackup(parsed.options.home ?? process.cwd(), parsed.options.output, { version: runtime.version });
  io.out(JSON.stringify(result, null, 2));
  return 0;
}
