import { probeImapConnection } from './imap.mjs';

const LIVE_VERIFICATION_WINDOW_MS = 36 * 60 * 60 * 1000;

const normalizeAddress = (value) => {
  const address = String(value ?? '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(address)) throw new Error('Email address is invalid');
  return address;
};

export function assertPublicEmailAddress(value) {
  const address = normalizeAddress(value);
  const domain = address.slice(address.lastIndexOf('@') + 1);
  const reserved = new Set(['example.com', 'example.net', 'example.org', 'localhost']);
  if (reserved.has(domain) || /(?:^|\.)(?:test|example|invalid|localhost)$/.test(domain)) {
    throw new Error('Email address uses a reserved example domain; provide the real mailbox selected for job applications');
  }
  return address;
}

function baseSettings(settings) {
  const { verification: _verification, ...base } = settings ?? {};
  return base;
}

function normalizeSettings(provider, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Email account settings must be an object');
  if (provider === 'host') {
    if (typeof input.connector !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.connector.trim())) {
      throw new Error('Host-managed email accounts require a valid connector name');
    }
    if (Object.keys(input).some((key) => key !== 'connector')) {
      throw new Error('Host-managed email settings only stores the connector name; keep credentials in the host');
    }
    return { connector: input.connector.trim() };
  }
  if (provider === 'imap') {
    const allowed = new Set(['host', 'port', 'username', 'mailbox']);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('IMAP settings only store host, port, username, and mailbox');
    const host = String(input.host ?? '').trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || !host.includes('.')) throw new Error('IMAP host is invalid');
    const port = Number(input.port ?? 993);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('IMAP port is invalid');
    const username = String(input.username ?? '').trim();
    if (!username || /[\u0000\r\n]/.test(username)) throw new Error('IMAP username is required');
    const mailbox = String(input.mailbox ?? 'INBOX').trim();
    if (!mailbox || /[\u0000\r\n]/.test(mailbox)) throw new Error('IMAP mailbox is invalid');
    return { host, port, username, mailbox };
  }
  return baseSettings(input);
}

export function configureEmailAccount(db, input) {
  if (input.readOnly === false) throw new Error('Email accounts are read-only in this release');
  if (input.secret !== undefined || input.password !== undefined || input.token !== undefined) throw new Error('Do not provide inline secrets; use secretRef');
  const provider = String(input.provider ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) throw new Error('Email provider is invalid');
  const address = normalizeAddress(input.address);
  const id = `${provider}:${address}`;
  const suppliedSecretRef = input.secretRef;
  if (provider === 'host' && suppliedSecretRef != null) {
    throw new Error('Host-managed email accounts must not store a secretRef; credentials stay in the host connector');
  }
  if (provider !== 'host' && suppliedSecretRef != null && !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(String(suppliedSecretRef))) {
    throw new Error('Email secretRef must use env:VARIABLE');
  }
  if (provider === 'imap' && suppliedSecretRef == null) throw new Error('IMAP accounts require secretRef env:VARIABLE');
  const secretRef = suppliedSecretRef ?? null;
  const normalizedSettings = normalizeSettings(provider, input.settings ?? {});
  const serializedSettings = JSON.stringify(normalizedSettings);
  const existing = db.prepare('SELECT secret_ref secretRef, config_json settings FROM email_accounts WHERE id = ?').get(id);
  if (!existing) {
    db.prepare(`INSERT INTO email_accounts (id, provider, address, read_only, secret_ref, config_json)
      VALUES (?, ?, ?, 1, ?, ?)`).run(id, provider, address, secretRef, serializedSettings);
  } else if ((existing.secretRef ?? null) !== secretRef || JSON.stringify(baseSettings(JSON.parse(existing.settings))) !== serializedSettings) {
    const linkedTasks = db.prepare(`SELECT id, config_json configJson FROM automations
      WHERE task_type = 'mail-sync' AND account_id = ?`).all(id).map((task) => {
      const config = JSON.parse(task.configJson);
      delete config.registration;
      return { id: task.id, config };
    });
    db.prepare(`UPDATE email_accounts SET secret_ref = ?, read_only = 1, config_json = ?, cursor = NULL,
      revision = revision + 1, last_run_id = NULL, last_batch_hash = NULL, last_fetched_at = NULL,
      last_attempt_at = NULL, last_success_at = NULL, error = NULL WHERE id = ?`)
      .run(secretRef, serializedSettings, id);
    const resetTask = db.prepare(`UPDATE automations SET cursor = NULL, last_attempt_at = NULL,
      last_success_at = NULL, error = NULL, config_json = ? WHERE id = ?`);
    for (const task of linkedTasks) resetTask.run(JSON.stringify(task.config), task.id);
  } else {
    db.prepare('UPDATE email_accounts SET read_only = 1 WHERE id = ?').run(id);
  }
  return listEmailAccounts(db).find((item) => item.id === id);
}

