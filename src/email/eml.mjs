import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fingerprintMessage } from './dedupe.mjs';
import { recordEvent } from '../domain/events.mjs';

function parseHeaders(raw) {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

export function parseEml(text) {
  const match = text.match(/\r?\n\r?\n/);
  const splitAt = match?.index ?? text.length;
  const headers = parseHeaders(text.slice(0, splitAt));
  const body = match ? text.slice(splitAt + match[0].length) : '';
  const parsedDate = Date.parse(headers.date ?? '');
  return {
    messageId: headers['message-id'] ?? null,
    from: headers.from ?? '',
    to: headers.to ?? '',
    subject: headers.subject ?? '',
    sentAt: Number.isNaN(parsedDate) ? null : new Date(parsedDate).toISOString(),
    body,
  };
}

export function classifyEmail(message) {
  const text = `${message.subject}\n${message.body}`.toLowerCase();
  if (/offer|congratulations.*position|pleased to offer/.test(text)) return 'offer';
  if (/interview|schedule.*time|video cover letter/.test(text)) return 'interview';
  if (/assessment|coding challenge|complete.*test/.test(text)) return 'assessment';
  if (/not moving forward|other candidates|unfortunately|regret to inform/.test(text)) return 'rejection';
  if (/application (has been )?received|thank you for applying|application submitted/.test(text)) return 'application_confirmation';
  if (/newsletter|job alert|recommended jobs|talent community/.test(text)) return 'marketing';
  return 'unknown';
}

export { fingerprintMessage };

export async function importEml(db, file, options) {
  const account = db.prepare('SELECT id FROM email_accounts WHERE id = ?').get(options.accountId);
  if (!account) throw new Error(`Unknown email account: ${options.accountId}`);
  const message = parseEml(await readFile(file, 'utf8'));
  const fingerprint = fingerprintMessage(message);
  const traceId = `email-${createHash('sha256').update(`${options.accountId}\0${fingerprint}`).digest('hex').slice(0, 32)}`;
  if (db.prepare('SELECT 1 FROM decision_traces WHERE id = ?').get(traceId)) return { created: false, fingerprint };
  const classification = classifyEmail(message);
  const decision = { classification, fingerprint, subject: message.subject, from: message.from };
  db.prepare(`INSERT INTO decision_traces
    (id, application_id, engine, mode, decision_json, confidence, applied, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(traceId, options.applicationId ?? null, 'rules', 'email-ingest', JSON.stringify(decision), null, options.recordedAt ?? new Date().toISOString());
  if (options.applicationId) {
    recordEvent(db, {
      id: traceId,
      applicationId: options.applicationId,
      type: 'email_candidate',
      occurredAt: null,
      observedAt: message.sentAt ?? options.recordedAt ?? new Date().toISOString(),
      recordedAt: options.recordedAt ?? new Date().toISOString(),
      title: `Email candidate: ${classification}`,
      note: `${classification.replaceAll('_', ' ')} email detected; pending review before application status changes.`,
      source: { kind: 'email', accountId: options.accountId, messageId: message.messageId, from: message.from, subject: message.subject },
      statusAfter: null,
    });
  }
  return { created: true, classification, fingerprint, traceId };
}

