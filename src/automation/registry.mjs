import { validateTimezone } from '../config/defaults.mjs';
import { BUILT_IN_TASKS } from './tasks.mjs';
import { createHash } from 'node:crypto';

const row = (value) => value && ({
  id: value.id, type: value.task_type, enabled: Boolean(value.enabled), timezone: value.timezone,
  schedule: value.schedule, accountId: value.account_id, notificationPolicy: value.notification_policy,
  cursor: value.cursor, lastAttemptAt: value.last_attempt_at, lastSuccessAt: value.last_success_at,
  error: value.error, config: JSON.parse(value.config_json),
});

function validateTime(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('time must be HH:MM');
  return value;
}

export { BUILT_IN_TASKS };

export const REQUIRED_TASK_TYPES = Object.freeze(['mail-sync', 'deadline-review']);

function sharedCodexSchedules(tasks) {
  const byType = new Map(tasks.map((task) => [task.type, task]));
  return REQUIRED_TASK_TYPES
    .filter((type) => byType.has(type))
    .map((type) => {
      const task = byType.get(type);
      return { taskId: task.id, schedule: task.schedule, timezone: task.timezone };
    });
}

function normalizeAccountIds(values) {
  return [...new Set((values ?? [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))].sort();
}

export function taskEmailAccountIds(task) {
  const configured = normalizeAccountIds(task?.config?.accountIds);
  return configured.length ? configured : normalizeAccountIds([task?.accountId]);
}

export function taskBindingRevision(task) {
  return createHash('sha256').update(JSON.stringify({
    id: task.id,
    type: task.type,
    enabled: task.enabled,
    timezone: task.timezone,
    schedule: task.schedule,
    accountIds: taskEmailAccountIds(task),
    notificationPolicy: task.notificationPolicy,
  })).digest('hex');
}

export function isCurrentTaskClaim(task) {
  const registration = task.config.registration;
  return Boolean(registration?.driver)
    && Boolean(registration?.externalId)
    && registration.bindingRevision === taskBindingRevision(task);
}

function hasCurrentAttestation(task) {
  const registration = task.config.registration;
  return isCurrentTaskClaim(task)
    && registration.status === 'verified'
    && registration.verified === true
    && typeof registration.verifiedAt === 'string'
    && !Number.isNaN(Date.parse(registration.verifiedAt))
    && typeof registration.verifier?.method === 'string';
}

export function isCurrentTaskRegistration(task) {
  return hasCurrentAttestation(task);
}

export function automationSetupState(tasks) {
  const configured = new Map(tasks.filter((task) => REQUIRED_TASK_TYPES.includes(task.type) && task.enabled).map((task) => [task.type, task]));
  if (!REQUIRED_TASK_TYPES.every((type) => configured.has(type))) return tasks.length ? 'pending-registration' : 'not-configured';
  return REQUIRED_TASK_TYPES.every((type) => {
    const task = configured.get(type);
    const registration = task.config.registration;
    const verifiedAt = Date.parse(registration?.verifiedAt ?? '');
    const registeredAt = Date.parse(registration?.registeredAt ?? '');
    const lastExternalRunAt = Date.parse(registration?.lastExternalRunAt ?? '');
    return hasCurrentAttestation(task)
      && !Number.isNaN(lastExternalRunAt)
      && lastExternalRunAt >= Math.max(verifiedAt, registeredAt);
  })
    ? 'registered'
    : 'pending-registration';
}

export function upsertTask(db, input) {
  if (!Object.hasOwn(BUILT_IN_TASKS, input.type)) throw new Error(`Unknown automation task: ${input.type}`);
  if (typeof input.enabled !== 'boolean') throw new Error('enabled must be true or false');
  const primaryId = `career-journal-${input.type}`;
  const legacyId = `jobops-${input.type}`;
  const existingTask = db.prepare('SELECT * FROM automations WHERE id IN (?, ?) ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1')
    .get(primaryId, legacyId, primaryId);
  const id = existingTask?.id ?? primaryId;
  const timezone = validateTimezone(input.timezone);
  const schedule = validateTime(input.time);
  const previousConfig = existingTask ? JSON.parse(existingTask.config_json) : {};
  const accountIds = input.type === 'mail-sync'
    ? normalizeAccountIds(input.accountIds ?? (input.accountId != null ? [input.accountId] : previousConfig.accountIds ?? []))
    : [];
  const accountId = input.type === 'mail-sync' ? accountIds[0] ?? null : input.accountId ?? null;
  const notificationPolicy = input.notificationPolicy ?? 'actionable';
  const previousAccountIds = input.type === 'mail-sync'
    ? taskEmailAccountIds({ accountId: existingTask?.account_id ?? null, config: previousConfig })
    : [];
  const mailAccountChanged = Boolean(existingTask)
    && input.type === 'mail-sync'
    && JSON.stringify(previousAccountIds) !== JSON.stringify(accountIds);
  const cursor = mailAccountChanged ? null : input.cursor ?? existingTask?.cursor ?? null;
  const lastAttemptAt = mailAccountChanged ? null : existingTask?.last_attempt_at ?? null;
  const lastSuccessAt = mailAccountChanged ? null : existingTask?.last_success_at ?? null;
  const error = mailAccountChanged ? null : existingTask?.error ?? null;
  const registrationStillMatches = Boolean(existingTask)
    && Boolean(existingTask.enabled) === input.enabled
    && existingTask.timezone === timezone
    && existingTask.schedule === schedule
    && (input.type !== 'mail-sync' || JSON.stringify(previousAccountIds) === JSON.stringify(accountIds))
    && (input.type === 'mail-sync' || (existingTask.account_id ?? null) === accountId)
    && existingTask.notification_policy === notificationPolicy;
  const config = { ...(input.config ?? previousConfig) };
  if (input.type === 'mail-sync') config.accountIds = accountIds;
  if (!registrationStillMatches) delete config.registration;
  db.prepare(`INSERT INTO automations
    (id, task_type, enabled, timezone, schedule, account_id, notification_policy, cursor,
      last_attempt_at, last_success_at, error, config_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, timezone=excluded.timezone,
      schedule=excluded.schedule, account_id=excluded.account_id,
      notification_policy=excluded.notification_policy, cursor=excluded.cursor,
      last_attempt_at=excluded.last_attempt_at, last_success_at=excluded.last_success_at,
      error=excluded.error, config_json=excluded.config_json`)
    .run(id, input.type, input.enabled ? 1 : 0, timezone, schedule, accountId, notificationPolicy,
      cursor, lastAttemptAt, lastSuccessAt, error, JSON.stringify(config));
  return row(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
}

export function listTasks(db) {
  return db.prepare('SELECT * FROM automations ORDER BY id').all().map(row);
}

export function disableTask(db, id) {
  const result = db.prepare('UPDATE automations SET enabled = 0 WHERE id = ?').run(id);
  if (!result.changes) throw new Error(`Unknown automation: ${id}`);
  return row(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
}

export function removeTask(db, id) {
  return Boolean(db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes);
}

export function markTaskRegistration(db, id, registration) {
  const task = row(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
  if (!task) throw new Error(`Unknown automation: ${id}`);
  const driver = String(registration?.driver ?? '').trim().toLowerCase();
  const externalId = String(registration?.externalId ?? '').trim();
  if (!driver || !externalId) throw new Error('Host scheduler attestation requires driver and externalId');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(driver)) throw new Error('Scheduler driver contains unsupported characters');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(externalId)) throw new Error('Scheduler externalId contains unsupported characters');
  if (driver === 'codex' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(externalId)) {
    throw new Error('Codex automation id contains unsupported characters');
  }
  const requestedExecution = registration?.execution == null ? null : {
    node: String(registration.execution.node ?? ''),
    cli: String(registration.execution.cli ?? ''),
    home: String(registration.execution.home ?? ''),
    platform: registration.execution.platform == null ? null : String(registration.execution.platform),
  };
  if (requestedExecution && ['node', 'cli', 'home'].some((key) => !requestedExecution[key] || /[\0\r\n]/.test(requestedExecution[key]))) {
    throw new Error('Scheduler execution binding contains an unsupported path value');
  }
  if (requestedExecution?.platform && !['darwin', 'linux', 'win32'].includes(requestedExecution.platform)) {
    throw new Error('Scheduler execution binding platform is unsupported');
  }
  const registeredAt = registration.registeredAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(registeredAt))) throw new Error('registeredAt must be an ISO timestamp');
  const duplicate = listTasks(db).find((candidate) => candidate.id !== id
    && candidate.config.registration?.driver?.toLowerCase() === driver
    && candidate.config.registration?.externalId === externalId);
  let sharedSchedules = null;
  let duplicateConfig = null;
  if (duplicate) {
    const sharedTypes = new Set([task.type, duplicate.type]);
    const requiredPair = sharedTypes.size === REQUIRED_TASK_TYPES.length
      && REQUIRED_TASK_TYPES.every((type) => sharedTypes.has(type));
    const duplicateExecution = duplicate.config.registration?.execution ?? null;
    const sameExecution = requestedExecution != null
      && duplicateExecution != null
      && duplicateExecution.node === requestedExecution.node
      && duplicateExecution.cli === requestedExecution.cli
      && duplicateExecution.home === requestedExecution.home
      && (duplicateExecution.platform ?? null) === requestedExecution.platform;
    if (driver !== 'codex' || !requiredPair || duplicate.timezone !== task.timezone || !sameExecution) {
      throw new Error(`External scheduler ${driver}/${externalId} is already registered to ${duplicate.type}; only the two required Codex tasks may share one matching heartbeat`);
    }
    sharedSchedules = sharedCodexSchedules([task, duplicate]);
    duplicateConfig = {
      ...duplicate.config,
      registration: {
        ...duplicate.config.registration,
        status: 'pending-verification',
        verified: false,
        registeredAt: new Date(registeredAt).toISOString(),
        sharedSchedules,
        verifiedAt: null,
        verifier: null,
        lastExternalRunAt: null,
      },
    };
  }
  const revision = taskBindingRevision(task);
  const previous = task.config.registration;
  const requestedExecutionMatches = requestedExecution == null
    || (previous?.execution?.node === requestedExecution.node
      && previous?.execution?.cli === requestedExecution.cli
      && previous?.execution?.home === requestedExecution.home
      && (previous?.execution?.platform ?? null) === requestedExecution.platform);
  const sameVerifiedClaim = previous?.status === 'verified'
    && previous?.verified === true
    && previous?.driver?.toLowerCase() === driver
    && previous?.externalId === externalId
    && previous?.bindingRevision === revision
    && requestedExecutionMatches;
  const config = {
    ...task.config,
    registration: {
      status: sameVerifiedClaim ? 'verified' : 'pending-verification',
      driver,
      externalId,
      verified: sameVerifiedClaim,
      registeredAt: sameVerifiedClaim
        ? previous.registeredAt
        : new Date(registeredAt).toISOString(),
      timezone: task.timezone,
      schedule: task.schedule,
      accountId: task.accountId ?? null,
      accountIds: taskEmailAccountIds(task),
      notificationPolicy: task.notificationPolicy,
      bindingRevision: revision,
      execution: requestedExecution ?? (sameVerifiedClaim ? previous.execution ?? null : null),
      ...(sharedSchedules ? { sharedSchedules } : {}),
      verifiedAt: sameVerifiedClaim ? previous.verifiedAt : null,
      verifier: sameVerifiedClaim ? previous.verifier : null,
      lastExternalRunAt: sameVerifiedClaim
        ? previous.lastExternalRunAt ?? null
        : null,
    },
  };
  // A shared heartbeat updates two task rows, so keep that pair atomic. The
  // ordinary one-row path may be called inside the native installer transaction.
  const startedTransaction = Boolean(duplicateConfig);
  if (startedTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    if (duplicateConfig) {
      db.prepare('UPDATE automations SET config_json = ? WHERE id = ?').run(JSON.stringify(duplicateConfig), duplicate.id);
    }
    db.prepare('UPDATE automations SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
    if (startedTransaction) db.exec('COMMIT');
  } catch (error) {
    if (startedTransaction && db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return row(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
}

export function verifyTaskRegistration(db, id, verification) {
  const task = row(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
  if (!task) throw new Error(`Unknown automation: ${id}`);
  if (!isCurrentTaskClaim(task)) throw new Error(`Automation has no current scheduler registration claim: ${id}`);
  const method = String(verification?.method ?? '').trim().toLowerCase();
  if (!['native-probe', 'trusted-host'].includes(method)) throw new Error('Scheduler verification method is unsupported');
  const verifiedAt = verification?.verifiedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(verifiedAt))) throw new Error('verifiedAt must be an ISO timestamp');
  const evidenceDigest = verification?.evidenceDigest == null ? null : String(verification.evidenceDigest).trim();
  if (evidenceDigest && !/^sha256:[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error('Scheduler evidence digest is invalid');
  const registration = task.config.registration;
  const config = {
    ...task.config,
    registration: {
      ...registration,
      status: 'verified',
      verified: true,
      verifiedAt: new Date(verifiedAt).toISOString(),
      verifier: { method, evidenceDigest },
      lastExternalRunAt: null,
    },
  };
  db.prepare('UPDATE automations SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
  return row(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
}

export function clearTaskRegistration(db, id) {
  const task = row(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
  if (!task) throw new Error(`Unknown automation: ${id}`);
  const config = { ...task.config };
  delete config.registration;
  db.prepare('UPDATE automations SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
  return row(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
}

export async function runTask(db, id, { dryRun = false, handler, externalId = null }) {
  const task = row(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
  if (!task) throw new Error(`Unknown automation: ${id}`);
  if (!task.enabled && !dryRun) throw new Error(`Automation is disabled: ${id}`);
  if (dryRun) return { taskId: id, dryRun: true, wouldRun: task.type };
  const claimedExternalId = externalId == null ? null : String(externalId).trim();
  if (externalId != null && !claimedExternalId) throw new Error('external-id cannot be empty');
  if (claimedExternalId) {
    const registration = task.config.registration;
    if (!hasCurrentAttestation(task)) throw new Error(`Automation has no verified scheduler registration: ${id}`);
    if (registration.externalId !== claimedExternalId) throw new Error(`External id does not match the registered scheduler for ${id}`);
  }
  const attemptedAt = new Date().toISOString();
  db.prepare('UPDATE automations SET last_attempt_at = ?, error = NULL WHERE id = ?').run(attemptedAt, id);
  try {
    const result = await handler(task);
    const successAt = new Date().toISOString();
    const config = claimedExternalId ? {
      ...task.config,
      registration: { ...task.config.registration, lastExternalRunAt: successAt },
    } : task.config;
    db.prepare('UPDATE automations SET last_success_at = ?, cursor = ?, error = NULL, config_json = ? WHERE id = ?')
      .run(successAt, result.cursor ?? task.cursor, JSON.stringify(config), id);
    return { taskId: id, ...result, lastSuccessAt: successAt, externalRun: Boolean(claimedExternalId) };
  } catch (error) {
    db.prepare('UPDATE automations SET error = ? WHERE id = ?').run(error.message, id);
    throw error;
  }
}
