import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from '../runtime/redact.mjs';
import { atomic } from './lease.mjs';

export function reviewExitCode(receipt) {
  const codes = { ok: 0, partial: 2, failed: 1, busy: 75, interrupted: 1, unknown: 2, running: 75 };
  if (!Object.hasOwn(codes, receipt.status)) throw new Error(`Unknown run status: ${receipt.status}`);
  return codes[receipt.status];
}
export function worstExit(codes) {
  return codes.includes(1) ? 1 : codes.includes(75) ? 75 : codes.includes(2) ? 2 : 0;
}

export function localDate(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function receiptFile(home, runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId)) throw new Error('Invalid run id');
  return path.join(home, '.career-journal', 'runs', `${runId.replaceAll(':', '__')}.json`);
}
async function atomicFile(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${redact(JSON.stringify(value, null, 2))}\n`, { mode: 0o600 });
  await rename(tmp, file);
}
export async function writeReceipt(home, receipt) {
  const file = receiptFile(home, receipt.run_id);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicFile(file, receipt);
  if (receipt.kind === 'daily') await atomicFile(path.join(path.dirname(file), 'latest.json'), receipt);
}
export async function readRunReceipt(home, runId) {
  try { return JSON.parse(await readFile(receiptFile(home, runId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function readCurrentReceipt(home, { date, runId } = {}) {
  let receipt;
  if (runId) receipt = await readRunReceipt(home, runId);
  else {
    try {
      const latest = JSON.parse(await readFile(path.join(home, '.career-journal', 'runs', 'latest.json'), 'utf8'));
      receipt = await readRunReceipt(home, latest.run_id);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!receipt || receipt.kind !== 'daily') return { state: 'missing' };
  if (date && receipt.run_date !== date) return { state: 'stale', receipt };
  return { state: receipt.status === 'running' || !receipt.finished ? 'running' : 'finished', receipt };
}
export async function finalizeDailyReceipt(db, home, { dailyId, stages, now, timezone }) {
  if (!timezone) throw new Error('Daily finalization requires a timezone');
  const stageRows = stages.map((stage) => {
    const row = stage.runId && db.prepare('SELECT * FROM runs WHERE run_id=?').get(stage.runId);
    if (row?.parent_run_id && row.parent_run_id !== dailyId) throw new Error(`Stage ${stage.name} belongs to another daily run`);
    return { ...stage, receipt: row ? JSON.parse(row.receipt_json) : undefined };
  });
  const code = worstExit(stages.map((stage) => reviewExitCode({ status: stage.status })));
  const status = ({ 0: 'ok', 1: 'failed', 2: 'partial', 75: 'busy' })[code];
  const daily = { schema: 1, kind: 'daily', run_id: dailyId, run_date: localDate(now, timezone), parent_run_id: null,
    started: stages.map((s) => s.runId && db.prepare('SELECT started_at FROM runs WHERE run_id=?').get(s.runId)?.started_at).filter(Boolean).sort()[0] ?? now,
    finished: now, status, worstExit: code, stages: stageRows,
    warnings: stageRows.flatMap((s) => s.receipt?.warnings ?? []), errors: stageRows.flatMap((s) => s.receipt?.errors ?? []) };
  atomic(db, () => {
    db.prepare(`INSERT INTO runs(run_id,kind,owner,started_at,heartbeat_at,finished_at,status,receipt_json)
      VALUES (?,'daily','daily-finalize',?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,finished_at=excluded.finished_at,status=excluded.status,receipt_json=excluded.receipt_json`)
      .run(dailyId, daily.started, now, now, status === 'busy' ? 'partial' : status, redact(JSON.stringify(daily)));
  });
  await writeReceipt(home, daily);
  return daily;
}
