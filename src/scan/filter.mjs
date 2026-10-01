import { DIRECTION_KEYWORDS, directionLabel, matchDirections } from './directions.mjs';
import { excerpt, normalizeText, termPattern } from './text.mjs';

// Profile-driven role filters. Every function is pure: it takes a normalised
// role record and a scan profile (see profile-input.mjs) and returns plain
// data. A dropped role always carries a human-readable "<code>: <why>" reason.

export const FILTER_REASON_CODES = Object.freeze([
  'job-type',
  'season',
  'direction',
  'degree-phd-only',
  'degree-undergrad-only',
  'citizenship',
  'clearance',
  'export-control',
  'sponsorship',
  'no-return-offer',
  'location',
  'remote',
]);

const TERM_NAMES = Object.freeze({ spring: 'Spring', summer: 'Summer', fall: 'Fall', autumn: 'Fall', winter: 'Winter' });
const TERM_WORD = '(spring|summer|fall|autumn|winter)';

// Lower-cases and folds common abbreviations so that sentence splitting does
// not break "U.S. citizen" or "Ph.D." apart.
export function prepareText(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => normalizeText(line)
    .replace(/(?<![a-z])u\.\s?s\.(?:\s?a\.)?/g, 'us ')
    .replace(/(?<![a-z])ph\.\s?d\.?/g, 'phd ')
    .replace(/(?<![a-z])m\.\s?s\.(?![a-z])/g, 'ms ')
    .replace(/(?<![a-z])b\.\s?s\.(?![a-z])/g, 'bs ')
    .replace(/(?<![a-z])(e\.g|i\.e|etc|incl|approx)\./g, '$1')
    .replace(/ +/g, ' ')
    .trim()).filter(Boolean).join('\n');
}

