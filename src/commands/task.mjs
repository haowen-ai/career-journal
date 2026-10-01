import { openHomeDatabase } from '../runtime/home.mjs';
import { listTasks, setTaskStatus, upsertTask } from '../domain/tasks.mjs';

const usage = 'Usage: career-journal task add|list|done|reopen';

function requiredTaskId(parsed) {
  const value = parsed.options['task-id'] ?? parsed.positionals[0];
  if (typeof value !== 'string' || !value.trim()) throw new Error('task-id is required');
  return value.trim();
}

export async function taskCommand(parsed, io) {
  if (!['add', 'list', 'done', 'reopen'].includes(parsed.subcommand)) throw new Error(usage);
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    if (parsed.subcommand === 'add') {
      const record = upsertTask(context.db, {
        id: parsed.options['task-id'],
        applicationId: parsed.options.id,
        kind: parsed.options.kind,
        title: parsed.options.title,
        platform: parsed.options.platform,
        link: parsed.options.link,
        dueAt: parsed.options['due-at'],
        dueNote: parsed.options['due-note'],
        status: parsed.options.status,
        note: parsed.options.note,
        source: parsed.options.source === undefined ? undefined : { kind: String(parsed.options.source) },
      });
      io.out(JSON.stringify(record));
      return 0;
    }
    if (parsed.subcommand === 'list') {
      const records = listTasks(context.db, { status: parsed.options.status ?? null });
      if (parsed.options.json) io.out(JSON.stringify(records, null, 2));
      else for (const item of records) io.out([item.id, item.dueAt ?? '-', item.status, item.kind, item.company, item.role, item.title].join('\t'));
      return 0;
    }
    const record = setTaskStatus(context.db, requiredTaskId(parsed), parsed.subcommand === 'done' ? 'done' : 'open');
    io.out(JSON.stringify(record));
    return 0;
  } finally { context.db.close(); }
}
