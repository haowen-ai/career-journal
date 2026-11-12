import countries from './data/countries.json' with { type: 'json' };
import { companyExcluded } from '../review/excluded.mjs';
import { aliasesFor, canonicalUrl, identityOptionsOf } from './identity.mjs';
import { anyFunctionCompany, roleDirection } from '../review/direction.mjs';

const STUDENT = /\b(?:intern(?:s|ship|ships)?|winternships?|co[- ]?ops?|apprentice(?:s|ship|ships)?|placements?|working students?|students?|fellow(?:s|ship|ships)?|residen(?:t|ts|cy)|graduate program(?:me)?|early career|university program(?:me)?|campus program(?:me)?|summer (?:analysts?|associates?|20\d\d program(?:me)?)|currently enrolled|class of 20\d\d)\b/i;
// Descriptions often mention students in company-wide boilerplate. Only explicit
// program phrases count there; titles and departments retain the broader signal. A bare
// plural ("experience through internships") is a requirement, not an offer; a plural counts only
// where the posting offers it ("we offer summer internships", "join our co-ops").
const PROGRAM = /\b(?:interns?|internship|co[- ]?ops?|(?:employment|job|position|contract|work)\s+type\s*:?\s*(?:interns?|internships?|co[- ]?ops?|placements?)|(?:we\s+(?:offer|are\s+offering|hire|are\s+hiring)|offering|hiring|our|join\s+our)\s+(?:[\w-]+\s+){0,3}?(?:internships|co[- ]?ops)|(?<!(?:through|previous|prior|past|relevant|from)\s+)(?:summer|fall|spring|winter|paid)\s+(?:internships|co[- ]?ops)|(?:student|industrial|work|summer|year[- ]long)\s+placements?|placement\s+(?:students?|years?)|apprentice(?:s|ship|ships)?|summer\s+20\d\d\s+(?:interns?|analysts?|associates?|program(?:me)?)|(?:graduate|early career|university|campus)\s+program(?:me)?)\b/i;
// A season and year on a listing is an internship term, for example Simplify's "Summer 2027".
const TERM = /\b(?:spring|summer|fall|autumn|winter)\s+20\d\d\b/i;
const DIRECTION = /\b(?:data|analytics|analyst|AI|ML|machine\s+learning|product|program|project|business|insights|intelligence|solutions|strategy|BI|quant)\b/i;
// Optional extra engagement types a student search also accepts (review-policy.json `engagementSignals`, case-insensitive
// regular expressions such as "\\bcontract(?:or)?\\b" or "part[- ]time"). They are tested on the title, categories and
// employment type only (descriptions mention contractors in boilerplate). Such a title counts as a student signal only
// when it is also in direction under profile/role-direction.json (a title that only needs the judge's function label,
// require_allow, is let through to the judge); without that file every matching title counts. Term and place are
// judged by the review rules as for any internship.
export function engagementRules(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string' && item.trim())) throw new Error('review-policy engagementSignals must be a list of non-empty strings');
  return raw.map((source) => {
    try { return new RegExp(source, 'iu'); } catch (error) { throw new Error(`review-policy engagementSignals has an invalid pattern ${JSON.stringify(source)}: ${error.message}`, { cause: error }); }
  });
}

function engagementSignal(record, policy) {
  const patterns = policy.engagement ?? [];
  if (!patterns.length) return false;
  const texts = [record.title, ...(record.categories ?? []), record.employmentType].filter((text) => typeof text === 'string' && text);
  if (!texts.some((text) => patterns.some((pattern) => pattern.test(text)))) return false;
  const direction = roleDirection(record.title, policy.direction, { company: record.company, aliases: policy.companyAliases ?? {} });
  return direction.ok || direction.reason === 'require_allow';
}

// Title screen (profile/title-screen.json): drops the listing title alone decides, before any fetch.
// { "function": [regex], "level": [regex], "term": true|false, "language": { "maxNonLatinShare": 0..1 } }.
// Patterns are case-insensitive regular expressions on the title only. A bad file is an error, never skipped.
const TITLE_SCREEN_KEYS = new Set(['rule', 'function', 'level', 'term', 'language']);
export function titleScreenRules(raw, label = 'title-screen.json') {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(raw)) if (!TITLE_SCREEN_KEYS.has(key)) throw new Error(`${label} has an unknown key ${JSON.stringify(key)}`);
  const list = (key) => {
    const value = raw[key] ?? [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) throw new Error(`${label} ${key} must be a list of non-empty strings`);
    return value.map((source) => {
      try { return new RegExp(source, 'iu'); } catch (error) { throw new Error(`${label} ${key} has an invalid pattern ${JSON.stringify(source)}: ${error.message}`, { cause: error }); }
    });
  };
  if (raw.term !== undefined && typeof raw.term !== 'boolean') throw new Error(`${label} term must be true or false`);
  let maxNonLatinShare = null;
  if (raw.language !== undefined) {
    const share = raw.language?.maxNonLatinShare;
    if (typeof raw.language !== 'object' || Array.isArray(raw.language) || typeof share !== 'number' || !(share >= 0 && share < 1)) {
      throw new Error(`${label} language.maxNonLatinShare must be a number from 0 up to (not including) 1`);
    }
    maxNonLatinShare = share;
  }
  return { function: list('function'), level: list('level'), term: raw.term === true, maxNonLatinShare };
}

