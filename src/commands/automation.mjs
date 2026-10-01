import { rm } from 'node:fs/promises';
import path from 'node:path';
import { openHomeDatabase } from '../runtime/home.mjs';
import {
  upsertTask,
  listTasks,
  disableTask,
  removeTask,
  runTask,
  markTaskRegistration,
  clearTaskRegistration,
  automationSetupState,
  verifyTaskRegistration,
  taskEmailAccountIds,
  AGENT_HOST_DRIVERS,
} from '../automation/registry.mjs';
import { runDeadlineReview, runDailyConsolidation } from '../automation/tasks.mjs';
import { nativeSchedulerRegistration } from '../automation/platform.mjs';
import { installNativeScheduler } from '../automation/native-scheduler.mjs';
import { hostCommandLineForTask, probeTaskRegistration } from '../automation/probe.mjs';
import { createBackup } from './backup.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { saveConfig, workspaceDirectory } from '../config/store.mjs';
import { syncImapEmailAccount } from '../email/imap-sync.mjs';
import { isLiveVerifiedEmailAccount, listEmailAccounts } from '../email/accounts.mjs';
import { configuredDecisionAdapters } from './email.mjs';
import { loadScanProfile } from '../scan/profile-input.mjs';
import { scanFailed, scanWithContext } from './scan.mjs';

const HOST_SYNC_RUN_MAX_AGE_MS = 30 * 60 * 1000;

const automationId = (parsed, tasks = []) => parsed.options.id
  ?? (parsed.options.task ? tasks.find((task) => task.type === parsed.options.task)?.id ?? `career-journal-${parsed.options.task}` : null);

async function persistAutomationState(context) {
  context.config.automation = { ...context.config.automation, setupState: automationSetupState(listTasks(context.db)) };
  context.config.updatedAt = new Date().toISOString();
  await saveConfig(context.root, context.config);
}

