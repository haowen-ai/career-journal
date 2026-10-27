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
    const id = /_([A-Za-z]{0,4}[-_]?\d{3,}(?:-\d+)?)$/i.exec(parts.at(-1) ?? '')?.[1];
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
    if (req?.provider === 'workday' && id === req.id && /-\d+$/.test(normalized)) add('company_req', `company_req:${company}:${normalized.replace(/-\d+$/, '')}`);
  }
  const url = canonicalUrl(record.url);
  if (url) add('url', `url:${url}`);
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
  if (left !== right) db.prepare('INSERT OR IGNORE INTO posting_links (left_id,right_id,kind,reason,created_at) VALUES (?,?,?,?,?)').run(left, right, kind, reason, now);
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
function conflict(db, from, to, now) {
  link(db, from, to, 'conflict', 'contradictory authoritative aliases', now);
  markReview(db, from, { now, state: 'held', decision: 'unclear', code: 'identity_conflict', holdOwner: 'user' });
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

export function reconcileAliases(db, postingId, aliases, { now, fence } = {}) {
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
  const targets = [...new Map(aliases.map((item) => owned(db, item.alias)).filter((p) => p && p.id !== postingId).map((p) => [p.id, p])).values()];
  for (const target of targets) {
    if ((currentPosting.application_id && target.application_id && currentPosting.application_id !== target.application_id)
        || contradicts(authority(db, postingId), authority(db, target.id))) return conflict(db, postingId, target.id, now);
  }
  if (targets.length > 1) return conflict(db, postingId, targets[1].id, now);
  if (contradicts(authority(db, postingId), aliases)) return conflict(db, postingId, targets[0]?.id ?? postingId, now);
  if (targets.length) {
    const target = targets[0];
    if (!target.application_id && currentPosting.application_id) {
      db.prepare('UPDATE postings SET application_id=?,updated_at=? WHERE id=?').run(currentPosting.application_id, now, target.id);
      target.application_id = currentPosting.application_id;
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
  return { action: 'added', postingId };
}

export function resolvePosting(db, record, { now, companyAliases } = {}) {
  const aliases = aliasesFor(record, { companyAliases });
  const matches = aliases.map((item) => ({ ...item, posting: owned(db, item.alias) })).filter((item) => item.posting);
  if (matches.length) {
    const hit = matches.find((item) => item.kind === 'req' || item.kind === 'company_req') ?? matches[0];
    // Source and URL hits cannot grant unowned, contradictory authoritative aliases to an old posting.
    const separate = contradicts(authority(db, hit.posting.id), aliases);
    const postingId = separate ? newPosting(db, record, now) : hit.posting.id;
    if (separate) {
      conflict(db, postingId, hit.posting.id, now);
      for (const item of aliases) if (!owned(db, item.alias)) db.prepare('INSERT INTO posting_aliases (alias,posting_id,kind,created_at) VALUES (?,?,?,?)').run(item.alias, postingId, item.kind, now);
    } else reconcileAliases(db, postingId, aliases, { now });
    return { postingId: effective(db, postingId).id, created: separate, matchedBy: hit.kind, links: [] };
  }
  const postingId = newPosting(db, record, now);
  reconcileAliases(db, postingId, aliases, { now });
  const links = [];
  for (const candidate of db.prepare('SELECT * FROM postings WHERE id<>? AND merged_into IS NULL').all(postingId)) {
    if (companyKey(candidate.company, companyAliases) !== companyKey(record.company ?? '', companyAliases)) continue;
    if (Math.max(titleSimilarity(candidate.title, record.title), titleContainment(candidate.title, record.title)) < 0.6) continue;
    link(db, postingId, candidate.id, 'maybe_same', 'similar title; identity not established', now);
    links.push({ postingId: candidate.id, kind: 'maybe_same' });
  }
  return { postingId, created: true, matchedBy: null, links };
}

function applicationRecord(app) {
  const prefix = /^([a-z][a-z0-9-]*):(.+)$/.exec(app.external_id ?? '');
  return { company: app.company, title: app.role, url: app.job_url, source: app.source ?? (prefix?.[1] !== 'posting' ? prefix?.[1] : null),
    sourceId: app.source_id ?? (prefix?.[1] !== 'posting' ? prefix?.[2] : null), externalId: prefix ? null : app.external_id };
}

export function bindApplication(db, applicationId, { now, companyAliases } = {}) {
  const app = db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
  if (!app) throw new Error('Application not found');
  const record = applicationRecord(app);
  const aliases = aliasesFor(record, { companyAliases });
  const prior = db.prepare('SELECT id FROM postings WHERE application_id=? AND merged_into IS NULL').get(applicationId);
  const explicit = app.external_id?.startsWith('posting:') ? effective(db, app.external_id.slice(8)) : null;
  const hits = [...new Map(aliases.map((a) => owned(db, a.alias)).filter(Boolean).map((p) => [p.id, p])).values()];
  let postingId = prior?.id ?? explicit?.id ?? hits[0]?.id;
  let created = false;
  if (!postingId) { postingId = newPosting(db, record, now); created = true; }
  const posting = effective(db, postingId);
  if (posting.application_id && posting.application_id !== applicationId) {
    postingId = prior?.id ?? newPosting(db, record, now);
    db.prepare('UPDATE postings SET application_id=? WHERE id=?').run(applicationId, postingId);
    conflict(db, postingId, posting.id, now);
    return { postingId, action: 'conflict' };
  }
  db.prepare('UPDATE postings SET application_id=? WHERE id=? AND (application_id IS NULL OR application_id=?)').run(applicationId, postingId, applicationId);
  const reconciled = reconcileAliases(db, postingId, aliases, { now });
  if (reconciled.action === 'quarantined') return { postingId, action: 'conflict' };
  postingId = effective(db, postingId).id;
  const bound = db.prepare('UPDATE postings SET application_id=? WHERE id=? AND (application_id IS NULL OR application_id=?)').run(applicationId, postingId, applicationId);
  if (!bound.changes) throw new Error('Application binding conflict');
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
