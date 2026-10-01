import { normalizeText } from './text.mjs';

// Duplicate detection for scanned roles. A role is the same as an earlier one
// when it shares a source id, an ATS requisition id in its URL, the same
// link, or (for the same company key) a near-identical title. Earlier records
// include every stored application, whatever its status, so a role that was
// applied to or skipped is never queued again.

export const DUPLICATE_THRESHOLD = 0.9;
export const POSSIBLE_DUPLICATE_THRESHOLD = 0.6;

const LEGAL_SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'bv', 'pbc']);
const TITLE_STOPWORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'at', 'with', 'or', 'on']);
const TITLE_STEMS = new Map([['internship', 'intern'], ['internships', 'intern'], ['engineering', 'engineer'], ['scientist', 'science']]);

export function companyKey(name, aliases = {}) {
  const words = normalizeText(name).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1))) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  const key = words.join('');
  const aliasTable = Object.fromEntries(Object.entries(aliases ?? {}).map(([alias, canonical]) => [companyKey(alias), companyKey(canonical)]));
  return aliasTable[key] ?? key;
}

export function titleTokens(title) {
  const tokens = normalizeText(title).replace(/co-op/g, 'coop').replace(/[^a-z0-9+#]+/g, ' ').trim().split(' ').filter(Boolean);
  const result = new Set();
  for (const raw of tokens) {
    if (TITLE_STOPWORDS.has(raw)) continue;
    let token = TITLE_STEMS.get(raw) ?? raw;
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !/\d/.test(token)) token = token.slice(0, -1);
    result.add(TITLE_STEMS.get(token) ?? token);
  }
  return result;
}

export function titleSimilarity(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// Words that describe the programme rather than the role, so two titles for the same role written by
// different boards ("Campus Graduate Summer Internship Program - 2027 Global Decision Science" and
// "Data Science Intern - Global Decision Science") still share their distinctive words.
const GENERIC_TITLE_TOKENS = new Set(['intern', 'coop', 'summer', 'fall', 'winter', 'spring', 'program', 'programme', 'campus',
  'graduate', 'grad', 'master', 'masters', 'm', 'ms', 'phd', 'undergraduate', 'student', 'early', 'career', 'new', 'york', 'ny',
  'nyc', 'city', 'remote', 'us', 'usa', 'united', 'state', 'ii', 'iii', 'i', 'associate', 'analyst', 'engineer', 'level']);

function distinctiveTokens(title) {
  return new Set([...titleTokens(title)].filter((token) => !GENERIC_TITLE_TOKENS.has(token) && !/^(19|20)\d\d$/.test(token)));
}

// Share of the shorter title's distinctive words found in the other title; 0 when either has fewer than 3.
export function titleContainment(left, right) {
  const a = distinctiveTokens(left);
  const b = distinctiveTokens(right);
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size < 3) return 0;
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / small.size;
}

export const CONTAINMENT_THRESHOLD = 0.8;
const SUBMITTED_STATUSES = new Set(['applied', 'assessment', 'interview', 'offer', 'accepted', 'declined', 'rejected']);

function parseUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch { return null; }
}

// Extracts an ATS requisition or posting id from a job URL.
export function requisitionKey(value) {
  const url = parseUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const param = (name) => {
    for (const [key, item] of url.searchParams) if (key.toLowerCase() === name && item.trim()) return item.trim();
    return null;
  };
  const ghJid = param('gh_jid');
  if (ghJid && /^\d+$/.test(ghJid)) return `greenhouse:${ghJid}`;
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    // Embedded application forms carry the posting id as ?token=<id>.
    const token = param('token');
    if (token && /^\d+$/.test(token)) return `greenhouse:${token}`;
    const index = segments.indexOf('jobs');
    if (index >= 0 && /^\d+$/.test(segments[index + 1] ?? '')) return `greenhouse:${segments[index + 1]}`;
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (/(^|\.)lever\.co$/.test(host)) {
    const id = segments.find((segment) => uuid.test(segment));
    if (id) return `lever:${id.toLowerCase()}`;
  }
  if (/(^|\.)ashbyhq\.com$/.test(host)) {
    const id = segments.find((segment) => uuid.test(segment));
    if (id) return `ashby:${id.toLowerCase()}`;
  }
  if (/\.myworkdayjobs\.com$/.test(host) || /(^|\.)myworkdaysite\.com$/.test(host)) {
    const last = segments.at(-1) ?? '';
    const match = /_((?:jr|r|req)?-?\d{3,}(?:-\d+)?)$/i.exec(last);
    if (match) return `workday:${host.split('.')[0]}:${match[1].toLowerCase()}`;
  }
  if (/\.oraclecloud\.com$/.test(host)) {
    // Oracle HCM Candidate Experience: .../CandidateExperience/<lang>/sites/<site>/job/<id>
    const index = segments.indexOf('job');
    if (index >= 0 && /^\d+$/.test(segments[index + 1] ?? '')) return `oracle:${host.split('.')[0]}:${segments[index + 1]}`;
  }
  if (/\.icims\.com$/.test(host)) {
    const index = segments.indexOf('jobs');
    if (index >= 0 && /^\d+$/.test(segments[index + 1] ?? '')) return `icims:${host}:${segments[index + 1]}`;
  }
  if (/(^|\.)smartrecruiters\.com$/.test(host)) {
    const id = segments.find((segment) => /^\d{6,}/.test(segment));
    if (id) return `smartrecruiters:${/^\d+/.exec(id)[0]}`;
  }
  for (const name of ['jobid', 'job_id', 'reqid', 'req_id', 'requisitionid', 'requisition_id', 'jid']) {
    const id = param(name);
    if (id && /^[A-Za-z0-9_-]{3,64}$/.test(id)) return `${host.replace(/^www\./, '')}:${name}:${id.toLowerCase()}`;
  }
  return null;
}

