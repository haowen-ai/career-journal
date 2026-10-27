import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/store.mjs';
import { openHomeDatabase, assertHomeOutsideCheckout } from '../runtime/home.mjs';
import { readFile } from 'node:fs/promises';
import { redact } from '../runtime/redact.mjs';
import { migrate, openDatabase, openReadOnlyDatabase, pendingMigrationError, assertSchemaNotNewer } from '../storage/database.mjs';
import { loadScanProfile } from '../scan/profile-input.mjs';
import { runScan } from '../scan/run.mjs';

const usage = 'Usage: career-journal scan run [--dry-run] [--json] [--profile <path>]';

export function profileOption(parsed) {
  if (!Object.hasOwn(parsed.options, 'profile')) return undefined;
  if (typeof parsed.options.profile !== 'string' || !parsed.options.profile.trim()) throw new Error('--profile requires a path');
  return parsed.options.profile;
}

// A dry run must not create or change the database, so it reads the existing
// one read-only, or uses an empty in-memory schema on a fresh workspace.
async function openDryRunDatabase(home) {
  assertHomeOutsideCheckout(home);
  const root = path.resolve(home);
  const config = await loadConfig(root);
  const databasePath = path.resolve(root, config.data.database);
  if (!existsSync(databasePath)) {
    const db = openDatabase(':memory:');
    migrate(db);
    return { root, config, db };
  }
  const db = openReadOnlyDatabase(databasePath);
  assertSchemaNotNewer(db);
  const pending = migrate(db, { dryRun: true }).pending;
  if (pending.length) {
    db.close();
    throw pendingMigrationError(pending);
  }
  return { root, config, db };
}

export function scanSourcesConfigured(profile) {
  return profile.sources.atsBoards.length > 0 || profile.sources.careerOps
    || (profile.sources.simplify.enabled && Boolean(profile.sources.simplify.url || profile.sources.simplify.urls?.length));
}

export async function scanWithContext(context, profile, runtime = {}, { dryRun = false, runId, parentRunId, deadlineAt } = {}) {
  if (!scanSourcesConfigured(profile)) {
    throw new Error('The profile has no scan sources. Add sources.atsBoards entries, or enable sources.careerOps or sources.simplify.');
  }
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  let policy = {};
  try { policy = JSON.parse(await readFile(path.join(context.root, path.dirname(context.config.data.database), 'profile', 'screening-policy.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return runScan({
    db: context.db,
    profile,
    fetchImpl,
    policy, runId, parentRunId, deadlineAt,
    careerOpsConfig: context.config.careerOps ?? {},
    careerOpsDependencies: runtime.careerOps ?? {},
    dryRun,
    now: runtime.now?.() ?? new Date().toISOString(),
  });
}

export function scanExitCode(summary) {
  return summary.status === 'failed' ? 1 : summary.status === 'busy' ? 75 : summary.status === 'partial' ? 2 : 0;
}
export function scanFailed(summary) { return scanExitCode(summary) === 1; }

export function formatScanSummary(summary) {
  const lines = [`Role scan${summary.dryRun ? ' (dry run: nothing written)' : ''}: ${summary.status}`];
  lines.push(`Sources: ${summary.sources.map((item) => `${item.partition} ${item.status} ${item.count}${item.detail ? ` (${item.detail})` : ''}${item.alert ? ` [${item.alert}]` : ''}`).join('; ')}`);
  const { raw, observed, newPostings, reused, dropped, review, quarantined } = summary.counts;
  lines.push(`Raw ${raw}; observed ${observed}; new postings ${newPostings}; reused ${reused}; review ${review}; quarantined ${quarantined}`);
  if (Object.keys(dropped).length) lines.push(`Dropped: ${Object.entries(dropped).map(([code, count]) => `${code} ${count}`).join(', ')}`);
  return redact(lines.join('\n'));
}

export async function scanCommand(parsed, io, runtime = {}) {
  if (parsed.subcommand !== 'run') throw new Error(usage);
  const home = parsed.options.home ?? process.cwd();
  const dryRun = parsed.options['dry-run'] === true;
  const profile = await loadScanProfile(home, { path: profileOption(parsed) });
  const context = dryRun ? await openDryRunDatabase(home) : await openHomeDatabase(home);
  try {
    const summary = await scanWithContext(context, profile, runtime, { dryRun, runId: parsed.options['run-id'], parentRunId: parsed.options['parent-run-id'], deadlineAt: parsed.options['deadline-at'] });
    io.out(redact(parsed.options.json ? JSON.stringify(summary, null, 2) : formatScanSummary(summary)));
    if (scanFailed(summary)) {
      io.err('Every scan source failed; no successful census.');
      return 1;
    }
    return scanExitCode(summary);
  } catch (error) {
    if (error.code === 75) { io.err(error.message); return 75; }
    throw error;
  } finally { context.db.close(); }
}
