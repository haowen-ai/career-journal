import { createHash } from 'node:crypto';
import { SEASON_TOKEN, termSegments, titleScreenDrop, YEAR_TOKEN } from '../funnel/classify.mjs';
import { findQuote } from './clauses.mjs';
import { deliver, deliveryPolicy, logReview, parseJson } from './deliver.mjs';
import { dependencyHash } from './inputs.mjs';
import { atomic, claimItem } from './lease.mjs';
import { reviewOwnershipJoins, userDecisionSql } from './ownership.mjs';
import { locationExemptInWindow } from './overrides.mjs';
import { autoReopenAllowed } from './reopen-policy.mjs';
import { currentLocations, locationGate, locationGateSettings } from './grouping.mjs';

// Screening redesign, amendment G (user, 2026-11-09): the review settles what code can decide before any fetch or
// model call, and the primary model's well-quoted rejections are final.
//
// Pre-fetch gates (applyRuleGates), for state='due' reviews (never user-owned rows; of the held rows only the term rule's
// fetch-failure browser_review takeover below):
//   title    (G6) the function list of profile/title-screen.json with every scan guard (direction words, role-direction
//            allow patterns, anyFunctionCompanies); level/term/language are not run here. -> function_out_of_scope
//   location (G1) grouping.mjs locationGate: complete, specific US places all outside the wanted states, no exempt
//            brand, no remote/hybrid or summary wording. -> outside_area
//   term     (user, 2026-11-12) termLocationGate below: a title that states only a non-summer term of one configured
//            window, and complete, specific US places all outside that window's states. -> term_or_area
//            It also takes over held browser_review rows the worker's fetch-failure path produced (heldFromFetchFailure).
// A rule settlement carries flags [title_rule|location_rule|term_location_rule, automated] and evidence.ruleGate { rule, matchedText,
// configHash }; it is never a same-title group source (G4). Its dep_hashes_json.ruleGate keeps the config hash, and
// replanRuleSettled re-queues it when that configuration changes.
//
// Escalation routing (G2/G3, used by reviewPrimaryVerdict for the worker and eval):
//   judge.finalRejectionCodes  codes whose quoted primary rejection is final (default below)
//   judge.escalationSample     share of those final rejections still escalated, chosen by a hash of the posting id
//                              (default 0.05; 0 turns the sample off)

export const DEFAULT_FINAL_REJECTION_CODES = Object.freeze(['outside_area', 'function_out_of_scope', 'degree', 'graduation', 'authorization', 'term_or_area']);
export const DEFAULT_ESCALATION_SAMPLE = 0.05;
export const RULE_FLAGS = Object.freeze({ title_function: 'title_rule', location_outside_area: 'location_rule', term_location: 'term_location_rule' });
export const RULE_CODES = Object.freeze({ title_function: 'function_out_of_scope', location_outside_area: 'outside_area', term_location: 'term_or_area' });
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

// ------------------------------------------------------------------ term + location gate (user, 2026-11-12)
// A posting whose TITLE states only a non-summer term of one configured window (review-policy.json windows, for example
// "Winter/Spring 2027" against the off-season window) and whose complete, specific US places (the G1 parse rule) are all
// outside that window's states is settled term_or_area before any fetch. The window's states are areas.homeStates (the
// policy's own rule for the off-season areas: the home metro area and remote within a home state); a window whose in-person
// areas cover every configured area is the location gate's job and never this one. The title proof is strict, and
// anything it cannot prove goes to the fetch and the judge as before:
//   - at least one season word paired with a year (the classify.mjs segments, at most three words apart), every season
//     word in the title paired, and every season in that one window's termKinds;
//   - every year in the title (range ends too) is the window's year;
//   - no "summer" anywhere, no month name or abbreviation, no graduation, cohort, start or hiring wording.
// A location-exempt brand is exempt here only when its exemption covers that window (overrides.mjs exemptWindow).
// Review policy termLocationGate.enabled (default true) turns the gate off; it is not a screening policy part.
const SUMMER_WORD = /\bsummer\b/i;
const MONTH_WORD = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const COHORT_WORD = /\b(?:graduat\w*|grads?|class\s+of|alumni|cohorts?|intakes?|start(?:s|ing|ers?)?|hires?|hiring)\b/i;
const SEASON_WORDS = /\b(?:spring|summer|fall|autumn|winter)\b/gi;
const TITLE_YEARS = /\b(20\d\d)(?:\s*[-–/]\s*(?:20)?(\d\d)\b)?/g;

