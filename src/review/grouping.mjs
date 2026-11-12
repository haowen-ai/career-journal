import countries from '../funnel/data/countries.json' with { type: 'json' };
import { countryOf } from '../funnel/classify.mjs';
import { companyKey } from '../scan/dedupe.mjs';
import { locationExempt } from './overrides.mjs';
import { parseJson } from './deliver.mjs';
import { userDecisionSql, reviewOwnershipJoins } from './ownership.mjs';

// Same-title grouping (user, 2026-11-09): one posting published at many locations is judged once. A settled
// judge decision of one member is copied to the others when it does not depend on the location; a location
// dependent decision is never copied, each other member only gets the cheap location rule below.

export const DEFAULT_GROUP_WINDOW_DAYS = 30;
export const GROUP_FLAG = 'group_copy';
// Decisions that depend on where the job is: never copied, only the location rule may settle a member.
export const LOCATION_CODES = Object.freeze(['outside_area', 'outside_window', 'term_or_area']);
// Judge codes that hold for every location of the same posting text: the criteria keys of the judgment schema
// (except 'closed', which is per requisition), the function gate, and the hold codes a forced decision settles.
export const COPYABLE_CODES = Object.freeze(['function_out_of_scope', 'degree', 'graduation', 'requirement', 'authorization',
  'defense', 'clearance', 'return_offer', 'missing_fact', 'requirement_unclear', 'user_review']);

export function groupWindowDays(policy) {
  const value = policy?.grouping?.windowDays;
  if (value === undefined || value === null) return DEFAULT_GROUP_WINDOW_DAYS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('review policy grouping.windowDays must be a number of days, 0 or more');
  return value;
}

