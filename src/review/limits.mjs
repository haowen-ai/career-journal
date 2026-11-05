import { companyKey } from '../scan/dedupe.mjs';
import { SUBMITTED_STATUSES } from '../funnel/contract.mjs';

// Company limits, one evaluator for delivery, the startup pass, cap release and the queue commands.
// Rules (all must hold; the first reached one is reported):
//   default cap   review-policy companyCap { max, windowDays } — rolling window, code company_cap
//   activeCaps    company-overrides activeCaps [{ company, max }] — applications in progress, code company_cap
//   limits[]      company-overrides limits [{ company, max, window, cycleStart? }] — code company_limit.
//                 A rolling-window ('<n>d') entry replaces the default cap for its company.
//   program rules screening-policy rules[] with limit/blocked (program- or country-scoped), code company_limit
// Counting:
//   'active'          current status in ACTIVE_STATUSES (ended applications do not count).
//   '<n>d' / 'cycle'  immutable submission history, whatever the current status: the submission date is
//                     applied_at → earliest submitted/application_submitted event → earliest event whose
//                     status_after is a submitted status → created_at (dateSource 'created_at', flagged).
//                     Never updated_at. An application with none of these was never submitted.
export const ACTIVE_STATUSES = Object.freeze(['applied', 'assessment', 'interview', 'offer']);
export const LIMIT_CODES = Object.freeze(['company_cap', 'company_limit']);
const SUBMISSION_EVENTS = ['submitted', 'application_submitted'];
const DAY = 86_400_000;
const words = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const eventTime = (event) => event.occurred_at || event.observed_at || event.recorded_at || null;
const placeholders = (list) => list.map(() => '?').join(',');

// Every application with submission evidence, with its immutable submission date.
export function submissionHistory(db) {
  const events = new Map();
  for (const event of db.prepare(`SELECT application_id,event_type,status_after,occurred_at,observed_at,recorded_at FROM application_events
      WHERE event_type IN (${placeholders(SUBMISSION_EVENTS)}) OR status_after IN (${placeholders(SUBMITTED_STATUSES)})`).all(...SUBMISSION_EVENTS, ...SUBMITTED_STATUSES)) {
    const entry = events.get(event.application_id) ?? { submitted: null, status: null };
    const when = eventTime(event);
    if (when) {
      const slot = SUBMISSION_EVENTS.includes(event.event_type) ? 'submitted' : 'status';
      if (!entry[slot] || Date.parse(when) < Date.parse(entry[slot])) entry[slot] = when;
    }
    events.set(event.application_id, entry);
  }
  const history = [];
  for (const app of db.prepare('SELECT id,company,status,applied_at,created_at FROM applications').all()) {
    const seen = events.get(app.id);
    let date = null; let dateSource = null;
    if (app.applied_at) { date = app.applied_at; dateSource = 'applied_at'; }
    else if (seen?.submitted) { date = seen.submitted; dateSource = 'submitted_event'; }
    else if (seen?.status) { date = seen.status; dateSource = 'status_event'; }
    else if (SUBMITTED_STATUSES.includes(app.status)) { date = app.created_at; dateSource = 'created_at'; }
    if (!date) continue;
    history.push({ applicationId: app.id, company: app.company, status: app.status, submittedAt: date, dateSource, flagged: dateSource === 'created_at' });
  }
  return history;
}

export function activeApplicationsList(db) {
  return db.prepare(`SELECT id applicationId,company,status FROM applications WHERE status IN (${placeholders(ACTIVE_STATUSES)})`).all(...ACTIVE_STATUSES);
}

// All rules that can apply to a company, from the delivery policy (deliveryPolicy / withOverrides shape).
export function limitRules(company, policy = {}) {
  const aliases = policy.companyAliases;
  const same = (name) => companyKey(name, aliases) === companyKey(company, aliases);
  const own = (policy.limits ?? []).filter((limit) => same(limit.company));
  const rules = [];
  const cap = policy.companyCap;
  const rolling = own.filter((limit) => /^\d+d$/.test(limit.window));
  if (!rolling.length && Number.isInteger(cap?.max) && cap.max > 0 && Number(cap.windowDays) > 0) {
    rules.push({ code: 'company_cap', kind: 'rolling', max: cap.max, windowDays: Number(cap.windowDays), source: 'default' });
  }
  for (const item of (policy.activeCaps ?? []).filter((entry) => same(entry.company))) rules.push({ code: 'company_cap', kind: 'active', max: item.max, source: 'activeCaps' });
  for (const limit of own) {
    if (limit.window === 'active') rules.push({ code: 'company_limit', kind: 'active', max: limit.max, source: 'limits' });
    else if (limit.window === 'cycle') rules.push({ code: 'company_limit', kind: 'cycle', max: limit.max, cycleStart: limit.cycleStart, source: 'limits' });
    else rules.push({ code: 'company_limit', kind: 'rolling', max: limit.max, windowDays: Number(limit.window.slice(0, -1)), source: 'limits' });
  }
  return rules;
}

