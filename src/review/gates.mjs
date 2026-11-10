import { createHash } from 'node:crypto';
import { titleScreenDrop } from '../funnel/classify.mjs';
import { findQuote } from './clauses.mjs';
import { deliver, deliveryPolicy, logReview, parseJson } from './deliver.mjs';
import { dependencyHash } from './inputs.mjs';
import { atomic, claimItem } from './lease.mjs';
import { reviewOwnershipJoins, userDecisionSql } from './ownership.mjs';
import { autoReopenAllowed } from './reopen-policy.mjs';
import { currentLocations, locationGate, locationGateSettings } from './grouping.mjs';

// Screening redesign, amendment G (user, 2026-11-09): the review settles what code can decide before any fetch or
// model call, and the primary model's well-quoted rejections are final.
//
// Pre-fetch gates (applyRuleGates), for state='due' reviews only (never held, browser_review or user-owned rows):
//   title    (G6) the function list of profile/title-screen.json with every scan guard (direction words, role-direction
//            allow patterns, anyFunctionCompanies); level/term/language are not run here. -> function_out_of_scope
//   location (G1) grouping.mjs locationGate: complete, specific US places all outside the wanted states, no exempt
//            brand, no remote/hybrid or summary wording. -> outside_area
// A rule settlement carries flags [title_rule|location_rule, automated] and evidence.ruleGate { rule, matchedText,
// configHash }; it is never a same-title group source (G4). Its dep_hashes_json.ruleGate keeps the config hash, and
// replanRuleSettled re-queues it when that configuration changes.
//
// Escalation routing (G2/G3, used by reviewPrimaryVerdict for the worker and eval):
//   judge.finalRejectionCodes  codes whose quoted primary rejection is final (default below)
//   judge.escalationSample     share of those final rejections still escalated, chosen by a hash of the posting id
//                              (default 0.05; 0 turns the sample off)

export const DEFAULT_FINAL_REJECTION_CODES = Object.freeze(['outside_area', 'function_out_of_scope', 'degree', 'graduation', 'authorization', 'term_or_area']);
export const DEFAULT_ESCALATION_SAMPLE = 0.05;
export const RULE_FLAGS = Object.freeze({ title_function: 'title_rule', location_outside_area: 'location_rule' });
export const RULE_CODES = Object.freeze({ title_function: 'function_out_of_scope', location_outside_area: 'outside_area' });
export const AUTOMATED_FLAG = 'automated';
export const RULE_CHANGED = 'rule_changed';
const EXPLORATION_LANES = ['no_student_signal', 'out_of_direction'];

export function escalationRouting(policy) {
  const judge = policy?.judge ?? {};
  const codes = judge.finalRejectionCodes ?? DEFAULT_FINAL_REJECTION_CODES;
  if (!Array.isArray(codes) || !codes.every((code) => typeof code === 'string' && code.trim())) {
    throw new Error('review policy judge.finalRejectionCodes must be a list of rejection codes');
  }
  const sample = judge.escalationSample ?? DEFAULT_ESCALATION_SAMPLE;
  if (typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error('review policy judge.escalationSample must be a number from 0 to 1');
  }
  return { finalCodes: new Set(codes.map((code) => code.trim())), sample };
}

// Fetch failure kinds that a retry will not fix (forbidden, bot wall, another posting, a stub, or a page with no
// readable posting body): the worker sends them to browser_review on the first failure instead of waiting for the
// third. Review policy fetcher.browserAtOnce (a list of failure kinds) replaces the default; absent keeps it.
export const DEFAULT_BROWSER_AT_ONCE = Object.freeze(['http_403', 'challenge', 'wrong_posting', 'too_short']);

export function browserAtOnce(policy) {
  const kinds = policy?.fetcher?.browserAtOnce ?? DEFAULT_BROWSER_AT_ONCE;
  if (!Array.isArray(kinds) || !kinds.every((kind) => typeof kind === 'string' && kind.trim())) {
    throw new Error('review policy fetcher.browserAtOnce must be a list of fetch failure kinds');
  }
  return Object.freeze(kinds.map((kind) => kind.trim()));
}

// Deterministic: the same posting is always in or out of the sample for the same share, so runs are reproducible.
export function escalationSampled(postingId, sample) {
  if (!(sample > 0) || postingId === null || postingId === undefined) return false;
  if (sample >= 1) return true;
  const value = Number.parseInt(createHash('sha256').update(`escalation-sample:${postingId}`).digest('hex').slice(0, 12), 16) / 2 ** 48;
  return value < sample;
}

