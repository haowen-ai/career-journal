import { randomUUID } from 'node:crypto';
import { companyKey, titleSimilarity, titleContainment } from '../scan/dedupe.mjs';
import { SUBMITTED_STATUSES } from './contract.mjs';

const parseUrl = (value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
};

export function canonicalUrl(value) {
  const url = parseUrl(value);
  if (!url) return null;
  const query = new URLSearchParams([...url.searchParams].filter(([key]) => !/^(?:utm_.*|gh_src|ref|source|src|lever-source|lever-origin|iis|iisn|icims|trk)$/i.test(key)));
  query.sort();
  return `${url.host.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${query.size ? `?${query}` : ''}${url.hash.startsWith('#/') ? url.hash : ''}`;
}

export function providerRequisition(value) {
  const url = parseUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
  const param = (name) => [...url.searchParams].find(([key, val]) => key.toLowerCase() === name && val.trim())?.[1];
  const result = (provider, tenant, id) => id ? { provider, tenant, id } : null;
  const uuid = parts.find((part) => /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(part));
  const after = (segment) => parts[parts.indexOf(segment) + 1];
  const numeric = (id) => /^\d+$/.test(id ?? '') ? id : null;
  if (/(^|\.)greenhouse\.io$/.test(host) || numeric(param('gh_jid'))) {
    const tenant = param('for') ?? (parts[0] === 'v1' ? parts[parts.indexOf('boards') + 1] : parts[0]);
    return result('greenhouse', tenant === 'embed' ? '-' : tenant ?? '-', numeric(param('gh_jid')) ?? numeric(after('jobs')) ?? numeric(param('token')));
  }
  if (/(^|\.)lever\.co$/.test(host)) return result('lever', parts[0] ?? '-', uuid?.toLowerCase());
  if (/(^|\.)ashbyhq\.com$/.test(host)) return result('ashby', parts[0] ?? '-', uuid?.toLowerCase());
  if (/(^|\.)(?:myworkdayjobs|myworkdaysite)\.com$/.test(host)) {
    const id = /_((?:[A-Za-z]{1,4}\d{2}_|[A-Za-z]{0,4}[-_]?)\d{3,}(?:-\d+)?)$/i.exec(parts.at(-1) ?? '')?.[1];
    const tenant = host === 'myworkdaysite.com' ? parts[parts.indexOf('recruiting') + 1] : host.split('.')[0];
    return result('workday', tenant ?? '-', id?.toUpperCase());
  }
  if (/\.oraclecloud\.com$/.test(host)) return result('oracle', host.split('.')[0], numeric(after('job')));
  if (/\.icims\.com$/.test(host)) return result('icims', host, numeric(after('jobs')));
  if (/(^|\.)smartrecruiters\.com$/.test(host)) return result('smartrecruiters', parts[0] ?? '-', /^\d+/.exec(parts.find((p) => /^\d{6,}/.test(p)) ?? '')?.[0]);
  if (/(^|\.)(?:successfactors\.(?:com|eu)|successfactors\.com\.cn)$/.test(host) || param('ats') === 'successfactors') {
    return result('successfactors', host, [...parts].reverse().find((part) => /^\d+$/.test(part)));
  }
  for (const key of ['jobid', 'job_id', 'reqid', 'requisitionid', 'jid']) {
    const id = param(key);
    if (id) return result('generic', host, id);
  }
  return null;
}