export function listEmailAccounts(db) {
  return db.prepare(`SELECT id, provider, address, read_only readOnly,
    cursor, revision, last_run_id lastRunId, last_batch_hash lastBatchHash, last_fetched_at lastFetchedAt,
    last_attempt_at lastAttemptAt, last_success_at lastSuccessAt, error, config_json settings
    FROM email_accounts ORDER BY id`).all().map((item) => ({ ...item, readOnly: Boolean(item.readOnly), settings: JSON.parse(item.settings) }));
}

export function emailSetupState(accounts, boundAccountId = null) {
  const selectedAccounts = boundAccountId == null
    ? accounts
    : accounts.filter((account) => account.id === boundAccountId);
  const liveAccounts = selectedAccounts.filter((account) => isLiveVerifiedEmailAccount(account));
  if (liveAccounts.some((account) => account.lastSuccessAt && !account.error)) return 'verified';
  if (liveAccounts.length) return 'connected-pending-sync';
  const hostAccounts = selectedAccounts.filter((account) => account.provider === 'host' && account.readOnly && account.settings?.connector);
  if (hostAccounts.some((account) => account.lastSuccessAt && !account.error)) return 'host-attested';
  if (hostAccounts.length || selectedAccounts.some((account) => account.provider === 'imap')) return 'pending-verification';
  return selectedAccounts.length ? 'fallback-only' : 'not-configured';
}

export function isLiveVerifiedEmailAccount(account, now = new Date().toISOString()) {
  if (account?.provider !== 'imap' || !account.readOnly) return false;
  const verification = account.settings?.verification;
  if (verification?.method !== 'imap-tls' || verification.address !== account.address) return false;
  const verifiedAt = Date.parse(verification.verifiedAt ?? '');
  const reference = Date.parse(now);
  return !Number.isNaN(verifiedAt)
    && !Number.isNaN(reference)
    && verifiedAt <= reference + 5 * 60 * 1000
    && reference - verifiedAt <= LIVE_VERIFICATION_WINDOW_MS;
}

export async function verifyImapEmailAccount(db, id, capabilities = {}) {
  const row = db.prepare(`SELECT id, provider, address, read_only readOnly, secret_ref secretRef,
    config_json settings FROM email_accounts WHERE id = ?`).get(id);
  if (!row) throw new Error(`Unknown email account: ${id}`);
  if (row.provider !== 'imap' || !row.readOnly) throw new Error('Live IMAPS verification requires a read-only IMAP account');
  const settings = JSON.parse(row.settings);
  const attemptedAt = new Date(capabilities.now ?? new Date().toISOString()).toISOString();
  db.prepare('UPDATE email_accounts SET last_attempt_at = ?, error = NULL WHERE id = ?').run(attemptedAt, id);
  try {
    const proof = await probeImapConnection({ ...settings, secretRef: row.secretRef }, capabilities);
    return recordImapVerification(db, id, proof);
  } catch (error) {
    db.prepare('UPDATE email_accounts SET error = ? WHERE id = ?').run(error.message, id);
    throw error;
  }
}

export function recordImapVerification(db, id, proof) {
  const row = db.prepare('SELECT provider, address, config_json settings FROM email_accounts WHERE id = ?').get(id);
  if (!row || row.provider !== 'imap') throw new Error(`Unknown IMAP email account: ${id}`);
  const settings = JSON.parse(row.settings);
  const verifiedAt = new Date(proof?.verifiedAt ?? '').toISOString();
  if (proof?.method !== 'imap-tls'
    || proof.server !== settings.host
    || Number(proof.port) !== Number(settings.port)
    || proof.username !== settings.username
    || proof.mailbox !== settings.mailbox) {
    throw new Error('IMAPS verification proof does not match the configured account');
  }
  const verified = {
    method: 'imap-tls',
    address: row.address,
    server: proof.server,
    port: Number(proof.port),
    mailbox: proof.mailbox,
    verifiedAt,
  };
  db.prepare('UPDATE email_accounts SET config_json = ?, error = NULL WHERE id = ?')
    .run(JSON.stringify({ ...baseSettings(settings), verification: verified }), id);
  return listEmailAccounts(db).find((account) => account.id === id);
}

export function disconnectEmailAccount(db, id) {
  const linkedTasks = db.prepare(`SELECT id, config_json configJson FROM automations
    WHERE task_type = 'mail-sync' AND account_id = ?`).all(id);
  const resetTask = db.prepare(`UPDATE automations SET cursor = NULL, last_attempt_at = NULL,
    last_success_at = NULL, error = NULL, config_json = ? WHERE id = ?`);
  for (const task of linkedTasks) {
    const config = JSON.parse(task.configJson);
    delete config.registration;
    resetTask.run(JSON.stringify(config), task.id);
  }
  return Boolean(db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id).changes);
}
