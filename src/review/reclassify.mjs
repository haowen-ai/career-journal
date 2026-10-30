import { classifyRole } from '../funnel/classify.mjs';
import { SIGNAL_DROP_CODES } from '../funnel/contract.mjs';
import { currentRecordReader, latestSightings } from '../funnel/membership.mjs';
import { logReview, parseJson } from './deliver.mjs';
import { atomic } from './lease.mjs';
import { reviewOwnershipJoins, userDecisionSql } from './ownership.mjs';

const DESCRIPTION_RANK = { full: 2, tags: 1 };
const completeness = (observation) => {
  const parts = parseJson(observation.completeness_json);
  return (DESCRIPTION_RANK[parts.description] ?? 0) + (parts.locations === 'complete') + (parts.arrangement === 'known') + (parts.employment_type === 'explicit');
};
const ACTIVE_AFTER_MS = 600_000;

// The most complete source decides. A signal drop needs every source to agree, because one
// source's bare listing cannot rule out the student signal another source shows.
function classifyPosting(observations, options) {
  const [primary, ...others] = observations.toSorted((a, b) => completeness(b) - completeness(a))
    .map((observation) => classifyRole(JSON.parse(observation.fields_json), options));
  if (!SIGNAL_DROP_CODES.includes(primary.code)) return primary;
  return others.find((result) => result.kind === 'review') ?? primary;
}

const skipReason = (row) => row.user_decided ? 'user_decided' : row.hold_owner === 'user' ? 'user_held' : row.lease_owner ? 'leased'
  : row.application_id ? 'application' : row.merged_into ? 'merged' : parseJson(row.flags_json, []).includes('manual') ? 'manual' : null;

const activeRunError = (run) => Object.assign(new Error(`A ${run.kind} run is active (${run.run_id}); rerun reclassify after it finishes`), { code: 75 });

// One-off settlement of reviews queued before classifyRole dropped them at scan. A scan or review
// run must not overlap it: it refuses to start during one, and a batch that finds one rolls back.
// Reads happen outside the write lock; each batch re-checks ownership, merge membership and new
// sightings in one short transaction, so a run can be interrupted and repeated.
export function reclassifyReviews(db, { policy, profile, now, dryRun = false, batch = 500 }) {
  const activeRun = db.prepare(`SELECT run_id,kind FROM runs WHERE kind IN ('scan','review') AND status='running' AND heartbeat_at>=? ORDER BY started_at LIMIT 1`);
  const active = () => activeRun.get(new Date(Date.parse(now) - ACTIVE_AFTER_MS).toISOString());
  if (!dryRun && active()) throw activeRunError(active());
  const report = { dryRun, scanned: 0, dropped: {}, kept: {}, skipped: {}, batches: 0 };
  const bump = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
  const rows = db.prepare(`SELECT r.posting_id,r.lane,r.flags_json,r.hold_owner,r.lease_owner,r.updated_at,p.application_id,p.listed,p.merged_into,
      ${userDecisionSql} user_decided
    FROM reviews r JOIN postings p ON p.id=r.posting_id ${reviewOwnershipJoins}
    WHERE r.state='due' AND r.stage IN ('fetch','scan') ORDER BY r.first_seen,r.posting_id`).all();
  const { latest, maxRowid } = latestSightings(db);
  const reader = currentRecordReader(db);
  const stillOpen = db.prepare(`SELECT r.posting_id,r.updated_at FROM reviews r JOIN postings p ON p.id=r.posting_id ${reviewOwnershipJoins}
    WHERE r.posting_id IN (SELECT value FROM json_each(?)) AND r.state='due' AND r.stage IN ('fetch','scan') AND r.lease_owner IS NULL
      AND COALESCE(r.hold_owner,'')<>'user' AND p.application_id IS NULL AND p.merged_into IS NULL AND NOT ${userDecisionSql}`);
  const sightedSince = db.prepare('SELECT DISTINCT posting_id FROM observation_sightings WHERE rowid>?');
  const settle = db.prepare(`UPDATE reviews SET state='done',decision='dropped',code=?,next_due=NULL,updated_at=? WHERE posting_id=? AND state='due'`);
  for (let start = 0; start < rows.length; start += batch) {
    const drops = new Map();
    for (const row of rows.slice(start, start + batch)) {
      report.scanned += 1;
      const skip = skipReason(row);
      if (skip) { bump(report.skipped, skip); continue; }
      const members = reader.members(row.posting_id);
      const observations = reader.records(members, latest);
      if (!observations.length) { bump(report.skipped, 'no_observation'); continue; }
      // postings.listed follows whichever source was ingested last. Closed means closed everywhere.
      const delisted = !row.listed && observations.every((item) => !item.listed);
      const result = delisted ? { kind: 'drop', code: 'delisted', evidence: [] } : classifyPosting(observations, { policy, profile });
      if (result.kind === 'drop') drops.set(row.posting_id, { ...result, updatedAt: row.updated_at, members: members.join('\n') });
      else bump(report.kept, row.lane);
    }
    report.batches += 1;
    if (dryRun) { for (const { code } of drops.values()) bump(report.dropped, code); continue; }
    atomic(db, () => {
      const run = active();
      if (run) throw activeRunError(run);
      const open = new Map(stillOpen.all(JSON.stringify([...drops.keys()])).map((row) => [row.posting_id, row.updated_at]));
      // A sighting written after the read can change the latest record a decision used.
      const sighted = new Set(sightedSince.all(maxRowid).map((row) => row.posting_id));
      for (const [id, { code, evidence, updatedAt, members }] of drops) {
        const current = reader.members(id);
        if (open.get(id) !== updatedAt || current.join('\n') !== members || current.some((member) => sighted.has(member))) {
          bump(report.skipped, 'changed'); continue;
        }
        settle.run(code, now, id);
        logReview(db, id, { now, stage: 'scan', payload: { action: 'reclassified', code, evidence } });
        bump(report.dropped, code);
      }
    });
  }
  report.remainingDue = Object.fromEntries(db.prepare("SELECT lane,COUNT(*) n FROM reviews WHERE state='due' GROUP BY lane ORDER BY lane").all().map((row) => [row.lane, row.n]));
  return report;
}
