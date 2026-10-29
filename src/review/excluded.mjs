import { companyKey } from '../scan/dedupe.mjs';

const patterns = new Map();
const compiled = (value) => {
  if (!patterns.has(value)) patterns.set(value, new RegExp(value, 'i'));
  return patterns.get(value);
};

// The effective company exclusion as scan, classification and delivery apply it.
// policy.userExcludedCompanies is the screening policy's list (a judge dependency);
// policy.overrideExcludedCompanies and policy.overrideExcludedPatterns come from
// profile/company-overrides.json (not a dependency). A re-allowed company is never
// excluded. Returns { source: 'screening' | 'user', match } or null.
const sameCompany = (list, company, aliases) => (list ?? []).some((name) => companyKey(name, aliases) === companyKey(company, aliases));

export function companyExcluded(company, policy = {}) {
  if (!company || !String(company).trim()) return null;
  const aliases = policy.companyAliases;
  if (sameCompany(policy.reallowedCompanies, company, aliases)) return null;
  const listed = (list) => (list ?? []).find((name) => companyKey(name, aliases) === companyKey(company, aliases));
  const user = listed(policy.overrideExcludedCompanies);
  if (user) return { source: 'user', match: user };
  const pattern = (policy.overrideExcludedPatterns ?? []).find((value) => compiled(value).test(String(company).trim()));
  if (pattern) return { source: 'user', match: pattern };
  const screening = listed(policy.userExcludedCompanies);
  return screening ? { source: 'screening', match: screening } : null;
}

export const USER_EXCLUDED_REASON = 'company_excluded (user)';
