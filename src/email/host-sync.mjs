import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { commitPreparedMessageImport, prepareMessageImport } from './eml.mjs';
import { isLiveVerifiedEmailAccount, recordImapVerification } from './accounts.mjs';
import { fetchImapMailbox } from './imap.mjs';
import { isCurrentTaskRegistration, taskEmailAccountIds } from '../automation/registry.mjs';

const MAX_BATCH_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_TEXT = 2 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COVERAGE_OVERLAP_MS = 60 * 60 * 1000;

function requiredString(value, name, max = MAX_MESSAGE_TEXT) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (Buffer.byteLength(value) > max) throw new Error(`${name} exceeds the size limit`);
  return value.trim();
}

function nullableCursor(input, name) {
  if (!Object.hasOwn(input, name)) throw new Error(`batch.${name} is required and may be null`);
  return input[name] === null ? null : requiredString(input[name], `batch.${name}`, 4096);
}

function isoDate(value, name) {
  const raw = requiredString(value, name, 128);
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) throw new Error(`${name} must be an ISO date-time`);
  return new Date(timestamp).toISOString();
}

function rollingCoverage(input, fetchedAt) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('batch.coverage is required');
  }
  if (input.mode !== 'rolling-24h-all-messages') {
    throw new Error('batch.coverage.mode must be rolling-24h-all-messages');
  }
  if (input.allMessages !== true) throw new Error('batch.coverage.allMessages must be true');
  if (input.paginationComplete !== true) throw new Error('batch.coverage.paginationComplete must be true');
  const windowStart = isoDate(input.windowStart, 'batch.coverage.windowStart');
  const windowEnd = isoDate(input.windowEnd, 'batch.coverage.windowEnd');
  const duration = Date.parse(windowEnd) - Date.parse(windowStart);
  if (duration < DAY_MS || duration > DAY_MS + MAX_COVERAGE_OVERLAP_MS) {
    throw new Error('batch.coverage must span the complete previous 24 hours with at most one hour of overlap');
  }
  const fetchLag = Date.parse(fetchedAt) - Date.parse(windowEnd);
  if (fetchLag < 0 || fetchLag > 5 * 60 * 1000) {
    throw new Error('batch.coverage.windowEnd must be no later than five minutes before fetchedAt');
  }
  return {
    mode: input.mode,
    windowStart,
    windowEnd,
    allMessages: true,
    paginationComplete: true,
  };
}

function normalizeMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Each batch message must be an object');
  const sentAt = input.sentAt == null ? null : isoDate(input.sentAt, 'message.sentAt');
  const body = input.body == null ? '' : String(input.body);
  if (Buffer.byteLength(body) > MAX_MESSAGE_TEXT) throw new Error('message.body exceeds the size limit');
  return {
    messageId: input.messageId ? requiredString(input.messageId, 'message.messageId', 512) : `<${requiredString(input.sourceId, 'message.sourceId', 512)}>`,
    from: requiredString(input.from, 'message.from', 4096),
    to: requiredString(input.to, 'message.to', 4096),
    subject: requiredString(input.subject, 'message.subject', 32_768),
    sentAt,
    body,
    applicationId: input.applicationId ? requiredString(input.applicationId, 'message.applicationId', 512) : null,
  };
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function matchApplication(db, message) {
  if (message.applicationId) {
    return db.prepare('SELECT id FROM applications WHERE id = ?').get(message.applicationId)?.id ?? null;
  }
  const text = normalized(`${message.subject}\n${message.body}`);
  const matches = db.prepare('SELECT id, company, role, external_id externalId FROM applications').all()
    .map((application) => {
      const externalId = normalized(application.externalId);
      const company = normalized(application.company);
      const role = normalized(application.role);
      const externalMatch = Boolean(externalId && text.includes(externalId));
      const companyRoleMatch = Boolean(company && role && text.includes(company) && text.includes(role));
      return { id: application.id, score: externalMatch ? 2 : companyRoleMatch ? 1 : 0 };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  if (!matches.length || matches[1]?.score === matches[0].score) return null;
  return matches[0].id;
}

function hashBatch(batch) {
  const { cursor: _cursor, ...payload } = batch;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function registeredMailTask(db, accountId, externalTaskId) {
  const tasks = db.prepare(`SELECT id, task_type type, enabled, timezone, schedule, account_id accountId,
    notification_policy notificationPolicy, cursor, config_json configJson FROM automations
    WHERE task_type = 'mail-sync' ORDER BY id`).all()
    .map((task) => {
      let config;
      try { config = JSON.parse(task.configJson); }
      catch { config = {}; }
      return { ...task, enabled: Boolean(task.enabled), config };
    })
    .filter((task) => taskEmailAccountIds(task).includes(accountId));
  const matches = tasks.filter((task) => task.config.registration?.externalId === externalTaskId);
  if (matches.length !== 1) throw new Error('Batch externalTaskId does not match one registered mail-sync task for the account');
  const task = matches[0];
  if (!isCurrentTaskRegistration(task)) throw new Error('Mail-sync scheduler attestation is not current for its task binding');
  return task;
}

function validateMailboxBatch(input, { requireCoverage = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Host sync batch must be an object');
  const accountId = requiredString(input.accountId, 'batch.accountId', 512);
  const connector = requiredString(input.connector, 'batch.connector', 128);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(connector)) throw new Error('batch.connector is invalid');
  if (input.readOnly !== true) throw new Error('batch.readOnly must be true');
  const beforeCursor = nullableCursor(input, 'beforeCursor');
  const afterCursor = requiredString(input.afterCursor, 'batch.afterCursor', 4096);
  const runId = requiredString(input.runId, 'batch.runId', 512);
  const fetchedAt = isoDate(input.fetchedAt, 'batch.fetchedAt');
  const coverage = requireCoverage
    ? rollingCoverage(input.coverage, fetchedAt)
    : input.coverage ? rollingCoverage(input.coverage, fetchedAt) : null;
  const externalTaskId = requiredString(input.externalTaskId, 'batch.externalTaskId', 512);
  if (!Array.isArray(input.messages) || input.messages.length > MAX_MESSAGES) {
    throw new Error(`batch.messages must contain at most ${MAX_MESSAGES} items`);
  }
  return {
    accountId,
    connector,
    readOnly: true,
    beforeCursor,
    afterCursor,
    cursor: afterCursor,
    runId,
    fetchedAt,
    ...(coverage ? { coverage } : {}),
    externalTaskId,
    messages: input.messages.map(normalizeMessage),
  };
}

export function validateHostBatch(input) {
  return validateMailboxBatch(input, { requireCoverage: true });
}

export async function loadHostBatch(file) {
  const details = await stat(file);
  if (details.size > MAX_BATCH_BYTES) throw new Error('Host sync batch exceeds the size limit');
  return validateHostBatch(JSON.parse(await readFile(file, 'utf8')));
}

async function syncMailboxBatch(db, accountId, rawBatch, adapters, now, expectedProvider) {
  const batch = validateMailboxBatch(rawBatch, { requireCoverage: expectedProvider === 'host' });
  if (batch.accountId !== accountId) throw new Error('Batch accountId must match the requested account');
  const account = db.prepare(`SELECT id, provider, address, read_only readOnly, cursor, revision,
    last_run_id lastRunId, last_batch_hash lastBatchHash, last_fetched_at lastFetchedAt,
    config_json settings FROM email_accounts WHERE id = ?`).get(accountId);
  if (!account) throw new Error(`Unknown email account: ${accountId}`);
  if (!account.readOnly || account.provider !== expectedProvider) {
    throw new Error(expectedProvider === 'host'
      ? 'Host batch sync requires a host-managed read-only email account'
      : 'Direct IMAPS sync requires a read-only IMAP account');
  }
  let settings;
  try { settings = JSON.parse(account.settings); }
  catch { throw new Error('Configured email account settings are invalid'); }
  account.settings = settings;
  if (account.provider === 'imap' && !isLiveVerifiedEmailAccount(account, now)) {
    throw new Error('IMAP batch sync requires a fresh live IMAPS verification; caller JSON cannot establish mailbox identity');
  }
  const expectedConnector = account.provider === 'host' ? settings.connector : 'imap';
  if (expectedConnector !== batch.connector) throw new Error('Batch connector must match the configured account connector');
  const task = registeredMailTask(db, accountId, batch.externalTaskId);
  const currentCursor = account.cursor ?? null;
  const selectedAccountIds = taskEmailAccountIds(task);
  const singleAccount = selectedAccountIds.length === 1;
  if (singleAccount && (task.cursor ?? null) !== currentCursor) throw new Error('Mail-sync task cursor does not match the configured account cursor');

  const batchHash = hashBatch(batch);
  if (account.lastRunId === batch.runId) {
    if (account.lastBatchHash !== batchHash) throw new Error(`Host sync replay conflict for runId ${batch.runId}`);
    return {
      accountId,
      beforeCursor: batch.beforeCursor,
      afterCursor: currentCursor,
      cursor: currentCursor,
      runId: batch.runId,
      examined: 0,
      created: 0,
      replayed: true,
    };
  }
  if (currentCursor !== batch.beforeCursor) {
    throw new Error(`Stale host sync cursor: expected ${currentCursor ?? 'null'}, received ${batch.beforeCursor ?? 'null'}`);
  }
  if (account.lastFetchedAt && Date.parse(batch.fetchedAt) <= Date.parse(account.lastFetchedAt)) {
    throw new Error(`Out-of-order host sync batch: fetchedAt must be later than ${account.lastFetchedAt}`);
  }

  const attempted = db.prepare(`UPDATE email_accounts SET last_attempt_at = ?, error = NULL
    WHERE id = ? AND revision = ? AND cursor IS ?`).run(now, accountId, account.revision, currentCursor);
  if (attempted.changes !== 1) throw new Error('Stale host sync cursor: account changed before processing');
  if (singleAccount) {
    db.prepare('UPDATE automations SET last_attempt_at = ?, error = NULL WHERE id = ? AND cursor IS ?')
      .run(now, task.id, currentCursor);
  } else {
    db.prepare('UPDATE automations SET last_attempt_at = ?, error = NULL WHERE id = ?').run(now, task.id);
  }

  let created = 0;
  try {
    const preparedMessages = [];
    for (const message of batch.messages) {
      preparedMessages.push(await prepareMessageImport(db, message, {
        accountId,
        applicationId: matchApplication(db, message),
        recordedAt: now,
      }, adapters));
    }
    const newMessages = preparedMessages.filter((item) => item.state === 'prepared');
    const decisionEngines = Object.fromEntries([...new Set(newMessages.map((item) => item.routed.engine))]
      .sort().map((engine) => [engine, newMessages.filter((item) => item.routed.engine === engine).length]));
    const decisionSummary = {
      newMessages: newMessages.length,
      deduplicated: preparedMessages.length - newMessages.length,
      jevAttempted: newMessages.filter((item) => item.routed.jevAttempted).length,
      engines: decisionEngines,
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      const locked = db.prepare('SELECT revision, cursor FROM email_accounts WHERE id = ?').get(accountId);
      if (locked.revision !== account.revision || (locked.cursor ?? null) !== currentCursor) {
        throw new Error('Stale host sync cursor: account changed during processing');
      }
      for (const prepared of preparedMessages) {
        const result = commitPreparedMessageImport(db, prepared, { withinTransaction: true });
        if (result.created) created += 1;
      }
      const accountUpdate = db.prepare(`UPDATE email_accounts SET cursor = ?, revision = revision + 1,
        last_run_id = ?, last_batch_hash = ?, last_fetched_at = ?, last_success_at = ?, error = NULL
        WHERE id = ? AND revision = ? AND cursor IS ?`)
        .run(batch.afterCursor, batch.runId, batchHash, batch.fetchedAt, now, accountId, account.revision, currentCursor);
      if (accountUpdate.changes !== 1) throw new Error('Stale host sync cursor: account changed during processing');
      const taskUpdate = singleAccount
        ? db.prepare(`UPDATE automations SET cursor = ?, last_attempt_at = ?,
          last_success_at = ?, error = NULL, config_json = ? WHERE id = ? AND cursor IS ?`)
          .run(batch.afterCursor, now, now, JSON.stringify(task.config), task.id, currentCursor)
        : db.prepare(`UPDATE automations SET last_attempt_at = ?, last_success_at = ?,
          error = NULL, config_json = ? WHERE id = ?`)
          .run(now, now, JSON.stringify(task.config), task.id);
      if (taskUpdate.changes !== 1) throw new Error('Stale host sync cursor: mail-sync task changed during processing');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return {
      accountId,
      beforeCursor: batch.beforeCursor,
      afterCursor: batch.afterCursor,
      cursor: batch.afterCursor,
      runId: batch.runId,
      fetchedAt: batch.fetchedAt,
      examined: batch.messages.length,
      created,
      decisions: decisionSummary,
      replayed: false,
    };
  } catch (error) {
    db.prepare(`UPDATE email_accounts SET error = ? WHERE id = ? AND revision = ? AND cursor IS ?`)
      .run(error.message, accountId, account.revision, currentCursor);
    if (singleAccount) {
      db.prepare(`UPDATE automations SET error = ?, last_attempt_at = ? WHERE id = ? AND cursor IS ?`)
        .run(error.message, now, task.id, currentCursor);
    } else {
      db.prepare('UPDATE automations SET error = ?, last_attempt_at = ? WHERE id = ?').run(error.message, now, task.id);
    }
    throw error;
  }
}

export async function syncHostBatch(db, accountId, rawBatch, adapters = {}, now = new Date().toISOString()) {
  return syncMailboxBatch(db, accountId, rawBatch, adapters, now, 'host');
}

export async function syncImapEmailAccount(db, accountId, options = {}, adapters = {}) {
  const row = db.prepare(`SELECT id, provider, address, read_only readOnly, secret_ref secretRef,
    cursor, config_json settings FROM email_accounts WHERE id = ?`).get(accountId);
  if (!row) throw new Error(`Unknown email account: ${accountId}`);
  if (row.provider !== 'imap' || !row.readOnly) throw new Error('Direct IMAPS sync requires a read-only IMAP account');
  const externalTaskId = String(options.externalTaskId ?? '').trim();
  if (!externalTaskId) throw new Error('Direct IMAPS sync requires the registered mail-sync external task ID');
  let settings;
  try { settings = JSON.parse(row.settings); }
  catch { throw new Error('Configured IMAP account settings are invalid'); }
  const attemptedAt = new Date(options.now ?? new Date().toISOString()).toISOString();
  db.prepare('UPDATE email_accounts SET last_attempt_at = ?, error = NULL WHERE id = ?').run(attemptedAt, accountId);
  try {
    const fetched = await fetchImapMailbox({ ...settings, secretRef: row.secretRef }, {
      beforeCursor: row.cursor ?? null,
    }, options);
    recordImapVerification(db, accountId, fetched.verification);
    return await syncMailboxBatch(db, accountId, {
      accountId,
      connector: 'imap',
      readOnly: true,
      beforeCursor: fetched.beforeCursor,
      afterCursor: fetched.afterCursor,
      runId: options.runId ?? `imap-${randomUUID()}`,
      fetchedAt: fetched.fetchedAt,
      externalTaskId,
      messages: fetched.messages,
    }, adapters, fetched.fetchedAt, 'imap');
  } catch (error) {
    db.prepare('UPDATE email_accounts SET error = ? WHERE id = ?').run(error.message, accountId);
    throw error;
  }
}