// Cache the two table reads for a pass over many postings.
export function limitCounts(db) {
  return { history: submissionHistory(db), active: activeApplicationsList(db) };
}

function counted(rule, company, { counts, now, aliases }) {
  const key = companyKey(company, aliases);
  if (rule.kind === 'active') return counts.active.filter((app) => companyKey(app.company, aliases) === key);
  const since = rule.kind === 'cycle' ? Date.parse(rule.cycleStart) : Date.parse(now) - rule.windowDays * DAY;
  return counts.history.filter((app) => companyKey(app.company, aliases) === key && Date.parse(app.submittedAt) >= since
    && (rule.kind === 'cycle' || Date.parse(app.submittedAt) > since));
}

// A program/country-scoped rule of the screening policy (rules[]). It applies when the verdict's program
// carries every word of the rule's program/countryScope; a rule without scope applies company-wide. A
// verdict without a program is outside a scoped rule (noted, never held).
export function programRule(company, program, policy = {}) {
  const notes = [];
  for (const rule of policy.rules ?? []) {
    if (companyKey(rule.company, policy.companyAliases) !== companyKey(company, policy.companyAliases)) continue;
    if (rule.program || rule.countryScope) {
      if (!program) { if (rule.note) notes.push(rule.note); continue; }
      const scope = new Set(words(`${program.name ?? ''} ${program.countryScope ?? ''}`));
      if (!words(`${rule.program ?? ''} ${rule.countryScope ?? ''}`).every((word) => scope.has(word))) continue;
    }
    const used = rule.usedConfirmed ?? rule.used ?? 0;
    const reason = rule.blockReason === 'quota-reconciliation-pending' || (rule.blocked && rule.distinctApplicationsInWindow === null) ? 'reconciliation_pending'
      : Number.isFinite(rule.limit) && used >= rule.limit ? 'limit_reached' : rule.blocked ? 'blocked' : null;
    if (reason) {
      return { code: 'company_limit', kind: 'program', source: 'screeningRules', reason, max: Number.isFinite(rule.limit) ? rule.limit : null, count: used,
        program: rule.program ?? null, countryScope: rule.countryScope ?? null, window: rule.window ?? null, note: rule.note ?? null, applicationIds: rule.applicationIds ?? [] };
    }
    if (rule.note) notes.push(rule.note);
  }
  return { blocked: null, notes };
}

// The first reached limit for a company, or null. `exclude` leaves one application out of the count
// (the application being judged, so its own lead or submission never blocks itself).
export function evaluateLimits(company, { policy = {}, now, counts, db, program, exclude = null } = {}) {
  counts ??= limitCounts(db);
  const program_ = programRule(company, program, policy);
  if (program_.code) return program_;
  for (const rule of limitRules(company, policy)) {
    const apps = counted(rule, company, { counts, now, aliases: policy.companyAliases }).filter((app) => app.applicationId !== exclude);
    if (apps.length >= rule.max) {
      return { code: rule.code, kind: rule.kind, source: rule.source, max: rule.max, count: apps.length, applicationIds: apps.map((app) => app.applicationId),
        ...(rule.windowDays ? { windowDays: rule.windowDays } : {}), ...(rule.cycleStart ? { cycleStart: rule.cycleStart } : {}),
        ...(rule.kind === 'active' ? { active: true } : {}), flaggedDates: apps.filter((app) => app.flagged).map((app) => app.applicationId) };
    }
  }
  return null;
}

// Notes of matching unblocked program rules, appended to the fit note at delivery.
export const programNotes = (company, program, policy) => programRule(company, program, policy).notes ?? [];