const shaped = (id) => /^[A-Za-z]{0,4}[-_]?\d{3,}(?:-\d+)?$/.test(id) ? id.toUpperCase() : id;
export function aliasesFor(record, { companyAliases } = {}) {
  const aliases = [];
  const add = (kind, alias) => { if (!aliases.some((item) => item.alias === alias)) aliases.push({ alias, kind }); };
  const req = providerRequisition(record.url);
  if (record.source && record.sourceId != null && record.sourceId !== '') {
    // CareerOps combines providers whose local ids are only unique within a tenant.
    const namespace = record.source === 'careerops' && !parseUrl(record.sourceId)
      ? `${req ? `${req.provider}:${req.tenant}` : record.partition && record.partition !== 'all' ? record.partition : `${parseUrl(record.url)?.host ?? 'unknown'}:${companyKey(record.company, companyAliases)}`}:` : '';
    add('source', `source:${record.source}:${namespace}${record.sourceId}`);
  }
  if (req) add('req', `req:${req.provider}:${req.tenant || '-'}:${req.id}`);
  const company = companyKey(record.company ?? '', companyAliases);
  const ids = [req?.id, record.requisitionId, record.externalId].filter((id) => id != null && id !== '' && !String(id).startsWith('posting:'));
  for (const id of ids) {
    const normalized = req?.provider === 'generic' && id === req.id ? id : shaped(String(id));
    add('company_req', `company_req:${company}:${normalized}`);
    // Workday adds a posting suffix to the jobReqId in list URLs. Keep the URL id too.
    const suffix = /^(.*)-\d{1,2}$/.exec(normalized);
    if (req?.provider === 'workday' && id === req.id && suffix && (suffix[1].match(/\d/g)?.length ?? 0) >= 3) {
      add('company_req', `company_req:${company}:${suffix[1]}`);
    }
  }
  const url = canonicalUrl(record.url);
  const parsed = parseUrl(record.url);
  const landing = parsed && !req && !parsed.hash.startsWith('#/')
    && /^(?:\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:careers|jobs))?\/*$/i.test(parsed.pathname);
  if (url && !landing) add('url', `url:${url}`);
  return aliases;
}

function effective(db, id) {
  const seen = new Set();
  while (id) {
    if (seen.has(id)) throw new Error('Posting merge cycle');
    seen.add(id);
    const row = db.prepare('SELECT * FROM postings WHERE id = ?').get(id);
    if (!row || !row.merged_into) return row;
    id = row.merged_into;
  }
  return null;
}
const owned = (db, alias) => {
  const hit = db.prepare('SELECT posting_id FROM posting_aliases WHERE alias = ?').get(alias);
  return hit ? effective(db, hit.posting_id) : null;
};
function newPosting(db, record, now) {
  const id = randomUUID();
  db.prepare(`INSERT INTO postings (id, company, title, canonical_url, first_seen, last_seen, listed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, record.company ?? '', record.title ?? '', canonicalUrl(record.url), now, now, record.listed === false ? 0 : 1, now, now);
  return id;
}
function link(db, left, right, kind, reason, now) {
  if (left === right && kind !== 'conflict') return false;
  const existing = db.prepare('SELECT 1 FROM posting_links WHERE left_id=? AND right_id=? AND kind=?');
  if (existing.get(left, right, kind) || existing.get(right, left, kind)) return false;
  return Boolean(db.prepare('INSERT OR IGNORE INTO posting_links (left_id,right_id,kind,reason,created_at) VALUES (?,?,?,?,?)').run(left, right, kind, reason, now).changes);
}
function reusedApplication(db, posting) {
  const app = posting?.application_id ? db.prepare('SELECT * FROM applications WHERE id = ?').get(posting.application_id) : null;
  if (!app) return null;
  if (SUBMITTED_STATUSES.includes(app.status) || app.applied_at) return 'already_submitted';
  if (app.status === 'withdrawn' && app.skip_owner === 'user') return 'user_declined';
  return null;
}
function markReview(db, id, { now, state, decision = null, code = null, holdOwner = null }) {
  db.prepare(`INSERT INTO reviews (posting_id,stage,state,decision,code,hold_owner,hold_since,next_due,first_seen,updated_at)
    VALUES (?,'fetch',?,?,?,?,?,?,?,?) ON CONFLICT(posting_id) DO UPDATE SET state=excluded.state,decision=excluded.decision,
    code=excluded.code,hold_owner=excluded.hold_owner,hold_since=excluded.hold_since,next_due=excluded.next_due,
    lease_owner=NULL,lease_until=NULL,lease_generation=reviews.lease_generation+1,updated_at=excluded.updated_at`)
    .run(id, state, decision, code, holdOwner, holdOwner ? now : null, state === 'due' ? now : null, now, now);
}
const quietLanes = new Set(['no_student_signal', 'out_of_direction']);
function matters(posting, classification = {}) {
  return (classification.listed ?? Boolean(posting.listed)) && classification.kind !== 'drop' && classification.decision !== 'dropped' && !quietLanes.has(classification.lane);
}
function conflict(db, from, to, now, classification) {
  link(db, from, to, 'conflict', 'contradictory authoritative aliases', now);
  const posting = effective(db, from);
  const review = db.prepare('SELECT state,lane,decision FROM reviews WHERE posting_id=?').get(from);
  const current = classification ?? review;
  if (matters(posting, current)) markReview(db, from, { now, state: 'held', decision: 'unclear', code: 'identity_conflict', holdOwner: 'user' });
  else if (review?.state === 'leased') markReview(db, from, { now, state: 'done', decision: 'unclear', code: 'identity_conflict' });
  return { action: 'quarantined', postingId: from };
}

function authority(db, postingId) {
  return db.prepare(`WITH RECURSIVE members(id) AS (SELECT ? UNION SELECT p.id FROM postings p JOIN members m ON p.merged_into=m.id)
    SELECT alias,kind FROM posting_aliases WHERE posting_id IN (SELECT id FROM members) AND kind IN ('req','company_req')`).all(postingId);
}
function contradicts(left, right) {
  const authoritative = (items) => items.filter((item) => ['req', 'company_req'].includes(item.kind));
  left = authoritative(left); right = authoritative(right);
  if (!left.length || !right.length) return false;
  const rightAliases = new Set(right.map((item) => item.alias));
  if (!left.some((item) => rightAliases.has(item.alias))) return true;
  // A shared company requisition must not mask different ids in the same ATS tenant.
  const scopes = (items) => {
    const groups = new Map();
    for (const { alias } of items) {
      const scope = alias.slice(0, alias.lastIndexOf(':'));
      if (!groups.has(scope)) groups.set(scope, new Set());
      groups.get(scope).add(alias);
    }
    return groups;
  };
  const other = scopes(right);
  return [...scopes(left)].some(([scope, ids]) => other.has(scope) && ![...ids].some((id) => other.get(scope).has(id)));
}

// Distinct ATS postings may share a company requisition. This is different from
// adding contradictory authoritative ids to one already-established posting.
function differentAtsIds(left, right) {
  const scopes = (items) => {
    const result = new Map();
    for (const { alias, kind } of items) {
      if (kind !== 'req') continue;
      const scope = alias.slice(0, alias.lastIndexOf(':'));
      if (!result.has(scope)) result.set(scope, new Set());
      result.get(scope).add(alias);
    }
    return result;
  };
  const other = scopes(right);
  return [...scopes(left)].some(([scope, ids]) => other.has(scope) && ![...ids].some((id) => other.get(scope).has(id)));
}

function decisiveApplication(db, ...ids) {
  const rank = (app) => SUBMITTED_STATUSES.includes(app.status) || app.applied_at ? 3
    : app.status === 'withdrawn' && app.skip_owner === 'user' ? 2 : app.status === 'prepared' ? 1 : 0;
  return ids.filter(Boolean).map((id) => db.prepare('SELECT * FROM applications WHERE id=?').get(id))
    .filter(Boolean).sort((a, b) => rank(b) - rank(a))[0];
}

function resolveApplicationDuplicates(db, postings, now, companyAliases) {
  const winner = decisiveApplication(db, ...postings.map((posting) => posting.application_id));
  const canonical = postings.find((posting) => posting.application_id === winner.id);
  const code = reusedApplication(db, canonical);
  for (const posting of postings) {
    // Keep every application's own posting, while exact aliases resolve to the
    // most decisive application rather than whichever row bootstrapped first.
    if (posting.id !== canonical.id) db.prepare('UPDATE posting_aliases SET posting_id=? WHERE posting_id=?').run(canonical.id, posting.id);
    if (code) markReview(db, posting.id, { now, state: 'done', decision: 'reused', code });
  }
  if (code) {
    const group = duplicateGroups(db, { companyAliases }).find((item) => item.applicationIds.includes(winner.id));
    for (const id of group?.postingIds ?? []) {
      if (db.prepare('SELECT code FROM reviews WHERE posting_id=?').get(id)?.code !== 'identity_conflict') {
        markReview(db, id, { now, state: 'done', decision: 'reused', code });
      }
    }
  }
}

export function reconcileAliases(db, postingId, aliases, { now, fence, classification, companyAliases, candidates, linkSiblings = true } = {}) {
  const originalId = postingId;
  if (fence) {
    const row = db.prepare('SELECT lease_owner,lease_generation FROM reviews WHERE posting_id=?').get(postingId);
    if (row?.lease_owner !== fence.owner || row?.lease_generation !== fence.generation) {
      const error = new Error('Stale item lease'); error.name = 'StaleLeaseError'; throw error;
    }
  }
  postingId = effective(db, postingId)?.id;
  if (!postingId) throw new Error('Posting not found');
  const currentPosting = effective(db, postingId);
  const currentAuthority = authority(db, postingId);
  const matches = aliases.map((item) => ({ ...item, posting: owned(db, item.alias) })).filter((item) => item.posting && item.posting.id !== postingId);
  if (contradicts(currentAuthority, aliases)) return conflict(db, postingId, matches[0]?.posting.id ?? postingId, now, classification);
  const siblings = [...new Map(matches.filter((item) => item.kind === 'company_req'
    && differentAtsIds([...currentAuthority, ...aliases], authority(db, item.posting.id))
    && !matches.some((other) => other.posting.id === item.posting.id && other.kind !== 'company_req'))
    .map((item) => [item.posting.id, item.posting])).values()];
  const targets = [...new Map(matches.filter((item) => !siblings.some((sibling) => sibling.id === item.posting.id)).map((item) => [item.posting.id, item.posting])).values()];
  for (const target of targets) {
    if (contradicts(currentAuthority, authority(db, target.id))) return conflict(db, postingId, target.id, now, classification);
  }
  if (targets.length > 1) return conflict(db, postingId, targets[1].id, now, classification);
  if (targets.length) {
    const target = targets[0];
    if (currentPosting.application_id && target.application_id && currentPosting.application_id !== target.application_id) {
      for (const a of aliases) if (!owned(db, a.alias)) db.prepare('INSERT INTO posting_aliases (alias,posting_id,kind,created_at) VALUES (?,?,?,?)').run(a.alias, postingId, a.kind, now);
      resolveApplicationDuplicates(db, [target, currentPosting], now, companyAliases);
      return { action: 'added', postingId };
    }
    const app = decisiveApplication(db, target.application_id, currentPosting.application_id);
    if (app && app.id !== target.application_id) {
      db.prepare('UPDATE postings SET application_id=?,updated_at=? WHERE id=?').run(app.id, now, target.id);
      target.application_id = app.id;
    }
    db.prepare('UPDATE postings SET merged_into=?,application_id=NULL,updated_at=? WHERE id=?').run(target.id, now, postingId);
    const fromReview = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(postingId);
    const code = reusedApplication(db, target);
    if (code) markReview(db, target.id, { now, state: 'done', decision: 'reused', code });
    else if (fromReview) {
      const targetReview = db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(target.id);
      if (!targetReview || targetReview.updated_at <= fromReview.updated_at) {
        markReview(db, target.id, { now, state: 'due' });
        db.prepare('UPDATE reviews SET stage=?,lane=?,flags_json=?,evidence_json=?,dep_hashes_json=? WHERE posting_id=?')
          .run(fromReview.stage, fromReview.lane, fromReview.flags_json, fromReview.evidence_json, fromReview.dep_hashes_json, target.id);
      }
      db.prepare('UPDATE snapshots SET posting_id=? WHERE posting_id=?').run(target.id, postingId);
    }
    if (fromReview) markReview(db, postingId, { now, state: 'done', decision: 'reused', code: code ?? 'bound' });
    for (const a of aliases) if (!owned(db, a.alias)) db.prepare('INSERT INTO posting_aliases (alias,posting_id,kind,created_at) VALUES (?,?,?,?)').run(a.alias, target.id, a.kind, now);
    return { action: 'bound', postingId: originalId, boundTo: target.id };
  }
  for (const a of aliases) if (!owned(db, a.alias)) db.prepare('INSERT INTO posting_aliases (alias,posting_id,kind,created_at) VALUES (?,?,?,?)').run(a.alias, postingId, a.kind, now);
  if (linkSiblings && siblings.length) {
    candidates ??= postingCandidates(db, { companyAliases });
    const current = candidateOf(db, currentPosting, classification, { candidates, companyAliases });
    for (const sibling of siblings) maybeSame(db, current, candidateOf(db, sibling, undefined, { candidates, companyAliases }), { now, companyAliases, reason: 'shared company requisition; distinct ATS postings' });
    rememberCandidate(candidates, current, companyAliases);
  }
  return { action: 'added', postingId };
}

function rememberCandidate(candidates, posting, companyAliases) {
  const key = companyKey(posting.company, companyAliases);
  if (!candidates.has(key)) candidates.set(key, new Map());
  candidates.get(key).set(posting.id, posting);
}

function candidateOf(db, posting, classification, { candidates, companyAliases }) {
  const cached = candidates.get(companyKey(posting.company, companyAliases))?.get(posting.id);
  const review = classification ?? db.prepare('SELECT lane,decision FROM reviews WHERE posting_id=?').get(posting.id);
  const candidate = { ...posting, eligible: matters(posting, review), unboundLinks: cached?.unboundLinks ?? 0 };
  if (cached) return Object.assign(cached, candidate);
  return candidate;
}

function maybeSame(db, left, right, { now, companyAliases, reason }) {
  if (!left.eligible || !right.eligible || companyKey(left.company, companyAliases) !== companyKey(right.company, companyAliases)) return false;
  if (!left.application_id && !right.application_id && (left.unboundLinks >= 5 || right.unboundLinks >= 5)) return false;
  if (!link(db, left.id, right.id, 'maybe_same', reason, now)) return false;
  if (!right.application_id) left.unboundLinks += 1;
  if (!left.application_id) right.unboundLinks += 1;
  return true;
}

export function postingCandidates(db, { companyAliases } = {}) {
  const candidates = new Map();
  const degrees = new Map();
  for (const edge of db.prepare(`SELECT l.left_id,l.right_id,a.application_id left_app,b.application_id right_app
    FROM posting_links l JOIN postings a ON a.id=l.left_id JOIN postings b ON b.id=l.right_id WHERE l.kind='maybe_same'`).all()) {
    if (!edge.right_app) degrees.set(edge.left_id, (degrees.get(edge.left_id) ?? 0) + 1);
    if (!edge.left_app) degrees.set(edge.right_id, (degrees.get(edge.right_id) ?? 0) + 1);
  }
  for (const posting of db.prepare(`SELECT p.*,r.lane,r.decision FROM postings p LEFT JOIN reviews r ON r.posting_id=p.id WHERE p.merged_into IS NULL`).all()) {
    rememberCandidate(candidates, { ...posting, eligible: matters(posting, posting), unboundLinks: degrees.get(posting.id) ?? 0 }, companyAliases);
  }
  return candidates;
}

export function resolvePosting(db, record, { now, companyAliases, candidates, classification, applicationId } = {}) {
  candidates ??= postingCandidates(db, { companyAliases });
  if (classification) classification = { ...classification, listed: record.listed !== false };
  const aliases = aliasesFor(record, { companyAliases });
  const matches = aliases.map((item) => ({ ...item, posting: owned(db, item.alias) })).filter((item) => item.posting);
  let postingId; let created = false; let matchedBy = null;
  if (matches.length) {
    const hit = matches.find((item) => item.kind === 'req') ?? matches.find((item) => item.kind === 'source' || item.kind === 'url') ?? matches[0];
    matchedBy = hit.kind;
    const sibling = hit.kind === 'company_req' && differentAtsIds(authority(db, hit.posting.id), aliases);
    // Source and URL hits cannot grant unowned, contradictory authoritative aliases to an old posting.
    const separate = sibling || contradicts(authority(db, hit.posting.id), aliases);
    postingId = separate ? newPosting(db, record, now) : hit.posting.id;
    created = separate;
    if (separate && !sibling) {
      conflict(db, postingId, hit.posting.id, now, classification);
      for (const item of aliases) if (!owned(db, item.alias)) db.prepare('INSERT INTO posting_aliases (alias,posting_id,kind,created_at) VALUES (?,?,?,?)').run(item.alias, postingId, item.kind, now);
    } else reconcileAliases(db, postingId, aliases, { now, classification, companyAliases, candidates, linkSiblings: false });
  } else {
    postingId = newPosting(db, record, now); created = true;
    reconcileAliases(db, postingId, aliases, { now, classification, companyAliases, candidates, linkSiblings: false });
  }
  const posting = effective(db, postingId);
  const company = companyKey(record.company ?? '', companyAliases);
  if (candidates && posting.id !== postingId) candidates.get(company)?.delete(postingId);
  const current = candidateOf(db, { ...posting, listed: record.listed === false ? 0 : 1, application_id: posting.application_id ?? applicationId }, classification, { candidates, companyAliases });
  const links = [];
  const pool = candidates.get(company)?.values() ?? [];
  for (const candidate of pool) {
    if (candidate.id === posting.id) continue;
    const shared = matches.some((item) => item.kind === 'company_req' && item.posting.id === candidate.id);
    if (!shared && Math.max(titleSimilarity(candidate.title, record.title), titleContainment(candidate.title, record.title)) < 0.6) continue;
    if (maybeSame(db, current, candidate, { now, companyAliases, reason: shared ? 'shared company requisition; distinct ATS postings' : 'similar title; identity not established' })) {
      links.push({ postingId: candidate.id, kind: 'maybe_same' });
    }
  }
  if (candidates) rememberCandidate(candidates, current, companyAliases);
  return { postingId: posting.id, created, matchedBy, links };
}

function applicationRecord(app) {
  const prefix = /^([a-z][a-z0-9-]*):(.+)$/.exec(app.external_id ?? '');
  return { company: app.company, title: app.role, url: app.job_url, source: app.source ?? (prefix?.[1] !== 'posting' ? prefix?.[1] : null),
    sourceId: app.source_id ?? (prefix?.[1] !== 'posting' ? prefix?.[2] : null), externalId: prefix ? null : app.external_id };
}

// Submission dedupe is deliberately separate from posting identity: different
// ATS postings (I2) keep their ids even when the user has submitted the program.
const programTitle = (value) => String(value ?? '').normalize('NFKD').toLowerCase()
  .replace(/\band\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

function submissionKeys(record, companyAliases) {
  const company = companyKey(record.company, companyAliases);
  if (!company) return [];
  const aliases = aliasesFor(record, { companyAliases });
  const keys = aliases.filter(({ kind }) => kind === 'company_req').map(({ alias }) => alias);
  const url = parseUrl(record.url);
  // Custom career sites put the job id either immediately after /job(s)/ or
  // after the location/title slug. Only whole id segments count; zip codes in
  // slugs and intermediate location ids cannot become requisition keys (D3).
  if (url && !providerRequisition(record.url)) {
    const parts = url.pathname.split('/').filter(Boolean);
    const marker = parts.findIndex((part) => /^(?:jobs?|details)$/i.test(part));
    const isId = (part) => /^\d{3,}(?:-\d{1,4})?$/.test(part ?? '');
    const id = marker < 0 ? null : isId(parts.at(-1)) ? parts.at(-1) : isId(parts[marker + 1]) ? parts[marker + 1] : null;
    if (id) {
      const suffix = parts[marker].toLowerCase() === 'details' ? /-\d{1,4}$/ : /-\d{1,2}$/;
      keys.push(`company_req:${company}:${id.replace(suffix, '')}`);
    }
  }
  keys.push(...aliases.filter(({ kind }) => kind === 'url').map(({ alias }) => `${company}:${alias}`));
  return keys;
}

export function submittedApplicationIndex(db, { companyAliases } = {}) {
  const identities = new Map(); const programs = new Map();
  const apps = db.prepare(`SELECT * FROM applications WHERE status IN (${SUBMITTED_STATUSES.map(() => '?').join(',')})
    OR COALESCE(applied_at,'')<>'' ORDER BY created_at,id`).all(...SUBMITTED_STATUSES);
  for (const app of apps) {
    const record = applicationRecord(app);
    for (const key of submissionKeys(record, companyAliases)) if (!identities.has(key)) identities.set(key, app.id);
    const company = companyKey(app.company, companyAliases); const title = programTitle(app.role);
    if (company && title && !programs.has(`${company}:${title}`)) programs.set(`${company}:${title}`, app.id);
  }
  return { identities, programs };
}

export function submittedDuplicate(db, record, { companyAliases, index } = {}) {
  index ??= submittedApplicationIndex(db, { companyAliases });
  if (!record.url && record.canonical_url) record = { ...record, url: /^https?:/.test(record.canonical_url) ? record.canonical_url : `https://${record.canonical_url}` };
  const key = submissionKeys(record, companyAliases).find((item) => index.identities.has(item));
  if (key) return { applicationId: index.identities.get(key), match: 'same_requisition' };
  const company = companyKey(record.company, companyAliases); const title = programTitle(record.title);
  const applicationId = company && title && index.programs.get(`${company}:${title}`);
  return applicationId ? { applicationId, match: 'same_program' } : null;
}

export function bindApplication(db, applicationId, { now, companyAliases } = {}) {
  const app = db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
  if (!app) throw new Error('Application not found');
  const record = applicationRecord(app);
  const aliases = aliasesFor(record, { companyAliases });
  const prior = db.prepare('SELECT id FROM postings WHERE application_id=? AND merged_into IS NULL').get(applicationId);
  const explicit = app.external_id?.startsWith('posting:') ? effective(db, app.external_id.slice(8)) : null;
  const resolved = prior || explicit ? { postingId: prior?.id ?? explicit.id, created: false } : resolvePosting(db, record, { now, companyAliases, applicationId });
  let postingId = resolved.postingId;
  let created = resolved.created;
  const initial = effective(db, postingId);
  if (initial.application_id && initial.application_id !== applicationId) {
    postingId = newPosting(db, record, now); created = true;
  }
  db.prepare('UPDATE postings SET application_id=?,updated_at=? WHERE id=?').run(applicationId, now, postingId);
  const duplicates = [...new Map(aliases.map((a) => owned(db, a.alias)).filter((posting) => posting && posting.id !== postingId && posting.application_id
    && !differentAtsIds(authority(db, posting.id), aliases) && !contradicts(authority(db, posting.id), aliases)).map((posting) => [posting.id, posting])).values()];
  if (duplicates.length) {
    for (const a of aliases) if (!owned(db, a.alias)) db.prepare('INSERT INTO posting_aliases (alias,posting_id,kind,created_at) VALUES (?,?,?,?)').run(a.alias, postingId, a.kind, now);
    resolveApplicationDuplicates(db, [...duplicates, effective(db, postingId)], now, companyAliases);
    return { postingId, action: created ? 'created' : 'bound' };
  }
  const reconciled = reconcileAliases(db, postingId, aliases, { now, companyAliases });
  if (reconciled.action === 'quarantined') return { postingId, action: 'conflict' };
  postingId = effective(db, postingId).id;
  return { postingId, action: created ? 'created' : 'bound' };
}

export function duplicateGroups(db, { since, companyAliases } = {}) {
  const apps = db.prepare('SELECT * FROM applications').all();
  const parents = new Map(apps.map((app) => [app.id, app.id]));
  const root = (id) => { while (parents.get(id) !== id) id = parents.get(id); return id; };
  const keys = new Map();
  const postings = new Map();
  for (const app of apps) {
    const ids = db.prepare('SELECT id FROM postings WHERE application_id=?').all(app.id).map((p) => effective(db, p.id)?.id).filter(Boolean);
    if (app.external_id?.startsWith('posting:') && effective(db, app.external_id.slice(8))) ids.push(effective(db, app.external_id.slice(8)).id);
    postings.set(app.id, [...new Set(ids)]);
    const aliases = aliasesFor(applicationRecord(app), { companyAliases });
    for (const id of ids) aliases.push(...db.prepare('SELECT alias,kind FROM posting_aliases WHERE posting_id=?').all(id));
    for (const item of aliases.filter((a) => ['req', 'company_req', 'url'].includes(a.kind))) {
      if (keys.has(item.alias)) parents.set(root(app.id), root(keys.get(item.alias)));
      else keys.set(item.alias, app.id);
    }
  }
  const groups = new Map();
  for (const app of apps) {
    const id = root(app.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(app);
  }
  return [...groups.values()].filter((group) => group.length > 1).map((group) => ({
    key: [...keys].find(([, id]) => root(id) === root(group[0].id))?.[0] ?? group[0].id,
    applicationIds: group.map((a) => a.id).sort(), postingIds: [...new Set(group.flatMap((a) => postings.get(a.id)))].sort(),
    historical: Boolean(since) && group.every((app) => Date.parse(app.created_at) < Date.parse(since)),
  }));
}
