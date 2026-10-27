import countries from './data/countries.json' with { type: 'json' };
import { companyKey } from '../scan/dedupe.mjs';
import { aliasesFor, canonicalUrl } from './identity.mjs';

const STUDENT = /\b(?:intern(?:s|ship|ships)?|co[- ]?ops?|apprentice(?:s|ship|ships)?|placements?|working students?|students?|fellow(?:s|ship|ships)?|residen(?:t|ts|cy)|graduate program(?:me)?|early career|university program(?:me)?|campus program(?:me)?|summer (?:analysts?|associates?|20\d\d program(?:me)?)|currently enrolled|class of 20\d\d)\b/i;
// Descriptions often mention students in company-wide boilerplate. Only explicit
// program phrases count there; titles and departments retain the broader signal.
const PROGRAM = /\b(?:interns?|internships?|co[- ]?ops?|apprentice(?:s|ship|ships)?|summer\s+20\d\d\s+(?:interns?|analysts?|associates?|program(?:me)?)|(?:graduate|early career|university|campus)\s+program(?:me)?)\b/i;
const DIRECTION = /\b(?:data|analytics|analyst|AI|ML|machine\s+learning|product|program|project|business|insights|intelligence|solutions|strategy|BI|quant)\b/i;
const names = new Map();
const normalized = (value) => String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
for (const country of countries.countries) {
  for (const name of [country.alpha2, country.alpha3, country.name, displayNames.of(country.alpha2)]) names.set(normalized(name), country.alpha2);
}
for (const [name, code] of Object.entries({ 'united states of america': 'US', 'u s': 'US', 'u s a': 'US', 'uk': 'GB', 'u k': 'GB', 'south korea': 'KR', 'north korea': 'KP', 'russia': 'RU', 'vietnam': 'VN', 'taiwan': 'TW' })) names.set(name, code);
const stateNames = new Set(Object.values(countries.usStates).map(normalized));

function countryOf(location) {
  // Explicit structured country context takes precedence over ambiguous place names.
  const explicit = typeof location === 'object' && (location?.countryCode ?? location?.country);
  if (typeof explicit === 'string' && names.has(normalized(explicit))) return names.get(normalized(explicit));
  const raw = typeof location === 'string' ? location : location?.location ?? location?.name ?? location?.place ?? '';
  const value = normalized(raw);
  if (names.has(value) && !stateNames.has(value) && !Object.hasOwn(countries.usStates, raw)) return names.get(value);
  // Country/state tokens are interpreted only at location boundaries, never as substrings of city names.
  const pieces = String(raw).split(/[,;|/]|\s+-\s+/).map((piece) => piece.trim()).filter(Boolean);
  const resolved = new Set();
  for (const piece of pieces) {
    const key = normalized(piece.replace(/^remote\s+(?:in\s+)?/i, ''));
    const country = names.get(key);
    const state = stateNames.has(key) || Object.hasOwn(countries.usStates, piece);
    if (country && state && country !== 'US') continue;
    if (country) resolved.add(country);
    if (state) resolved.add('US');
  }
  return resolved.size === 1 ? [...resolved][0] : null;
}

export function classifyRole(record, { policy = {}, profile, identity: { submitted = false, userDeclined = false } = {} } = {}) {
  const flags = [];
  let lane = 'new';
  const outcome = (kind, code, evidence = []) => ({ kind, code, evidence, flags, lane });
  if (submitted) return outcome('reuse', 'already_submitted');
  if (userDeclined) return outcome('reuse', 'user_declined');
  if ((policy.userExcludedCompanies ?? []).some((name) => companyKey(name, policy.companyAliases) === companyKey(record.company, policy.companyAliases))) {
    return outcome('drop', 'company_excluded', [record.company]);
  }
  const aliases = new Set(aliasesFor(record, { companyAliases: policy.companyAliases }).map((item) => item.alias));
  for (const entry of policy.userExcludedPostings ?? []) {
    const value = typeof entry === 'string' ? entry : entry.alias ?? entry.url;
    const url = canonicalUrl(value);
    if ((url && aliases.has(`url:${url}`)) || (value?.startsWith('company_req:') && aliases.has(value))) return outcome('drop', 'posting_excluded', [value]);
  }
  const allowed = profile?.search?.countries ?? [];
  const locations = record.locations ?? [];
  const resolved = locations.map(countryOf);
  if (allowed.length && record.completeness?.locations === 'complete' && record.completeness?.arrangement === 'known'
      && record.remote === false && !/remote/i.test(record.workplaceType ?? '') && locations.length
      && resolved.every((country) => country && !allowed.includes(country))) return outcome('drop', 'outside_countries', locations);
  if (record.listed === false) flags.push('listed_false');
  if (record.completeness?.locations !== 'complete') flags.push('partial_locations');
  const signal = [record.title, ...(record.categories ?? []), record.department].some((text) => STUDENT.test(text ?? ''))
    || PROGRAM.test(record.description ?? '');
  if (!signal) flags.push('generic_title');
  const studentSearch = ['internship', 'co-op'].includes(profile?.search?.jobType);
  if (studentSearch && !signal) {
    flags.push('no_student_signal'); lane = 'no_student_signal';
  } else if (studentSearch && record.source === 'simplify' && record.categories?.length
      && record.categories.every((category) => /^hardware(?: engineering)?$/i.test(String(category).trim()))
      && !DIRECTION.test(record.title ?? '')) {
    lane = 'out_of_direction';
  }
  if (record.terms?.length) flags.push('term_tag_conflict');
  if (record.degrees?.length) flags.push('degree_tag');
  if (locations.some((location) => stateNames.has(normalized(location)) || Object.hasOwn(countries.usStates, String(location)))) flags.push('state_only_location');
  if (record.deadlineAt && record.deadlineKind === 'cutoff' && !['no_student_signal', 'out_of_direction'].includes(lane)) lane = 'deadline';
  return outcome('review', null);
}
