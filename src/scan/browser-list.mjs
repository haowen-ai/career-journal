// Browser fallback for company lists the scan could not fetch (user 2026-11-09).
//
// A scan records a CareerOps entry whose list could not be read as a partition with status
// `error`. The nightly reviewer opens that company's careers page in a browser, searches it for
// student roles, and hands the rows it read to `scan attach`. The rows are ingested like any other
// batch and judged by the same code; nothing here decides eligibility.
//
// A browser read is never a census: it holds only the student-titled roles a person searched for.
// It is recorded as `partial` in a run of its own that source health leaves out of a list's
// history (src/funnel/health.mjs), so it feeds neither the count baseline nor the fail streak.
import { randomUUID } from 'node:crypto';
import { aliasesFor, canonicalUrl, identityOptionsOf } from '../funnel/identity.mjs';
import { ingestBatch } from '../funnel/ingest.mjs';
import { redact } from '../runtime/redact.mjs';
import { parseCareerOpsRoles } from './sources/careerops.mjs';

export const BROWSER_LIST_DETAIL = 'browser read: student titles only';
// Same freshness rule as a scan's own start check (src/scan/run.mjs startRun).
const RUNNING_FRESH_MS = 600_000;
const SOURCE = 'careerops';
const nameOf = (partition) => String(partition).slice(String(partition).indexOf(':') + 1);
// json_valid first: one unreadable receipt must not fail the whole query.
const isBrowserRun = "(json_valid(r.receipt_json) AND json_extract(r.receipt_json,'$.browserList') IS NOT NULL)";
const refuse = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode });

// The latest scan that tried the CareerOps lists itself, its lists that failed, and which of those
// a browser read has not settled yet. A browser read settles a list only for the scan it names
// (receipt forScanRunId), so tonight's failure is never hidden by an earlier read. While a scan is
// still running nothing is offered: its result is not known yet.
export function failedLists(db, { now = new Date().toISOString() } = {}) {
  const running = db.prepare("SELECT run_id,heartbeat_at FROM runs WHERE kind='scan' AND status='running'").all()
    .find((row) => Date.parse(now) - Date.parse(row.heartbeat_at) < RUNNING_FRESH_MS);
  if (running) return { scanRunId: running.run_id, scanRunning: true, wholeScanFailed: false, lists: [] };
  const scan = db.prepare(`SELECT r.run_id,r.started_at,r.finished_at,r.receipt_json FROM runs r WHERE r.kind='scan' AND r.status IN ('ok','partial','failed')
    AND NOT (${isBrowserRun}) AND EXISTS (SELECT 1 FROM run_sources s WHERE s.run_id=r.run_id AND s.source=?)
    ORDER BY r.started_at DESC LIMIT 1`).get(SOURCE);
  if (!scan) return { scanRunId: null, scanRunning: false, wholeScanFailed: false, lists: [] };
  const failed = db.prepare("SELECT partition,detail FROM run_sources WHERE run_id=? AND source=? AND status='error' ORDER BY partition").all(scan.run_id, SOURCE);
  const settled = new Set(db.prepare(`SELECT s.partition FROM run_sources s JOIN runs r ON r.run_id=s.run_id
    WHERE s.source=? AND json_valid(r.receipt_json) AND json_extract(r.receipt_json,'$.forScanRunId')=?`).all(SOURCE, scan.run_id).map((row) => row.partition));
  let reported = [];
  try { reported = JSON.parse(scan.receipt_json ?? '{}').sources ?? []; } catch { /* a receipt without sources names no URL */ }
  const receipt = new Map(reported.filter((item) => item?.source === SOURCE).map((item) => [item.partition, item]));
  return {
    scanRunId: scan.run_id,
    scanStartedAt: scan.started_at,
    scanFinishedAt: scan.finished_at,
    scanRunning: false,
    // The whole CareerOps step failed: there is no per-company list to read by hand.
    wholeScanFailed: failed.some((row) => row.partition === 'all'),
    lists: failed.filter((row) => row.partition !== 'all' && !settled.has(row.partition)).map((row) => ({
      partition: row.partition,
      company: receipt.get(row.partition)?.company ?? nameOf(row.partition),
      careersUrl: receipt.get(row.partition)?.careersUrl ?? null,
      error: row.detail || null,
    })),
  };
}

function openList(db, partition, now) {
  const state = failedLists(db, { now });
  if (state.scanRunning) throw refuse(`A scan run is still running (${state.scanRunId}); read the lists after it has finished`, 75);
  const list = state.lists.find((item) => item.partition === partition);
  if (!list) throw refuse(`"${partition}" is not a company list waiting for a browser read (it did not fail in the latest scan, or it was already read)`);
  return { ...list, scanRunId: state.scanRunId };
}

// A browser run is written in two steps. The run row comes first (observations name it) but it
// settles nothing: a list counts as read only once its run_sources row exists, and that row is
// written together with the final receipt after the batch is in.
function openRun(db, { runId, parentRunId, now, scanRunId }) {
  db.prepare(`INSERT INTO runs (run_id,kind,parent_run_id,owner,started_at,heartbeat_at,finished_at,status,receipt_json) VALUES (?,'scan',?,?,?,?,?,'failed',?)`)
    .run(runId, parentRunId ?? null, randomUUID(), now, now, now, JSON.stringify({ runId, browserList: true, forScanRunId: scanRunId, error: 'browser read not finished' }));
}

