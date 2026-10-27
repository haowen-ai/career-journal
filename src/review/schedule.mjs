import { EXPLORATION_SHARE } from '../funnel/contract.mjs';
import { reviewOwnershipJoins, userDecisionSql } from './ownership.mjs';

// Keep backlog-sized work inside SQLite. Only the bounded admitted buffer crosses
// into JS; ownership and posting URLs must not require per-candidate lookups.
export function createReviewScheduler(db, { now, owner, policy, budget, unlistedOnly }) {
  const allowance = budget ? Math.max(1, Math.ceil(budget * EXPLORATION_SHARE)) : 0;
  const common = { now, owner, unlisted: JSON.stringify([...unlistedOnly]), allowance };
  const reviewable = `FROM reviews r JOIN postings p ON p.id=r.posting_id
    ${reviewOwnershipJoins}
    WHERE (r.next_due IS NULL OR r.next_due<=:now) AND NOT ${userDecisionSql}
      AND r.posting_id NOT IN (SELECT value FROM json_each(:unlisted))`;
  const explorationCount = db.prepare(`SELECT COUNT(*) n FROM (
    SELECT 1 ${reviewable}
      AND r.lane IN ('no_student_signal','out_of_direction')
      AND (r.state='due' OR r.state='leased' AND r.lease_owner=:owner)
    LIMIT :allowance)`);
  const explorationAvailable = () => allowance ? explorationCount.get(common).n : 0;
  const explorationTarget = explorationAvailable();
  const select = db.prepare(`WITH
    base AS NOT MATERIALIZED (
      SELECT r.posting_id,r.stage,r.lane,r.first_seen,
        r.lane IN ('no_student_signal','out_of_direction') exploration,
        r.lane NOT IN ('no_student_signal','out_of_direction')
          AND (r.lane='aged' OR julianday(:now)-julianday(r.first_seen)>=:agedDays) aged,
        CASE WHEN json_extract(CASE WHEN json_valid(r.deadline_json) THEN r.deadline_json ELSE '{}' END,'$.kind')='cutoff'
          AND julianday(json_extract(CASE WHEN json_valid(r.deadline_json) THEN r.deadline_json ELSE '{}' END,'$.date'))<=julianday(:now)+7
          THEN julianday(json_extract(CASE WHEN json_valid(r.deadline_json) THEN r.deadline_json ELSE '{}' END,'$.date')) END cutoff
      ${reviewable}
        AND (r.state='due' OR r.state='leased' AND r.posting_id IN (SELECT value FROM json_each(:fetching)))
        AND r.posting_id NOT IN (SELECT value FROM json_each(:seen))
    ), sampled AS MATERIALIZED (
      SELECT * FROM base WHERE exploration ORDER BY first_seen,posting_id LIMIT :explorationLeft
    ), eligible AS MATERIALIZED (
      SELECT * FROM base WHERE NOT exploration UNION ALL SELECT * FROM sampled
    ), deadlines AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY cutoff IS NULL,cutoff,first_seen,posting_id) deadline_rank FROM eligible
    ), ranked AS (
      -- The first deadline does not consume one of the additional aged slots.
      SELECT *, SUM(CASE WHEN aged AND NOT (cutoff IS NOT NULL AND deadline_rank=1) THEN 1 ELSE 0 END)
        OVER (ORDER BY first_seen,posting_id) aged_rank FROM deadlines
    ), paid_order AS (
      SELECT *, CASE
        WHEN cutoff IS NOT NULL AND deadline_rank=1 THEN 0
        WHEN aged AND aged_rank<=:agedReserve THEN 1
        WHEN exploration THEN 2 WHEN cutoff IS NOT NULL THEN 3 WHEN aged THEN 4
        WHEN lane='bootstrap' THEN 5 WHEN lane='new' THEN 6 WHEN lane='refresh' THEN 7 ELSE 8 END priority
      FROM ranked
    ), chosen AS MATERIALIZED (
      SELECT * FROM paid_order
      WHERE :fetchAllowed OR stage NOT IN ('scan','fetch') OR posting_id IN (SELECT value FROM json_each(:fetching))
      ORDER BY posting_id IN (SELECT value FROM json_each(:queued)) DESC,
        priority,CASE WHEN priority IN (0,3) THEN cutoff END,first_seen,posting_id
      LIMIT :limit
    )
    SELECT r.*,p.canonical_url,EXISTS(SELECT 1 FROM eligible) has_pending
    FROM (SELECT 1) marker LEFT JOIN chosen c ON 1
      LEFT JOIN reviews r ON r.posting_id=c.posting_id LEFT JOIN postings p ON p.id=c.posting_id
    ORDER BY c.priority,CASE WHEN c.priority IN (0,3) THEN c.cutoff END,c.first_seen,c.posting_id`);
  return {
    explorationTarget, explorationAvailable,
    refill({ seen, fetching, queued, explorationLeft, limit, fetchAllowed, policy: refillPolicy = policy }) {
      const rows = select.all({ now, unlisted: common.unlisted, seen: JSON.stringify([...seen]), fetching: JSON.stringify([...fetching]),
        queued: JSON.stringify(queued), explorationLeft, limit, fetchAllowed: Number(fetchAllowed),
        agedDays: refillPolicy.serviceTargets?.agedAfterDays ?? 2,
        agedReserve: Math.max(1, Math.ceil(budget * (refillPolicy.serviceTargets?.agedReserveShare ?? .25))) });
      return { pending: Boolean(rows[0].has_pending), rows: rows.filter((row) => row.posting_id) };
    },
  };
}
