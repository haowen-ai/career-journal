import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadConfig, workspaceDirectory } from '../config/store.mjs';
import { detectCareerOps } from '../integrations/careerops.mjs';
import { openReadOnlyDatabase, migrate } from '../storage/database.mjs';
import { hasCompleteHostSyncCoverage, isLiveVerifiedEmailAccount, listEmailAccounts } from '../email/accounts.mjs';
import { isCurrentTaskRegistration, listTasks, REQUIRED_TASK_TYPES, taskEmailAccountIds } from '../automation/registry.mjs';
import { probeTaskRegistration } from '../automation/probe.mjs';
import { secretReferenceState } from '../secrets/reference.mjs';

const major = (version) => Number(String(version).replace(/^v/, '').split('.')[0]);
const DAILY_HEALTH_WINDOW_MS = 36 * 60 * 60 * 1000;

function timestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

function recent(value, now) {
  const parsed = timestamp(value);
  return parsed !== null && parsed <= now + 5 * 60 * 1000 && now - parsed <= DAILY_HEALTH_WINDOW_MS;
}

function externallyObserved(task, now) {
  if (!isCurrentTaskRegistration(task) || task.error) return false;
  const registration = task.config.registration;
  const registeredAt = timestamp(registration.registeredAt);
  const externalRunAt = timestamp(registration.lastExternalRunAt);
  return registeredAt !== null
    && externalRunAt !== null
    && externalRunAt >= registeredAt
    && recent(registration.lastExternalRunAt, now)
    && recent(task.lastSuccessAt, now);
}

function envReferenceState(secretRef, env) {
  if (!secretRef) return { ok: true, detail: 'no credential reference configured' };
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(secretRef);
  if (!match) return { ok: false, detail: 'credential must use env:VARIABLE' };
  return env[match[1]] ? { ok: true, detail: `credential ${match[1]} is available` } : { ok: false, detail: `set environment variable ${match[1]}` };
}