export function termLocationGateSettings(policy) {
  const section = policy?.termLocationGate;
  if (section === undefined || section === null) return { enabled: true };
  if (typeof section !== 'object' || Array.isArray(section)) throw new Error('review policy termLocationGate must be an object');
  for (const key of Object.keys(section)) if (key !== 'enabled') throw new Error(`review policy termLocationGate has an unknown key ${JSON.stringify(key)}`);
  if (section.enabled !== undefined && typeof section.enabled !== 'boolean') throw new Error('review policy termLocationGate.enabled must be true or false');
  return { enabled: section.enabled !== false };
}

const kindsOf = (window) => (Array.isArray(window?.termKinds) ? window.termKinds : []).map((kind) => String(kind).trim().toLowerCase());
const inPersonAreas = (list) => (Array.isArray(list) ? list : []).filter((key) => key !== 'us_remote');

// The one non-summer window a title's stated terms prove, with the terms: { window, terms } or null.
export function offseasonTitleTerm(title, policy) {
  const text = String(title ?? '');
  if (!text || SUMMER_WORD.test(text) || MONTH_WORD.test(text) || COHORT_WORD.test(text)) return null;
  const years = [...text.matchAll(TITLE_YEARS)].flatMap((match) => [Number(match[1]), ...(match[2] ? [2000 + Number(match[2])] : [])]);
  const tokens = [];
  for (const words of termSegments(text)) {
    const yearsAt = words.flatMap((word, index) => { const year = YEAR_TOKEN.exec(word); return year ? [{ index, year: year[2] ? 2000 + Number(year[2]) : Number(year[1]) }] : []; });
    words.forEach((word, index) => {
      if (!SEASON_TOKEN.test(word)) return;
      tokens.push({ season: word.toLowerCase(), years: yearsAt.filter((item) => Math.abs(item.index - index) - 1 <= 3).map((item) => item.year) });
    });
  }
  // Every season word of the title must be a token with a year ("Winter-Spring 2027" is one word: not proven).
  if (!tokens.length || tokens.length !== (text.match(SEASON_WORDS) ?? []).length || tokens.some((token) => !token.years.length)) return null;
  const year = years[0];
  if (!years.length || years.some((value) => value !== year)) return null;
  const windows = (policy?.windows ?? []).filter((window) => window && window.year !== undefined && window.year !== null && Number(window.year) === year);
  const matched = new Set();
  for (const token of tokens) {
    const hits = windows.filter((window) => kindsOf(window).includes(token.season));
    if (!hits.length) return null;
    for (const window of hits) matched.add(window);
  }
  if (matched.size !== 1) return null;
  const [window] = matched;
  if (kindsOf(window).includes('summer')) return null;
  const allInPerson = inPersonAreas(policy?.areas?.keys);
  const windowInPerson = inPersonAreas(window.areas);
  if (!allInPerson.length || allInPerson.every((key) => windowInPerson.includes(key))) return null;
  const terms = [...new Set(tokens.map((token) => `${token.season} ${year}`))];
  return { window, terms };
}

export function termLocationGate({ title, locations, record = {}, policy, company, overrides, aliases = {}, url = null }) {
  if (!termLocationGateSettings(policy).enabled) return null;
  const term = offseasonTitleTerm(title, policy);
  if (!term) return null;
  const homeStates = (Array.isArray(policy?.areas?.homeStates) ? policy.areas.homeStates : []).map((state) => String(state).toUpperCase());
  if (!homeStates.length) return null;
  if (locationExemptInWindow(company, term.window, { policy, overrides, aliases })) return null;
  // The G1 parse rule with the window's states as the wanted ones (the exemption was checked above, per window).
  const places = locationGate({ locations, record, title, policy: { ...policy, areas: { ...policy.areas, allowedStates: homeStates } }, company: null, overrides: null, aliases, url });
  if (!places) return null;
  return { rule: 'term_location', matchedText: term.terms.join(', '), window: term.window.id ?? null, places: places.places, states: places.states };
}