const STATE_CODES = new Set(Object.keys(countries.usStates).map((code) => code.toLowerCase()));
const STATE_NAMES = new Map(Object.entries(countries.usStates).map(([code, name]) => [name.toLowerCase(), code]));
const COUNTRY_NAMES = new Set(countries.countries.map((country) => country.name.toLowerCase()));
const PLACE_WORDS = /^(?:(?:us|u\.s\.|usa|united states(?: of america)?|north america|nationwide|global|worldwide|multiple locations|various locations|multiple cities|remote|hybrid|on-?site|in-?office|virtual|work from home|wfh|anywhere)(?:\s*[-(]?\s*(?:us|usa|united states|remote|hybrid|on-?site)\)?)?)$/;
const clean = (value) => String(value ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
const cityOf = (place) => clean(place).split(',')[0].trim();

function locationPiece(piece, cities) {
  const value = piece.replace(/^[\s(]+|[\s).]+$/g, '').trim();
  if (!value) return false;
  if (PLACE_WORDS.test(value) || STATE_NAMES.has(value) || COUNTRY_NAMES.has(value) || cities.has(value)) return true;
  const match = /^([\p{L}\p{M} .'-]+),\s*([\p{L} .]+?)(?:,\s*(?:us|usa|united states))?$/u.exec(value);
  if (match) {
    const region = match[2].trim();
    return STATE_CODES.has(region) || STATE_NAMES.has(region) || COUNTRY_NAMES.has(region) || ['us', 'usa', 'united states'].includes(region);
  }
  return false;
}

// Whether a title suffix names only places (or remote/hybrid wording), for example "Chicago, IL",
// "Remote - US", "New York, NY / Jersey City, NJ" or a city from the posting's own locations.
export function locationOnly(text, locations = []) {
  const value = clean(text).replace(/^[-–—|:,\s(]+|[-–—|:,\s)]+$/g, '');
  if (!value) return false;
  const cities = new Set(locations.flatMap((place) => [cityOf(place), clean(place)]).filter(Boolean));
  if (locationPiece(value, cities)) return true;
  const pieces = value.split(/\s*(?:\/|;|\||\+|&|\bor\b|\band\b)\s*/).filter(Boolean);
  return pieces.length > 0 && pieces.every((piece) => locationPiece(piece, cities));
}

const REQUISITION = /(?:\s+|\s*[-–—|:,]\s*|\s*[(\[]\s*)(?:(?:req(?:uisition)?|job(?:\s*id)?|jr|r|id)\s*[#:.\-]?\s*[a-z]{0,2}[-_]?\d{4,}[a-z]?|#\s*\d{4,}|\d{5,})\s*[\])]?$/;
const SEPARATORS = /\s+[-–—|]\s+|\s*\(|,\s+|\s+@\s+/g;

// The group title: lower-case, trimmed, with trailing requisition ids and trailing place suffixes removed
// ("Claims Representative Internship - Chicago, IL - R12345" -> "claims representative internship"). Years and
// role words are kept. `locations` are the posting's own places, so a bare city suffix is removed only when the
// posting is located there.
export function groupTitle(title, { locations = [] } = {}) {
  let value = clean(title).replace(/[\s\-–—|:,]+$/, '');
  for (let round = 0; round < 6; round += 1) {
    const before = value;
    value = value.replace(REQUISITION, '').replace(/[\s\-–—|:,]+$/, '');
    for (const match of value.matchAll(SEPARATORS)) {
      const head = value.slice(0, match.index).trim();
      const tail = value.slice(match.index + match[0].length).replace(/\)\s*$/, '');
      if (head && /[a-z]/.test(head) && locationOnly(tail, locations)) { value = head.replace(/[\s\-–—|:,]+$/, ''); break; }
    }
    if (value === before) break;
  }
  return value;
}

export function groupKey(company, title, { locations = [], aliases = {} } = {}) {
  const firm = companyKey(company ?? '', aliases);
  const role = groupTitle(title, { locations });
  return firm && role ? `${firm}::${role}` : null;
}

// The places the scan saw for a posting (every observation, listed or not).
export function postingLocations(db, postingId) {
  const places = new Set();
  for (const row of db.prepare('SELECT fields_json FROM observations WHERE posting_id=?').all(postingId)) {
    const fields = parseJson(row.fields_json);
    for (const place of [...(Array.isArray(fields.locations) ? fields.locations : []), ...(typeof fields.location === 'string' ? [fields.location] : [])]) {
      if (typeof place === 'string' && place.trim()) places.add(place.trim());
      else if (place && typeof place === 'object' && typeof (place.name ?? place.location) === 'string') places.add(String(place.name ?? place.location).trim());
    }
  }
  return [...places];
}

// grouping.textSimilarity was removed (Codex code review, 2026-11-09): a copy needs byte-identical text, so a
// threshold setting would only mislead. A policy that still sets it is refused with this message.
export function groupTextSimilarity(policy) {
  if (policy?.grouping && Object.hasOwn(policy.grouping, 'textSimilarity')) {
    throw new Error('review policy grouping.textSimilarity is no longer used: a group copy needs identical posting text; remove the key');
  }
  return null;
}

// The places of a posting's CURRENT record: the fetched page's locations, else the latest observation's.
// Older observations are history (a posting moved from Chicago to Dallas is in Dallas).
export function currentLocations(db, postingId) {
  const snapshot = db.prepare('SELECT fields_json FROM snapshots WHERE posting_id=? AND identity_ok=1 ORDER BY fetched_at DESC,rowid DESC LIMIT 1').get(postingId);
  const fromPage = placesOf(parseJson(snapshot?.fields_json));
  if (fromPage.length) return fromPage;
  const observation = db.prepare('SELECT fields_json FROM observations WHERE posting_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1').get(postingId);
  return placesOf(parseJson(observation?.fields_json));
}
function placesOf(fields) {
  const places = new Set();
  for (const place of [...(Array.isArray(fields?.locations) ? fields.locations : []), ...(typeof fields?.location === 'string' ? [fields.location] : [])]) {
    if (typeof place === 'string' && place.trim()) places.add(place.trim());
    else if (place && typeof place === 'object' && typeof (place.name ?? place.location) === 'string') places.add(String(place.name ?? place.location).trim());
  }
  return [...places];
}

// The posting text a member was judged on (or would be): the latest readable snapshot, the same text the
// judge receives, with the current record's places and the requisition ids it is known by.
export function postingText(db, postingId) {
  const snapshot = db.prepare('SELECT text,fields_json,content_hash FROM snapshots WHERE posting_id=? AND identity_ok=1 AND text IS NOT NULL ORDER BY fetched_at DESC,rowid DESC LIMIT 1').get(postingId);
  if (!snapshot) return null;
  const fields = parseJson(snapshot.fields_json);
  const requisitions = [fields.requisitionId, ...db.prepare("SELECT alias FROM posting_aliases WHERE posting_id=? AND kind IN ('req','company_req')").all(postingId).map((row) => String(row.alias).split(':').at(-1))]
    .filter((value) => typeof value === 'string' && value.trim());
  return { text: snapshot.text, places: currentLocations(db, postingId), requisitions, snapshotHash: snapshot.content_hash };
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Normalised posting text for the identity check. Each text is normalised with ITS OWN places and requisition
// ids only (never the other posting's). Removed: (a) a whole line that is one of its own location strings (or the
// "City, ST" / "City, State" form of one), and any "Location(s): …" header line; (b) its own requisition ids.
// Everything else stays as it is apart from case and whitespace, so a city or state inside a sentence ("requires an
// Illinois license", "Dallas certification") makes two texts differ.
const LOCATION_HEADER = /^(?:job\s+)?(?:work\s+)?locations?\s*(?:\(s\))?\s*[:\-–—]/;
function placeForms(place) {
  const full = clean(place);
  if (!full) return [];
  const parts = full.split(',').map((part) => part.trim()).filter(Boolean);
  const forms = new Set([full]);
  if (parts.length >= 2) {
    forms.add(`${parts[0]}, ${parts[1]}`);
    const code = STATE_NAMES.get(parts[1]) ?? (STATE_CODES.has(parts[1]) ? parts[1].toUpperCase() : null);
    if (code) { forms.add(`${parts[0]}, ${code.toLowerCase()}`); forms.add(`${parts[0]}, ${String(countries.usStates[code] ?? '').toLowerCase()}`); }
  }
  return [...forms];
}
export function normalizePostingText(text, { places = [], requisitions = [] } = {}) {
  const forms = new Set(places.flatMap(placeForms));
  const lines = String(text ?? '').split(/\r?\n/).map(clean).filter((line) => {
    const bare = line.replace(/^[•\-*·\s]+|[\s.;]+$/g, '');
    return !(LOCATION_HEADER.test(bare) || forms.has(bare));
  });
  let value = lines.join('\n');
  const ids = [...new Set(requisitions.map(clean).filter((id) => id.length >= 3))].sort((a, b) => b.length - a.length);
  if (ids.length) value = value.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${ids.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'gu'), ' ');
  return value.replace(/\s+/g, ' ').trim();
}

// Whether two members are "the same role at another location": each text, normalised with its own places and
// requisition ids, is identical. Returns { same, reason } with reason 'identical', 'text_differs' or 'no_text'.
export function sameRoleText(member, source) {
  if (!member?.text || !source?.text) return { same: false, reason: 'no_text' };
  const own = (item) => normalizePostingText(item.text, { places: item.places ?? [], requisitions: item.requisitions ?? [] });
  return own(member) === own(source) ? { same: true, reason: 'identical' } : { same: false, reason: 'text_differs' };
}

function placeState(place) {
  const value = clean(place);
  const code = /,\s*([a-z]{2})\b(?:\s*,\s*(?:us|usa|united states))?\s*$/.exec(value)?.[1];
  if (code && STATE_CODES.has(code)) return { country: 'US', state: code.toUpperCase() };
  const tail = value.split(',').map((part) => part.trim()).filter(Boolean);
  for (const part of [...tail].reverse()) {
    if (STATE_NAMES.has(part)) return { country: 'US', state: STATE_NAMES.get(part) };
    if (['us', 'usa', 'united states', 'united states of america'].includes(part)) continue;
    if (COUNTRY_NAMES.has(part)) return { country: part, state: null };
  }
  return null;
}
const remoteish = (place) => /\b(?:remote|anywhere|virtual|work from home|nationwide|hybrid)\b/i.test(String(place));

// The cheap location rule. 'outside' when every place is in a US state outside policy.areas.allowedStates (or
// another country) and the company is not location exempt; 'inside' when some place is a city the judge already
// put in an allowed office of the source's accepted alternatives; otherwise null (the posting is judged).
export function locationRule({ locations, policy, company, overrides, aliases, allowedPlaces = [] }) {
  if (!locations?.length || locations.some(remoteish)) return null;
  const allowedCities = new Set(allowedPlaces.map(cityOf).filter(Boolean));
  const allowedStates = (policy?.areas?.allowedStates ?? []).map((state) => String(state).toUpperCase());
  if (allowedCities.size && locations.some((place) => allowedCities.has(cityOf(place))
    && (!placeState(place) || allowedPlaces.some((allowed) => cityOf(allowed) === cityOf(place) && placeState(allowed)?.state === placeState(place)?.state)))) return 'inside';
  if (!allowedStates.length || locationExempt(company, overrides, aliases)) return null;
  const resolved = locations.map(placeState);
  if (resolved.every((item) => item && (item.country !== 'US' || !allowedStates.includes(item.state)))) return 'outside';
  return null;
}

// Pre-fetch location gate (screening redesign, amendment G1). Stricter than locationRule: it settles a due posting
// outside_area only when the current record's places are a complete list of specific US places (a city and a known
// state), every one in a state outside policy.areas.allowedStates, the company (through its aliases) is not a
// location-exempt brand, the record is not marked remote, and no remote/hybrid or summary wording ("3 Locations",
// "Multiple Locations", "Various") appears in the workplace type, title or places. A place in an allowed state (its
// area inside that state is for the judge), a bare state, a city without a state, or a place outside the US: null,
// and the posting goes to the model as before.
const GATE_REMOTE = /\b(?:remote|hybrid|telecommut\w*|work from home|wfh|virtual|anywhere)\b/i;
const GATE_SUMMARY = /\b(?:\d+\s*(?:\+\s*)?(?:more\s+)?(?:locations?|offices?|cities|sites|states)|multiple|various|several|numerous|many|all|other|nationwide|any)\b/i;
const US_WORDS = new Set(['us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america']);
export function specificUsPlace(place) {
  const value = clean(place);
  if (!value || GATE_REMOTE.test(value) || GATE_SUMMARY.test(value)) return null;
  // Strict: exactly "City, ST" or "City, State", optionally followed by a US country suffix. Any other segment
  // ("Chicago, IL, Dallas, TX") makes the place unparseable, and the posting goes to the model.
  const parts = value.split(',').map((part) => part.trim());
  if (parts.some((part) => !part) || parts.length < 2 || parts.length > 3 || (parts.length === 3 && !US_WORDS.has(parts[2]))) return null;
  if (!STATE_CODES.has(parts[1]) && !STATE_NAMES.has(parts[1])) return null;
  const city = parts[0];
  if (!/\p{L}/u.test(city) || STATE_CODES.has(city) || STATE_NAMES.has(city) || COUNTRY_NAMES.has(city) || US_WORDS.has(city)) return null;
  const resolved = placeState(place);
  if (resolved?.country !== 'US' || !resolved.state || countryOf(String(place)) !== 'US') return null;
  return { city, state: resolved.state };
}
// Location completeness (Codex code review, 2026-11-09; coordinator decision): the careerops bridge marks every listing
// completeness.locations 'partial', so for careerops rows completeness is the parse rule above (no summary wording, every
// place a specific US city and state). Measured on the 1,301 postings judged on 2026-11-10: 388 pre-fetch gate hits, 1 whose
// final decision was eligible (0.26%, under the plan's 1% threshold); 5 where the model said eligible (1.29%), all from
// listings that showed one place while the page listed several, mostly amazon.jobs (2/25) and careers.fedex.com (2/6).
// Those hosts are distrusted (review-policy.json locationGate.untrustedHosts, default below): their postings never take
// the gate. Any other source that states completeness.locations and does not say 'complete' is not gated either.
export const DEFAULT_UNTRUSTED_HOSTS = Object.freeze(['amazon.jobs', 'careers.fedex.com']);
export function locationGateSettings(policy) {
  const hosts = policy?.locationGate?.untrustedHosts ?? DEFAULT_UNTRUSTED_HOSTS;
  if (!Array.isArray(hosts) || !hosts.every((host) => typeof host === 'string' && host.trim())) {
    throw new Error('review policy locationGate.untrustedHosts must be a list of host names');
  }
  return { untrustedHosts: hosts.map((host) => host.trim().toLowerCase().replace(/^\.+/, '')) };
}
const hostOf = (url) => String(url ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0];
const untrusted = (url, hosts) => {
  const host = hostOf(url);
  return Boolean(host) && hosts.some((item) => host === item || host.endsWith(`.${item}`));
};
// One location string may name several places ("Chicago, IL / Dallas, TX", "Chicago, IL; Dallas, TX"): each part is a
// place of its own.
const PLACE_SPLIT = /\s*[/;|&]\s*/;
export function locationGate({ locations, record = {}, title = null, policy, company, overrides, aliases, url = null }) {
  const allowedStates = (policy?.areas?.allowedStates ?? []).map((state) => String(state).toUpperCase());
  if (!allowedStates.length || !Array.isArray(locations) || !locations.length) return null;
  if (untrusted(url, locationGateSettings(policy).untrustedHosts)) return null;
  const records = Array.isArray(record) ? record : [record];
  if (records.some((item) => item?.completeness?.locations !== undefined && item.completeness.locations !== 'complete' && item.source !== 'careerops')) return null;
  if (records.some((item) => item?.remote === true)) return null;
  const texts = [title, ...records.map((item) => item?.workplaceType), ...locations];
  if (texts.some((text) => typeof text === 'string' && GATE_REMOTE.test(text))) return null;
  if (locations.some((place) => typeof place !== 'string' || GATE_SUMMARY.test(place))) return null;
  if (locationExempt(company, overrides, aliases)) return null;
  const parts = locations.flatMap((place) => place.split(PLACE_SPLIT)).map((part) => part.trim());
  if (!parts.length || parts.some((part) => !part)) return null;
  const places = parts.map(specificUsPlace);
  if (places.some((place) => !place || allowedStates.includes(place.state))) return null;
  return { rule: 'location_outside_area', matchedText: locations.join('; '), places: locations, states: [...new Set(places.map((place) => place.state))] };
}

// Settled judge decisions usable as a group source: done, judged (not a group copy, not a gate or user code),
// not owned by the user, updated within the window, and decided under today's screening inputs. Rows are
// indexed by company; a company's group keys (which need the members' locations) are computed on first use.
export function groupSources(db, { now, windowDays, state = null, aliases = {} }) {
  const byCompany = new Map();
  const keyed = new Map();
  const add = (row) => {
    const source = sourceOf(row, state);
    if (!source) return;
    const firm = companyKey(row.company ?? '', aliases);
    if (!byCompany.has(firm)) byCompany.set(firm, new Map());
    byCompany.get(firm).set(row.posting_id, { ...source, key: undefined });
  };
  if (windowDays > 0) {
    const since = new Date(Date.parse(now) - windowDays * 86400000).toISOString();
    for (const row of db.prepare(`${SOURCE_SQL} AND r.updated_at>=?`).all(since)) add(row);
  }
  return {
    // Sources of one group key ("company::title").
    find(key) {
      if (!key) return [];
      const firm = key.slice(0, key.indexOf('::'));
      const rows = byCompany.get(firm);
      if (!rows) return [];
      if (!keyed.has(firm)) {
        for (const source of rows.values()) source.key = groupKey(source.company, source.title, { locations: postingLocations(db, source.postingId), aliases });
        keyed.set(firm, true);
      }
      return [...rows.values()].filter((source) => source.key === key);
    },
    // The source as stored now, if it is still a valid source under today's inputs (rechecked at copy time:
    // sources are listed at run start, inputs may change during the run).
    current(postingId, currentState) {
      const row = db.prepare(`${SOURCE_SQL} AND r.posting_id=?`).get(postingId);
      return row ? sourceOf(row, currentState) : null;
    },
    // A review settled during this run becomes a source at once (rule: representative first).
    note(postingId) {
      if (!(windowDays > 0)) return;
      const row = db.prepare(`${SOURCE_SQL} AND r.posting_id=?`).get(postingId);
      if (!row) return;
      add(row);
      const firm = companyKey(row.company ?? '', aliases);
      const source = byCompany.get(firm)?.get(postingId);
      if (source && keyed.has(firm)) source.key = groupKey(source.company, source.title, { locations: postingLocations(db, postingId), aliases });
    },
  };
}
const SOURCE_SQL = `SELECT r.posting_id,r.decision,r.code,r.evidence_json,r.flags_json,r.dep_hashes_json,r.updated_at,p.company,p.title
    FROM reviews r JOIN postings p ON p.id=r.posting_id ${reviewOwnershipJoins}
    WHERE r.state='done' AND p.merged_into IS NULL AND NOT ${userDecisionSql}
      AND (r.decision='eligible' AND r.code IS NULL OR r.decision='not_eligible' AND r.code IN (${[...COPYABLE_CODES, ...LOCATION_CODES].map((code) => `'${code}'`).join(',')}))`;

// The screening inputs that make two decisions comparable (code changes do not invalidate a settled decision).
export const COMPARABLE_INPUTS = Object.freeze(['facts', 'rules', 'policy', 'screening', 'provenance', 'resume', 'windowsAreas']);
export function sourceOf(row, state = null) {
  const evidence = parseJson(row.evidence_json);
  const flags = parseJson(row.flags_json, []);
  // A rule settlement (gates.mjs) is never a source: it was decided from the title or the places alone.
  if (evidence.groupCopy || flags.includes(GROUP_FLAG) || evidence.provenance === 'automated' || evidence.ruleGate
    || flags.includes('title_rule') || flags.includes('location_rule') || flags.includes('term_location_rule')) return null;
  const stored = parseJson(row.dep_hashes_json).inputs;
  if (state) {
    if (!stored) return null;
    if (COMPARABLE_INPUTS.some((part) => JSON.stringify(stored[part] ?? null) !== JSON.stringify(state[part] ?? null))) return null;
  }
  return { postingId: row.posting_id, decision: row.decision, code: row.code, evidence, flags, title: row.title, company: row.company, judgedAt: row.updated_at };
}

const allowedPlacesOf = (source) => (source.evidence.location?.alternatives ?? []).flatMap((alternative) => (alternative.offices ?? []).map((office) => office.place)).filter(Boolean);

// What a member gets from its group's settled sources: { verdict, source, rule } to settle it without a
// model call, or null to judge it normally.
// Every decision also needs the member's own posting text to match the source's (sameRoleText); a member whose
// group has sources but no identical text is returned as { mismatch, code, from } and judged normally.
export function groupVerdict({ sources, locations, text, sourceText = () => null, policy, company, overrides, aliases }) {
  if (!sources?.length) return null;
  const misses = [];
  const usable = sources.filter((source) => {
    const match = sameRoleText(text, sourceText(source.postingId));
    if (!match.same) misses.push({ from: source.postingId, reason: match.reason });
    return match.same;
  });
  // The recorded code: text_differs when a source's text was readable but not identical, else no_text.
  if (!usable.length) {
    const miss = misses.find((item) => item.reason === 'text_differs') ?? misses[0];
    return { mismatch: true, code: miss.reason, from: miss.from };
  }
  return groupResult({ usable, locations, policy, company, overrides, aliases });
}

function groupResult({ usable, locations, policy, company, overrides, aliases }) {
  const outside = () => locationRule({ locations, policy, company, overrides, aliases }) === 'outside';
  // A location-independent rejection holds wherever the job is.
  const independent = usable.find((source) => source.decision === 'not_eligible' && COPYABLE_CODES.includes(source.code));
  const eligible = usable.find((source) => source.decision === 'eligible');
  // Members that disagree on a location-independent point are not one role: judge this one on its own.
  if (independent && eligible) return null;
  if (independent) {
    const evidence = independent.evidence;
    return { source: independent, rule: 'copied', verdict: { decision: 'not_eligible', code: independent.code, evidence: evidence.evidence ?? [], needs: evidence.needs ?? {},
      fit: evidence.fit ?? null, deadline: evidence.deadline ?? { kind: 'none' }, program: evidence.program ?? null, location: null, factsUsed: evidence.factsUsed ?? [],
      question: null, holdFactIds: [], nextAction: null, flags: [GROUP_FLAG], ...(Object.hasOwn(evidence, 'function') ? { functionValue: evidence.function } : {}) } };
  }
  if (eligible) {
    const allowedPlaces = usable.filter((source) => source.decision === 'eligible').flatMap(allowedPlacesOf);
    const rule = locationRule({ locations, policy, company, overrides, aliases, allowedPlaces });
    if (rule === 'inside') {
      const evidence = eligible.evidence;
      const offices = (evidence.location?.offices ?? []).filter((office) => locations.some((place) => cityOf(place) === cityOf(office.place)));
      return { source: eligible, rule: 'copied', verdict: { decision: 'eligible', code: null, evidence: evidence.evidence ?? [], needs: evidence.needs ?? {},
        fit: evidence.fit ?? null, deadline: evidence.deadline ?? { kind: 'none' }, program: evidence.program ?? null,
        location: { ...(evidence.location ?? {}), offices, display: locations.join('; ') }, factsUsed: evidence.factsUsed ?? [],
        flags: [GROUP_FLAG], ...(Object.hasOwn(evidence, 'function') ? { functionValue: evidence.function } : {}) } };
    }
    if (rule === 'outside') return { source: eligible, rule: 'location', verdict: locationVerdict(locations) };
    return null;
  }
  // Only location-dependent rejections: the location rule alone may settle this member.
  const dependent = usable.find((source) => LOCATION_CODES.includes(source.code));
  if (dependent && outside()) return { source: dependent, rule: 'location', verdict: locationVerdict(locations) };
  return null;
}

const locationVerdict = (locations) => ({ decision: 'not_eligible', code: 'outside_area', evidence: [{ confirmed: true, code: 'outside_area', rule: 'location', places: locations }],
  location: { offices: [], remote: { scope: null, quote: null }, display: locations.join('; '), alternatives: [] }, question: null, holdFactIds: [], nextAction: null, flags: [GROUP_FLAG, 'location_rule'] });