export async function doctor(home, capabilities = {}) {
  const checks = [];
  const now = timestamp(capabilities.now ?? new Date().toISOString());
  if (now === null) throw new Error('doctor now must be an ISO date-time');
  const nodeVersion = capabilities.nodeVersion ?? process.versions.node;
  checks.push({ id: 'node', severity: major(nodeVersion) >= 24 ? 'pass' : 'fail', detail: nodeVersion });
  let config;
  try {
    config = await loadConfig(home);
    checks.push({ id: 'config', severity: 'pass', detail: `schema ${config.schemaVersion}` });
  } catch (error) {
    checks.push({ id: 'config', severity: 'fail', detail: error.message });
    return { ok: false, checks };
  }
  const storageCheck = capabilities.storage ?? (async () => {
    const directory = workspaceDirectory(home);
    await mkdir(directory, { recursive: true });
    await access(directory);
    const probe = path.join(directory, `.doctor-${randomUUID()}`);
    await writeFile(probe, '', { flag: 'wx', mode: 0o600 });
    await rm(probe);
    return { ok: true, detail: 'writable' };
  });
  try {
    const storage = await storageCheck();
    checks.push({ id: 'storage', severity: storage.ok ? 'pass' : 'fail', detail: storage.detail ?? '' });
  } catch (error) { checks.push({ id: 'storage', severity: 'fail', detail: error.message }); }
  const careerOpsCheck = capabilities.careerOps ?? (() => detectCareerOps(config.careerOps));
  const careerOps = await careerOpsCheck();
  checks.push({ id: 'careerops', severity: careerOps.ok ? 'pass' : 'warn', detail: careerOps.detail ?? '' });
  let accounts = [];
  let tasks = [];
  const databasePath = path.resolve(home, config.data.database);
  let databaseReady = false;
  if (!existsSync(databasePath)) {
    checks.push({ id: 'migration', severity: 'fail', detail: 'database is missing; complete setup before running doctor' });
  } else try {
    const db = openReadOnlyDatabase(databasePath);
    try {
      const pending = migrate(db, { dryRun: true }).pending;
      if (pending.length) {
        checks.push({ id: 'migration', severity: 'fail', detail: `pending versions ${pending.join(', ')}; run migrate --dry-run, back up, then migrate --apply` });
      } else {
        databaseReady = true;
        checks.push({ id: 'migration', severity: 'pass', detail: 'schema is current' });
        accounts = listEmailAccounts(db);
        tasks = listTasks(db);
      }
    } finally { db.close(); }
  } catch (error) {
    checks.push({ id: 'migration', severity: 'fail', detail: `cannot inspect database schema: ${error.message}` });
  }
  if (!databaseReady) {
    checks.push({ id: 'email', severity: 'fail', detail: 'mailbox health is unavailable until the database schema is current' });
  } else {
    const hostAccounts = accounts.filter((item) => item.provider === 'host' && item.readOnly && item.settings?.connector);
    const imapAccounts = accounts.filter((item) => item.provider === 'imap' && item.readOnly && item.settings?.host);
    const configuredMailTask = tasks.find((task) => task.type === 'mail-sync' && task.enabled);
    const selectedIds = taskEmailAccountIds(configuredMailTask);
    const healthyAccounts = accounts.filter((item) => selectedIds.includes(item.id)
      && isLiveVerifiedEmailAccount(item, new Date(now).toISOString())
      && item.lastSuccessAt
      && item.lastFetchedAt
      && !item.error
      && hasCompleteHostSyncCoverage(item)
      && recent(item.lastSuccessAt, now)
      && recent(item.lastFetchedAt, now));
    const emailUsable = selectedIds.length > 0 && healthyAccounts.length === selectedIds.length;
    const freshHostBatch = hostAccounts.some((item) => item.lastSuccessAt
      && item.lastFetchedAt
      && !item.error
      && hasCompleteHostSyncCoverage(item)
      && recent(item.lastSuccessAt, now)
      && recent(item.lastFetchedAt, now));
    const incompleteHostCoverage = hostAccounts.some((item) => item.lastSuccessAt && !hasCompleteHostSyncCoverage(item));
    checks.push({
      id: 'email',
      severity: emailUsable ? 'pass' : 'fail',
      detail: emailUsable
        ? `${healthyAccounts.length} selected read-only mailbox${healthyAccounts.length === 1 ? '' : 'es'} live-verified and synced in the last 36 hours (${[...new Set(healthyAccounts.map((account) => account.provider === 'imap' ? 'IMAPS' : 'trusted host'))].join(', ')})`
        : incompleteHostCoverage
          ? 'host mailbox has prior sync timestamps but no complete rolling-24-hour all-message coverage proof; run a full paginated sync before advancing health'
          : freshHostBatch
          ? 'host connector batch is self-attested; caller JSON cannot prove mailbox identity. Pair the connector with a live verifier adapter or configure IMAPS'
          : hostAccounts.length
            ? 'host mailbox is configured but remains self-attested; connect a live verifier adapter or configure IMAPS'
            : imapAccounts.length
              ? 'every selected mailbox needs a successful live verification and read-only sync in the last 36 hours'
          : accounts.length ? 'manual or unsupported email account cannot provide daily sync' : 'no job-search email account configured',
    });
  }
  const requiredTasks = REQUIRED_TASK_TYPES;
  const schedulerProbe = capabilities.schedulerProbe ?? ((task) => probeTaskRegistration(task, {
    codexHome: capabilities.codexHome,
  }));
  const schedulerProbes = new Map(await Promise.all(tasks
    .filter((task) => requiredTasks.includes(task.type) && task.enabled)
    .map(async (task) => {
      try {
        const result = await schedulerProbe(task);
        return [task.id, typeof result === 'boolean' ? { ok: result, detail: result ? 'verified' : 'not found' } : result];
      } catch (error) {
        return [task.id, { ok: false, detail: error.message }];
      }
    })));
  const registeredTasks = new Map(tasks
    .filter((task) => requiredTasks.includes(task.type)
      && task.enabled
      && externallyObserved(task, now)
      && schedulerProbes.get(task.id)?.ok === true)
    .map((task) => [task.type, task]));
  const mailTask = registeredTasks.get('mail-sync');
  const healthyAccountIds = new Set(accounts
    .filter((account) => isLiveVerifiedEmailAccount(account, new Date(now).toISOString())
      && !account.error
      && hasCompleteHostSyncCoverage(account)
      && recent(account.lastSuccessAt, now)
      && recent(account.lastFetchedAt, now))
    .map((account) => account.id));
  const automationUsable = requiredTasks.every((type) => registeredTasks.has(type))
    && taskEmailAccountIds(mailTask).length > 0
    && taskEmailAccountIds(mailTask).every((id) => healthyAccountIds.has(id));
  const failedSchedulerProbes = tasks
    .filter((task) => requiredTasks.includes(task.type) && task.enabled && schedulerProbes.get(task.id)?.ok !== true)
    .map((task) => `${task.type}: ${schedulerProbes.get(task.id)?.detail ?? 'not probed'}`);
  checks.push({
    id: 'automation',
    severity: automationUsable ? 'pass' : 'fail',
    detail: automationUsable
      ? 'daily mailbox and deadline-review tasks are live-probed and have run successfully within 36 hours'
      : failedSchedulerProbes.length
        ? `scheduler probe failed (${failedSchedulerProbes.join('; ')}); install or verify every real schedule, then observe one matching successful run within 36 hours`
        : 'daily tasks are not fully healthy; verify every real schedule and observe one matching successful run for each task within 36 hours',
  });

  const env = capabilities.env ?? process.env;
  const model = config.model ?? { provider: 'none' };
  let modelState = { ok: false, detail: 'not configured; core rules remain available' };
  if (model.provider === 'openai-compatible') {
    const credential = envReferenceState(model.secretRef, env);
    modelState = { ok: Boolean(model.baseUrl && model.model && credential.ok), detail: !model.baseUrl || !model.model ? 'configure model baseUrl and model name' : credential.detail };
  } else if (model.provider === 'host-agent') {
    modelState = { ok: true, detail: 'current host Agent reviews ambiguous candidates; no separate endpoint or API key required' };
  } else if (model.provider !== 'none') modelState = { ok: false, detail: `unsupported provider ${model.provider}` };
  checks.push({ id: 'model', severity: modelState.ok ? 'pass' : 'warn', detail: modelState.detail });

  let jevState = { ok: false, detail: config.jev.accessState };
  if (config.jev.accessState === 'enabled') {
    const credential = await secretReferenceState(config.jev.secretRef, {
      env,
      platform: capabilities.platform,
      readKeychain: capabilities.readKeychain,
    });
    jevState = {
      ok: credential.ok && Boolean(config.jev.model),
      detail: credential.ok ? `enabled with ${config.jev.model}; ${credential.detail}` : credential.detail,
    };
  } else if (config.jev.accessState === 'waitlisted') jevState.detail = 'waitlisted; no key required until access is granted';
  checks.push({ id: 'jev', severity: jevState.ok ? 'pass' : 'warn', detail: jevState.detail });
  return { ok: !checks.some((item) => item.severity === 'fail'), checks };
}

export async function doctorCommand(parsed, io) {
  const report = await doctor(parsed.options.home ?? process.cwd());
  for (const check of report.checks) io.out(`${check.severity.toUpperCase()} ${check.id}: ${check.detail}`);
  return report.ok ? 0 : 1;
}