export function canonicalUrl(value) {
  const url = parseUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const kept = [...url.searchParams].filter(([key]) => !/^(utm_|ref$|source$|src$|gh_src$|lever-source|lever-origin)/i.test(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';
  return `${host}${url.pathname.replace(/\/+$/, '')}${query}`.toLowerCase();
}

function identityKeys(record, aliases) {
  const keys = [];
  if (record.source && record.sourceId) keys.push(['source id', `source:${record.source}:${record.sourceId}`]);
  const requisition = requisitionKey(record.url);
  if (requisition) keys.push(['requisition id in the link', `req:${requisition}`]);
  const link = canonicalUrl(record.url);
  if (link) keys.push(['link', `url:${link}`]);
  const company = companyKey(record.company, aliases);
  // The posting id inside a link also identifies the role within its company, so a link from one board
  // (or a careers-site wrapper around it) matches a record that stored only the bare requisition id.
  const linkId = requisition ? requisition.split(':').at(-1) : null;
  for (const id of [record.requisitionId, record.externalId, linkId].filter(Boolean)) {
    keys.push(['company requisition id', `reqid:${company}:${normalizeText(id).replace(/[^a-z0-9]+/g, '')}`]);
  }
  return keys;
}

function describe(reference) {
  return reference.kind === 'existing'
    ? `${reference.id} (${reference.status})`
    : `"${reference.title}" at ${reference.company} in this scan`;
}

// existing: stored applications as { id, company, role, jobUrl, source, sourceId, externalId, status }.
// Returns one result per incoming role, in order:
//   { role, status: 'new' | 'possible-duplicate' | 'duplicate', of?, similarity?, reason? }
export function dedupeRoles(roles, existing = [], { aliases = {} } = {}) {
  const byKey = new Map();
  const byCompany = new Map();
  const register = (record, reference) => {
    for (const [, key] of identityKeys(record, aliases)) if (!byKey.has(key)) byKey.set(key, reference);
    const company = companyKey(record.company, aliases);
    if (!byCompany.has(company)) byCompany.set(company, []);
    byCompany.get(company).push({ title: record.title, reference });
  };
  for (const item of existing) {
    let { source, sourceId } = item;
    // Records written before schema 5 kept a source-prefixed id such as "simplify:<id>" in external_id.
    const prefixed = /^([a-z][a-z0-9-]*):(.+)$/.exec(item.externalId ?? '');
    if (!source && prefixed) [, source, sourceId] = prefixed;
    const externalId = item.externalId && !prefixed ? item.externalId : null;
    register(
      { source, sourceId, url: item.jobUrl, company: item.company, title: item.role, externalId },
      { kind: 'existing', id: item.id, status: item.status, title: item.role, company: item.company },
    );
  }
  const results = [];
  for (const role of roles) {
    const keys = identityKeys(role, aliases);
    const hit = keys.find(([, key]) => byKey.has(key));
    if (hit) {
      const reference = byKey.get(hit[1]);
      results.push({ role, status: 'duplicate', of: reference, reason: `duplicate: same ${hit[0]} as ${describe(reference)}` });
      continue;
    }
    let best = null;
    for (const candidate of byCompany.get(companyKey(role.company, aliases)) ?? []) {
      const similarity = titleSimilarity(role.title, candidate.title);
      const containment = titleContainment(role.title, candidate.title);
      const score = Math.max(similarity, containment >= CONTAINMENT_THRESHOLD ? POSSIBLE_DUPLICATE_THRESHOLD : 0);
      if (!best || score > best.score) best = { score, similarity, containment, reference: candidate.reference };
    }
    const similarity = best ? Math.round(best.similarity * 100) / 100 : 0;
    if (best && best.similarity >= DUPLICATE_THRESHOLD) {
      results.push({ role, status: 'duplicate', of: best.reference, similarity, reason: `duplicate: same company and title (similarity ${similarity}) as ${describe(best.reference)}` });
      continue;
    }
    const reference = { kind: 'scan', title: role.title, company: role.company };
    const possible = best && best.score >= POSSIBLE_DUPLICATE_THRESHOLD;
    // Never queue what may be a role the user already submitted: a likely match to a submitted
    // application is held back as a duplicate, with the reason, instead of being queued with a note.
    if (possible && best.reference.kind === 'existing' && SUBMITTED_STATUSES.has(best.reference.status)) {
      results.push({ role, status: 'duplicate', of: best.reference, similarity, reason: `duplicate: likely the same role as the submitted application ${describe(best.reference)} (title similarity ${similarity}, shared distinctive words ${Math.round(best.containment * 100)}%)` });
      continue;
    }
    if (possible) {
      results.push({ role, status: 'possible-duplicate', of: best.reference, similarity, reason: `possible-duplicate: similar title (similarity ${similarity}) to ${describe(best.reference)}` });
    } else {
      results.push({ role, status: 'new' });
    }
    register(role, reference);
  }
  return results;
}
