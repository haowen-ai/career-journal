import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { renderScheduler } from './platform.mjs';
import { probeTaskRegistration } from './probe.mjs';
import { workspaceDirectory } from '../config/store.mjs';

const execFileDefault = promisify(execFileCallback);

async function readOptional(file, fs) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function withoutCronBlock(crontab, taskId) {
  const begin = `# BEGIN CAREER JOURNAL ${taskId}`;
  const end = `# END CAREER JOURNAL ${taskId}`;
  const lines = String(crontab ?? '').split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line === begin ? [index] : []);
  const ends = lines.flatMap((line, index) => line === end ? [index] : []);
  if (!starts.length && !ends.length) {
    const unchanged = lines.join('\n').replace(/\n+$/, '');
    return unchanged ? `${unchanged}\n` : '';
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw new Error(`Refusing to edit crontab: malformed or duplicate CAREER JOURNAL marker for ${taskId}`);
  }
  const kept = [...lines.slice(0, starts[0]), ...lines.slice(ends[0] + 1)];
  const result = kept.join('\n').replace(/\n+$/, '');
  return result ? `${result}\n` : '';
}

async function currentCrontab(execFile) {
  try {
    const result = await execFile('crontab', ['-l'], { encoding: 'utf8' });
    return typeof result === 'string' ? result : result.stdout ?? '';
  } catch (error) {
    const detail = `${error.stderr ?? ''}\n${error.message ?? ''}`;
    if (/no crontab/i.test(detail)) return '';
    throw error;
  }
}

function windowsTaskNotFound(value) {
  const detail = typeof value === 'string'
    ? value
    : `${value?.stderr ?? ''}\n${value?.message ?? ''}`;
  return /(?:the system cannot find (?:the file|the path) specified|cannot find the task named|specified task (?:name )?.* does not exist|cannot find the specified task)/i.test(detail);
}

export async function installNativeScheduler(task, runtime, options = {}) {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? execFileDefault;
  const fs = options.fs ?? { mkdir, readFile, rm, writeFile };
  const artifact = renderScheduler(task, runtime, platform);
  const probe = () => probeTaskRegistration(task, {
    platform,
    execFile,
    uid: options.uid,
    osHome: options.osHome,
    definitionContent: platform === 'darwin' ? artifact.content : undefined,
    systemTimezone: options.systemTimezone,
    now: options.now,
  });

  if (platform === 'darwin') {
    const destination = path.join(options.osHome ?? os.homedir(), 'Library', 'LaunchAgents', artifact.fileName);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const previous = await readOptional(destination, fs);
    await fs.writeFile(destination, artifact.content, { mode: 0o600 });
    const domain = `gui/${options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : '')}`;
    try {
      try { await execFile('launchctl', ['bootout', domain, destination], { encoding: 'utf8' }); } catch {}
      await execFile('launchctl', ['bootstrap', domain, destination], { encoding: 'utf8' });
      const verified = await probe();
      if (!verified.ok) throw new Error(verified.detail);
      return { installed: true, kind: artifact.kind, path: destination, probe: verified };
    } catch (error) {
      const rollbackErrors = [];
      try { await execFile('launchctl', ['bootout', domain, destination], { encoding: 'utf8' }); }
      catch (rollbackError) {
        if (!/not loaded|could not find|no such process/i.test(rollbackError.message ?? '')) rollbackErrors.push(rollbackError);
      }
      try {
        if (previous === null) await fs.rm(destination, { force: true });
        else {
          await fs.writeFile(destination, previous, { mode: 0o600 });
          await execFile('launchctl', ['bootstrap', domain, destination], { encoding: 'utf8' });
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `launchd installation failed (${error.message}) and rollback failed (${rollbackErrors.map((item) => item.message).join('; ')})`,
        );
      }
      throw new Error(`launchd installation failed: ${error.message}`);
    }
  }

  const schedulerDirectory = path.join(workspaceDirectory(runtime.home), 'schedulers');
  await fs.mkdir(schedulerDirectory, { recursive: true, mode: 0o700 });
  const destination = path.join(schedulerDirectory, artifact.fileName);
  await fs.writeFile(destination, artifact.content, { mode: 0o600 });

  if (platform === 'win32') {
    const existing = await probe();
    if (existing.ok) return { installed: true, unchanged: true, kind: artifact.kind, path: destination, probe: existing };
    if (/job exists but/i.test(existing.detail ?? '')) {
      throw new Error(`Windows Task Scheduler job already exists but does not match ${task.type}; remove it explicitly before installing`);
    }
    if (!windowsTaskNotFound(existing.detail)) {
      throw new Error(`Cannot safely determine whether the Windows Task Scheduler job exists: ${existing.detail}`);
    }
    let createSucceeded = false;
    try {
      await execFile('schtasks.exe', artifact.command, { encoding: 'utf8' });
      createSucceeded = true;
      const verified = await probe();
      if (!verified.ok) throw new Error(verified.detail);
      return { installed: true, kind: artifact.kind, path: destination, probe: verified };
    } catch (error) {
      if (!createSucceeded) throw new Error(`Windows Task Scheduler installation failed: ${error.message}`);
      const rollbackErrors = [];
      try {
        await execFile('schtasks.exe', ['/Delete', '/TN', task.config.registration.externalId, '/F'], { encoding: 'utf8' });
      } catch (rollbackError) {
        if (!windowsTaskNotFound(rollbackError)) rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Windows Task Scheduler installation failed (${error.message}) and rollback failed (${rollbackErrors.map((item) => item.message).join('; ')})`,
        );
      }
      throw new Error(`Windows Task Scheduler installation failed: ${error.message}`);
    }
  }

  const previous = await currentCrontab(execFile);
  const active = `${withoutCronBlock(previous, task.id)}${artifact.content}`;
  const activeFile = path.join(schedulerDirectory, `${task.id}.active-crontab`);
  const rollbackFile = path.join(schedulerDirectory, `${task.id}.rollback-crontab`);
  await fs.writeFile(activeFile, active, { mode: 0o600 });
  try {
    await execFile('crontab', [activeFile], { encoding: 'utf8' });
    const verified = await probe();
    if (!verified.ok) throw new Error(verified.detail);
    await fs.rm(activeFile, { force: true });
    return { installed: true, kind: artifact.kind, path: destination, probe: verified };
  } catch (error) {
    const rollbackErrors = [];
    try {
      await fs.writeFile(rollbackFile, previous, { mode: 0o600 });
      await execFile('crontab', [rollbackFile], { encoding: 'utf8' });
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    const cleanup = await Promise.allSettled([
      fs.rm(activeFile, { force: true }),
      fs.rm(rollbackFile, { force: true }),
    ]);
    rollbackErrors.push(...cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason));
    if (rollbackErrors.length) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `cron installation failed (${error.message}) and rollback failed (${rollbackErrors.map((item) => item.message).join('; ')})`,
      );
    }
    throw new Error(`cron installation failed: ${error.message}`);
  }
}