// A title in the wanted direction is never dropped by the function list (data, analytics, AI/ML, quant, product,
// strategy, business ... or a role-direction.json allow pattern), nor is any title at an any-function company; the judge decides those.
const DIRECTION_GUARD = /\b(?:data|analytic\w*|analysts?|AI|ML|machine\s+learning|artificial\s+intelligence|product\w*|programs?|project\w*|business|insights?|intelligence|solutions?|strateg\w*|BI|quant\w*|statistic\w*|scien\w*|consult\w*|econom\w*|financ\w*|software|computer|computational|digital|research\w*|forecast\w*|technolog\w*|automation|robotic\w*)\b/iu;

// A season and year earlier than the search season (profile.search.season) is a term already past or started. A pair is a
// season word and a year in the same title segment with at most three words between them, in either order ("Summer 2026",
// "Summer Intern 2026", "2026 Fall Co-op"); a year in a "Class of", "graduating" or "grad(uation)" phrase is not a term.
// Without a pair nothing is decided ("Summer Intern (Class of 2026)" stays for review). It drops unless a pair at or after
// the season also appears ("Summer 2026 / Summer 2027"). A year range is a year like any other in the pair rule and
// counts by its end year ("Fall 2026-2027", "2026-2027 Fall Co-op", "Summer 2026/27" reach 2027). Winter of the year before the season stays for review (December to February).
const SEASON_TOKEN = /^(spring|summer|fall|autumn|winter)$/i;
const YEAR_TOKEN = /^(20\d\d)(?:[-–/](?:20)?(\d\d))?$/;
// A graduation clause ("Class of 2026", "Graduating in Spring 2026-2027", "Grad 2026") names no work term: it is cut from
// its first word to the closing bracket when it sits inside brackets, otherwise to the next comma, semicolon or bar.
const GRAD_START = /\b(?:class\s+of|graduating|graduation|grads?)\b/gi;
function withoutGraduation(title) {
  let text = title;
  for (let match = GRAD_START.exec(text); match; match = GRAD_START.exec(text)) {
    const before = text.slice(0, match.index);
    const inside = before.lastIndexOf('(') > before.lastIndexOf(')') || before.lastIndexOf('[') > before.lastIndexOf(']');
    const rest = text.slice(match.index);
    const stop = rest.search(inside ? /[)\]]/ : /[,;|]/);
    const end = stop === -1 ? text.length : match.index + stop;
    text = `${before} | ${text.slice(end)}`;
    GRAD_START.lastIndex = before.length + 3;
  }
  return text;
}
// The words of each title segment (graduation clauses cut), the unit the pair rule works on. Exported with the
// season and year tokens for the review's pre-fetch term gate (review/gates.mjs), which needs the same segments.
export function termSegments(title) {
  return withoutGraduation(String(title ?? '')).split(/[,;|()[\]]|\s+[-–—/]\s+|\s+[-–—](?=\S)|(?<=\S)[-–—]\s+/)
    .map((segment) => segment.replace(/\/(?!\d)/g, ' ').split(/\s+/).map((word) => word.replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean));
}
export { SEASON_TOKEN, YEAR_TOKEN };
export function termPairs(title) {
  const pairs = [];
  for (const words of termSegments(title)) {
    const seasons = words.flatMap((word, index) => SEASON_TOKEN.test(word) ? [{ index, season: word.toLowerCase() }] : []);
    if (!seasons.length) continue;
    words.forEach((word, index) => {
      const year = YEAR_TOKEN.exec(word);
      if (!year) return;
      const near = seasons.filter((item) => Math.abs(item.index - index) - 1 <= 3);
      if (!near.length) return;
      const closest = near.reduce((a, b) => Math.abs(a.index - index) <= Math.abs(b.index - index) ? a : b);
      // A range ("2026-2027", "2026/27") counts by its end year: it reaches the season when its end does.
      pairs.push({ season: closest.season, year: year[2] ? 2000 + Number(year[2]) : Number(year[1]) });
    });
  }
  return pairs;
}
function pastTerm(title, season) {
  const target = Number(String(season ?? '').match(/20\d\d/)?.[0]);
  if (!target) return null;
  const pairs = termPairs(title);
  if (!pairs.length || pairs.some((pair) => pair.year >= target || (pair.season === 'winter' && pair.year === target - 1))) return null;
  return pairs.map((pair) => `${pair.season} ${pair.year}`).join(', ');
}

