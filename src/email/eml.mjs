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

function existingImport(db, traceId, contentHash, fingerprint) {
  const existing = db.prepare('SELECT decision_json decisionJson FROM decision_traces WHERE id = ?').get(traceId);
  if (!existing) return null;
  const prior = JSON.parse(existing.decisionJson);
  if (prior.contentHash && prior.contentHash !== contentHash) throw new Error(`Email identity conflict: ${fingerprint}`);
  return { created: false, fingerprint };
}

export async function prepareMessageImport(db, message, options, adapters = {}) {
  const account = db.prepare('SELECT id FROM email_accounts WHERE id = ?').get(options.accountId);
  if (!account) throw new Error(`Unknown email account: ${options.accountId}`);
  const fingerprint = fingerprintMessage(message);
  const contentHash = messageContentHash(message);
  const traceId = `email-${createHash('sha256').update(`${options.accountId}\0${fingerprint}`).digest('hex').slice(0, 32)}`;
  const existing = existingImport(db, traceId, contentHash, fingerprint);
  if (existing) return { state: 'existing', result: existing };
  const routed = await decide({ kind: 'email-classification', text: `${message.subject}\n${message.body}` }, adapters);
  const classification = routed.decision.classification;
  const decision = { ...routed.decision, fingerprint, contentHash, subject: message.subject, from: message.from, ...(routed.shadow ? { shadow: routed.shadow } : {}) };
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  return {
    state: 'prepared',
    traceId,
    fingerprint,
    contentHash,
    message,
    options,
    routed,
    classification,
    decision,
    recordedAt,
  };
}

export function commitPreparedMessageImport(db, prepared, { withinTransaction = false } = {}) {
  if (prepared.state === 'existing') return prepared.result;
  const raced = existingImport(db, prepared.traceId, prepared.contentHash, prepared.fingerprint);
  if (raced) return raced;
  if (!withinTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO decision_traces
      (id, application_id, engine, mode, decision_json, confidence, applied, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(prepared.traceId, prepared.options.applicationId ?? null, prepared.routed.engine, 'email-ingest', JSON.stringify(prepared.decision), prepared.routed.decision.confidence ?? null, prepared.routed.applied ? 1 : 0, prepared.recordedAt);
    if (prepared.options.applicationId && prepared.classification !== 'marketing') {
      recordEvent(db, {
        id: prepared.traceId,
        applicationId: prepared.options.applicationId,
        type: 'email_candidate',
        occurredAt: null,
        observedAt: prepared.message.sentAt ?? prepared.recordedAt,
        recordedAt: prepared.recordedAt,
        title: `Email candidate: ${prepared.classification}`,
        note: `${prepared.classification.replaceAll('_', ' ')} email detected; pending review before application status changes.`,
        source: { kind: 'email', accountId: prepared.options.accountId, messageId: prepared.message.messageId, from: prepared.message.from, subject: prepared.message.subject },
        statusAfter: null,
      }, { withinTransaction: true });
    }
    if (!withinTransaction) db.exec('COMMIT');
  } catch (error) {
    if (!withinTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return {
    created: true,
    classification: prepared.classification,
    fingerprint: prepared.fingerprint,
    traceId: prepared.traceId,
    engine: prepared.routed.engine,
  };
}

export async function importMessage(db, message, options, adapters = {}) {
  return commitPreparedMessageImport(db, await prepareMessageImport(db, message, options, adapters));
}

export async function importEml(db, file, options, adapters = {}) {
  return importMessage(db, parseEml(await readFile(file, 'utf8')), options, adapters);
}
