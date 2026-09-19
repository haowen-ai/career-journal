import { randomUUID } from 'node:crypto';
import { openHomeDatabase } from '../runtime/home.mjs';
import { recordEvent } from '../domain/events.mjs';

export async function eventCommand(parsed, io) {
  if (parsed.subcommand !== 'record') throw new Error('Usage: jobops event record');
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    const result = recordEvent(context.db, {
      id: parsed.options['event-id'] ?? randomUUID(),
      applicationId: parsed.options.id,
      type: parsed.options.type ?? 'manual_update',
      occurredAt: parsed.options['occurred-at'] ?? null,
      observedAt: parsed.options['observed-at'] ?? new Date().toISOString(),
      recordedAt: parsed.options['recorded-at'] ?? new Date().toISOString(),
      title: parsed.options.title,
      note: parsed.options.note ?? '',
      source: { kind: parsed.options.source ?? 'user' },
      statusAfter: parsed.options.status ?? null,
    });
    io.out(JSON.stringify(result));
    return 0;
  } finally { context.db.close(); }
}

