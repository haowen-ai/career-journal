import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fingerprintMessage } from './dedupe.mjs';
import { recordEvent } from '../domain/events.mjs';
import { decide } from '../decision/router.mjs';
import { classifyEmailWithRules } from '../decision/rules.mjs';

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
  return classifyEmailWithRules(`${message.subject}\n${message.body}`).classification;
}

export { fingerprintMessage };

function messageContentHash(message) {
  return createHash('sha256').update(JSON.stringify({
    from: message.from,
    to: message.to,
    subject: message.subject,
    sentAt: message.sentAt,
    body: message.body,
  })).digest('hex');
}

export async function importEml(db, file, options, adapters = {}) {
  const account = db.prepare('SELECT id FROM email_accounts WHERE id = ?').get(options.accountId);
  if (!account) throw new Error(`Unknown email account: ${options.accountId}`);
  const message = parseEml(await readFile(file, 'utf8'));
  const fingerprint = fingerprintMessage(message);
  const contentHash = messageContentHash(message);
  const traceId = `email-${createHash('sha256').update(`${options.accountId}\0${fingerprint}`).digest('hex').slice(0, 32)}`;
  const existing = db.prepare('SELECT decision_json decisionJson FROM decision_traces WHERE id = ?').get(traceId);
  if (existing) {
    const prior = JSON.parse(existing.decisionJson);
    if (prior.contentHash && prior.contentHash !== contentHash) throw new Error(`Email identity conflict: ${fingerprint}`);
    return { created: false, fingerprint };
  }
  const routed = await decide({ kind: 'email-classification', text: `${message.subject}\n${message.body}` }, adapters);
  const classification = routed.decision.classification;
  const decision = { ...routed.decision, fingerprint, contentHash, subject: message.subject, from: message.from, ...(routed.shadow ? { shadow: routed.shadow } : {}) };
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO decision_traces
      (id, application_id, engine, mode, decision_json, confidence, applied, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(traceId, options.applicationId ?? null, routed.engine, 'email-ingest', JSON.stringify(decision), routed.decision.confidence ?? null, routed.applied ? 1 : 0, recordedAt);
    if (options.applicationId) {
      recordEvent(db, {
        id: traceId,
        applicationId: options.applicationId,
        type: 'email_candidate',
        occurredAt: null,
        observedAt: message.sentAt ?? recordedAt,
        recordedAt,
        title: `Email candidate: ${classification}`,
        note: `${classification.replaceAll('_', ' ')} email detected; pending review before application status changes.`,
        source: { kind: 'email', accountId: options.accountId, messageId: message.messageId, from: message.from, subject: message.subject },
        statusAfter: null,
      }, { withinTransaction: true });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { created: true, classification, fingerprint, traceId, engine: routed.engine };
}
