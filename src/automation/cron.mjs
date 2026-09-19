const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

export function renderCron(task, runtime) {
  const [hour, minute] = task.schedule.split(':');
  const command = [runtime.node, runtime.cli, 'automation', 'run', '--id', task.id, '--home', runtime.home].map(quote).join(' ');
  return { kind: 'cron', fileName: `${task.id}.cron`, content: `CRON_TZ=${task.timezone}\n${Number(minute)} ${Number(hour)} * * * ${command}\n` };
}

