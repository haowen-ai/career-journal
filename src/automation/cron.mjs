const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

export function renderCron(task, runtime) {
  const [hour, minute] = task.schedule.split(':');
  const command = [runtime.node, runtime.cli, 'automation', 'run', '--id', task.id, '--home', runtime.home,
    '--external-id', task.config.registration.externalId].map(quote).join(' ');
  return {
    kind: 'cron',
    fileName: `${task.id}.cron`,
    content: `# BEGIN CAREER JOURNAL ${task.id}\nCRON_TZ=${task.timezone}\n${Number(minute)} ${Number(hour)} * * * ${command}\n# END CAREER JOURNAL ${task.id}\n`,
  };
}
