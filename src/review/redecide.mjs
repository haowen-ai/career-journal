import { dependencyHash } from './inputs.mjs';
import { buildJudgeRequest } from './prompt.mjs';
import { inputState } from './worker.mjs';
import { cachedJudgment, judgmentEnvelope } from './judgment-cache.mjs';
import { decide } from './decide.mjs';
import { applyCompanyCap, deliver, deliveryPolicy, heldReleaseBlock, parseJson, suppressSubmittedDuplicates } from './deliver.mjs';
import { atomic, claimItem } from './lease.mjs';
import { reviewOwnershipJoins, userDecisionSql, userDecided } from './ownership.mjs';
import { jevDecision, jevVerdict, usesJevSplit } from './jev-split.mjs';
import { exemptVerdict, jevPlaceOnly, locationExempt } from './overrides.mjs';
import { applyRoleDirection } from './direction-pass.mjs';

const without = (parts, key) => Object.fromEntries(Object.entries(parts ?? {}).filter(([name]) => name !== key));

// Replay only the deterministic decision layer. Cached judgments retain their
// original hashes: they were produced by those dependencies, not today's code.
// A Jev-decided review is replayed from its stored probabilities. postingIds
// limits the replay to those postings.
export async function redecideReviews(db, { inputs, judges, held, done = false, now, postingIds = null }) {
  suppressSubmittedDuplicates(db, { now, policy: inputs.screeningPolicy });
  applyCompanyCap(db, { now, policy: deliveryPolicy(inputs) });
  const only = postingIds ? new Set([postingIds].flat()) : null;
  applyRoleDirection(db, { now, policy: deliveryPolicy(inputs) });
  const runtime = {};
  for (const tier of ['primary', 'escalation']) {
    const request = await buildJudgeRequest({ posting: {}, snapshot: { text: '' }, sections: [], inputs, adapter: judges[tier], tier });
    runtime[tier] = request.deps.parts;
  }
  const currentInputs = without(inputState(inputs), 'code');
  const states = [...(held ? ['held'] : []), ...(done ? ['done'] : [])];
  const report = { redecided: 0, changed: 0, kept: 0, by_decision: {} };
  const candidates = db.prepare(`SELECT r.posting_id FROM reviews r JOIN postings p ON p.id=r.posting_id
    ${reviewOwnershipJoins} WHERE p.merged_into IS NULL AND NOT ${userDecisionSql}
    AND r.state IN (${states.map(() => '?').join(',')}) ORDER BY r.first_seen,r.posting_id`).all(...states);
  for (const { posting_id: id } of candidates) {
    if (only && !only.has(id)) continue;
    atomic(db, () => {
      const row = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(id);
      if (!states.includes(row.state) || userDecided(db, row)) return;
      const stored = parseJson(row.dep_hashes_json);
      if (stored.invalidated || !stored.inputs || dependencyHash(without(stored.inputs, 'code')) !== dependencyHash(currentInputs)) return;
      const snapshot = db.prepare(`SELECT * FROM snapshots WHERE posting_id=? AND identity_ok=1 AND text IS NOT NULL
        ORDER BY fetched_at DESC,rowid DESC LIMIT 1`).get(id);
      if (!snapshot || stored.snapshot !== snapshot.content_hash) return;
      const posting = db.prepare('SELECT * FROM postings WHERE id=?').get(id);
      const aliases = inputs.screeningPolicy?.companyAliases;
      const stage = parseJson(row.evidence_json);
      let verdict;
      let functionLabel;
      if (parseJson(row.flags_json, []).includes('jev_decided') && stage.jev && usesJevSplit(inputs.policy)) {
        const thresholds = inputs.policy.judge.primary.thresholds;
        const decided = jevDecision(stage.jev, thresholds);
        // In between, or an exempt brand's place-only rejection, needs a judge call: not a replay.
        if (!decided || decided.code === 'outside_area' && jevPlaceOnly(stage.jev, thresholds) && locationExempt(posting.company, inputs.overrides, aliases)) return;
        verdict = jevVerdict(decided, stage.jev, inputs.facts);
      } else for (const tier of ['primary', 'escalation']) {
        const parts = stored.runtime?.[tier];
        if (!parts || dependencyHash(without(parts, 'decide')) !== dependencyHash(without(runtime[tier], 'decide'))) return;
        const context = { tier, depsHash: dependencyHash(parts), snapshotHash: snapshot.content_hash, remember: false };
        const output = cachedJudgment(db, id, context);
        if (!judgmentEnvelope(output, context)) return;
        if (typeof output.function?.value === 'string') functionLabel = output.function.value;
        const args = { snapshotText: snapshot.text, judgment: output, facts: inputs.facts, policy: inputs.policy,
          tier, firstSeen: posting.first_seen, jobType: inputs.profile?.search?.jobType };
        verdict = exemptVerdict({ ...args, verdict: decide(args), company: posting.company, overrides: inputs.overrides, aliases });
        if (!verdict.escalate) break;
      }
      if (!verdict || verdict.escalate) return;
      // A replayed judgment never answers a question hold; leave it held untouched.
      if (heldReleaseBlock(row, verdict)) { report.kept += 1; return; }
      const fence = claimItem(db, id, { owner: `redecide-${process.pid}`, now });
      if (!fence) return;
      deliver(db, { postingId: id, fence, verdict: functionLabel === undefined ? verdict : { ...verdict, functionValue: functionLabel }, now, policy: deliveryPolicy(inputs) });
      const delivered = db.prepare('SELECT decision,code FROM reviews WHERE posting_id=?').get(id);
      report.redecided += 1;
      if (delivered.decision !== row.decision || delivered.code !== row.code) report.changed += 1;
      report.by_decision[delivered.decision] = (report.by_decision[delivered.decision] ?? 0) + 1;
    });
  }
  return report;
}
