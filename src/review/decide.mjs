import { findQuote, normalizeQuote, validateCriterion } from './clauses.mjs';

export const DECIDE_VERSION = 'clause-decisions-1';
const FIT_LEVELS = ['low', 'medium', 'high'];
const emptyDeadline = () => ({ kind: 'none', date: null, time: null, tz: null, precision: null, quote: null });
const clean = (value) => normalizeQuote(value ?? '').toLowerCase();

function validatedQuote(text, value) { return findQuote(text, value) ? value : null; }

function dateValid(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function dateEvidence(quote, value) {
  if (!dateValid(value)) return null;
  const exact = [...quote.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((match) => match[0]);
  if (exact.length) return exact[0] === value ? { start: value, end: value } : null;
  const year = value.slice(0, 4);
  const month = Number(value.slice(5, 7));
  const reference = new Date(`${value}T12:00:00Z`);
  const names = ['long', 'short'].map((style) => new Intl.DateTimeFormat('en', { month: style, timeZone: 'UTC' }).format(reference).replace(/\.$/, '').toLowerCase());
  for (const name of names) {
    const forward = new RegExp(`\\b${name}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*${year}\\b`, 'i').exec(quote);
    const reverse = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${name}\\.?\\s*,?\\s*${year}\\b`, 'i').exec(quote);
    const day = forward?.[1] ?? reverse?.[1];
    if (day) {
      const actual = `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
      return actual === value ? { start: actual, end: actual } : null;
    }
  }
  if (!names.some((name) => new RegExp(`\\b${name}\\.?\\s+(?:of\\s+)?${year}\\b`, 'i').test(quote))) return null;
  // Month-only wording proves an interval, never the model's invented start day.
  return { start: `${year}-${String(month).padStart(2, '0')}-01`, end: new Date(Date.UTC(Number(year), month, 0)).toISOString().slice(0, 10) };
}

function termEvidence(text, term) {
  if (!term || !findQuote(text, term.quote)) return false;
  const quote = clean(term.quote);
  if (!term.label || ![term.label, term.kind].filter(Boolean).every((label) => quote.includes(clean(label)))) return false;
  if (term.year !== undefined && term.year !== null && (!Number.isInteger(term.year) || !new RegExp(`\\b${term.year}\\b`).test(quote))) return false;
  if (term.start && !dateValid(term.start)) return false;
  if (term.start && !dateEvidence(quote, term.start)) return false;
  return true;
}

function matchesWindow(term, window) {
  const labels = [term.kind, term.label].filter(Boolean).map(clean);
  if (!window.termKinds?.some((kind) => labels.some((label) => label === clean(kind) || label.split(/\s+/).includes(clean(kind))))) return false;
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
  if (!remote || !/^(?:us|state:[A-Z]{2}|none|non_us)$/.test(remote.scope) || !findQuote(text, remote.quote)) return false;
  if (!['us', 'non_us'].includes(remote.scope) && !remote.scope.startsWith('state:')) return true;
  const quote = clean(remote.quote);
  if (!/\bremote(?:ly)?\b|\bwork from home\b|\btelecommut/i.test(quote)) return false;
  if (/\bon[- ]site\s+only\b|\b(?:no|not|without)\s+(?:\w+\s+){0,3}remote\b|\bremote(?:\s+\w+){0,3}\s+(?:not|unavailable|prohibited)\b/.test(quote)) return false;
  if (remote.scope === 'us') {
    if (/\b(?:outside|excluding|except|not(?:\s+in)?)\s+(?:the\s+)?(?:united states|u\.?s\.?(?:a\.?)?)\b/.test(quote)) return false;
    return /\bunited states\b|\bu\.?s\.?(?:a\.?)?(?=\W|$)/.test(quote);
  }
  if (remote.scope.startsWith('state:')) return new RegExp(`\\b${remote.scope.slice(6)}\\b`).test(remote.quote);
  return true;
}

function readAlternative(text, alternative, policy) {
  let contradictory = false;
  const offices = [];
  const keys = new Set([...(policy.areas?.keys ?? []), 'outside', 'unknown']);
  for (const office of alternative.offices ?? []) {
    if (!findQuote(text, office.quote) || !office.place || !clean(office.quote).includes(clean(office.place)) || !keys.has(office.area)) { contradictory = true; continue; }
    let area = office.area;
    const state = /,\s*([A-Z]{2})\b/.exec(office.place)?.[1];
    const allowedStates = policy.areas?.allowedStates ?? [];
    if (state && allowedStates.length && !allowedStates.includes(state)) area = 'outside';
    if (state && allowedStates.includes(state) && area === 'outside') contradictory = true;
    offices.push({ place: office.place, area, quote: office.quote });
  }
  const remoteInput = alternative.remote;
  const remote = remoteEvidence(text, remoteInput)
    ? { scope: remoteInput.scope, quote: remoteInput.quote } : { scope: null, quote: null };
  if (remoteInput?.quote && !remote.quote) contradictory = true;
  const termOk = termEvidence(text, alternative.term);
  if (alternative.term?.quote && !termOk) contradictory = true;
  const acceptable = termOk && (policy.windows ?? []).some((window) => {
    if (!matchesWindow(alternative.term, window)) return false;
    if (offices.some((office) => !['outside', 'unknown'].includes(office.area) && window.areas?.includes(office.area))) return true;
    if (!window.areas?.includes('us_remote')) return false;
    return remote.scope === 'us' || (remote.scope?.startsWith('state:') && policy.areas?.homeStates?.includes(remote.scope.slice(6)));
  });
  return { offices, remote, acceptable, contradictory };
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
      const hasTime = typeof given.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(given.time) && typeof given.tz === 'string' && given.tz.length > 0;
      deadline = { kind: given.kind, date: given.date, time: hasTime ? given.time : null, tz: hasTime ? given.tz : null, precision: hasTime ? 'datetime' : 'date', quote };
    }
  }
  return { program, location: { offices, remote, display }, deadline, needs };
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