// Held browser_review rows the worker's fetch-failure path produced (worker.mjs: deliver with code browser_review, logged
// with verdict.holdOrigin 'fetch_failure', or before that marker with the question "Open the official posting: …"),
// identified by the delivery logged at the hold's own start. Never a hold from `review hold`, an identity conflict, or a
// row with any user action (a user decision, a user review log entry, a user application event).
export const HELD_FROM_FETCH_FAILURE_SQL = `r.state='held' AND r.code='browser_review'
  AND EXISTS (SELECT 1 FROM review_log l WHERE l.posting_id=r.posting_id AND l.kind='delivery' AND l.at=r.hold_since AND json_valid(l.payload_json)
    AND json_extract(l.payload_json,'$.verdict.code')='browser_review'
    AND (json_extract(l.payload_json,'$.verdict.holdOrigin')='fetch_failure' OR json_extract(l.payload_json,'$.verdict.question') LIKE 'Open the official posting:%'))
  AND NOT EXISTS (SELECT 1 FROM review_log m WHERE m.posting_id=r.posting_id AND json_valid(m.payload_json) AND json_extract(m.payload_json,'$.action')='manual_hold')
  AND NOT EXISTS (SELECT 1 FROM application_events e WHERE e.application_id=p.application_id AND (
    json_valid(e.source_json) AND (json_extract(e.source_json,'$.actor') IN ('user','apply') OR json_extract(e.source_json,'$.kind') IN ('user','manual','event-command'))
    OR (NOT json_valid(e.source_json) OR json_extract(e.source_json,'$.actor') IS NULL) AND (e.event_type LIKE 'manual\\_%' ESCAPE '\\' OR e.event_type LIKE 'user\\_%' ESCAPE '\\')))`;

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
    // The on/off switch is left out: turning the gate off stops new settlements without re-queuing the settled ones.
    term_location: dependencyHash({ windows: inputs.policy?.windows ?? null, areas: inputs.policy?.areas ?? null, exempt: inputs.overrides?.locationExempt ?? null,
      aliases: policy.companyAliases ?? {}, untrustedHosts: locationGateSettings(inputs.policy).untrustedHosts }),
  };
}

function recordFields(db, postingId) {
  const observation = db.prepare('SELECT fields_json FROM observations WHERE posting_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1').get(postingId);
  const snapshot = db.prepare('SELECT fields_json FROM snapshots WHERE posting_id=? AND identity_ok=1 ORDER BY fetched_at DESC,rowid DESC LIMIT 1').get(postingId);
  return [parseJson(observation?.fields_json), parseJson(snapshot?.fields_json)].filter((fields) => fields && Object.keys(fields).length);
}

// Which rule settles a posting, if any (title first, then location, then term + location). Pure apart from reading the
// posting's record. `only` limits the rules tried (a held row is taken over by the term rule alone).
export function ruleGateHit(db, row, { inputs, policy = deliveryPolicy(inputs), only = null }) {
  const aliases = policy.companyAliases ?? {};
  const tries = (rule) => !only || only.includes(rule);
  if (tries('title_function')) {
    const title = titleGate({ title: row.title, company: row.company }, { titleScreen: inputs.titleScreen, direction: inputs.direction ?? null, aliases });
    if (title) return title;
  }
  const url = row.canonical_url ?? db.prepare('SELECT canonical_url FROM postings WHERE id=?').get(row.posting_id)?.canonical_url ?? null;
  const locations = currentLocations(db, row.posting_id);
  const record = recordFields(db, row.posting_id);
  if (tries('location_outside_area')) {
    const place = locationGate({ locations, record, title: row.title, policy: inputs.policy, company: row.company, overrides: inputs.overrides, aliases, url });
    if (place) return place;
  }
  if (tries('term_location')) return termLocationGate({ title: row.title, locations, record, policy: inputs.policy, company: row.company, overrides: inputs.overrides, aliases, url });
  return null;
}

