import { findQuote, normalizeQuote, validateCriterion } from './clauses.mjs';
import { quotedClock } from './deadline.mjs';

export const DECIDE_VERSION = 'structured-decisions-3';
const FIT_LEVELS = ['low', 'medium', 'high'];
const emptyDeadline = () => ({ kind: 'none', date: null, time: null, tz: null, precision: null, quote: null });
const clean = (value) => normalizeQuote(value ?? '').toLowerCase();
const seasons = (value) => [...new Set((clean(value).match(/\b(?:winter|spring|summer|fall|autumn)\b/g) ?? []).map((season) => season === 'autumn' ? 'fall' : season))];
const US_STATE_TERRITORY_CODES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC AS GU MP PR VI UM'.split(' '));
const cityPart = (place) => clean(place).split(',')[0].trim();

function validatedQuote(text, value) { return findQuote(text, value) ? value : null; }

function dateValid(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function dateEvidence(quote, value) {
  const monthOnly = typeof value === 'string' && /^\d{4}-\d{2}$/.test(value);
  const date = monthOnly ? `${value}-01` : value;
  if (!dateValid(date)) return null;
  const exact = [...quote.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((match) => match[0]);
  if (exact.length) return (monthOnly ? dateValid(exact[0]) && exact[0].slice(0, 7) === value : exact[0] === value)
    ? { start: exact[0], end: exact[0] } : null;
  const year = value.slice(0, 4);
  const month = Number(value.slice(5, 7));
  const reference = new Date(`${date}T12:00:00Z`);
  const names = ['long', 'short'].map((style) => new Intl.DateTimeFormat('en', { month: style, timeZone: 'UTC' }).format(reference).replace(/\.$/, '').toLowerCase());
  for (const name of names) {
    const forward = new RegExp(`\\b${name}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*${year}\\b`, 'i').exec(quote);
    const reverse = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${name}\\.?\\s*,?\\s*${year}\\b`, 'i').exec(quote);
    const day = forward?.[1] ?? reverse?.[1];
    if (day) {
      const actual = `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
      return (monthOnly ? dateValid(actual) : actual === value) ? { start: actual, end: actual } : null;
    }
  }
  // A month-range term can state its year only after the ending month.
  const monthName = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const rangeEnd = monthOnly ? `(?:(?:[-–—]|to|through)\\s*${monthName}\\.?\\s+)?` : '';
  if (!names.some((name) => new RegExp(`\\b${name}\\.?\\s+${rangeEnd}(?:of\\s+)?${year}\\b`, 'i').test(quote))) return null;
  // Month-only wording proves an interval, never the model's invented start day.
  return { start: `${year}-${String(month).padStart(2, '0')}-01`, end: new Date(Date.UTC(Number(year), month, 0)).toISOString().slice(0, 10) };
}

function quoteAgreesWithTerm(term, quote, own = false) {
  const named = seasons(quote);
  const labeled = seasons(term.label);
  // A shared term quote may list several alternatives. It only needs to
  // include this label's season; office/scope quotes must still agree with it.
  return (own ? !named.length || labeled.every((season) => named.includes(season)) : named.every((season) => labeled.includes(season)))
    && (clean(quote).match(/\b\d{4}\b/g) ?? []).every((year) => Number(year) === term.year);
}

function termPlacesAgree(quote, offices) {
  // Compare literal named places in this quote with this alternative's offices.
  // No page-wide place lookup or proximity-based track assignment is involved.
  const city = String.raw`\p{Lu}[\p{L}\p{M}.'-]*(?:\s+\p{Lu}[\p{L}\p{M}.'-]*)*`;
  const value = normalizeQuote(quote ?? '');
  const places = [
    ...[...value.matchAll(new RegExp(`${city},\\s*([A-Z]{2})\\b`, 'gu'))].filter((match) => US_STATE_TERRITORY_CODES.has(match[1])
      && !/\b(?:intern(?:ship)?|engineer|researcher|student|analyst|summer)$/i.test(cityPart(match[0]))
      && !/^\/(?:PhD|MBA|MS|BS)\b/i.test(value.slice(match.index + match[0].length))).map((match) => match[0]),
    ...[...value.matchAll(new RegExp(`\\b(?:[Bb]ased|[Ll]ocated) in (${city})(?:,\\s*([A-Z]{2})\\b)?`, 'gu'))].filter((match) => !match[2] || US_STATE_TERRITORY_CODES.has(match[2])).map((match) => match[1]),
  ];
  return places.every((place) => offices.some((office) => {
    const expected = cityPart(office.place);
    const actual = cityPart(place);
    return expected && (actual === expected || actual.endsWith(` ${expected}`));
  }));
}

function titleYears(text) {
  const title = text.match(/^[ \t]*TITLE:[ \t]*(.+)$/im)?.[1]
    ?? text.match(/^[ \t]*#{1,6}[ \t]+(.+)$/m)?.[1]
    ?? text.split('\n').find((line) => line.trim() && !/^[ \t]*URL:/i.test(line)) ?? '';
  return (title.match(/\b\d{4}\b/g) ?? []).map(Number);
}

function termEvidence(text, term, inferred = false) {
  if (!term || !findQuote(text, term.quote)) return false;
  const quote = clean(term.quote);
  if (!term.label || !quoteAgreesWithTerm(term, quote, true)) return false;
  if (term.start && !dateEvidence(quote, term.start)) return false;
  const years = titleYears(text);
  // Missing year evidence is incomplete, not contradictory.
  if (term.year == null && !/\b\d{4}\b/.test(quote) && !years.length) return null;
  const labeled = seasons(term.label);
  const named = seasons(quote);
  const fromTitle = years.length > 0 && years.every((year) => year === term.year)
    && labeled.length > 0 && labeled.every((season) => named.includes(season));
  if (!Number.isInteger(term.year) || !inferred && !new RegExp(`\\b${term.year}\\b`).test(quote) && !fromTitle) return false;
  return true;
}

function matchesTermKind(term, kinds) {
  const labels = [term.kind, term.label].filter(Boolean).map(clean);
  return kinds?.some((kind) => labels.some((label) => label === clean(kind) || label.split(/\s+/).includes(clean(kind))));
}

function matchesWindow(term, window) {
  if (!matchesTermKind(term, window.termKinds)) return false;
  if (window.year !== undefined && window.year !== null && Number(term.year) !== Number(window.year)) return false;
  if (window.startAfter || window.startBefore) {
    const range = dateEvidence(clean(term.quote), term.start);
    if (!range) return false;
    if (window.startAfter && range.start < window.startAfter) return false;
    if (window.startBefore && range.end > window.startBefore) return false;
  }
  return window.year !== undefined || Boolean(window.startAfter || window.startBefore);
}

function remoteEvidence(text, remote) {
  return Boolean(remote && /^(?:us|state:[A-Z]{2}|none|non_us)$/.test(remote.scope) && findQuote(text, remote.quote));
}

function inferTerm(text, term, firstSeen, jobType) {
  const yearUnknown = !/\b\d{4}\b/.test(term?.quote ?? '') && !titleYears(text).length;
  // An unsupported model year cannot bypass the first-seen inference window.
  if (yearUnknown && term?.year != null) term = { ...term, year: null };
  const observed = new Date(firstSeen);
  if (!Number.isFinite(observed.getTime()) || observed.getUTCMonth() < 7) return { term, inferred: false };
  const year = observed.getUTCFullYear() + 1;
  if (jobType === 'internship' && !/\b\d{4}\b/.test(text) && !seasons(text).length) {
    const quote = term?.quote ?? /\b(?:internships?|interns?)\b/i.exec(text)?.[0];
    if (quote) return { term: { ...term, label: 'summer', kind: 'summer', year, quote }, inferred: true };
  }
  if (!term) return { term, inferred: false };
  const labeled = seasons(term.label);
  const named = labeled.length ? labeled : seasons(term.kind);
  if (term.year == null && yearUnknown && named.length === 1) {
    return { term: { ...term, year }, inferred: true };
  }
  if (jobType === 'internship' && term.year === year && !seasons(text).length
    && !seasons(term.label).length && !term.kind && new RegExp(`\\b${year}\\b`).test(term.quote ?? '')) {
    return { term: { ...term, label: 'summer', kind: 'summer' }, inferred: true };
  }
  return { term, inferred: false };
}

function tiedToTerm(text, term, quote, place) {
  // Prose proximity is only an advisory for the primary tier. The model's
  // alternatives, not these segments, determine track membership.
  const own = seasons(term.quote);
  const other = seasons(quote);
  if (other.some((season) => !own.includes(season))) return false;
  const years = quote.match(/\b\d{4}\b/g) ?? [];
  if (years.some((year) => Number(year) !== term.year)) return false;
  const statedWindows = new Set([...clean(text).matchAll(/\b(winter|spring|summer|fall|autumn)(?:\s+(?:of\s+)?(\d{4}))?\b|\b(\d{4})\s+(winter|spring|summer|fall|autumn)\b/g)]
    .map((match) => `${match[1] ?? match[4]}:${match[2] ?? match[3] ?? term.year ?? ''}`));
  if (statedWindows.size <= 1) return true; // A single window can use the page's global location.
  // Several tracks need a local statement linking the term to this office/scope.
  // A sentence can itself list several alternatives, so split those boundaries too.
  const segments = text.split(/\n|;|[.!?](?:\s|$)|,\s*(?:and|or)\s+(?=(?:an?\s+)?(?:winter|spring|summer|fall|autumn)\b)/i);
  return segments.some((segment) => seasons(segment).every((season) => own.includes(season))
    && findQuote(segment, term.quote) && (place ? clean(segment).includes(clean(place)) : findQuote(segment, quote)));
}

function readAlternative(text, alternative, policy, firstSeen, jobType) {
  let contradictory = false;
  let advisory = false;
  const { term, inferred } = inferTerm(text, alternative.term, firstSeen, jobType);
  const quotedOffices = alternative.offices ?? [];
  const remoteInput = alternative.remote?.scope === 'unknown' ? null : alternative.remote;
  if (term && (!quoteAgreesWithTerm(term, term.quote, true) || [...quotedOffices.map((office) => office.quote), remoteInput?.quote]
    .some((quote) => !quoteAgreesWithTerm(term, quote)) || !termPlacesAgree(term.quote, quotedOffices))) contradictory = true;
  const offices = [];
  const keys = new Set([...(policy.areas?.keys ?? []), 'outside', 'unknown']);
  for (const office of quotedOffices) {
    if (!findQuote(text, office.quote) || !cityPart(office.place) || !clean(office.quote).includes(cityPart(office.place)) || !keys.has(office.area)) { contradictory = true; continue; }
    let area = office.area;
    const code = /,\s*([A-Z]{2})\b/.exec(office.place)?.[1];
    const state = US_STATE_TERRITORY_CODES.has(code) ? code : null;
    const allowedStates = policy.areas?.allowedStates ?? [];
    if (state && allowedStates.length && !allowedStates.includes(state)) area = 'outside';
    if (state && allowedStates.includes(state) && area === 'outside') contradictory = true;
    if (term && !tiedToTerm(text, term, office.quote, office.place)) advisory = true;
    offices.push({ place: office.place, area, quote: office.quote });
  }
  const remote = remoteEvidence(text, remoteInput)
    ? { scope: remoteInput.scope, quote: remoteInput.quote } : { scope: null, quote: null };
  if (remoteInput?.quote && !remote.quote) contradictory = true;
  if (term && remote.scope && remote.scope !== 'none' && !tiedToTerm(text, term, remote.quote)) advisory = true;
  const termOk = termEvidence(text, term, inferred);
  if (alternative.term?.quote && termOk === false) contradictory = true;
  const windows = termOk ? (policy.windows ?? []).filter((window) => matchesWindow(term, window)) : [];
  const allowed = termOk && !contradictory ? windows.flatMap((window) => {
    const allowedOffices = offices.filter((office) => !['outside', 'unknown'].includes(office.area) && window.areas?.includes(office.area));
    const allowedRemote = window.areas?.includes('us_remote') && (remote.scope === 'us'
      || remote.scope?.startsWith('state:') && policy.areas?.homeStates?.includes(remote.scope.slice(6)));
    return allowedOffices.length || allowedRemote ? [{ term, offices: allowedOffices, remote: allowedRemote ? remote : { scope: 'none', quote: null } }] : [];
  }) : [];
  const knownKind = termOk && matchesTermKind(term, ['winter', 'spring', 'summer', 'fall', 'autumn', 'semester', 'quarter', 'co-op', ...(policy.windows ?? []).flatMap((window) => window.termKinds ?? [])]);
  const datesKnown = termOk && (policy.windows ?? []).every((window) => !matchesTermKind(term, window.termKinds)
    || window.year != null && term.year !== Number(window.year) || !(window.startAfter || window.startBefore) || dateEvidence(clean(term.quote), term.start));
  const validated = Boolean(knownKind && datesKnown && !contradictory && offices.every((office) => office.area !== 'unknown')
    && (offices.length || remote.scope && remote.scope !== 'none'));
  const allowedRemote = (policy.windows ?? []).some((window) => window.areas?.includes('us_remote'))
    && (remote.scope === 'us' || remote.scope?.startsWith('state:') && policy.areas?.homeStates?.includes(remote.scope.slice(6)));
  const outsideArea = !contradictory && offices.length > 0 && offices.every((office) => office.area === 'outside') && !allowedRemote;
  return { term: termOk ? term : null, offices, remote, acceptable: allowed.length > 0, allowed, contradictory, advisory,
    validated, outsideArea, outside: windows.length ? 'outside_area' : 'outside_window', inferred: termOk && !contradictory && inferred };
}

function normalizeDetails(text, judgment, alternatives) {
  const offices = alternatives.flatMap((alternative) => alternative.offices).filter((office, index, all) => all.findIndex((other) => other.place === office.place && other.area === office.area) === index);
  const remote = alternatives.find((alternative) => alternative.remote.scope && alternative.remote.scope !== 'none')?.remote
    ?? alternatives.find((alternative) => alternative.remote.quote)?.remote ?? { scope: null, quote: null };
  const display = [offices.map((office) => office.place).join('; '), remote.scope && remote.scope !== 'none' ? `Remote (${remote.scope})` : ''].filter(Boolean).join('; ');
  const name = validatedQuote(text, judgment.program?.name_quote);
  const countryScope = validatedQuote(text, judgment.program?.country_scope_quote);
  const program = name ? { name, countryScope, quote: [name, countryScope].filter(Boolean).join(' — ') } : null;
  const quotes = Object.fromEntries(['essay', 'documents', 'assessment'].map((key) => [key, validatedQuote(text, judgment.needs?.[`${key}_quote`])]));
  const needs = { ...Object.fromEntries(Object.entries(quotes).map(([key, quote]) => [key, quote !== null])), quotes };
  let deadline = emptyDeadline();
  const given = judgment.deadline;
  const quote = validatedQuote(text, given?.quote);
  if (quote && ['cutoff', 'posting_end', 'rolling'].includes(given.kind)) {
    if (given.kind === 'rolling') deadline = { ...emptyDeadline(), kind: 'rolling', quote };
    else if (dateValid(given.date) && dateEvidence(clean(quote), given.date)?.start === given.date && dateEvidence(clean(quote), given.date)?.end === given.date) {
      const hasTime = quotedClock(quote, given.time, given.tz, given.date);
      deadline = { kind: given.kind, date: given.date, time: hasTime ? given.time : null, tz: hasTime ? given.tz : null, precision: hasTime ? 'datetime' : 'date', quote };
    }
  }
  const allowed = alternatives.flatMap((item) => item.allowed);
  return { program, location: { offices, remote, display, alternatives: allowed }, deadline, needs };
}

function fitFor(judgment, policy, functionValue) {
  let level = FIT_LEVELS.includes(judgment.fit?.level) ? judgment.fit.level : 'medium';
  for (const adjustment of policy.fit?.adjust ?? []) {
    if (adjustment.function !== functionValue) continue;
    if (FIT_LEVELS.includes(adjustment.set)) level = adjustment.set;
    if (Number.isFinite(adjustment.lowerBy) && adjustment.lowerBy > 0) level = FIT_LEVELS[Math.max(0, FIT_LEVELS.indexOf(level) - Math.trunc(adjustment.lowerBy))];
  }
  const notes = [];
  if (judgment.fit?.strengths?.length) notes.push(`Strengths: ${judgment.fit.strengths.join('; ')}`);
  if (judgment.fit?.gaps?.length) notes.push(`Gaps: ${judgment.fit.gaps.join('; ')}`);
  return { level, note: notes.join('. ') };
}

export function decide({ snapshotText, judgment, facts, policy, tier, firstSeen, jobType }) {
  const text = String(snapshotText ?? '');
  const judged = judgment && typeof judgment === 'object' ? judgment : {};
  const alternatives = (judged.alternatives ?? []).map((alternative) => readAlternative(text, alternative, policy, firstSeen, jobType));
  const details = normalizeDetails(text, judged, alternatives);
  const functionValue = validatedQuote(text, judged.function?.quote) ? judged.function.value : null;
  const criteria = (judged.criteria ?? []).filter((criterion) => criterion.key !== 'function')
    .map((criterion) => ({ criterion, validation: validateCriterion(text, criterion, facts) }));
  const evidence = criteria.filter(({ validation }) => validation.valid).map(({ criterion, validation }) => ({
    confirmed: validation.confirmedConflict, section: validation.section, clause: validation.clause.text,
    factIds: [...(criterion.fact_ids ?? [])], quote: criterion.quote,
  }));
  const factsUsed = [...new Set([...facts.filter((fact) => fact.polarity === 'constraint').map((fact) => fact.id), ...criteria.flatMap(({ criterion }) => criterion.fact_ids ?? [])])];
  const base = { code: null, escalate: false, factsUsed, evidence, flags: alternatives.some((item) => item.inferred) ? ['term_inferred'] : [], fit: fitFor(judged, policy, functionValue), ...details };
  const unclear = (code, question) => ({ ...base, decision: 'unclear', code, escalate: tier === 'primary', nextAction: 'user_review', question });
  const rejected = (code, question) => tier === 'primary' ? unclear(code, question) : { ...base, decision: 'not_eligible', code };
  const termOrArea = () => unclear('term_or_area', 'Which stated work window and office or remote scope match your policy?');
  if (tier !== 'primary' && policy.functions?.outOfScope?.includes(functionValue)) return rejected('function_out_of_scope', `Is ${functionValue} work in scope?`);
  const confirmed = criteria.find(({ criterion, validation }) => criterion.status === 'conflicts' && validation.confirmedConflict);
  if (confirmed) return rejected(confirmed.criterion.key, confirmed.validation.clause.text);
  const allOutsideArea = alternatives.length > 0 && alternatives.every((alternative) => alternative.outsideArea);
  if (allOutsideArea || alternatives.length && alternatives.every((alternative) => alternative.validated && !alternative.acceptable)) {
    const code = !allOutsideArea && alternatives.every((alternative) => alternative.outside === 'outside_window') ? 'outside_window' : 'outside_area';
    // Retain the validated model alternatives, including all supporting quotes,
    // even though none can be delivered as an allowed location alternative.
    base.evidence.push(...alternatives.map(({ term, offices, remote }) => ({ confirmed: true, code, term, offices, remote,
      factIds: [], quote: term?.quote ?? offices[0]?.quote ?? remote.quote, quotes: [term?.quote, ...offices.map((office) => office.quote), remote.quote].filter(Boolean) })));
    return rejected(code, 'The quoted alternatives all fall outside your policy.');
  }
  const advisoryCriterion = ({ criterion, validation }) => {
    if (criterion.status !== 'unclear' || !validation.valid) return false;
    // Without cited facts, only a required-section clause can raise a question.
    if (!criterion.fact_ids?.length) return validation.section !== 'required';
    const cited = criterion.fact_ids.map((id) => facts.find((fact) => fact.id === id));
    return cited.every((fact) => fact && (/^(?:availability|.+-availability)$/.test(fact.id) || fact.polarity === 'has'));
  };
  const unresolved = criteria.find((item) => (item.criterion.status === 'conflicts' || item.criterion.status === 'unclear')
    && item.validation.reason !== 'non_mandatory' && !advisoryCriterion(item));
  if (unresolved) {
    const { criterion, validation } = unresolved;
    return { ...unclear(validation.reason === 'missing_fact' || criterion.status === 'unclear' ? 'missing_fact' : 'requirement_unclear', validation.clause?.text ?? criterion.quote ?? 'Please clarify the mandatory requirement.'),
      holdFactIds: [...(criterion.fact_ids ?? [])] };
  }
  if (policy.functions?.outOfScope?.includes(functionValue)) return rejected('function_out_of_scope', `Is ${functionValue} work in scope?`);
  if (policy.functions?.userCall?.includes(functionValue)) return unclear('user_review', `Would you like to consider this ${functionValue} role?`);
  if (!alternatives.some((alternative) => alternative.acceptable)) return termOrArea();
  if (tier === 'primary' && alternatives.some((alternative) => alternative.acceptable && alternative.advisory)) return termOrArea();
  return { ...base, decision: 'eligible' };
}
