// Redesign Lane C: the owner's rules enforced at the one gate every role passes (deliver()), sticky withdrawals,
// limits counted from submission history, duplicate records. Synthetic data only: every employer, place and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshDb, insertPosting, insertReview, reviewOf, eventsOf, seedApplication, T0, at } from '../../test-utils/funnel-v3.mjs';
import { SCREENING_POLICY } from '../../test-utils/funnel-v3-fixtures.mjs';
import { companySizes, companySizeGate, ensureCompanySizes, loadCompanySizes, saveSizeDecisions } from '../../src/review/company-size.mjs';
import { createCompanySizeResolver } from '../../src/review/company-size-runtime.mjs';
import { evaluateLimits, limitCounts, submissionHistory } from '../../src/review/limits.mjs';
import { duplicateOfSubmitted, textSimilarity } from '../../src/review/duplicate.mjs';
import { applyCompanyCap, deliver, requeueSystemFailures, unhide, annotateMail, MAIL_SUPPRESSION } from '../../src/review/deliver.mjs';
import { claimItem } from '../../src/review/lease.mjs';
import { loadUserOverrides, withOverrides } from '../../src/review/overrides.mjs';
import { classifyRole, CERTAIN_DROP_CODES } from '../../src/funnel/classify.mjs';
import { recordEvent } from '../../src/domain/events.mjs';
import { rescreenLeads, verifyQueuedRole } from '../../src/commands/queue.mjs';
import { directionRules, roleDirection, softwareOnlyRole } from '../../src/review/direction.mjs';
import { resolveIdentityConflicts } from '../../src/funnel/identity.mjs';

const ELIGIBLE = { decision: 'eligible', code: null, fit: { level: 'medium', note: 'SQL match' }, deadline: { kind: 'none' },
  location: { offices: [{ place: 'Chicago, IL', area: 'chicago', quote: 'Location: Chicago, IL' }], remote: { scope: 'none', quote: null }, display: 'Chicago, IL' } };
const sizes = (extra = {}) => companySizes({ large: ['Big Example Co'], small: ['Tiny Example Co'], ...extra });
const policyWith = (extra = {}) => ({ ...SCREENING_POLICY, companySizes: sizes(), ...extra });
let seq = 0;
function posting(db, { id = `p-${seq += 1}`, company = 'Big Example Co', title = 'Data Science Intern', applicationId = null, url, aliases = [] } = {}) {
  insertPosting(db, { id, company, title, applicationId, aliases, ...(url ? { url } : {}) });
  insertReview(db, { postingId: id, stage: 'deliver' });
  return id;
}
const deliverAs = (db, id, verdict, { policy = policyWith(), now = T0, authorization = null, text = null } = {}) =>
  deliver(db, { postingId: id, verdict, fence: claimItem(db, id, { owner: 'worker-a', now }), now, policy, authorization, text });
const appOf = (db, id) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id=p.application_id WHERE p.id=?').get(id);
async function tempDir(prefix) { return mkdtemp(path.join(os.tmpdir(), prefix)); }

// ===================================================================== C1 company size