// The posting quote behind a primary rejection, or null. The function rejection needs the judge's function quote; a
// criterion rejection needs the conflicting criterion's quote; both must be found verbatim in the posting text.
export function rejectionQuote({ verdict, judgment, snapshotText }) {
  const text = String(snapshotText ?? '');
  const found = (quote) => (findQuote(text, quote) ? quote : null);
  if (verdict?.code === 'function_out_of_scope') return found(judgment?.function?.quote);
  const criterion = (judgment?.criteria ?? []).find((item) => item?.key === verdict?.code && item.status === 'conflicts' && found(item.quote));
  if (criterion) return criterion.quote;
  if (judgment) return null;
  // Without the raw judgment: the confirmed evidence decide() kept for this rejection's clause.
  const evidence = (verdict?.evidence ?? []).find((item) => item?.confirmed === true && (item.clause === verdict.question || item.code === verdict.code) && found(item.quote));
  return evidence?.quote ?? null;
}

// The title screen with only its function list (G6): level, term and language are scan-only.
export function titleGateScreen(titleScreen) {
  return titleScreen?.function?.length ? { function: titleScreen.function, level: [], term: false, maxNonLatinShare: null } : null;
}

export function titleGate({ title, company }, { titleScreen, direction = null, aliases = {} }) {
  const screen = titleGateScreen(titleScreen);
  if (!screen) return null;
  const drop = titleScreenDrop({ title, company }, { titleScreen: screen, direction, companyAliases: aliases });
  if (drop?.code !== 'title_function') return null;
  const pattern = screen.function.find((item) => item.source === drop.evidence[1]);
  return { rule: 'title_function', pattern: drop.evidence[1], matchedText: pattern?.exec(String(title))?.[0] ?? null };
}

// Configuration hashes each rule depends on: a change re-queues the rows that rule settled (G4).
export function ruleGateHashes(inputs) {
  const policy = deliveryPolicy(inputs);
  const direction = inputs.direction ?? null;
  const sources = (list) => (list ?? []).map((pattern) => pattern.source);
  return {
    title_function: dependencyHash({ function: sources(inputs.titleScreen?.function), allow: sources(direction?.allow),
      anyFunctionCompanies: direction?.anyFunctionCompanies ?? [], aliases: policy.companyAliases ?? {} }),
    location_outside_area: dependencyHash({ areas: inputs.policy?.areas ?? null, exempt: inputs.overrides?.locationExempt ?? null, aliases: policy.companyAliases ?? {},
      untrustedHosts: locationGateSettings(inputs.policy).untrustedHosts }),
  };
}

function recordFields(db, postingId) {
  const observation = db.prepare('SELECT fields_json FROM observations WHERE posting_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1').get(postingId);
  const snapshot = db.prepare('SELECT fields_json FROM snapshots WHERE posting_id=? AND identity_ok=1 ORDER BY fetched_at DESC,rowid DESC LIMIT 1').get(postingId);
  return [parseJson(observation?.fields_json), parseJson(snapshot?.fields_json)].filter((fields) => fields && Object.keys(fields).length);
}

// Which rule settles a posting, if any (title first, then location). Pure apart from reading the posting's record.
export function ruleGateHit(db, row, { inputs, policy = deliveryPolicy(inputs) }) {
  const aliases = policy.companyAliases ?? {};
  const title = titleGate({ title: row.title, company: row.company }, { titleScreen: inputs.titleScreen, direction: inputs.direction ?? null, aliases });
  if (title) return title;
  const url = row.canonical_url ?? db.prepare('SELECT canonical_url FROM postings WHERE id=?').get(row.posting_id)?.canonical_url ?? null;
  return locationGate({ locations: currentLocations(db, row.posting_id), record: recordFields(db, row.posting_id), title: row.title,
    policy: inputs.policy, company: row.company, overrides: inputs.overrides, aliases, url });
}

export function ruleGateVerdict(hit, configHash) {
  const code = RULE_CODES[hit.rule];
  const ruleGate = { rule: hit.rule, matchedText: hit.matchedText, configHash, ...(hit.pattern ? { pattern: hit.pattern } : {}) };
  return { decision: 'not_eligible', code, evidence: [{ confirmed: true, code, ...ruleGate, ...(hit.places ? { places: hit.places } : {}) }],
    location: hit.places ? { offices: [], remote: { scope: null, quote: null }, display: hit.places.join('; '), alternatives: [] } : null,
    question: null, holdFactIds: [], nextAction: null, flags: [RULE_FLAGS[hit.rule], AUTOMATED_FLAG], ruleGate };
}

