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
} from '../automation/registry.mjs';
import { runDeadlineReview, runDailyConsolidation } from '../automation/tasks.mjs';
import { nativeSchedulerRegistration } from '../automation/platform.mjs';
import { installNativeScheduler } from '../automation/native-scheduler.mjs';
import { codexCommandLineForTask, probeTaskRegistration } from '../automation/probe.mjs';
import { createBackup } from './backup.mjs';
import { randomUUID } from 'node:crypto';
import { saveConfig, workspaceDirectory } from '../config/store.mjs';
import { syncImapEmailAccount } from '../email/imap-sync.mjs';
import { isLiveVerifiedEmailAccount, listEmailAccounts } from '../email/accounts.mjs';
import { configuredDecisionAdapters } from './email.mjs';

const HOST_SYNC_RUN_MAX_AGE_MS = 30 * 60 * 1000;

const automationId = (parsed, tasks = []) => parsed.options.id
  ?? (parsed.options.task ? tasks.find((task) => task.type === parsed.options.task)?.id ?? `career-journal-${parsed.options.task}` : null);

async function persistAutomationState(context) {
  context.config.automation = { ...context.config.automation, setupState: automationSetupState(listTasks(context.db)) };
  context.config.updatedAt = new Date().toISOString();
  await saveConfig(context.root, context.config);
}

export async function automationCommand(parsed, io, runtime) {
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    if (['configure', 'update'].includes(parsed.subcommand)) {
      const tasks = listTasks(context.db);
      const existing = tasks.find((task) => task.id === automationId(parsed, tasks));
      const enabled = parsed.options.enabled === true ? true : parsed.options.disabled === true ? false : existing?.enabled;
      const task = upsertTask(context.db, {
        type: parsed.options.task,
        enabled,
        timezone: parsed.options.timezone ?? existing?.timezone ?? context.config.timezone,
        time: parsed.options.time ?? existing?.schedule,
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
          ? { codexCommandLine: codexCommandLineForTask(task) }
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
          systemTimezone: runtime.systemTimezone,
        });
      if (!probe?.ok) throw new Error(`Scheduler verification failed: ${probe?.detail ?? 'job not found'}`);
      const verified = verifyTaskRegistration(context.db, task.id, {
        method: task.config.registration.driver === 'codex' ? 'trusted-host' : 'native-probe',
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
      context.db.exec('BEGIN IMMEDIATE');
      let installed;
      try {
        const claimed = markTaskRegistration(context.db, existing.id, native);
        installed = runtime.scheduler?.install
          ? await runtime.scheduler.install(claimed, schedulerRuntime)
          : await installNativeScheduler(claimed, schedulerRuntime, { platform });
        if (!installed?.probe?.ok) throw new Error(`Scheduler installation could not be verified: ${installed?.probe?.detail ?? 'no probe evidence'}`);
        verifyTaskRegistration(context.db, claimed.id, {
          method: 'native-probe', evidenceDigest: installed.probe.evidenceDigest,
        });
        context.db.exec('COMMIT');
      } catch (error) {
        if (context.db.inTransaction) context.db.exec('ROLLBACK');
        throw error;
      }
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
