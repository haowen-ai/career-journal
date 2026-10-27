export function setCooldown(db, key, { until, reason }) {
  db.prepare('INSERT INTO cooldowns(key,until,reason) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET until=excluded.until,reason=excluded.reason').run(key, until, reason);
}
export function activeCooldown(db, key, { now }) {
  const row = db.prepare('SELECT until,reason FROM cooldowns WHERE key=?').get(key);
  return row && Date.parse(row.until) > Date.parse(now) ? { ...row } : null;
}
