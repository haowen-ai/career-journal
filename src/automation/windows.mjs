export function renderWindows(task, runtime) {
  const taskName = `JobSearchOps-${task.type}`;
  const action = `"${runtime.node}" "${runtime.cli}" automation run --id ${task.id} --home "${runtime.home}"`;
  return {
    kind: 'schtasks',
    fileName: `${task.id}.txt`,
    command: ['/Create', '/F', '/SC', 'DAILY', '/TN', taskName, '/TR', action, '/ST', task.schedule],
    content: `schtasks ${['/Create', '/F', '/SC', 'DAILY', '/TN', taskName, '/TR', action, '/ST', task.schedule].map((item) => `"${item.replace(/"/g, '\\"')}"`).join(' ')}\n`,
  };
}