export function sentences(value) {
  return prepareText(value)
    .split(/(?<=[.!?;])\s+|\n+|\s*•\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function roleText(role) {
  return [role?.title, ...(role?.categories ?? []), role?.description].filter(Boolean).join('\n');
}

function quote(text, match) {
  return `"${excerpt(text, match.index, match[0].length, 30)}"`;
}

function firstMatch(text, patterns, { skip } = {}) {
  for (const sentence of sentences(text)) {
    if (skip && skip.test(sentence)) continue;
    for (const pattern of patterns) {
      const match = pattern.exec(sentence);
      if (match) return { sentence, match, quote: quote(sentence, match) };
    }
  }
  return null;
}

// ---------------------------------------------------------------- season

export function parseSeason(value) {
  const text = normalizeText(value);
  const term = new RegExp(`(?<![a-z])${TERM_WORD}(?![a-z])`).exec(text)?.[1];
  const year = /(?<!\d)(20\d{2})(?!\d)/.exec(text)?.[1];
  return { term: term ? TERM_NAMES[term] : null, year: year ? Number(year) : null };
}

function formatSeason({ term, year }) {
  return [term, year].filter(Boolean).join(' ') || 'any term';
}

function fullYear(value) {
  return value.startsWith("'") ? 2000 + Number(value.slice(1)) : Number(value);
}

export function seasonMentions(value) {
  const text = normalizeText(value);
  const found = [];
  const termFirst = new RegExp(`(?<![a-z])${TERM_WORD}\\s*(?:of\\s+)?(?:[-,/]\\s*)?(20\\d{2}|'\\d{2})(?!\\d)`, 'g');
  const yearFirst = new RegExp(`(?<![\\d'])(20\\d{2})\\s*(?:[-/]\\s*)?${TERM_WORD}(?![a-z])`, 'g');
  for (const match of text.matchAll(termFirst)) found.push({ term: TERM_NAMES[match[1]], year: fullYear(match[2]), text: match[0] });
  for (const match of text.matchAll(yearFirst)) found.push({ term: TERM_NAMES[match[2]], year: Number(match[1]), text: match[0] });
  return found;
}

function seasonMatches(mention, target) {
  return (!target.term || !mention.term || mention.term === target.term)
    && (!target.year || !mention.year || mention.year === target.year);
}

function describeMentions(mentions) {
  return [...new Set(mentions.map(formatSeason))].join(', ');
}

export function checkSeason(role, profile) {
  const target = parseSeason(profile?.search?.season);
  if (!target.term && !target.year) return { ok: true };
  const wanted = formatSeason(target);
  const listed = (role?.terms ?? []).map(parseSeason).filter((item) => item.term || item.year);
  if (listed.length) {
    return listed.some((item) => seasonMatches(item, target))
      ? { ok: true }
      : { ok: false, reason: `season: listed for ${describeMentions(listed)}; profile wants ${wanted}` };
  }
  const title = String(role?.title ?? '');
  const inTitle = seasonMentions(title);
  if (inTitle.length) {
    return inTitle.some((item) => seasonMatches(item, target))
      ? { ok: true }
      : { ok: false, reason: `season: title names ${describeMentions(inTitle)}; profile wants ${wanted}` };
  }
  if (target.year) {
    const years = [...normalizeText(title).matchAll(/(?<![a-z\d])(20\d{2})(?!\d)/g)].map((match) => Number(match[1]));
    if (years.length && !years.includes(target.year)) {
      return { ok: false, reason: `season: title names ${[...new Set(years)].join(', ')}; profile wants ${wanted}` };
    }
  }
  // In the description only a season named next to the internship itself
  // counts ("our Fall 2026 co-op"); interview or deadline dates do not.
  const inDescription = sentences(role?.description ?? '')
    .filter((sentence) => INTERNSHIP.test(sentence) || /(?<![a-z])(program|cohort|class|term|session)(?![a-z])/.test(sentence))
    .flatMap((sentence) => seasonMentions(sentence));
  if (inDescription.length && !inDescription.some((item) => seasonMatches(item, target))) {
    return { ok: false, reason: `season: posting mentions only ${describeMentions(inDescription)}; profile wants ${wanted}` };
  }
  return { ok: true };
}

// -------------------------------------------------------------- job type

const INTERNSHIP = /(?<![a-z])(interns?|internships?|co-?ops?|apprentices?|apprenticeships?|summer analysts?|summer associates?|working students?|placement year|industrial placement)(?![a-z])/;

export function checkJobType(role, profile) {
  const jobType = normalizeText(profile?.search?.jobType);
  if (!jobType) return { ok: true };
  const title = String(role?.title ?? '');
  const labelled = normalizeText([title, ...(role?.categories ?? [])].join(' | '));
  const isInternship = INTERNSHIP.test(labelled) || (role?.terms ?? []).length > 0;
  if (jobType === 'internship' && !isInternship) {
    return { ok: false, reason: `job-type: "${title}" does not look like an internship or co-op` };
  }
  if (['full-time', 'fulltime', 'new-grad', 'new grad'].includes(jobType) && INTERNSHIP.test(normalizeText(title))) {
    return { ok: false, reason: `job-type: "${title}" is an internship; profile wants ${jobType} roles` };
  }
  return { ok: true };
}

// ------------------------------------------------------------- direction

export function checkDirection(role, profile, { keywordMap = DIRECTION_KEYWORDS } = {}) {
  const primary = profile?.search?.directions?.primary ?? [];
  const secondary = profile?.search?.directions?.secondary ?? [];
  const ids = [...primary, ...secondary];
  const matches = matchDirections(role, ids, keywordMap);
  if (!ids.length || ids.includes('other') || matches.length) return { ok: true, matches };
  return {
    ok: false,
    matches,
    reason: `direction: title and categories match none of the profile directions (${ids.map(directionLabel).join(', ')})`,
  };
}

// ---------------------------------------------------------------- degree

const PHD_WORD = /(?<![a-z])(phd|doctoral|doctorate)(?![a-z])/;
const MASTERS_OK = /(?<![a-z])(masters?|master's|ms|msc|m\.sc|mba|meng|graduate students?|grad students?|graduate degree students?)(?![a-z])/;
const PHD_ONLY = [
  /(?<![a-z])phd (?:students?|candidates?) only(?![a-z])/,
  /(?<![a-z])only (?:open|available) to (?:current )?phd/,
  /(?<![a-z])(?:must|should) be (?:currently )?(?:enrolled in|pursuing) (?:a )?(?:phd|doctoral|doctorate)/,
  /(?<![a-z])currently (?:enrolled in|pursuing) (?:a )?(?:phd|doctoral|doctorate)(?![a-z])/,
  /(?<![a-z])(?:enrolled in|pursuing) a (?:phd|doctoral) (?:program|degree)/,
  /(?<![a-z])(?:open|available) (?:only )?to phd students(?![a-z])/,
];
const UNDERGRAD_WORD = /(?<![a-z])(undergrad|undergraduate|undergraduates)(?![a-z])/;
const UNDERGRAD_ONLY = [
  /(?<![a-z])rising (?:freshm[ae]n|sophomores?|juniors?|seniors?)(?![a-z])/,
  /(?<![a-z])current(?:ly)? (?:an? )?(?:undergraduate )?(?:freshm[ae]n|sophomores?|juniors?)(?![a-z])/,
  /(?<![a-z])(?:freshm[ae]n|sophomores?)\s*(?:,|or|and|\/)\s*(?:or |and )?(?:sophomores?|juniors?)(?![a-z])/,
  /(?<![a-z])undergraduates? (?:students? )?only(?![a-z])/,
  /(?<![a-z])only (?:open|available) to (?:current )?undergraduate/,
  /(?<![a-z])(?:must|should) be (?:an? )?(?:current(?:ly)? )?(?:enrolled )?(?:an? )?undergraduate/,
  /(?<![a-z])open to undergraduates? only(?![a-z])/,
];

function acceptsMasters(text) {
  return MASTERS_OK.test(prepareText(text).replace(/undergraduate/g, 'undergrad'));
}

export function checkDegree(role, profile) {
  const level = profile?.candidate?.degree?.level;
  if (!level || level === 'other') return { ok: true };
  const title = String(role?.title ?? '');
  const text = roleText(role);
  const masterOk = acceptsMasters(text);
  const listedDegrees = (role?.degrees ?? []).map((item) => prepareText(item));
  if (level !== 'phd' && listedDegrees.length && listedDegrees.every((item) => PHD_WORD.test(item))) {
    return { ok: false, reason: `degree-phd-only: listed degrees are ${role.degrees.join(', ')}; profile degree is ${level}` };
  }
  // Boards that list the accepted degrees (SimplifyJobs does) are taken at their word: a list naming only
  // bachelor's or associate degrees is undergraduate-only for a graduate candidate.
  if (['masters', 'mba'].includes(level) && listedDegrees.length
    && listedDegrees.every((item) => /bachelor|associate|undergrad/.test(item))) {
    return { ok: false, reason: `degree-undergrad-only: listed degrees are ${role.degrees.join(', ')}; profile degree is ${level}` };
  }
  if (level !== 'phd' && !masterOk) {
    const phdTitle = PHD_WORD.exec(prepareText(title));
    if (phdTitle) return { ok: false, reason: `degree-phd-only: title "${title}" is for PhD students; profile degree is ${level}` };
    const phdText = firstMatch(text, PHD_ONLY);
    if (phdText) return { ok: false, reason: `degree-phd-only: PhD-only wording ${phdText.quote}; profile degree is ${level}` };
  }
  if (['masters', 'phd', 'mba'].includes(level) && !masterOk) {
    const undergradTitle = UNDERGRAD_WORD.exec(prepareText(title));
    if (undergradTitle) return { ok: false, reason: `degree-undergrad-only: title "${title}" is for undergraduates; profile degree is ${level}` };
    const undergradText = firstMatch(text, UNDERGRAD_ONLY);
    if (undergradText) return { ok: false, reason: `degree-undergrad-only: undergraduate-only wording ${undergradText.quote}; profile degree is ${level}` };
  }
  return { ok: true };
}

// --------------------------------------------------------- authorization

const PERMANENT_RESIDENT = /(?<![a-z])(permanent residen(?:t|ts|cy|ce)|green card|lawful permanent|lpr)(?![a-z])/;
const CITIZENSHIP = [
  /(?<![a-z])(?:us|united states) citizenship (?:is )?(?:required|a requirement|mandatory)/,
  /(?<![a-z])citizenship (?:is )?required(?![a-z])/,
  /(?<![a-z])(?:us|united states) citizenship (?:or|and\/or|\/) (?:lawful )?permanent residen\w*(?: status)? (?:is )?(?:required|a requirement|mandatory)/,
  /(?<![a-z])(?:must|need to|required to|have to) be (?:an? )?(?:us|united states|american) citizens?(?![a-z])/,
  /(?<![a-z])(?:us|united states) citizens? only(?![a-z])/,
  /(?<![a-z])requires? (?:us|united states) citizenship(?![a-z])/,
  /(?<![a-z])only (?:open|available) to (?:us|united states) citizens(?![a-z])/,
  /(?<![a-z])sponsorship: us citizenship is required/,
];
const CLEARANCE = [
  /(?<![a-z])(?:active|current) (?:top secret|secret|ts\/sci|ts|dod|doe|government|security|federal) (?:security )?clearance(?![a-z])/,
  /(?<![a-z])(?:top secret|secret|ts\/sci) (?:security )?clearance (?:is )?required(?![a-z])/,
  /(?<![a-z])(?:security )?clearance (?:is )?required(?![a-z])/,
  /(?<![a-z])(?:requires?|must (?:have|hold|possess|obtain)) (?:an? )?(?:active )?(?:top secret|secret|ts\/sci|security|government|dod) clearance(?![a-z])/,
  /(?<![a-z])(?:ability|able|eligib(?:le|ility)) to (?:obtain|be granted) (?:and maintain )?(?:an? )?(?:(?:top secret|secret|ts\/sci|security|government|dod|federal) )?(?:security )?clearance(?![a-z])/,
];
const US_PERSON = [
  /(?<![a-z])(?:must|required to|need to) be an? us person(?![a-z])/,
  /(?<![a-z])us persons? (?:only|status (?:is )?required)(?![a-z])/,
  /(?<![a-z])(?:itar|export control)[^.]{0,80}(?:us person|citizen|permanent resident)/,
];
const NO_SPONSORSHIP = [
  /(?<![a-z])(?:will not|won't|does not|do not|cannot|can't|unable to|not able to) (?:provide |offer |support )?(?:visa |immigration |employment )?sponsor(?:ship)?(?![a-z])/,
  /(?<![a-z])no (?:visa |immigration )?sponsorship(?![a-z])/,
  /(?<![a-z])sponsorship (?:is )?not (?:available|provided|offered|supported)(?![a-z])/,
  /(?<![a-z])without (?:the need for )?(?:current or future |now or in the future )?(?:visa |employer )?sponsorship(?![a-z])/,
  /(?<![a-z])(?:not|never) (?:now or in the future )?require (?:current or future |now or in the future )?(?:visa |employer |immigration |employment )?sponsorship(?![a-z])/,
  /(?<![a-z])sponsorship: does not offer sponsorship/,
];
const CLEARANCE_NOT_NEEDED = /(?<![a-z])(?:no|without) (?:(?:security|government) )?clearance|clearance (?:is )?not (?:required|needed)|not require (?:an? )?(?:(?:security|government) )?clearance/;

export function checkAuthorization(role, profile) {
  const status = profile?.candidate?.authorization?.status;
  const needsSponsorship = profile?.candidate?.authorization?.needsSponsorship === true;
  const text = roleText(role);
  const reasons = [];
  if (status && status !== 'citizen') {
    const citizenship = firstMatch(text, CITIZENSHIP);
    const prAccepted = citizenship && PERMANENT_RESIDENT.test(citizenship.sentence);
    if (citizenship && !(prAccepted && status === 'permanent-resident')) {
      reasons.push(`citizenship: requires US citizenship ${citizenship.quote}; profile authorization is ${status}`);
    }
    const clearance = firstMatch(text, CLEARANCE, { skip: CLEARANCE_NOT_NEEDED });
    if (clearance) reasons.push(`clearance: requires a security clearance ${clearance.quote}; profile authorization is ${status}`);
    if (status !== 'permanent-resident') {
      const usPerson = firstMatch(text, US_PERSON);
      if (usPerson) reasons.push(`export-control: requires US-person status ${usPerson.quote}; profile authorization is ${status}`);
    }
  }
  if (needsSponsorship) {
    const sponsorship = firstMatch(text, NO_SPONSORSHIP);
    if (sponsorship) reasons.push(`sponsorship: no visa sponsorship ${sponsorship.quote}; profile needs sponsorship`);
  }
  return { ok: reasons.length === 0, reasons };
}

// --------------------------------------------------------- return offer

const NO_RETURN_OFFER = [
  /(?<![a-z])no (?:full[- ]time )?return offers?(?![a-z])/,
  /(?<![a-z])(?:not (?:be )?eligible|ineligible) for (?:an? )?(?:full[- ]time )?(?:return offers?|conversion|full[- ]time (?:offers?|conversion|employment|roles?|positions?))/,
  /(?<![a-z])will not (?:receive|be (?:offered|extended|given)) (?:an? )?(?:full[- ]time )?return offers?/,
  /(?<![a-z])(?:does|will|do) not (?:lead to|result in|include|come with|convert (?:to|into)) (?:an? )?(?:full[- ]time )?(?:return offers?|offers? of employment|full[- ]time (?:offers?|employment|roles?|positions?))/,
  /(?<![a-z])no (?:possibility|opportunity|option) (?:of|for) (?:an? )?(?:full[- ]time )?(?:return offers?|conversion|full[- ]time (?:offers?|employment))/,
  /(?<![a-z])return offers? (?:are|is|will) not (?:be )?(?:offered|extended|available|provided|made)(?![a-z])/,
];

export function checkReturnOffer(role, profile) {
  if (!(profile?.search?.exclusions ?? []).includes('no-return-offer')) return { ok: true };
  const found = firstMatch(roleText(role), NO_RETURN_OFFER, { skip: /guarant/ });
  return found
    ? { ok: false, reason: `no-return-offer: posting says there is no return offer ${found.quote}; profile excludes these roles` }
    : { ok: true };
}

// -------------------------------------------------------------- location

const REMOTE = /(?<![a-z])(remote|anywhere|work from home|wfh|distributed|virtual)(?![a-z])/;
const BROAD = /^(?:(?:united states|usa|us|u\.s\.|u\.s\.a\.|north america|multiple locations|various locations|various|nationwide|americas)(?: of america)?)$/;

export function rankLocation(role, profile) {
  const preferences = profile?.search?.locations ?? [];
  const remoteOk = profile?.search?.remoteOk === true;
  const locations = (role?.locations ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
  if (!locations.length) return { ok: true, locRank: null, matched: null };
  let best = null;
  for (const location of locations) {
    const text = normalizeText(location);
    preferences.forEach((preference, index) => {
      if ((best === null || index + 1 < best.locRank) && preference.match.some((term) => termPattern(term).test(text))) {
        best = { locRank: index + 1, matched: preference.label };
      }
    });
  }
  if (best) return { ok: true, ...best };
  const remote = role?.remote === true || locations.some((location) => REMOTE.test(normalizeText(location)));
  if (remote && remoteOk) return { ok: true, locRank: preferences.length + 1, matched: 'Remote' };
  if (!preferences.length) return { ok: true, locRank: null, matched: null };
  const broad = locations.every((location) => BROAD.test(normalizeText(location).replace(/[()]/g, '').trim()));
  if (broad) return { ok: true, locRank: preferences.length + (remoteOk ? 2 : 1), matched: null, note: 'location is not specific' };
  if (remote && locations.every((location) => REMOTE.test(normalizeText(location)) || BROAD.test(normalizeText(location)))) {
    return { ok: false, locRank: null, matched: null, reason: `remote: remote role (${locations.join('; ')}) and profile does not accept remote` };
  }
  return {
    ok: false,
    locRank: null,
    matched: null,
    reason: `location: ${locations.join('; ')} matches none of the profile locations (${preferences.map((item) => item.label).join(', ')})`,
  };
}

// ------------------------------------------------------------- aggregate

export function filterRole(role, profile, options = {}) {
  const reasons = [];
  const jobType = checkJobType(role, profile);
  if (!jobType.ok) reasons.push(jobType.reason);
  const season = checkSeason(role, profile);
  if (!season.ok) reasons.push(season.reason);
  const direction = checkDirection(role, profile, options);
  if (!direction.ok) reasons.push(direction.reason);
  const degree = checkDegree(role, profile);
  if (!degree.ok) reasons.push(degree.reason);
  const authorization = checkAuthorization(role, profile);
  reasons.push(...authorization.reasons);
  const returnOffer = checkReturnOffer(role, profile);
  if (!returnOffer.ok) reasons.push(returnOffer.reason);
  const location = rankLocation(role, profile);
  if (!location.ok) reasons.push(location.reason);
  return {
    keep: reasons.length === 0,
    reasons,
    codes: reasons.map((reason) => reason.slice(0, reason.indexOf(':'))),
    locRank: location.locRank,
    location: location.matched,
    directions: direction.matches,
  };
}
