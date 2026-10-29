import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { companyKey } from '../scan/dedupe.mjs';
import { countryOf } from '../funnel/classify.mjs';
import { decide } from './decide.mjs';

// User overrides kept outside the judge dependencies. The screening policy, review
// policy and rule files are hashed into every judgment; editing them re-queues
// settled reviews for a paid re-judgment. These files are read at decision and
// delivery time only and never enter a dependency hash:
//   profile/location-exempt-brands.json { rule, brands[], windows? }
//     For a listed brand any US location is acceptable. windows (policy window ids)
//     defaults to the windows that already accept every in-person area; a window
//     limited to some areas (a home-only school-term co-op) stays as it is.
//   profile/company-overrides.json { rule, reallowedCompanies[], activeCaps[{ company, max }], liftedSkipReasons[] }
//     reallowedCompanies lifts a userExcludedCompanies entry; activeCaps limits the
//     applications in progress per company; liftedSkipReasons are skip-reason
//     prefixes of a company rule the user has lifted, so a re-allowed company's
//     lead withdrawn by that rule may be restored by an eligible review.
export const EXEMPT_FILE = 'location-exempt-brands.json';
export const COMPANY_FILE = 'company-overrides.json';
export const emptyOverrides = () => ({ locationExempt: { brands: [], windows: null }, reallowedCompanies: [], activeCaps: [], liftedSkipReasons: [] });

const US_CODES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC AS GU MP PR VI UM'.split(' '));
const EXEMPT_AREA = 'exempt_us';

