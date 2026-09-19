import { quoteWindowsArgument } from './windows-argv.mjs';

export function renderWindows(task, runtime) {
  const taskName = task.id.startsWith('jobops-') ? `JobSearchOps-${task.type}` : `CareerJournal-${task.type}`;
  const action = [
    runtime.node, runtime.cli, 'automation', 'run', '--id', task.id, '--home', runtime.home,
    '--external-id', task.config.registration.externalId,
  ].map(quoteWindowsArgument).join(' ');
  return {
    kind: 'schtasks',
    fileName: `${task.id}.txt`,
    command: ['/Create', '/SC', 'DAILY', '/TN', taskName, '/TR', action, '/ST', task.schedule],
    content: `schtasks ${['/Create', '/SC', 'DAILY', '/TN', taskName, '/TR', action, '/ST', task.schedule].map((item) => `"${item.replace(/"/g, '\\"')}"`).join(' ')}\n`,
  };
}
