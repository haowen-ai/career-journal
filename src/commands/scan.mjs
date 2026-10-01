import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/store.mjs';
import { openHomeDatabase } from '../runtime/home.mjs';
import { migrate, openDatabase, openReadOnlyDatabase, pendingMigrationError } from '../storage/database.mjs';
import { loadScanProfile } from '../scan/profile-input.mjs';
import { runScan } from '../scan/run.mjs';
import { configuredDecisionAdapters } from './email.mjs';

const usage = 'Usage: career-journal scan run [--dry-run] [--json] [--profile <path>]';

export function profileOption(parsed) {
  if (!Object.hasOwn(parsed.options, 'profile')) return undefined;
  if (typeof parsed.options.profile !== 'string' || !parsed.options.profile.trim()) throw new Error('--profile requires a path');
  return parsed.options.profile;
}

// A dry run must not create or change the database, so it reads the existing
// one read-only, or uses an empty in-memory schema on a fresh workspace.
async function openDryRunDatabase(home) {
  const root = path.resolve(home);
  const config = await loadConfig(root);
  const databasePath = path.resolve(root, config.data.database);
  if (!existsSync(databasePath)) {
    const db = openDatabase(':memory:');
    migrate(db);
    return { root, config, db };
  }
  const db = openReadOnlyDatabase(databasePath);
  const pending = migrate(db, { dryRun: true }).pending;
  if (pending.length) {
    db.close();
    throw pendingMigrationError(pending);
  }
  return { root, config, db };
}

export function scanSourcesConfigured(profile) {
  return profile.sources.atsBoards.length > 0 || profile.sources.careerOps || profile.sources.simplify.enabled;
}

export async function scanWithContext(context, profile, runtime = {}, { dryRun = false } = {}) {
  if (!scanSourcesConfigured(profile)) {
    throw new Error('The profile has no scan sources. Add sources.atsBoards entries, or enable sources.careerOps or sources.simplify.');
  }
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  return runScan({
    db: context.db,
    profile,
    fetchImpl,
    adapters: dryRun ? {} : configuredDecisionAdapters(context.config, fetchImpl),
    careerOpsConfig: context.config.careerOps ?? {},
    careerOpsDependencies: runtime.careerOps ?? {},
    dryRun,
    now: runtime.now?.() ?? new Date().toISOString(),
  });
}

export function scanFailed(summary) {
  const attempted = summary.sources.filter((item) => item.status !== 'skipped');
  return attempted.length > 0 && attempted.every((item) => item.status === 'error');
}

function sourceLabel(item) {
  return item.board ? `${item.source}/${item.board}` : item.source;
}

export function formatScanSummary(summary) {
  const lines = [];
  lines.push(`Role scan${summary.dryRun ? ' (dry run: nothing written, fit from local rules)' : ''}`);
  lines.push(`Sources: ${summary.sources.map((item) => `${sourceLabel(item)} ${item.status}${item.status === 'ok' ? ` ${item.count}` : item.detail ? ` (${item.detail})` : ''}`).join('; ')}`);
  const { fetched, queued, dropped, duplicates, possibleDuplicates } = summary.counts;
  lines.push(`Fetched ${fetched}; queued ${queued}${possibleDuplicates ? ` (${possibleDuplicates} possible duplicate${possibleDuplicates === 1 ? '' : 's'})` : ''}; dropped ${dropped}; duplicates ${duplicates}`);
  for (const item of summary.queued) {
    lines.push(['  ', item.fit ?? '-', item.company, item.title, item.location ?? '-', item.id ?? '(dry run)'].join('\t'));
  }
  const reasons = Object.entries(summary.dropReasons).sort((left, right) => right[1] - left[1]);
  if (reasons.length) lines.push(`Dropped by reason: ${reasons.map(([code, count]) => `${code} ${count}`).join(', ')}`);
  return lines.join('\n');
}

export async function scanCommand(parsed, io, runtime = {}) {
  if (parsed.subcommand !== 'run') throw new Error(usage);
  const home = parsed.options.home ?? process.cwd();
  const dryRun = parsed.options['dry-run'] === true;
  const profile = await loadScanProfile(home, { path: profileOption(parsed) });
  const context = dryRun ? await openDryRunDatabase(home) : await openHomeDatabase(home);
  try {
    const summary = await scanWithContext(context, profile, runtime, { dryRun });
    io.out(parsed.options.json ? JSON.stringify(summary, null, 2) : formatScanSummary(summary));
    if (scanFailed(summary)) {
      io.err('Every scan source failed; nothing new was queued.');
      return 1;
    }
    return 0;
  } finally { context.db.close(); }
}