function closeRun(db, { runId, status, partitionStatus, partition, count, quarantined = 0, detail, receipt }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO run_sources (run_id,source,partition,status,count,errors,truncated,expected,detail,baseline,alert,raw_count,quarantined)
      VALUES (?,?,?,?,?,?,0,1,?,NULL,NULL,?,?)`).run(runId, SOURCE, partition, partitionStatus, count, Number(partitionStatus === 'error'), redact(detail), count, quarantined);
    db.prepare('UPDATE runs SET status=?,receipt_json=? WHERE run_id=?').run(status, redact(JSON.stringify(receipt)), runId);
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

// A posting the journal already knows (any identity alias of the row is owned) keeps its record:
// a browser row holds less than what a provider read, so storing it would look like a content
// change and send a settled or held review back to the start.
function isKnown(db, record, identity) {
  if (record.invalid) return false;
  const owned = db.prepare('SELECT 1 FROM posting_aliases WHERE alias=?');
  return aliasesFor(record, identity).some(({ alias }) => owned.get(alias) != null);
}

// Rows a person read off the company's careers page: [{ title, url, location | locations, requisitionId?, postedAt? }].
export function attachBrowserList(db, { partition, rows, now = new Date().toISOString(), policy = {}, profile, runId = `scan-browser-${randomUUID()}`, parentRunId }) {
  const list = openList(db, partition, now);
  if (!Array.isArray(rows)) throw refuse('The rows file must hold a JSON array of { title, url, location } objects');
  const byKey = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw refuse('Every row must be an object with title, url and location');
    const locations = [...(Array.isArray(row.locations) ? row.locations : []), ...(row.location ? [row.location] : [])].map((value) => String(value).trim()).filter(Boolean);
    // The same posting found by two searches, with or without tracking parameters, is one row; every
    // location it was listed under is kept.
    const key = canonicalUrl(row.url) || String(row.url ?? '').trim() || `\0${byKey.size}`;
    const known = byKey.get(key);
    if (known) { for (const location of locations) if (!known.locations.includes(location)) known.locations.push(location); continue; }
    byKey.set(key, { id: row.url, title: row.title, url: row.url, locations,
      requisitionId: row.requisitionId ?? null, postedAt: row.postedAt ?? null, company: list.company, partition,
      // No description was read: the review fetches the posting page itself.
      completeness: { description: 'none' } });
  }
  const roles = [...byKey.values()];
  const read = parseCareerOpsRoles({ roles });
  const records = read.filter((record) => !isKnown(db, record, identityOptionsOf(policy)));
  const known = read.length - records.length;
  openRun(db, { runId, parentRunId, now, scanRunId: list.scanRunId });
  try {
    const result = ingestBatch(db, { runId, source: SOURCE, partition, records, now, policy, profile });
    const { elapsedMs, ...counts } = result;
    const summary = { runId, status: 'partial', dryRun: false, browserList: true, forScanRunId: list.scanRunId,
      sources: [{ source: SOURCE, partition, status: 'partial', count: read.length, rawCount: read.length, truncated: false, detail: BROWSER_LIST_DETAIL, company: list.company,
        known, fetched: records.length, stored: result.stored, countedOnly: result.countedOnly, quarantined: result.quarantined }],
      alerts: [], counts: { raw: records.length, known, ...counts },
      ingest: [{ source: SOURCE, partition, fetched: records.length, stored: result.stored, countedOnly: result.countedOnly, quarantined: result.quarantined, elapsedMs }] };
    closeRun(db, { runId, status: 'partial', partitionStatus: 'partial', partition, count: read.length, quarantined: result.quarantined, detail: BROWSER_LIST_DETAIL, receipt: summary });
    return summary;
  } catch (error) {
    // The run row stays `failed` with no run_sources row, so the list is still waiting.
    try { db.prepare('UPDATE runs SET receipt_json=? WHERE run_id=?').run(redact(JSON.stringify({ runId, browserList: true, forScanRunId: list.scanRunId, error: error.message })), runId); } catch { /* keep the first error */ }
    throw error;
  }
}

// The careers page could not be read in a browser either (sign-in wall, bot wall, CAPTCHA).
export function markListUnreadable(db, { partition, reason, now = new Date().toISOString(), runId = `scan-browser-${randomUUID()}`, parentRunId }) {
  const list = openList(db, partition, now);
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) throw refuse('--unreadable needs --reason "<what the page showed and its URL>"');
  const detail = `browser read failed: ${text}`;
  const summary = { runId, status: 'failed', dryRun: false, browserList: true, forScanRunId: list.scanRunId,
    sources: [{ source: SOURCE, partition, status: 'error', count: 0, rawCount: 0, truncated: false, detail, company: list.company }],
    alerts: [{ source: SOURCE, partition, alert: 'error' }], counts: { raw: 0, known: 0 }, ingest: [] };
  openRun(db, { runId, parentRunId, now, scanRunId: list.scanRunId });
  closeRun(db, { runId, status: 'failed', partitionStatus: 'error', partition, count: 0, detail, receipt: summary });
  return summary;
}