export function ruleGateVerdict(hit, configHash) {
  const code = RULE_CODES[hit.rule];
  const ruleGate = { rule: hit.rule, matchedText: hit.matchedText, configHash, ...(hit.pattern ? { pattern: hit.pattern } : {}), ...(hit.window ? { window: hit.window } : {}) };
  return { decision: 'not_eligible', code, evidence: [{ confirmed: true, code, ...ruleGate, ...(hit.places ? { places: hit.places } : {}) }],
    location: hit.places ? { offices: [], remote: { scope: null, quote: null }, display: hit.places.join('; '), alternatives: [] } : null,
    question: null, holdFactIds: [], nextAction: null, flags: [RULE_FLAGS[hit.rule], AUTOMATED_FLAG], ruleGate };
}

const SETTLED_KEY = { title_function: 'title', location_outside_area: 'location', term_location: 'term' };

// Settles due reviews by the title, location and term rules, and held fetch-failure browser reviews by the term rule.
// Returns { title, location, term, termHeld } (termHeld: the part of term that was a held row).
export function applyRuleGates(db, { now, inputs, owner = 'review-rule-gate' }) {
  const policy = deliveryPolicy(inputs);
  const hashes = ruleGateHashes(inputs);
  const settled = { title: 0, location: 0, term: 0, termHeld: 0 };
  const termOn = termLocationGateSettings(inputs.policy).enabled;
  const rows = db.prepare(`SELECT r.posting_id,r.state,r.decision,r.lane,r.evidence_json,r.dep_hashes_json,p.company,p.title,p.canonical_url FROM reviews r JOIN postings p ON p.id=r.posting_id
    ${reviewOwnershipJoins} WHERE (r.state='due'${termOn ? ` OR ${HELD_FROM_FETCH_FAILURE_SQL}` : ''}) AND p.merged_into IS NULL AND NOT ${userDecisionSql}`).all();
  for (const row of rows) {
    const held = row.state === 'held';
    // Exploration lanes are sampling (delivery rewrites their code); a lead re-queued for a refresh was judged eligible
    // by the model; an explicit `review rejudge` asked for a model check. None of them is settled by a rule.
    if (EXPLORATION_LANES.includes(row.lane) || row.decision === 'eligible') continue;
    if (parseJson(row.evidence_json).reopenAuthorization?.authorization === 'rejudge') continue;
    const hit = ruleGateHit(db, row, { inputs, policy, ...(held ? { only: ['term_location'] } : {}) });
    if (!hit) continue;
    atomic(db, () => {
      // The row must still be what was selected (a concurrent delivery may have settled or re-held it).
      const current = db.prepare('SELECT state,code FROM reviews WHERE posting_id=?').get(row.posting_id);
      if (current?.state !== row.state || (held && current.code !== 'browser_review')) return;
      const fence = claimItem(db, row.posting_id, { owner, now });
      if (!fence) return;
      const verdict = ruleGateVerdict(hit, hashes[hit.rule]);
      deliver(db, { postingId: row.posting_id, verdict, fence, now, policy });
      const committed = db.prepare('SELECT state,code,dep_hashes_json FROM reviews WHERE posting_id=?').get(row.posting_id);
      if (committed.state !== 'done' || committed.code !== verdict.code) return;
      const deps = { ...parseJson(committed.dep_hashes_json), ruleGate: { rule: hit.rule, configHash: hashes[hit.rule] }, invalidated: false };
      delete deps.releasedHold;
      db.prepare('UPDATE reviews SET dep_hashes_json=? WHERE posting_id=?').run(JSON.stringify(deps), row.posting_id);
      logReview(db, row.posting_id, { now, stage: 'judge', kind: 'outcome', payload: { ruleGate: verdict.ruleGate, ...(held ? { takenOver: 'browser_review' } : {}) } });
      settled[SETTLED_KEY[hit.rule]] += 1;
      if (held) settled.termHeld += 1;
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