function nonLatinShare(title) {
  const letters = title.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((letter) => !/\p{Script=Latin}/u.test(letter)).length / letters.length;
}

export function titleScreenDrop(record, policy = {}, profile) {
  const screen = policy.titleScreen;
  const title = String(record.title ?? '').trim();
  if (!screen || !title) return null;
  if (screen.maxNonLatinShare !== null && nonLatinShare(title) > screen.maxNonLatinShare) return { code: 'title_language', evidence: [title] };
  const level = screen.level.find((pattern) => pattern.test(title));
  if (level) return { code: 'title_level', evidence: [title, level.source] };
  if (screen.term) {
    const term = pastTerm(title, profile?.search?.season);
    if (term) return { code: 'title_term', evidence: [title, term] };
  }
  const fn = screen.function.find((pattern) => pattern.test(title));
  // At an any-function company (role-direction.json anyFunctionCompanies) every function is wanted.
  if (fn && !DIRECTION_GUARD.test(title) && !(policy.direction?.allow ?? []).some((pattern) => pattern.test(title))
      && !anyFunctionCompany(record.company, policy.direction, policy.companyAliases)) return { code: 'title_function', evidence: [title, fn.source] };
  return null;
}

const names = new Map();
const normalized = (value) => String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
for (const country of countries.countries) {
  for (const name of [country.alpha2, country.alpha3, country.name, displayNames.of(country.alpha2)]) names.set(normalized(name), country.alpha2);
}
for (const [name, code] of Object.entries({ 'united states of america': 'US', 'u s': 'US', 'u s a': 'US', 'uk': 'GB', 'u k': 'GB', 'south korea': 'KR', 'north korea': 'KP', 'russia': 'RU', 'vietnam': 'VN', 'taiwan': 'TW' })) names.set(name, code);
const stateNames = new Set(Object.values(countries.usStates).map(normalized));
// Canadian provinces: a full name is Canada; an abbreviation only decides an ambiguous "CA" after it ("Halifax, NS, CA").
const PROVINCES = { AB: 'alberta', BC: 'british columbia', MB: 'manitoba', NB: 'new brunswick', NL: 'newfoundland and labrador', NS: 'nova scotia',
  NT: 'northwest territories', NU: 'nunavut', ON: 'ontario', PE: 'prince edward island', QC: 'quebec', SK: 'saskatchewan', YT: 'yukon' };
const provinceNames = new Set(Object.values(PROVINCES));

export function countryOf(location) {
  // Explicit structured country context takes precedence over ambiguous place names.
  const explicit = typeof location === 'object' && (location?.countryCode ?? location?.country);
  if (typeof explicit === 'string' && names.has(normalized(explicit))) return names.get(normalized(explicit));
  const raw = typeof location === 'string' ? location : location?.location ?? location?.name ?? location?.place ?? '';
  const value = normalized(raw);
  const isStateCode = (text) => /^[a-z]{2}$/i.test(String(text).trim()) && Object.hasOwn(countries.usStates, String(text).trim().toUpperCase());
  if (names.has(value) && !stateNames.has(value) && !isStateCode(raw)) return names.get(value);
  // Country/state tokens are interpreted only at location boundaries, never as substrings of city names.
  const pieces = String(raw).split(/[,;|/]|\s+-\s+/).map((piece) => piece.trim()).filter(Boolean);
  const last = pieces.length >= 2 ? pieces.at(-1) : null;
  if (last && /^CA$/i.test(last) && Object.hasOwn(PROVINCES, pieces.at(-2).toUpperCase()) && pieces.at(-2) === pieces.at(-2).toUpperCase()) return 'CA';
  const resolved = new Set();
  for (const [index, piece] of pieces.entries()) {
    if (provinceNames.has(normalized(piece))) { resolved.add('CA'); continue; }
    const key = normalized(piece.replace(/^remote\s+(?:in\s+)?/i, ''));
    const country = names.get(key);
    // State codes match in any case ("Chicago, il"). A two-letter token after a place (US-style ", XX") that is both a
    // state and a country code is the state ("Los Angeles, ca", "Chicago, IL"); alone it stays ambiguous.
    const code = isStateCode(piece);
    const state = stateNames.has(key) || code;
    if (country && state && country !== 'US') {
      if (code && index > 0) resolved.add('US');
      continue;
    }
    if (country) resolved.add(country);
    if (state) resolved.add('US');
  }
  return resolved.size === 1 ? [...resolved][0] : null;
}

