import { randomUUID } from 'node:crypto';
import { openHomeDatabase } from '../runtime/home.mjs';
import { recordEvent } from '../domain/events.mjs';

export async function eventCommand(parsed, io) {
  if (!['record', 'add'].includes(parsed.subcommand)) throw new Error('Usage: jobops event record|add');
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    const eventId = parsed.options['event-id'] ?? randomUUID();
    const existing = parsed.options['event-id']
      ? context.db.prepare('SELECT observed_at observedAt, recorded_at recordedAt FROM application_events WHERE id = ?').get(eventId)
      : null;
    const result = recordEvent(context.db, {
      id: eventId,
      applicationId: parsed.options.id,
      type: parsed.options.type ?? 'manual_update',
      occurredAt: parsed.options['occurred-at'] ?? null,
      observedAt: parsed.options['observed-at'] ?? existing?.observedAt ?? new Date().toISOString(),
      recordedAt: parsed.options['recorded-at'] ?? existing?.recordedAt ?? new Date().toISOString(),
      title: parsed.options.title,
      note: parsed.options.note ?? '',
      source: { kind: parsed.options.source ?? 'user' },
      statusAfter: parsed.options['status-after'] ?? parsed.options.status ?? null,
    });
    io.out(JSON.stringify(result));
    return 0;
  } finally { context.db.close(); }
}