// Claims the native registration, installs the scheduler job, and records its probe evidence
// in one transaction, so a failed install or probe leaves no claim behind. node:sqlite reports
// an open transaction through isTransaction.
export async function installNativeRegistration(db, taskId, registration, install) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const claimed = markTaskRegistration(db, taskId, registration);
    const installed = await install(claimed);
    if (!installed?.probe?.ok) throw new Error(`Scheduler installation could not be verified: ${installed?.probe?.detail ?? 'no probe evidence'}`);
    verifyTaskRegistration(db, claimed.id, {
      method: 'native-probe', evidenceDigest: installed.probe.evidenceDigest,
    });
    db.exec('COMMIT');
    return installed;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export async function automationCommand(parsed, io, runtime) {
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    if (['configure', 'update'].includes(parsed.subcommand)) {
      const tasks = listTasks(context.db);
      const existing = tasks.find((task) => task.id === automationId(parsed, tasks));
      const enabled = parsed.options.enabled === true ? true : parsed.options.disabled === true ? false : existing?.enabled;
      // role-scan defaults to the profile's pace.scanTime when no time is given.
      const profileScanTime = parsed.options.task === 'role-scan' && !parsed.options.time && !existing?.schedule
        ? (await loadScanProfile(context.root, { path: typeof parsed.options.profile === 'string' ? parsed.options.profile : undefined })).pace.scanTime ?? '08:00'
        : null;
      const task = upsertTask(context.db, {
        type: parsed.options.task,
        enabled,
        timezone: parsed.options.timezone ?? existing?.timezone ?? context.config.timezone,
        time: parsed.options.time ?? existing?.schedule ?? profileScanTime,
        accountId: Object.hasOwn(parsed.options, 'account') ? parsed.options.account : existing?.accountId ?? null,
        notificationPolicy: parsed.options.notify ?? existing?.notificationPolicy ?? 'actionable',
      });
      await persistAutomationState(context);
      io.out(JSON.stringify(task, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'list') {
      io.out(JSON.stringify(listTasks(context.db), null, 2));
      return 0;
    }
    if (parsed.subcommand === 'register-external') {
      const tasks = listTasks(context.db);
      const task = markTaskRegistration(context.db, automationId(parsed, tasks), {
        driver: parsed.options.driver,
        externalId: parsed.options['external-id'],
        execution: {
          node: process.execPath,
          cli: path.join(runtime.root, 'bin', 'career-journal.mjs'),
          home: context.root,
          platform: runtime.platform ?? process.platform,
        },
      });
      await persistAutomationState(context);
      io.out(JSON.stringify({
        ...task,
        ...(task.config.registration.driver === 'codex'
          ? { codexCommandLine: hostCommandLineForTask(task) }
          : {}),
        ...(task.config.registration.driver === 'claude-code'
          ? { claudeCodeCommandLine: hostCommandLineForTask(task) }
          : {}),
      }, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'unregister-external') {
      const task = clearTaskRegistration(context.db, automationId(parsed, listTasks(context.db)));
      await persistAutomationState(context);
      io.out(JSON.stringify(task, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'verify') {
      const task = listTasks(context.db).find((item) => item.id === automationId(parsed, listTasks(context.db)));
      if (!task) throw new Error('Unknown automation');
      const probe = runtime.scheduler?.probe
        ? await runtime.scheduler.probe(task)
        : await probeTaskRegistration(task, {
          platform: runtime.platform ?? process.platform,
          codexHome: runtime.codexHome,
          claudeHome: runtime.claudeHome,
          claudeAppSupport: runtime.claudeAppSupport,
          systemTimezone: runtime.systemTimezone,
        });
      if (!probe?.ok) throw new Error(`Scheduler verification failed: ${probe?.detail ?? 'job not found'}`);
      const verified = verifyTaskRegistration(context.db, task.id, {
        method: AGENT_HOST_DRIVERS.includes(task.config.registration.driver) ? 'trusted-host' : 'native-probe',
        evidenceDigest: probe.evidenceDigest,
      });
      await persistAutomationState(context);
      io.out(JSON.stringify({ verified: true, task: verified, probe: { detail: probe.detail } }, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'disable') {
      const task = disableTask(context.db, automationId(parsed, listTasks(context.db)));
      await persistAutomationState(context);
      io.out(JSON.stringify(task, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'remove') {
      const removed = removeTask(context.db, automationId(parsed, listTasks(context.db)));
      await persistAutomationState(context);
      io.out(JSON.stringify({ removed }));
      return 0;
    }
    if (parsed.subcommand === 'run') {
      const handlers = {
        'mail-sync': async (task) => {
          const sync = runtime.email?.syncImap ?? syncImapEmailAccount;
          const accountIds = taskEmailAccountIds(task);
          if (!accountIds.length) throw new Error('mail-sync has no selected job-search mailbox');
          const accounts = new Map(listEmailAccounts(context.db).map((account) => [account.id, account]));
          const results = [];
          for (const accountId of accountIds) {
            const account = accounts.get(accountId);
            if (!account) throw new Error(`Selected email account is missing: ${accountId}`);
            if (account.provider === 'imap') {
              results.push(await sync(context.db, accountId, {
                externalTaskId: task.config.registration.externalId,
                ...(runtime.emailCapabilities ?? {}),
              }, configuredDecisionAdapters(context.config)));
            } else if (account.provider === 'host') {
              const reference = Date.now();
              const successfulAt = Date.parse(account.lastSuccessAt ?? '');
              const fetchedAt = Date.parse(account.lastFetchedAt ?? '');
              const freshForRun = [successfulAt, fetchedAt].every((value) => !Number.isNaN(value)
                && value <= reference + 5 * 60 * 1000
                && reference - value <= HOST_SYNC_RUN_MAX_AGE_MS);
              if (!isLiveVerifiedEmailAccount(account) || account.error) {
                throw new Error(`Host mailbox ${account.address} needs a fresh trusted-host verification and read-only sync`);
              }
              if (!freshForRun) {
                throw new Error(`Host mailbox ${account.address} needs a fresh host sync immediately before automation run`);
              }
              results.push({ accountId, changed: 0, created: 0, cursor: account.cursor });
            } else {
              throw new Error(`Unsupported daily email provider for ${accountId}`);
            }
          }
          const changed = results.reduce((total, result) => total + (result.changed ?? result.created ?? 0), 0);
          const cursor = accountIds.length === 1 ? results[0].cursor ?? task.cursor : JSON.stringify(results.map((result) => [result.accountId, result.cursor ?? null]));
          return { accounts: results, changed, cursor };
        },
        'deadline-review': async (task) => runDeadlineReview(context.db, task),
        'role-scan': async () => {
          const profile = await loadScanProfile(context.root);
          const summary = await scanWithContext(context, profile, runtime);
          if (scanFailed(summary)) throw new Error('Every role-scan source failed; nothing new was queued');
          const queuedIds = summary.queued.map((item) => item.id).filter(Boolean);
          return {
            cursor: `sha256:${createHash('sha256').update(JSON.stringify({ type: 'role-scan', at: summary.scannedAt, queuedIds })).digest('hex')}`,
            changed: queuedIds.length,
            message: queuedIds.length ? `${queuedIds.length} new role(s) queued` : 'No new roles matched the profile',
            counts: summary.counts,
            dropReasons: summary.dropReasons,
            sources: summary.sources,
            queued: summary.queued,
          };
        },
        'daily-consolidation': async (task) => runDailyConsolidation(context.db, task, { home: context.root }),
        'local-backup': async (task) => {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const output = path.join(workspaceDirectory(context.root), 'backups', `${stamp}-${randomUUID().slice(0, 8)}`);
          await createBackup(context.root, output, { version: runtime.version });
          return { cursor: task.cursor, changed: 1, message: `Backup created at ${output}` };
        },
      };
      const result = await runTask(context.db, automationId(parsed, listTasks(context.db)), {
        dryRun: parsed.options['dry-run'] === true,
        externalId: parsed.options['external-id'] ?? null,
        handler: async (task) => {
          const handler = handlers[task.type];
          if (!handler) throw new Error(`Automation adapter unavailable for ${task.type}`);
          return handler(task);
        },
      });
      if (parsed.options['dry-run'] !== true) await persistAutomationState(context);
      if (result.changed || parsed.options['dry-run']) io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'install') {
      const tasks = listTasks(context.db);
      const existing = tasks.find((item) => item.id === automationId(parsed, tasks));
      if (!existing) throw new Error('Unknown automation');
      if (existing.type === 'mail-sync') {
        throw new Error('Native mail-sync requires a secure scheduler credential provider; configure a trusted external scheduler that supplies the configured env secret and verify it');
      }
      const platform = runtime.platform ?? process.platform;
      const schedulerRuntime = {
        node: process.execPath,
        cli: path.join(runtime.root, 'bin', 'career-journal.mjs'),
        home: context.root,
        platform,
      };
      const native = { ...nativeSchedulerRegistration(existing, platform), execution: schedulerRuntime };
      const installed = await installNativeRegistration(context.db, existing.id, native, (claimed) => (runtime.scheduler?.install
        ? runtime.scheduler.install(claimed, schedulerRuntime)
        : installNativeScheduler(claimed, schedulerRuntime, { platform })));
      await persistAutomationState(context);
      io.out(JSON.stringify({
        installed: true,
        kind: installed.kind,
        path: installed.path,
        probe: { detail: installed.probe.detail },
      }, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'uninstall') {
      const tasks = listTasks(context.db);
      const id = automationId(parsed, tasks);
      const storedTask = tasks.find((task) => task.id === id);
      const type = parsed.options.task ?? storedTask?.type ?? id?.replace(/^(?:career-journal|jobops)-/, '');
      const directory = path.join(workspaceDirectory(context.root), 'schedulers');
      const candidateIds = new Set([id, `career-journal-${type}`, `jobops-${type}`].filter(Boolean));
      const candidates = [
        `io.career-journal.${type}.plist`,
        `io.job-search-ops.${type}.plist`,
        ...[...candidateIds].flatMap((candidate) => [`${candidate}.cron`, `${candidate}.txt`]),
      ];
      for (const file of candidates) await rm(path.join(directory, file), { force: true });
      const localRegistrationCleared = Boolean(storedTask?.config.registration);
      if (storedTask) clearTaskRegistration(context.db, storedTask.id);
      await persistAutomationState(context);
      io.out(JSON.stringify({
        definitionRemoved: true,
        schedulerRegistrationRemoved: false,
        localRegistrationCleared,
        id,
        next: 'If you loaded this definition, unload it with the platform command documented in README.md.',
      }));
      return 0;
    }
    throw new Error('Usage: career-journal automation configure|list|run|update|disable|remove|install|verify|uninstall|register-external|unregister-external');
  } finally { context.db.close(); }
}