export function decide({ snapshotText, judgment, facts, policy, tier }) {
  const text = String(snapshotText ?? '');
  const judged = judgment && typeof judgment === 'object' ? judgment : {};
  const alternatives = (judged.alternatives ?? []).map((alternative) => readAlternative(text, alternative, policy));
  const details = normalizeDetails(text, judged, alternatives);
  const functionValue = validatedQuote(text, judged.function?.quote) ? judged.function.value : null;
  const criteria = (judged.criteria ?? []).map((criterion) => ({ criterion, validation: validateCriterion(text, criterion, facts) }));
  const evidence = criteria.filter(({ validation }) => validation.valid).map(({ criterion, validation }) => ({
    confirmed: validation.confirmedConflict, section: validation.section, clause: validation.clause.text,
    factIds: [...(criterion.fact_ids ?? [])], quote: criterion.quote,
  }));
  const factsUsed = [...new Set([...facts.filter((fact) => fact.polarity === 'constraint').map((fact) => fact.id), ...criteria.flatMap(({ criterion }) => criterion.fact_ids ?? [])])];
  const base = { code: null, escalate: false, factsUsed, evidence, fit: fitFor(judged, policy, functionValue), ...details };
  const unclear = (code, question) => ({ ...base, decision: 'unclear', code, escalate: tier === 'primary', nextAction: 'user_review', question });
  const rejected = (code, question) => tier === 'primary' ? unclear(code, question) : { ...base, decision: 'not_eligible', code };
  const conflicts = criteria.filter(({ criterion }) => criterion.status === 'conflicts');
  const confirmed = conflicts.find(({ validation }) => validation.confirmedConflict);
  if (confirmed) return rejected(confirmed.criterion.key, confirmed.validation.clause.text);
  if (policy.functions?.outOfScope?.includes(functionValue)) return rejected('function_out_of_scope', `Is ${functionValue} work in scope?`);
  if (policy.functions?.userCall?.includes(functionValue)) return unclear('user_review', `Would you like to consider this ${functionValue} role?`);
  const unresolved = criteria.find(({ criterion, validation }) => (criterion.status === 'conflicts' || criterion.status === 'unclear') && validation.reason !== 'non_mandatory' && (!validation.valid || ['required', 'eligibility'].includes(validation.section)));
  if (unresolved) {
    const { criterion, validation } = unresolved;
    return unclear(validation.reason === 'missing_fact' || criterion.status === 'unclear' ? 'missing_fact' : 'requirement_unclear', validation.clause?.text ?? criterion.quote ?? 'Please clarify the mandatory requirement.');
  }
  if (!alternatives.some((alternative) => alternative.acceptable) || alternatives.some((alternative) => alternative.contradictory)) return unclear('term_or_area', 'Which stated work window and office or remote scope match your policy?');
  return { ...base, decision: 'eligible' };
}
