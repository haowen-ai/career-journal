import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    if (/secretRef$/i.test(key)) {
      if (item == null
        || /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(String(item))
        || /^keychain:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(String(item))) output[key] = item;
      continue;
    }
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (/(?:password|passwd|secret|token|apikey|authorization|cookie|credential|privatekey|accesskey|sessionkey)/.test(normalizedKey)) continue;
    output[key] = sanitize(item);
  }
  return output;
}

function backupConfig(config) {
  const output = sanitize(config);
  if (output.automation?.setupState === 'registered') output.automation.setupState = 'pending-registration';
  if (['verified', 'host-attested', 'connected-pending-sync'].includes(output.email?.setupState)) {
    output.email.setupState = 'pending-verification';
  }
  return output;
}

function prepareBackupDatabase(databaseFile) {
  const db = openDatabase(databaseFile);
  try {
    const hasArtifacts = db.prepare("SELECT 1 value FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
    const artifactIndex = hasArtifacts
      ? db.prepare(`SELECT id, application_id applicationId, kind, lifecycle, file_name fileName,
          sha256, submitted_at submittedAt, recorded_at recordedAt, verification
        FROM artifacts ORDER BY recorded_at, id`).all()
      : [];
    const hasEmailAccounts = db.prepare("SELECT 1 value FROM sqlite_master WHERE type='table' AND name='email_accounts'").get();
    const hasAutomations = db.prepare("SELECT 1 value FROM sqlite_master WHERE type='table' AND name='automations'").get();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (hasEmailAccounts) {
        const columns = new Set(db.prepare('PRAGMA table_info(email_accounts)').all().map((column) => column.name));
        const nullableHealth = [
          'cursor', 'last_run_id', 'last_batch_hash', 'last_fetched_at',
          'last_attempt_at', 'last_success_at', 'error',
        ].filter((column) => columns.has(column));
        const assignments = nullableHealth.map((column) => `${column} = NULL`);
        if (columns.has('revision')) assignments.push('revision = 0');
        if (assignments.length) db.exec(`UPDATE email_accounts SET ${assignments.join(', ')}`);
        if (columns.has('config_json')) {
          const emailRows = db.prepare('SELECT id, config_json FROM email_accounts').all();
          const updateEmailConfig = db.prepare('UPDATE email_accounts SET config_json = ? WHERE id = ?');
          for (const row of emailRows) {
            const settings = JSON.parse(row.config_json);
            delete settings.verification;
            updateEmailConfig.run(JSON.stringify(settings), row.id);
          }
        }
      }
      if (hasAutomations) {
        const rows = db.prepare('SELECT id, config_json FROM automations').all();
        const updateConfig = db.prepare(`UPDATE automations
          SET config_json = ?, cursor = CASE WHEN task_type = 'mail-sync' THEN NULL ELSE cursor END,
            last_attempt_at = NULL, last_success_at = NULL, error = NULL
          WHERE id = ?`);
        for (const row of rows) {
          const config = JSON.parse(row.config_json);
          delete config.registration;
          delete config.lastExternalRunAt;
          updateConfig.run(JSON.stringify(config), row.id);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return artifactIndex;
  } finally {
    db.close();
  }
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
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    await writeFile(path.join(destination, 'config.json'), `${JSON.stringify(backupConfig(config), null, 2)}\n`, { mode: 0o600 });
    let artifactIndex = [];
    const sourceDatabase = path.resolve(root, config.data.database);
    if (await exists(sourceDatabase)) {
      const db = openDatabase(sourceDatabase);
      const copiedDatabase = path.join(destination, path.basename(sourceDatabase));
      try { await backupDatabase(db, copiedDatabase); }
      finally { db.close(); }
      artifactIndex = prepareBackupDatabase(copiedDatabase);
    }
    await writeFile(path.join(destination, 'artifacts-index.json'), `${JSON.stringify(artifactIndex, null, 2)}\n`, { mode: 0o600 });
    const files = await listFiles(destination);
    const manifest = {
      schemaVersion: 1,
      createdAt: options.now ?? new Date().toISOString(),
      sourceVersion: options.version ?? null,
      files: Object.fromEntries(await Promise.all(files.map(async (file) => [file, await digest(path.join(destination, file))]))),
      exclusions: [
        'credential values', 'environment files', 'artifact payloads',
        'scheduler host attestations and execution health', 'mailbox verification and execution health',
      ],
    };
    await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { output: destination, manifest };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function backupCommand(parsed, io, runtime) {
  if (!['create', null].includes(parsed.subcommand)) throw new Error('Usage: career-journal backup create --output <directory>');
  if (!parsed.options.output) throw new Error('backup create requires --output');
  const result = await createBackup(parsed.options.home ?? process.cwd(), parsed.options.output, { version: runtime.version });
  io.out(JSON.stringify(result, null, 2));
  return 0;
}