// Drops decided from the record and configuration alone, before any fetch. Ingest may count these
// instead of storing them (they never need a model or an official page).
export const CERTAIN_DROP_CODES = Object.freeze(['no_student_signal', 'company_excluded', 'outside_countries', 'company_small',
  'title_function', 'title_level', 'title_term', 'title_language']);

const locationText = (location) => typeof location === 'string' ? location
  : [location?.location, location?.name, location?.place, location?.city, location?.country].filter((part) => typeof part === 'string').join(', ');

export function classifyRole(record, { policy = {}, profile, identity: { submitted = false, userDeclined = false } = {} } = {}) {
  const flags = [];
  let lane = 'new';
  const outcome = (kind, code, evidence = []) => ({ kind, code, evidence, flags, lane });
  if (submitted) return outcome('reuse', 'already_submitted', typeof submitted === 'object' ? [submitted] : []);
  if (userDeclined) return outcome('reuse', 'user_declined');
  if (companyExcluded(record.company, policy)) {
    return outcome('drop', 'company_excluded', [record.company]);
  }
  // User rule: big companies only. A company known to be small (profile/company-size.json) is dropped
  // before any fetch; an unknown one is reviewed and its size is decided once per company.
  if (policy.companySizes?.enabled !== false && policy.companySizes?.sizeOf?.(record.company) === 'small') {
    return outcome('drop', 'company_small', [record.company]);
  }
  const aliases = new Set(aliasesFor(record, identityOptionsOf(policy)).map((item) => item.alias));
  for (const entry of policy.userExcludedPostings ?? []) {
    const value = typeof entry === 'string' ? entry : entry.alias ?? entry.url;
    const url = canonicalUrl(value);
    if ((url && aliases.has(`url:${url}`)) || (value?.startsWith('company_req:') && aliases.has(value))) return outcome('drop', 'posting_excluded', [value]);
  }
  const allowed = profile?.search?.countries ?? [];
  const locations = record.locations ?? [];
  // Every listed location resolves to a country outside the search, and nothing marks the role remote. A location
  // that does not resolve (a bare city) keeps the record for review; areas inside the country are judged in review.
  const remoteMarked = record.remote === true || [record.workplaceType, record.title, ...locations.map(locationText)]
    .some((text) => typeof text === 'string' && /remote/i.test(text));
  const countriesOf = locations.map(countryOf);
  if (allowed.length && locations.length && !remoteMarked && countriesOf.every((country) => country && !allowed.includes(country))) {
    return outcome('drop', 'outside_countries', locations.map((location, index) => ({ location: locationText(location), country: countriesOf[index] })));
  }
  const titleDrop = titleScreenDrop(record, policy, profile);
  if (titleDrop) return outcome('drop', titleDrop.code, titleDrop.evidence);
  if (record.listed === false) flags.push('listed_false');
  if (record.completeness?.locations !== 'complete') flags.push('partial_locations');
  const signal = [record.title, ...(record.categories ?? []), record.department].some((text) => STUDENT.test(text ?? ''))
    || PROGRAM.test(record.description ?? '') || PROGRAM.test(record.employmentType ?? '')
    || (record.terms ?? []).some((term) => TERM.test(term));
  if (!signal) flags.push('generic_title');
  const studentSearch = ['internship', 'co-op'].includes(profile?.search?.jobType);
  const engagement = studentSearch && !signal && engagementSignal(record, policy);
  if (engagement) flags.push('engagement_signal');
  let drop = null;
  if (studentSearch && !signal && !engagement) {
    flags.push('no_student_signal'); lane = 'no_student_signal'; drop = 'no_student_signal';
  } else if (studentSearch && !engagement && record.source === 'simplify' && record.categories?.length
      && record.categories.every((category) => /^hardware(?: engineering)?$/i.test(String(category).trim()))
      && !DIRECTION.test(record.title ?? '') && !(policy.direction?.allow ?? []).some((pattern) => pattern.test(record.title ?? ''))
      && !anyFunctionCompany(record.company, policy.direction, policy.companyAliases)) {
    lane = 'out_of_direction'; drop = 'out_of_direction';
  }
  if (record.terms?.length) flags.push('term_tag_conflict');
  if (record.degrees?.length) flags.push('degree_tag');
  if (locations.some((location) => stateNames.has(normalized(location)) || Object.hasOwn(countries.usStates, String(location)))) flags.push('state_only_location');
  if (record.deadlineAt && record.deadlineKind === 'cutoff' && !['no_student_signal', 'out_of_direction'].includes(lane)) lane = 'deadline';
  return drop ? outcome('drop', drop) : outcome('review', null);
}
