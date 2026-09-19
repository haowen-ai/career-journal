import { validateTimezone } from '../config/defaults.mjs';
import { BUILT_IN_TASKS } from './tasks.mjs';

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

export function upsertTask(db, input) {
  if (!Object.hasOwn(BUILT_IN_TASKS, input.type)) throw new Error(`Unknown automation task: ${input.type}`);
  if (typeof input.enabled !== 'boolean') throw new Error('enabled must be true or false');
  const primaryId = `career-journal-${input.type}`;
  const legacyId = `jobops-${input.type}`;
  const existingTask = db.prepare('SELECT id, cursor FROM automations WHERE id IN (?, ?) ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1')
    .get(primaryId, legacyId, primaryId);
  const id = existingTask?.id ?? primaryId;
  const timezone = validateTimezone(input.timezone);
  const schedule = validateTime(input.time);
  const cursor = input.cursor ?? existingTask?.cursor ?? null;
  db.prepare(`INSERT INTO automations
    (id, task_type, enabled, timezone, schedule, account_id, notification_policy, cursor, config_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, timezone=excluded.timezone,
      schedule=excluded.schedule, account_id=excluded.account_id,
      notification_policy=excluded.notification_policy, config_json=excluded.config_json`)
    .run(id, input.type, input.enabled ? 1 : 0, timezone, schedule, input.accountId ?? null, input.notificationPolicy ?? 'actionable', cursor, JSON.stringify(input.config ?? {}));
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

export async function runTask(db, id, { dryRun = false, handler }) {
  const task = row(db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
  if (!task) throw new Error(`Unknown automation: ${id}`);
  if (!task.enabled && !dryRun) throw new Error(`Automation is disabled: ${id}`);
  if (dryRun) return { taskId: id, dryRun: true, wouldRun: task.type };
  const attemptedAt = new Date().toISOString();
  db.prepare('UPDATE automations SET last_attempt_at = ?, error = NULL WHERE id = ?').run(attemptedAt, id);
  try {
    const result = await handler(task);
    const successAt = new Date().toISOString();
    db.prepare('UPDATE automations SET last_success_at = ?, cursor = ?, error = NULL WHERE id = ?')
      .run(successAt, result.cursor ?? task.cursor, id);
    return { taskId: id, ...result, lastSuccessAt: successAt };
  } catch (error) {
    db.prepare('UPDATE automations SET error = ? WHERE id = ?').run(error.message, id);
    throw error;
  }
}
