import { renderLaunchd } from './launchd.mjs';
import { renderCron } from './cron.mjs';
import { renderWindows } from './windows.mjs';
import { isCurrentTaskClaim } from './registry.mjs';

export function nativeSchedulerRegistration(task, platform = process.platform) {
  if (platform === 'darwin') {
    return {
      driver: 'launchd',
      externalId: task.id.startsWith('jobops-')
        ? `io.job-search-ops.${task.type}`
        : `io.career-journal.${task.type}`,
    };
  }
  if (platform === 'win32') {
    return {
      driver: 'schtasks',
      externalId: task.id.startsWith('jobops-')
        ? `JobSearchOps-${task.type}`
        : `CareerJournal-${task.type}`,
    };
  }
  return { driver: 'cron', externalId: task.id };
}

function validateSchedulerValue(name, value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} contains an unsupported scheduler path value`);
  }
}

export function renderScheduler(task, runtime, platform = process.platform) {
  if (!isCurrentTaskClaim(task) || !task.config.registration.externalId) {
    throw new Error(`Run automation register-external for ${task.type} before rendering its scheduler definition`);
  }
  const expected = nativeSchedulerRegistration(task, platform);
  if (task.config.registration.driver !== expected.driver || task.config.registration.externalId !== expected.externalId) {
    throw new Error(`Scheduler claim does not match the native ${expected.driver} identity ${expected.externalId}`);
  }
  validateSchedulerValue('runtime.node', runtime.node);
  validateSchedulerValue('runtime.cli', runtime.cli);
  validateSchedulerValue('runtime.home', runtime.home);
  const execution = task.config.registration.execution;
  if (execution && (execution.node !== runtime.node || execution.cli !== runtime.cli || execution.home !== runtime.home)) {
    throw new Error('Scheduler runtime does not match the claimed execution binding');
  }
  if (platform === 'darwin') return renderLaunchd(task, runtime);
  if (platform === 'win32') return renderWindows(task, runtime);
  return renderCron(task, runtime);
}
