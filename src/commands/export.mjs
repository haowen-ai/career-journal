import { writeFile } from 'node:fs/promises';
import { openHomeDatabase } from '../runtime/home.mjs';
import { listApplications } from './application.mjs';

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const csv = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function snapshot(db) {
  return listApplications(db).map((application) => ({
    ...application,
    events: db.prepare(`SELECT id, event_type type, occurred_at occurredAt, observed_at observedAt,
      recorded_at recordedAt, title, note, source_json source, status_after statusAfter
      FROM application_events WHERE application_id = ? ORDER BY recorded_at, id`).all(application.id)
      .map((event) => ({ ...event, source: JSON.parse(event.source) })),
    artifacts: db.prepare(`SELECT id, kind, lifecycle, file_name fileName, sha256, submitted_at submittedAt,
      recorded_at recordedAt, verification FROM artifacts WHERE application_id = ? ORDER BY recorded_at, id`).all(application.id),
  }));
}

export async function exportCommand(parsed, io) {
  const format = parsed.subcommand;
  if (!['json', 'markdown', 'csv'].includes(format)) throw new Error('Usage: jobops export json|markdown|csv --output <file>');
  if (!parsed.options.output) throw new Error('output is required');
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  try {
    const records = snapshot(context.db);
    let output;
    if (format === 'json') output = `${JSON.stringify(records, null, 2)}\n`;
    else if (format === 'markdown') output = `# Applications\n\n| Company | Role | Status | Applied |\n|---|---|---|---|\n${records.map((item) => `| ${cell(item.company)} | ${cell(item.role)} | ${cell(item.status)} | ${cell(item.appliedAt)} |`).join('\n')}\n`;
    else output = `company,role,status,appliedAt\n${records.map((item) => [item.company, item.role, item.status, item.appliedAt].map(csv).join(',')).join('\n')}\n`;
    await writeFile(parsed.options.output, output, { mode: 0o600 });
    io.out(parsed.options.output);
    return 0;
  } finally { context.db.close(); }
}