async function readOptional(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot load ${path.basename(file)}: ${error.message}`, { cause: error });
  }
  try { return JSON.parse(text); } catch (error) { throw new Error(`Cannot load ${path.basename(file)}: ${error.message}`, { cause: error }); }
}

function names(value, field, file) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) throw new Error(`Cannot load ${file}: ${field} must be a list of non-empty strings`);
  return value.map((item) => item.trim());
}

export async function loadUserOverrides(profileDir) {
  const result = emptyOverrides();
  const exempt = await readOptional(path.join(profileDir, EXEMPT_FILE));
  if (exempt !== null) {
    if (typeof exempt !== 'object' || Array.isArray(exempt)) throw new Error(`Cannot load ${EXEMPT_FILE}: expected an object`);
    result.locationExempt = { brands: names(exempt.brands, 'brands', EXEMPT_FILE), windows: exempt.windows == null ? null : names(exempt.windows, 'windows', EXEMPT_FILE) };
  }
  const company = await readOptional(path.join(profileDir, COMPANY_FILE));
  if (company !== null) {
    if (typeof company !== 'object' || Array.isArray(company)) throw new Error(`Cannot load ${COMPANY_FILE}: expected an object`);
    result.reallowedCompanies = names(company.reallowedCompanies, 'reallowedCompanies', COMPANY_FILE);
    result.liftedSkipReasons = names(company.liftedSkipReasons, 'liftedSkipReasons', COMPANY_FILE);
    const caps = company.activeCaps ?? [];
    if (!Array.isArray(caps) || !caps.every((cap) => typeof cap?.company === 'string' && cap.company.trim() && Number.isInteger(cap.max) && cap.max > 0)) {
      throw new Error(`Cannot load ${COMPANY_FILE}: activeCaps must be a list of { company, max } with a positive integer max`);
    }
    result.activeCaps = caps.map((cap) => ({ company: cap.company.trim(), max: cap.max }));
  }
  return result;
}

const sameCompany = (list, company, aliases) => (list ?? []).some((name) => companyKey(name, aliases) === companyKey(company, aliases));
export const reallowed = (company, policy = {}) => sameCompany(policy.reallowedCompanies, company, policy.companyAliases);

// The screening policy as delivery and scanning apply it. The input object is not modified.
export function withOverrides(screeningPolicy = {}, overrides) {
  const o = overrides ?? emptyOverrides();
  const aliases = screeningPolicy.companyAliases;
  return { ...screeningPolicy,
    userExcludedCompanies: (screeningPolicy.userExcludedCompanies ?? []).filter((company) => !sameCompany(o.reallowedCompanies, company, aliases)),
    reallowedCompanies: o.reallowedCompanies ?? [], activeCaps: o.activeCaps ?? [], liftedSkipReasons: o.liftedSkipReasons ?? [] };
}

export function locationExempt(company, overrides, aliases = {}) {
  return Boolean(company) && sameCompany(overrides?.locationExempt?.brands, company, aliases);
}

// A place is in the US when it names a US state or the US, or ends in a US state
// code ("Atlanta, GA"); any other country, or no state or country, is not.
export function usPlace(place) {
  const value = String(place ?? '');
  const country = countryOf(value);
  if (country) return country === 'US';
  const code = /,\s*([A-Z]{2})\b/.exec(value)?.[1];
  return Boolean(code && US_CODES.has(code));
}

function exemptWindow(window, policy, overrides) {
  const listed = overrides?.locationExempt?.windows;
  if (listed) return listed.includes(window.id);
  const inPerson = (policy.areas?.keys ?? []).filter((key) => key !== 'us_remote');
  return inPerson.length > 0 && inPerson.every((key) => window.areas?.includes(key));
}

// Jev split: a rejection on place alone (no other dimension below its reject threshold).
export function jevPlaceOnly(probabilities, thresholds) {
  const reject = thresholds?.reject ?? {};
  return Number.isFinite(probabilities?.place) && probabilities.place < reject.place
    && Object.entries(reject).every(([dimension, value]) => dimension === 'place' || probabilities[dimension] >= value);
}

// Replays the deterministic decision with an exempt brand's US offices counted as
// in area. The replay stands only when it is eligible, or at the primary tier when
// it escalates to the escalation tier. Anything else (a non-US office, a window
// outside the exemption, any other failed rule or open question) keeps the
// original outside_area rejection, so the exemption never raises a user question.
export function exemptVerdict({ verdict, company, overrides, aliases, snapshotText, judgment, facts, policy, tier, firstSeen, jobType }) {
  if (verdict?.code !== 'outside_area' || !(verdict.decision === 'not_eligible' || verdict.primaryRejection)) return verdict;
  if (!locationExempt(company, overrides, aliases) || !judgment || typeof judgment !== 'object') return verdict;
  const windows = (policy.windows ?? []).filter((window) => exemptWindow(window, policy, overrides));
  if (!windows.length) return verdict;
  const allowedStates = policy.areas?.allowedStates ?? [];
  const exemptPolicy = { ...policy,
    areas: { ...policy.areas, keys: [...(policy.areas?.keys ?? []), EXEMPT_AREA], allowedStates: allowedStates.length ? [...new Set([...allowedStates, ...US_CODES])] : allowedStates },
    windows: (policy.windows ?? []).map((window) => windows.includes(window) ? { ...window, areas: [...(window.areas ?? []), EXEMPT_AREA] } : window) };
  const relabel = (office) => {
    if (!office || !usPlace(office.place)) return office;
    const code = /,\s*([A-Z]{2})\b/.exec(office.place ?? '')?.[1];
    const outside = office.area === 'outside' || office.area === 'unknown' || (US_CODES.has(code) && allowedStates.length > 0 && !allowedStates.includes(code));
    return outside ? { ...office, area: EXEMPT_AREA } : office;
  };
  const exemptJudgment = { ...judgment, alternatives: (judgment.alternatives ?? []).map((alternative) => ({ ...alternative, offices: (alternative.offices ?? []).map(relabel) })) };
  const replay = decide({ snapshotText, judgment: exemptJudgment, facts, policy: exemptPolicy, tier, firstSeen, jobType });
  if (replay.decision !== 'eligible' && !(tier === 'primary' && replay.escalate)) return verdict;
  return { ...replay, flags: [...new Set([...(replay.flags ?? []), 'location_exempt'])] };
}