test('[C1] company size loads from company-size.json with aliases; no file means no rule', async () => {
  const dir = await tempDir('cj-size-');
  try {
    assert.equal(companySizeGate('Anyone Co', await loadCompanySizes(dir)), 'large', 'no size file: every company passes');
    await writeFile(path.join(dir, 'company-overrides.json'), JSON.stringify({ aliases: { 'Tiny Example Holdings (Unit)': 'Tiny Example Co' } }));
    await writeFile(path.join(dir, 'company-size.json'), JSON.stringify({ rule: 'synthetic', large: ['Big Example Co'], small: ['Tiny Example Co'], defenseExcluded: ['Armor Example Co'],
      decided: [{ company: 'Learned Example Co', size: 'small', by: 'jev', at: T0 }] }));
    const loaded = await loadCompanySizes(dir);
    assert.equal(companySizeGate('Big Example Co, Inc.', loaded), 'large');
    assert.equal(companySizeGate('Tiny Example Holdings (Unit)', loaded), 'small', 'the alias map is used');
    assert.equal(companySizeGate('Learned Example Co', loaded), 'small', 'decided[] counts');
    assert.equal(companySizeGate('Unknown Example Co', loaded), 'unknown');
    const overrides = await loadUserOverrides(dir);
    assert.ok(overrides.excludedCompanies.includes('Armor Example Co'), 'defenseExcluded joins the user exclusion');
    await writeFile(path.join(dir, 'company-size.json'), JSON.stringify({ decided: [{ company: 'X', size: 'medium' }] }));
    await assert.rejects(loadCompanySizes(dir), /company-size\.json/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('[C1] ensureCompanySizes: Jev accept/reject decide, between goes to the model, operational failures decide nothing, one decision per company', async () => {
  const dir = await tempDir('cj-size-ensure-');
  try {
    await writeFile(path.join(dir, 'company-size.json'), JSON.stringify({ rule: 'synthetic', large: [], small: [] }));
    const loaded = await loadCompanySizes(dir, { aliases: { 'Alpha Example Group': 'Alpha Example Co' } });
    const probabilities = { 'Alpha Example Co': 0.9, 'Beta Example Co': 0.1, 'Gamma Example Co': 0.5, 'Delta Example Co': 0.5 };
    const jevCalls = [];
    const askJev = async (question, { company }) => {
      jevCalls.push(company);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (company === 'Broken Example Co') throw new Error('Jev HTTP 503');
      return { probability: probabilities[company] };
    };
    const askModel = async (company) => (company === 'Gamma Example Co' ? { size: 'large', reason: 'listed on an exchange' } : { error: 'timeout' });
    const save = saveSizeDecisions(dir);
    const companies = ['Alpha Example Co', 'Alpha Example Group', 'Beta Example Co', 'Gamma Example Co', 'Delta Example Co', 'Broken Example Co'];
    const [first, second] = await Promise.all([
      ensureCompanySizes({ companies, sizes: loaded, askJev, askModel, save, now: T0 }),
      ensureCompanySizes({ companies: ['Alpha Example Co'], sizes: loaded, askJev, askModel, save, now: T0 }),
    ]);
    assert.equal(jevCalls.filter((name) => name === 'Alpha Example Co').length, 1, 'one in-flight decision per normalized company');
    assert.equal(jevCalls.includes('Alpha Example Group'), false, 'aliases are one company');
    assert.deepEqual(first.decided.map((entry) => [entry.company, entry.size, entry.by]).sort(),
      [['Alpha Example Co', 'large', 'jev'], ['Beta Example Co', 'small', 'jev'], ['Gamma Example Co', 'large', 'model']]);
    assert.deepEqual(first.failed.map((item) => [item.company, item.stage]).sort(), [['Broken Example Co', 'jev'], ['Delta Example Co', 'model']]);
    assert.match(first.failed.find((item) => item.company === 'Broken Example Co').error, /Jev HTTP 503/, 'the real error is kept');
    assert.deepEqual(second.decided, [], 'the second caller reuses the in-flight decision');
    assert.equal(companySizeGate('Delta Example Co', loaded), 'unknown', 'a failure decides nothing');
    const file = JSON.parse(await readFile(path.join(dir, 'company-size.json'), 'utf8'));
    assert.equal(file.rule, 'synthetic', 'the rest of the file is kept');
    assert.deepEqual(file.decided.map((entry) => entry.company).sort(), ['Alpha Example Co', 'Beta Example Co', 'Gamma Example Co'], 'concurrent appends are all kept');
    assert.equal(file.decided.find((entry) => entry.company === 'Gamma Example Co').reason, 'listed on an exchange');
    const again = await ensureCompanySizes({ companies: ['Beta Example Co'], sizes: await loadCompanySizes(dir), askJev, askModel, save, now: T0 });
    assert.deepEqual([again.decided, again.known], [[], ['Beta Example Co']], 'a decided company is not asked again');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Review finding 2026-11-05: size questions share the worker's outage breakers. They run with bounded concurrency,
// and dispatch stops after the Jev failure streak or three identical model failures; the rest stay unknown.
test('[C1] ensureCompanySizes runs with bounded concurrency and stops dispatching at the Jev and model failure thresholds', async () => {
  const companies = Array.from({ length: 25 }, (_, n) => `Unknown Example ${n} Co`);
  const save = async () => {};
  let active = 0; let peak = 0;
  const jevCalls = [];
  const downJev = async (question, { company }) => {
    jevCalls.push(company); active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    throw new Error('Jev HTTP 503');
  };
  const down = await ensureCompanySizes({ companies, sizes: companySizes(), askJev: downJev, askModel: async () => ({ size: 'large' }), save, now: T0, concurrency: 1, jevFailureStreak: 20 });
  assert.equal(jevCalls.length, 20, 'no Jev question after 20 consecutive failures');
  assert.equal(down.stopped, 'jev_unavailable');
  assert.equal(down.failed.length, 25, 'every unresolved company is reported failed');
  assert.equal(down.decided.length, 0);
  assert.equal(peak, 1, 'concurrency is bounded');

  const modelCalls = [];
  const between = await ensureCompanySizes({ companies, sizes: companySizes(), askJev: async () => ({ probability: 0.5 }),
    askModel: async (company) => { modelCalls.push(company); throw new Error('codex exited 1'); }, save, now: T0, concurrency: 1 });
  assert.equal(modelCalls.length, 3, 'the model is not called after three identical failures');
  assert.equal(between.stopped, 'adapter_failure');
  assert.equal(between.failed.length, 25);

  let wide = 0; let widePeak = 0;
  const slowJev = async () => { wide += 1; widePeak = Math.max(widePeak, wide); await new Promise((resolve) => setTimeout(resolve, 2)); wide -= 1; return { probability: 0.9 }; };
  const ok = await ensureCompanySizes({ companies, sizes: companySizes(), askJev: slowJev, askModel: async () => ({ size: 'large' }), save, now: T0, concurrency: 4 });
  assert.equal(ok.decided.length, 25);
  assert.ok(widePeak <= 4, `at most four questions in flight (saw ${widePeak})`);

  const dir = await tempDir('cj-size-breaker-');
  try {
    await writeFile(path.join(dir, 'company-size.json'), JSON.stringify({ rule: 'synthetic' }));
    let asked = 0;
    const resolve = createCompanySizeResolver({ profileDir: dir, reviewPolicy: { judge: { jevFailureStreak: 2 }, companySize: { concurrency: 1 } },
      askJev: async () => { asked += 1; throw new Error('Jev HTTP 503'); }, askModel: async () => ({ size: 'large' }), save });
    const viaPolicy = await resolve({ companies, now: T0 });
    assert.deepEqual([asked, viaPolicy.stopped, viaPolicy.failed.length], [2, 'jev_unavailable', 25], 'the resolver uses judge.jevFailureStreak');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('[C1] deliver: small → not_eligible company_small; unknown → back to due with company_size_pending and no application change; classify drops known small', () => {
  const db = freshDb();
  const small = posting(db, { company: 'Tiny Example Co' });
  assert.equal(deliverAs(db, small, ELIGIBLE).action, 'no_application');
  assert.deepEqual([reviewOf(db, small).state, reviewOf(db, small).decision, reviewOf(db, small).code], ['done', 'not_eligible', 'company_small']);
  assert.equal(JSON.parse(reviewOf(db, small).evidence_json).gate.judged, true);
  const lead = seedApplication(db, { company: 'Mystery Example Co', role: 'Data Science Intern' });
  const unknown = posting(db, { company: 'Mystery Example Co', applicationId: lead.id });
  const before = JSON.stringify(db.prepare('SELECT * FROM applications WHERE id=?').get(lead.id));
  assert.equal(deliverAs(db, unknown, ELIGIBLE).action, 'company_size_pending');
  const row = reviewOf(db, unknown);
  assert.deepEqual([row.state, row.decision, row.last_error, row.lease_owner], ['due', null, 'company_size_pending', null]);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM applications WHERE id=?').get(lead.id)), before, 'no application change');
  assert.equal(deliverAs(db, posting(db, { company: 'Big Example Co' }), ELIGIBLE).action, 'created');
  const record = { company: 'Tiny Example Co', title: 'Data Science Intern', url: 'https://jobs.example.test/1', locations: [] };
  assert.equal(classifyRole(record, { policy: policyWith() }).code, 'company_small');
  assert.ok(CERTAIN_DROP_CODES.includes('company_small') && CERTAIN_DROP_CODES.includes('no_student_signal'));
});

// ===================================================================== C2 limits

function submitted(db, { company, days, source = 'applied_at', status = 'applied' }) {
  const id = `sub-${seq += 1}`;
  const when = at(-days);
  db.prepare("INSERT INTO applications (id, company, role, job_url, status, applied_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, company, `Role ${seq}`, `https://jobs.example.test/${id}`, status, source === 'applied_at' ? when : null, source === 'created_at' ? when : at(-500), at(-1));
  if (source === 'event') db.prepare("INSERT INTO application_events (id, application_id, event_type, occurred_at, observed_at, recorded_at, title, note, source_json, status_after, content_hash) VALUES (?, ?, 'application_submitted', NULL, ?, ?, 's', '', '{}', NULL, ?)").run(`e-${id}`, id, when, when, `h-${id}`);
  return id;
}

test('[C2] submission history: applied_at → submitted event → status event → created_at (flagged); never updated_at; withdrawn after submission still counts', () => {
  const db = freshDb();
  const a = submitted(db, { company: 'Limit Example Co', days: 10 });
  const b = submitted(db, { company: 'Limit Example Co', days: 20, source: 'event', status: 'withdrawn' });
  const c = submitted(db, { company: 'Limit Example Co', days: 30, source: 'created_at', status: 'rejected' });
  const stale = submitted(db, { company: 'Limit Example Co', days: 400, source: 'none', status: 'applied' });
  const lead = submitted(db, { company: 'Limit Example Co', days: 5, source: 'none', status: 'lead' });
  const history = new Map(submissionHistory(db).map((item) => [item.applicationId, item]));
  assert.equal(history.get(a).dateSource, 'applied_at');
  assert.equal(history.get(b).dateSource, 'submitted_event', 'a withdrawn application with a submission event counts');
  assert.deepEqual([history.get(c).dateSource, history.get(c).flagged], ['created_at', true]);
  assert.equal(Date.parse(history.get(stale).submittedAt), Date.parse(at(-500)), 'created_at, not the recent updated_at');
  assert.equal(history.has(lead), false, 'a lead was never submitted');
  const policy = { companyCap: { max: 3, windowDays: 90 } };
  const hit = evaluateLimits('Limit Example Co', { policy, now: T0, db });
  assert.deepEqual([hit.code, hit.count, hit.flaggedDates], ['company_cap', 3, [c]]);
  assert.equal(evaluateLimits('Limit Example Co', { policy: { companyCap: { max: 4, windowDays: 90 } }, now: T0, db }), null);
});

test('[C2] limits[]: rolling replaces the default for its company, cycle counts since cycleStart, active counts current status; max 0 is an exclusion', async () => {
  const db = freshDb();
  for (const days of [10, 100, 200]) submitted(db, { company: 'Cycle Example Co', days });
  submitted(db, { company: 'Active Example Co', days: 10, status: 'interview' });
  submitted(db, { company: 'Active Example Co', days: 11, status: 'rejected' });
  for (const days of [1, 2, 3]) submitted(db, { company: 'Loose Example Co', days });
  const policy = { companyCap: { max: 3, windowDays: 90 }, limits: [
    { company: 'Cycle Example Co', max: 2, window: 'cycle', cycleStart: at(-150) },
    { company: 'Active Example Co', max: 1, window: 'active' },
    { company: 'Loose Example Co', max: 5, window: '90d' },
  ] };
  const cycle = evaluateLimits('Cycle Example Co', { policy, now: T0, db });
  assert.deepEqual([cycle.code, cycle.kind, cycle.count], ['company_limit', 'cycle', 2]);
  const active = evaluateLimits('Active Example Co', { policy, now: T0, db });
  assert.deepEqual([active.code, active.count], ['company_limit', 1], 'the ended application does not count');
  assert.equal(evaluateLimits('Loose Example Co', { policy, now: T0, db }), null, 'a per-company rolling limit replaces the default cap');
  const dir = await tempDir('cj-limits-');
  try {
    await writeFile(path.join(dir, 'company-overrides.json'), JSON.stringify({ limits: [{ company: 'Never Example Co', max: 0, window: '90d' }, { company: 'Cycle Example Co', max: 2, window: 'cycle', cycleStart: '2026-08-01' }] }));
    const loaded = await loadUserOverrides(dir);
    assert.ok(loaded.excludedCompanies.includes('Never Example Co'), 'max 0 becomes an exclusion');
    assert.deepEqual(loaded.limits.map((item) => item.company), ['Cycle Example Co']);
    await writeFile(path.join(dir, 'company-overrides.json'), JSON.stringify({ limits: [{ company: 'Bad', max: 1, window: 'cycle' }] }));
    await assert.rejects(loadUserOverrides(dir), /limits/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('[C2] a reached limit is a decision at delivery, released by the startup pass only for the exact review-owned reason', () => {
  const db = freshDb();
  const policy = policyWith({ companyCap: { max: 5, windowDays: 90 }, limits: [{ company: 'Big Example Co', max: 1, window: '90d' }] });
  const sub = submitted(db, { company: 'Big Example Co', days: 10 });
  const lead = seedApplication(db, { company: 'Big Example Co', role: 'Analytics Intern' });
  const id = posting(db, { applicationId: lead.id, title: 'Analytics Intern' });
  const other = seedApplication(db, { company: 'Big Example Co', role: 'Data Intern' });
  const otherId = posting(db, { applicationId: other.id, title: 'Data Intern' });
  assert.equal(deliverAs(db, id, ELIGIBLE, { policy }).action, 'withdrawn');
  assert.equal(deliverAs(db, otherId, ELIGIBLE, { policy }).action, 'withdrawn');
  assert.deepEqual([reviewOf(db, id).code, appOf(db, id).skip_reason, appOf(db, id).skip_owner], ['company_limit', 'company_limit', 'review']);
  db.prepare("UPDATE applications SET skip_reason='changed by hand' WHERE id=?").run(other.id);
  assert.equal(applyCompanyCap(db, { now: at(1), policy }).restored, 0, 'still over the limit');
  db.prepare('UPDATE applications SET applied_at=? WHERE id=?').run(at(-120), sub);
  const pass = applyCompanyCap(db, { now: at(1), policy });
  assert.equal(pass.restored, 1);
  assert.deepEqual([appOf(db, id).status, appOf(db, id).skip_reason], ['lead', null], 'released with authorization cap_release');
  assert.equal(eventsOf(db, lead.id).at(-1).source.authorization, 'cap_release');
  assert.equal(appOf(db, otherId).status, 'withdrawn', 'a withdrawal whose reason changed is not released');
});

// ===================================================================== C5 sticky withdrawals

test('[C5] deliver restores a withdrawn application only with rejudge/cap_release/relist; mail unhide clears only the mail suppression', () => {
  const db = freshDb();
  const lead = seedApplication(db, { company: 'Big Example Co', role: 'Data Science Intern' });
  const id = posting(db, { applicationId: lead.id });
  deliverAs(db, id, { decision: 'not_eligible', code: 'requirement_conflict' });
  assert.equal(appOf(db, id).status, 'withdrawn');
  db.prepare("UPDATE reviews SET state='due' WHERE posting_id=?").run(id);
  assert.equal(deliverAs(db, id, ELIGIBLE).action, 'withdrawal_kept');
  assert.deepEqual([reviewOf(db, id).state, reviewOf(db, id).code], ['done', 'requirement_conflict'], 'the settled decision is kept');
  assert.equal(deliverAs(db, id, ELIGIBLE, { authorization: 'cap_release' }).action, 'withdrawal_kept', 'cap_release only releases a cap/limit withdrawal');
  assert.equal(deliverAs(db, id, ELIGIBLE, { authorization: 'rejudge' }).action, 'restored');

  const mail = seedApplication(db, { company: 'Big Example Co', role: 'Mail Intern' });
  const mailId = posting(db, { applicationId: mail.id, title: 'Mail Intern' });
  annotateMail(db, { postingId: mailId, match: 'exact', messageId: 'm1', subject: 'Thanks for applying', received: T0, matched: [], now: T0 });
  assert.equal(appOf(db, mailId).skip_reason, MAIL_SUPPRESSION);
  unhide(db, { postingId: mailId, now: T0 });
  assert.equal(appOf(db, mailId).skip_reason, null);
  db.prepare("UPDATE applications SET skip_reason='待核: browser_review — open', skip_owner='review' WHERE id=?").run(mail.id);
  unhide(db, { postingId: mailId, now: T0 });
  assert.equal(appOf(db, mailId).skip_reason, '待核: browser_review — open', 'another review suppression stays');
});

test('[C10] queue verify --actor apply is terminal like the user; --actor audit is review-owned with its own code and never restored by a normal run', () => {
  const db = freshDb();
  const applyApp = seedApplication(db, { company: 'Big Example Co', role: 'Apply Intern' });
  const applyId = posting(db, { applicationId: applyApp.id, title: 'Apply Intern' });
  verifyQueuedRole(db, { id: applyApp.id, result: 'skip', reason: 'posting closed on the form', actor: 'apply' }, T0);
  assert.deepEqual([appOf(db, applyId).skip_owner, reviewOf(db, applyId).code], ['user', 'user_declined']);
  assert.equal(eventsOf(db, applyApp.id).at(-1).source.actor, 'apply');
  const auditApp = seedApplication(db, { company: 'Big Example Co', role: 'Audit Intern' });
  const auditId = posting(db, { applicationId: auditApp.id, title: 'Audit Intern' });
  verifyQueuedRole(db, { id: auditApp.id, result: 'skip', reason: 'undergraduate only, quoted', actor: 'audit', code: 'audit_degree' }, T0);
  assert.deepEqual([appOf(db, auditId).skip_owner, appOf(db, auditId).skip_reason, reviewOf(db, auditId).code], ['review', 'undergraduate only, quoted', 'audit_degree']);
  assert.equal(JSON.parse(reviewOf(db, auditId).evidence_json).provenance, 'automated');
  db.prepare("UPDATE reviews SET state='due' WHERE posting_id=?").run(auditId);
  assert.equal(deliverAs(db, auditId, ELIGIBLE).action, 'withdrawal_kept');
  assert.equal(deliverAs(db, auditId, ELIGIBLE, { authorization: 'rejudge' }).action, 'restored', 'an explicit rejudge may restore it');
  assert.throws(() => verifyQueuedRole(db, { id: seedApplication(db, { company: 'Big Example Co', role: 'X' }).id, result: 'skip', reason: 'r', actor: 'audit' }, T0), /--code/);
  assert.throws(() => verifyQueuedRole(db, { id: 'x', result: 'skip', reason: 'r', actor: 'robot' }, T0), /actor/);
});

// ===================================================================== C6 cross-ATS duplicate

const BODY = 'About the role. Join our analytics team to build forecasting models for retail demand across stores. You will work with SQL and Python, partner with product managers, and present findings to leaders. Summer 2027 internship, twelve weeks, based in Chicago. Requirements: pursuing a graduate degree in statistics or a related field. Benefits include housing support and mentorship.';
function snapshot(db, postingId, text) {
  db.prepare("INSERT INTO snapshots (id, posting_id, content_hash, fetched_at, final_url, http_status, method, identity_ok, fields_json, sections_json, text) VALUES (?, ?, ?, ?, NULL, 200, 'html', 1, '{}', '[]', ?)")
    .run(`s-${postingId}`, postingId, `h-${postingId}`, T0, text);
}
function submittedPosting(db, { company = 'Big Example Co', title = 'Data Science Intern', text = BODY, aliases = [], status = 'applied', appliedAt = at(-5) } = {}) {
  const app = seedApplication(db, { company, role: title, status, appliedAt });
  const id = `p-sub-${seq += 1}`;
  insertPosting(db, { id, company, title, applicationId: app.id, url: `https://ats-one.example.test/jobs/${seq}`, aliases });
  snapshot(db, id, text);
  return { app, id };
}

test('[C6] a cross-ATS repost of a submitted role is not_eligible duplicate_submitted, linked, never merged; every condition is required', () => {
  const db = freshDb();
  const original = submittedPosting(db, { title: 'Intern, Data Science' });
  const repost = posting(db, { title: 'Data Science Internship', url: 'https://ats-two.example.test/role/77' });
  assert.equal(deliverAs(db, repost, ELIGIBLE, { text: BODY }).action, 'no_application');
  const row = reviewOf(db, repost);
  assert.deepEqual([row.decision, row.code], ['not_eligible', 'duplicate_submitted']);
  assert.equal(JSON.parse(row.evidence_json).gate.duplicateOf.applicationId, original.app.id);
  assert.equal(db.prepare('SELECT merged_into FROM postings WHERE id=?').get(repost).merged_into, null, 'identities stay separate');
  assert.ok(textSimilarity(BODY, BODY.toUpperCase().replace(/\./g, ' ')) >= 0.9, 'case and punctuation do not matter');
  const check = (setup, text = BODY) => { const fresh = freshDb(); const made = setup(fresh); return duplicateOfSubmitted(fresh, fresh.prepare('SELECT * FROM postings WHERE id=?').get(made), { text }); };
  const plain = (fresh, overrides = {}) => posting(fresh, { title: 'Data Science Intern', url: 'https://ats-two.example.test/role/1', ...overrides });
  assert.ok(check((fresh) => { submittedPosting(fresh); return plain(fresh); }), 'baseline duplicate');
  assert.equal(check((fresh) => { submittedPosting(fresh, { status: 'withdrawn', appliedAt: null }); return plain(fresh); }), null, 'a merely withdrawn application is not evidence');
  assert.equal(check((fresh) => { submittedPosting(fresh, { company: 'Other Example Co' }); return plain(fresh); }), null, 'different company');
  assert.equal(check((fresh) => { submittedPosting(fresh, { title: 'Data Engineering Intern' }); return plain(fresh); }), null, 'different title');
  assert.equal(check((fresh) => { submittedPosting(fresh); return plain(fresh); }, 'A different posting text about a supply chain role in Dallas with nothing in common.'), null, 'text below the threshold');
  assert.equal(check((fresh) => { submittedPosting(fresh, { text: BODY.replace('Summer 2027', 'Summer 2026') }); return plain(fresh); }), null, 'a different season/year');
  assert.equal(check((fresh) => { submittedPosting(fresh, { aliases: [['req:greenhouse:example:111', 'req']] }); return plain(fresh, { aliases: [['req:greenhouse:example:222', 'req']] }); }), null,
    'different requisition ids of the same ATS tenant');
});

// ===================================================================== C7 submission idempotency

test('[C7] a repeated submitted/application_submitted event is a no-op returning the existing event unless forced', () => {
  const db = freshDb();
  const app = seedApplication(db, { company: 'Big Example Co', role: 'Repeat Intern' });
  const event = (id, type) => ({ id, applicationId: app.id, type, observedAt: T0, recordedAt: T0, title: 'Submitted', source: { kind: 'mail' }, statusAfter: 'applied' });
  assert.equal(recordEvent(db, event('e1', 'submitted')).created, true);
  const again = recordEvent(db, event('e2', 'application_submitted'));
  assert.deepEqual([again.created, again.eventId], [false, 'e1']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM application_events WHERE application_id=? AND event_type IN ('submitted','application_submitted')").get(app.id).n, 1);
  assert.equal(recordEvent(db, { ...event('e3', 'submitted'), statusAfter: null }, { force: true }).created, true, 'force records a distinct submission');
});

// ===================================================================== C8 rescreen

test('[C8] queue rescreen lists gate violators among leads (dry run writes nothing) and withdraws them with --apply', () => {
  const db = freshDb();
  const policy = policyWith({ companyCap: { max: 1, windowDays: 90 }, userExcludedCompanies: ['Excluded Example Co'] });
  submitted(db, { company: 'Capped Example Co', days: 3 });
  const lead = (company, title = 'Data Science Intern') => { const app = seedApplication(db, { company, role: title }); const id = posting(db, { company, applicationId: app.id, title });
    db.prepare("UPDATE reviews SET state='done', decision='eligible', evidence_json=? WHERE posting_id=?").run(JSON.stringify({ fit: ELIGIBLE.fit, location: ELIGIBLE.location }), id); return app.id; };
  const ok = lead('Big Example Co');
  const small = lead('Tiny Example Co');
  const capped = lead('Capped Example Co');
  const excluded = lead('Excluded Example Co');
  const unknown = lead('Mystery Example Co');
  policy.companySizes = companySizes({ large: ['Big Example Co', 'Capped Example Co', 'Excluded Example Co'], small: ['Tiny Example Co'] });
  const before = JSON.stringify(db.prepare('SELECT * FROM applications ORDER BY id').all());
  const dry = rescreenLeads(db, { policy, now: T0 });
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM applications ORDER BY id').all()), before, 'a dry run writes nothing');
  const codes = Object.fromEntries(dry.results.map((item) => [item.applicationId, item.code]));
  assert.deepEqual(codes, { [small]: 'company_small', [capped]: 'company_cap', [excluded]: 'company_excluded', [unknown]: 'company_size_unknown' });
  assert.equal(dry.violations, 3);
  rescreenLeads(db, { policy, now: T0, apply: true });
  const status = (id) => db.prepare('SELECT status FROM applications WHERE id=?').get(id).status;
  assert.deepEqual([ok, small, capped, excluded, unknown].map(status), ['lead', 'withdrawn', 'withdrawn', 'withdrawn', 'lead']);
});

// ===================================================================== C9 holds get outcomes

test('[C9] legacy quota holds become decisions; system_failure holds are re-queued once, then reported external', () => {
  const db = freshDb();
  const held = posting(db, { company: 'Quota Full Example' });
  db.prepare("UPDATE reviews SET state='held', decision='unclear', code='quota_full', hold_owner='system', evidence_json=? WHERE posting_id=?").run(JSON.stringify({ fit: ELIGIBLE.fit }), held);
  assert.equal(applyCompanyCap(db, { now: T0, policy: policyWith({ companySizes: null }) }).holds, 1);
  assert.deepEqual([reviewOf(db, held).state, reviewOf(db, held).code], ['done', 'company_limit']);
  const failed = posting(db);
  db.prepare("UPDATE reviews SET state='held', code='system_failure', hold_owner='system', lost_attempts=2 WHERE posting_id=?").run(failed);
  assert.equal(requeueSystemFailures(db, { now: T0 }).requeued, 1);
  assert.equal(reviewOf(db, failed).state, 'due');
  db.prepare("UPDATE reviews SET state='held', code='system_failure' WHERE posting_id=?").run(failed);
  const second = requeueSystemFailures(db, { now: at(1) });
  assert.deepEqual([second.requeued, second.external.map((item) => item.postingId)], [0, [failed]]);
});

test('[C9] identity_conflict holds: ids proving one requisition bind to the partner (its settled decision stays); others are judged on their own', () => {
  const db = freshDb();
  insertPosting(db, { id: 'p-old', company: 'Parts Example Co', url: 'https://parts.wd1.myworkdayjobs.com/Careers/job/City/Intern_R26_0000001', aliases: [['req:workday:parts:0000001', 'req']] });
  insertReview(db, { postingId: 'p-old', state: 'done', decision: 'not_eligible', code: 'user_declined', nextDue: null });
  insertPosting(db, { id: 'p-held', company: 'Parts Example Co', url: 'https://parts.wd1.myworkdayjobs.com/Careers/job/City/Intern_R26_0000001?x=1', aliases: [['req:workday:parts:R26_0000001', 'req']] });
  insertReview(db, { postingId: 'p-held', state: 'held', decision: 'unclear', code: 'identity_conflict', holdOwner: 'user' });
  insertPosting(db, { id: 'p-a', company: 'Parts Example Co', url: 'https://parts.example.test/jobs/1', aliases: [['req:workday:parts:R26_0000002', 'req']] });
  insertPosting(db, { id: 'p-b', company: 'Parts Example Co', url: 'https://parts.example.test/jobs/2', aliases: [['req:workday:parts:R26_0000003', 'req']] });
  insertReview(db, { postingId: 'p-b', state: 'held', decision: 'unclear', code: 'identity_conflict', holdOwner: 'user' });
  for (const [left, right] of [['p-held', 'p-old'], ['p-b', 'p-a']]) db.prepare("INSERT INTO posting_links (left_id,right_id,kind,reason,created_at) VALUES (?,?,'conflict','x',?)").run(left, right, T0);
  const result = resolveIdentityConflicts(db, { now: T0 });
  assert.deepEqual(result.bound.map((item) => item.postingId), ['p-held']);
  assert.equal(db.prepare('SELECT merged_into FROM postings WHERE id=?').get('p-held').merged_into, 'p-old');
  assert.equal(reviewOf(db, 'p-old').code, 'user_declined', 'the settled decision of the partner stays');
  assert.deepEqual(result.separated.map((item) => item.postingId), ['p-b']);
  assert.deepEqual([reviewOf(db, 'p-b').state, reviewOf(db, 'p-b').hold_owner], ['due', null]);
});

// ===================================================================== C11 any-function companies

test('[C11] anyFunctionCompanies skips the direction filter for listed companies (aliases), at delivery and in the rules', () => {
  const rules = directionRules({ block: ['\\bsales\\b'], neutral: 'deny', anyFunctionCompanies: ['Favorite Example Co'] });
  assert.equal(roleDirection('Sales Operations Intern', rules).ok, false);
  assert.equal(roleDirection('Sales Operations Intern', rules, { company: 'Favorite Example Holdings', aliases: { 'Favorite Example Holdings': 'Favorite Example Co' } }).ok, true);
  assert.equal(softwareOnlyRole('Platform Developer Intern', 'software_engineering', rules, { company: 'Favorite Example Co' }), false);
  assert.throws(() => directionRules({ anyFunctionCompanies: 'x' }), /anyFunctionCompanies/);
  const db = freshDb();
  const policy = policyWith({ direction: rules, companySizes: companySizes({ large: ['Favorite Example Co', 'Big Example Co'] }) });
  assert.equal(deliverAs(db, posting(db, { company: 'Favorite Example Co', title: 'Sales Operations Intern' }), ELIGIBLE, { policy }).action, 'created');
  const out = posting(db, { company: 'Big Example Co', title: 'Sales Operations Intern' });
  deliverAs(db, out, ELIGIBLE, { policy });
  assert.equal(reviewOf(db, out).code, 'role_direction');
});

test('[C1/C2] withOverrides joins aliases, limits and sizes into the delivery policy', () => {
  const policy = withOverrides({ companyAliases: { A: 'B' } }, { aliases: { C: 'D' }, limits: [{ company: 'X', max: 1, window: 'active' }], companySizes: sizes() });
  assert.deepEqual(policy.companyAliases, { A: 'B', C: 'D' });
  assert.equal(policy.limits.length, 1);
  assert.equal(companySizeGate('Tiny Example Co', policy.companySizes), 'small');
  assert.ok(limitCounts(freshDb()).history);
});
