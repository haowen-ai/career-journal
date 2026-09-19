import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { openHomeDatabase } from '../runtime/home.mjs';
import { upsertTask, listTasks, disableTask, removeTask, runTask } from '../automation/registry.mjs';
import { renderScheduler } from '../automation/platform.mjs';
import { createBackup } from './backup.mjs';
import { randomUUID } from 'node:crypto';

const automationId = (parsed) => parsed.options.id ?? (parsed.options.task ? `jobops-${parsed.options.task}` : null);

export async function automationCommand(parsed, io, runtime) {
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    if (['configure', 'update'].includes(parsed.subcommand)) {
      const enabled = parsed.options.enabled === true ? true : parsed.options.disabled === true ? false : undefined;
      const task = upsertTask(context.db, {
        type: parsed.options.task,
        enabled,
        timezone: parsed.options.timezone ?? context.config.timezone,
        time: parsed.options.time,
        accountId: parsed.options.account ?? null,
        notificationPolicy: parsed.options.notify ?? 'actionable',
      });
      io.out(JSON.stringify(task, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'list') {
      io.out(JSON.stringify(listTasks(context.db), null, 2));
      return 0;
    }
    if (parsed.subcommand === 'disable') {
      io.out(JSON.stringify(disableTask(context.db, automationId(parsed)), null, 2));
      return 0;
    }
    if (parsed.subcommand === 'remove') {
      io.out(JSON.stringify({ removed: removeTask(context.db, automationId(parsed)) }));
      return 0;
    }
    if (parsed.subcommand === 'run') {
      const handlers = {
        'local-backup': async (task) => {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const output = path.join(context.root, '.jobops', 'backups', `${stamp}-${randomUUID().slice(0, 8)}`);
          await createBackup(context.root, output, { version: runtime.version });
          return { cursor: task.cursor, changed: 1, message: `Backup created at ${output}` };
        },
      };
      const result = await runTask(context.db, automationId(parsed), {
        dryRun: parsed.options['dry-run'] === true,
        handler: async (task) => {
          const handler = handlers[task.type];
          if (!handler) throw new Error(`Automation adapter unavailable for ${task.type}`);
          return handler(task);
        },
      });
      if (result.changed || parsed.options['dry-run']) io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'install') {
      const task = listTasks(context.db).find((item) => item.id === automationId(parsed));
      if (!task) throw new Error('Unknown automation');
      const artifact = renderScheduler(task, { node: process.execPath, cli: path.join(runtime.root, 'bin', 'jobops.mjs'), home: context.root });
      const directory = path.join(context.root, '.jobops', 'schedulers');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = path.join(directory, artifact.fileName);
      await writeFile(destination, artifact.content, { mode: 0o600 });
      io.out(JSON.stringify({ prepared: true, kind: artifact.kind, path: destination }, null, 2));
      return 0;
    }
    if (parsed.subcommand === 'uninstall') {
      const id = automationId(parsed);
      const directory = path.join(context.root, '.jobops', 'schedulers');
      const candidates = [`io.job-search-ops.${id.replace(/^jobops-/, '')}.plist`, `${id}.cron`, `${id}.txt`];
      for (const file of candidates) await rm(path.join(directory, file), { force: true });
      io.out(JSON.stringify({
        definitionRemoved: true,
        schedulerRegistrationRemoved: false,
        id,
        next: 'If you loaded this definition, unload it with the platform command documented in README.md.',
      }));
      return 0;
    }
    throw new Error('Usage: jobops automation configure|list|run|update|disable|remove|install|uninstall');
  } finally { context.db.close(); }
}
