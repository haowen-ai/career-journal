import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/store.mjs';
import { openHomeDatabase, assertHomeOutsideCheckout } from '../runtime/home.mjs';
import { readFile } from 'node:fs/promises';
import { redact } from '../runtime/redact.mjs';
import { migrate, openDatabase, openReadOnlyDatabase, pendingMigrationError, assertSchemaNotNewer } from '../storage/database.mjs';
import { loadScanProfile } from '../scan/profile-input.mjs';
import { runScan } from '../scan/run.mjs';
import { loadUserOverrides, withOverrides } from '../review/overrides.mjs';
import { loadDirectionRules } from '../review/direction.mjs';
import { engagementRules, titleScreenRules } from '../funnel/classify.mjs';
import { attachBrowserList, failedLists, markListUnreadable } from '../scan/browser-list.mjs';

const usage = `Usage: career-journal scan run [--dry-run] [--json] [--profile <path>]
       career-journal scan failed-lists [--json]
       career-journal scan attach --partition <provider:Company> --file <rows.json> [--json]
       career-journal scan attach --partition <provider:Company> --unreadable --reason <text> [--json]`;

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

export async function scanPolicy(context) {
  let policy = {};
  const profileDir = path.join(context.root, path.dirname(context.config.data.database), 'profile');
  try { policy = JSON.parse(await readFile(path.join(profileDir, 'screening-policy.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let reviewPolicy = {};
  try { reviewPolicy = JSON.parse(await readFile(path.join(profileDir, 'review-policy.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // profile/title-screen.json: title drops the listing alone decides (titleScreenRules). It is its own file because the
  // review stage hashes screening-policy.json as a judge dependency; editing that file would requeue settled judgments.
  let titleScreen = null;
  try { titleScreen = titleScreenRules(JSON.parse(await readFile(path.join(profileDir, 'title-screen.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`profile/title-screen.json: ${error.message}`, { cause: error }); }
  // Re-allowed companies (profile/company-overrides.json) are not dropped at scan. The role-direction
  // allow patterns (profile/role-direction.json) keep an AI/ML/data title out of the hardware-only drop.
  // review-policy.json engagementSignals: extra engagement types (contract, part-time ...) a student search keeps.
  return { ...withOverrides(policy, await loadUserOverrides(profileDir)), direction: await loadDirectionRules(profileDir),
    engagement: engagementRules(reviewPolicy?.engagementSignals), titleScreen };
}

export async function scanWithContext(context, profile, runtime = {}, { dryRun = false, runId, parentRunId, deadlineAt } = {}) {
  if (!scanSourcesConfigured(profile)) {
    throw new Error('The profile has no scan sources. Add sources.atsBoards entries, or enable sources.careerOps or sources.simplify.');
  }
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  const policy = await scanPolicy(context);
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
  lines.push(`Sources: ${summary.sources.map((item) => `${item.partition} ${item.status} ${item.count}${item.detail ? ` (${item.detail})` : ''}${item.alert ? ` [${item.alert}${item.failStreak > 1 ? `, ${item.failStreak} runs in a row` : ''}]` : ''}`).join('; ')}`);
  const { raw, observed, newPostings, reused, dropped, review, quarantined } = summary.counts;
  lines.push(`Raw ${raw}; observed ${observed}; new postings ${newPostings}; reused ${reused}; review ${review}; quarantined ${quarantined}`);
  if (Object.keys(dropped).length) lines.push(`Dropped: ${Object.entries(dropped).map(([code, count]) => `${code} ${count}`).join(', ')}`);
  return redact(lines.join('\n'));
}

// A browser read holds titles, links and locations only; the same bound as `review attach`.
const MAX_ROWS_FILE_BYTES = 2_000_000;

// Browser fallback for company lists the scan could not fetch: `failed-lists` names them,
// `attach` ingests the student roles a person read off the careers page (src/scan/browser-list.mjs).
async function browserListCommand(parsed, io, runtime) {
  const home = parsed.options.home ?? process.cwd();
  const context = await openHomeDatabase(home);
  try {
    const now = runtime.now?.() ?? new Date().toISOString();
    let result;
    if (parsed.subcommand === 'failed-lists') result = failedLists(context.db, { now });
    else {
      const partition = parsed.options.partition;
      if (typeof partition !== 'string' || !partition.trim()) throw Object.assign(new Error(usage), { exitCode: 1 });
      if (parsed.options.unreadable === true) result = markListUnreadable(context.db, { partition, reason: parsed.options.reason, now });
      else {
        if (typeof parsed.options.file !== 'string') throw Object.assign(new Error(usage), { exitCode: 1 });
        let rows;
        try {
          const text = await readFile(parsed.options.file, 'utf8');
          if (Buffer.byteLength(text) > MAX_ROWS_FILE_BYTES) throw new Error(`larger than ${MAX_ROWS_FILE_BYTES} bytes`);
          rows = JSON.parse(text);
        }
        catch (error) { throw Object.assign(new Error(`Cannot read the rows file: ${error.message}`), { exitCode: 1 }); }
        const profile = await loadScanProfile(home, { path: profileOption(parsed) });
        result = attachBrowserList(context.db, { partition, rows: rows?.rows ?? rows, now, policy: await scanPolicy(context), profile });
      }
    }
    if (parsed.options.json) io.out(redact(JSON.stringify(result, null, 2)));
    else if (parsed.subcommand === 'failed-lists') io.out(redact(result.lists.length
      ? result.lists.map((item) => `${item.partition}\t${item.careersUrl ?? '(no URL recorded)'}\t${item.status === 'partial' ? item.note : item.error ?? ''}`).join('\n')
      : result.scanRunning ? `A scan run is still running (${result.scanRunId}); read the lists after it has finished.`
      : result.wholeScanFailed ? 'The whole CareerOps step failed in the latest scan; there is no single company list to read.' : 'No company list is waiting for a browser read.'));
    else io.out(redact(`${result.sources[0].partition}: ${result.sources[0].status} ${result.sources[0].count} (${result.sources[0].detail})`));
    return 0;
  } catch (error) {
    if (![1, 75].includes(error.exitCode)) throw error;
    io.err(error.message);
    return error.exitCode;
  } finally { context.db.close(); }
}

export async function scanCommand(parsed, io, runtime = {}) {
  if (['failed-lists', 'attach'].includes(parsed.subcommand)) return browserListCommand(parsed, io, runtime);
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