// Settles due reviews by the title and location rules. Returns { title, location }.
export function applyRuleGates(db, { now, inputs, owner = 'review-rule-gate' }) {
  const policy = deliveryPolicy(inputs);
  const hashes = ruleGateHashes(inputs);
  const settled = { title: 0, location: 0 };
  const rows = db.prepare(`SELECT r.posting_id,r.decision,r.lane,r.evidence_json,r.dep_hashes_json,p.company,p.title,p.canonical_url FROM reviews r JOIN postings p ON p.id=r.posting_id
    ${reviewOwnershipJoins} WHERE r.state='due' AND p.merged_into IS NULL AND NOT ${userDecisionSql}`).all();
  for (const row of rows) {
    // Exploration lanes are sampling (delivery rewrites their code); a lead re-queued for a refresh was judged eligible
    // by the model; an explicit `review rejudge` asked for a model check. None of them is settled by a rule.
    if (EXPLORATION_LANES.includes(row.lane) || row.decision === 'eligible') continue;
    if (parseJson(row.evidence_json).reopenAuthorization?.authorization === 'rejudge') continue;
    const hit = ruleGateHit(db, row, { inputs, policy });
    if (!hit) continue;
    atomic(db, () => {
      const fence = claimItem(db, row.posting_id, { owner, now });
      if (!fence) return;
      const verdict = ruleGateVerdict(hit, hashes[hit.rule]);
      deliver(db, { postingId: row.posting_id, verdict, fence, now, policy });
      const committed = db.prepare('SELECT state,code,dep_hashes_json FROM reviews WHERE posting_id=?').get(row.posting_id);
      if (committed.state !== 'done' || committed.code !== verdict.code) return;
      const deps = { ...parseJson(committed.dep_hashes_json), ruleGate: { rule: hit.rule, configHash: hashes[hit.rule] }, invalidated: false };
      delete deps.releasedHold;
      db.prepare('UPDATE reviews SET dep_hashes_json=? WHERE posting_id=?').run(JSON.stringify(deps), row.posting_id);
      logReview(db, row.posting_id, { now, stage: 'judge', kind: 'outcome', payload: { ruleGate: verdict.ruleGate } });
      settled[hit.rule === 'title_function' ? 'title' : 'location'] += 1;
    });
  }
  return settled;
}

// G4: a rule settlement whose configuration changed since (title-screen.json function list and its guards, the areas,
// the location-exempt brands or the company aliases) is re-queued with a rule_changed authorization. The gates run
// right after, so a row the new configuration still settles is settled again without a fetch.
export function replanRuleSettled(db, { now, inputs }) {
  const hashes = ruleGateHashes(inputs);
  let requeued = 0;
  atomic(db, () => {
    for (const row of db.prepare(`SELECT r.*,a.status application_status FROM reviews r JOIN postings p ON p.id=r.posting_id ${reviewOwnershipJoins}
      WHERE r.state='done' AND json_valid(r.dep_hashes_json) AND json_extract(r.dep_hashes_json,'$.ruleGate.rule') IS NOT NULL AND NOT ${userDecisionSql}`).all()) {
      const deps = parseJson(row.dep_hashes_json);
      const { rule, configHash } = deps.ruleGate ?? {};
      if (!Object.hasOwn(hashes, rule) || configHash === hashes[rule] || row.code !== RULE_CODES[rule]) continue;
      if (!autoReopenAllowed({ review: row, application: row.application_status == null ? null : { status: row.application_status }, authorization: RULE_CHANGED })) continue;
      const evidence = { ...parseJson(row.evidence_json), reopenAuthorization: { authorization: RULE_CHANGED, at: now, rule } };
      const stored = { ...deps, invalidated: true };
      delete stored.ruleGate;
      const fetched = db.prepare('SELECT 1 FROM snapshots WHERE posting_id=? AND identity_ok=1 AND text IS NOT NULL LIMIT 1').get(row.posting_id);
      db.prepare(`UPDATE reviews SET state='due',stage=?,decision=NULL,code=NULL,next_due=?,hold_owner=NULL,hold_since=NULL,evidence_json=?,dep_hashes_json=?,updated_at=?
        WHERE posting_id=? AND state='done'`).run(fetched ? 'judge' : 'fetch', now, JSON.stringify(evidence), JSON.stringify(stored), now, row.posting_id);
      logReview(db, row.posting_id, { now, stage: 'judge', kind: 'replan', payload: { reason: 'rule configuration changed', rule } });
      requeued += 1;
    }
  });
  return { requeued };
}
