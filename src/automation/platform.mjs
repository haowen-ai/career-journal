import { renderLaunchd } from './launchd.mjs';
import { renderCron } from './cron.mjs';
import { renderWindows } from './windows.mjs';

export function renderScheduler(task, runtime, platform = process.platform) {
  if (platform === 'darwin') return renderLaunchd(task, runtime);
  if (platform === 'win32') return renderWindows(task, runtime);
  return renderCron(task, runtime);
}

