// Shared harness for the funnel v3 acceptance tests (test/funnel-v3). Synthetic data only.
// Every module under construction is loaded through load(), so a missing module or export fails the
// single test that needs it with "NOT IMPLEMENTED [lane]: …" instead of failing the whole file.
import { openDatabase, migrate, schemaMigrations } from '../src/storage/database.mjs';
import { createApplication } from '../src/commands/application.mjs';
import { recordEvent } from '../src/domain/events.mjs';

const ROOT = new URL('../', import.meta.url);

export async function load(lane, relativePath, names = []) {
  let module;
  try {
    module = await import(new URL(relativePath, ROOT).href);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(relativePath.replace(/^\.\//, ''))) {
      throw new Error(`NOT IMPLEMENTED [${lane}]: ${relativePath} does not exist yet`);
    }
    throw error;
  }
  const missing = names.filter((name) => !(name in module));
  if (missing.length) throw new Error(`NOT IMPLEMENTED [${lane}]: ${relativePath} is missing export(s) ${missing.join(', ')}`);
  return module;
}

// A migrated in-memory database at schema 6. Fails as NOT IMPLEMENTED until migration 006 is registered.
export function freshDb() {
  if (!schemaMigrations.some((item) => item.version === 6)) {
    throw new Error('NOT IMPLEMENTED [L1]: migration 006-funnel is not registered in schemaMigrations');
  }
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

export const T0 = '2026-11-02T03:00:00.000Z';

export function at(days, base = T0) {
  return new Date(Date.parse(base) + days * 86_400_000).toISOString();
}

// Seeds an application the way users and older releases created them.
export function seedApplication(db, {
  company, role, status = 'lead', jobUrl = null, externalId = null, source = null, sourceId = null,
  skipReason = null, skipOwner = undefined, appliedAt = null, fit = null, now = '2026-10-01T00:00:00.000Z',
}) {
  const application = createApplication(db, { company, role, externalId, jobUrl, status: 'lead' }, now);
  db.prepare(`UPDATE applications SET source = ?, source_id = ?, skip_reason = ?, applied_at = ?, fit = ?, updated_at = ? WHERE id = ?`)
    .run(source, sourceId, skipReason, appliedAt, fit, now, application.id);
  if (skipOwner !== undefined) db.prepare('UPDATE applications SET skip_owner = ? WHERE id = ?').run(skipOwner, application.id);
  if (status !== 'lead') {
    const path = { applied: ['applied'], rejected: ['applied', 'rejected'], interview: ['applied', 'interview'], prepared: ['prepared'], withdrawn: ['withdrawn'] }[status] ?? [status];
    let index = 0;
    for (const next of path) {
      recordEvent(db, {
        id: `seed-${application.id}-${index += 1}`,
        applicationId: application.id,
        type: next === 'applied' ? 'submitted' : 'manual_update',
        observedAt: now,
        recordedAt: now,
        title: `seed ${next}`,
        source: { kind: 'seed' },
        statusAfter: next,
      });
    }
  }
  return db.prepare('SELECT * FROM applications WHERE id = ?').get(application.id);
}

// The withdrawal an automated checker wrote through `queue verify --result skip` before this release.
export function seedCheckerWithdrawal(db, { company, role, jobUrl, note, externalId = null, now = '2026-10-10T00:00:00.000Z' }) {
  const application = seedApplication(db, { company, role, jobUrl, externalId, now });
  recordEvent(db, {
    id: `seed-skip-${application.id}`,
    applicationId: application.id,
    type: 'queue_skipped',
    observedAt: now,
    recordedAt: now,
    title: 'Skipped after posting check',
    note,
    source: { kind: 'queue-verify', result: 'skip', reason: note },
    statusAfter: 'withdrawn',
  });
  db.prepare('UPDATE applications SET skip_reason = ? WHERE id = ?').run(note, application.id);
  return db.prepare('SELECT * FROM applications WHERE id = ?').get(application.id);
}

export function application(db, id) {
  return db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
}

export function applicationsCount(db) {
  return db.prepare('SELECT COUNT(*) n FROM applications').get().n;
}

export function reviewOf(db, postingId) {
  return db.prepare('SELECT * FROM reviews WHERE posting_id = ?').get(postingId);
}

export function eventsOf(db, applicationId) {
  return db.prepare('SELECT event_type type, status_after statusAfter, source_json source FROM application_events WHERE application_id = ? ORDER BY recorded_at, rowid')
    .all(applicationId).map((row) => ({ ...row, source: JSON.parse(row.source) }));
}

// Fake judge adapter: answers from a script keyed by posting id (or a function), counts calls,
// and never touches the network. An answer is a judgment ({ output }) or a non-ok result such as
// { status: 'quota' } / { status: 'error', error } and may carry transportRetries.
export function fakeJudge({ tier = 'primary', model = `fake-${tier}`, effort = null, answers = {}, onCall } = {}) {
  const calls = [];
  return {
    id: `fake-${tier}`,
    runner: 'fake',
    model,
    tier,
    effort,
    cliVersion: 'fake-1',
    calls,
    async judge(request, context = {}) {
      calls.push({ request, context });
      if (onCall) await onCall(request, context);
      const answer = typeof answers === 'function' ? await answers(request, context) : answers[request.postingId];
      if (!answer) return { status: 'error', output: null, rawText: '', usage: {}, transportRetries: 0, error: 'no scripted answer' };
      if (answer.status && answer.status !== 'ok') {
        return { output: null, rawText: '', usage: {}, transportRetries: 0, error: answer.error ?? answer.status, ...answer };
      }
      const output = answer.output ?? answer;
      return { status: 'ok', rawText: JSON.stringify(output), usage: { input_tokens: 10, output_tokens: 5 }, transportRetries: 0, ...answer, output };
    },
  };
}

// A controllable clock for deadline and time-share tests: clock() returns epoch ms, sleep(ms) advances it.
export function fakeClock(start = Date.parse(T0)) {
  let now = start;
  return {
    clock: () => now,
    advance(ms) { now += ms; },
    sleep: async (ms) => { now += Math.max(0, Number(ms) || 0); },
    iso: () => new Date(now).toISOString(),
  };
}

// Fake R1 fetcher keyed by posting URL; values are fetch results (section 6.1 of the spec) or functions.
export function fakeFetcher(results = {}) {
  const calls = [];
  return {
    calls,
    async fetch(request) {
      calls.push(request);
      const value = results[request.url];
      const result = typeof value === 'function' ? await value(request) : value;
      return result ?? { ok: false, httpStatus: 0, error: 'no scripted page' };
    },
  };
}

// Raw schema helpers so L2 tests do not depend on L1's identity code (only on migration 006).
export function insertPosting(db, { id, company = 'Example Corp', title = 'Data Science Intern', url = `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`, applicationId = null, aliases = [], firstSeen = T0, listed = 1, availability = 'open' }) {
  db.prepare(`INSERT INTO postings (id, company, title, canonical_url, first_seen, last_seen, listed, availability, application_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, company, title, url, firstSeen, firstSeen, listed, availability, applicationId, firstSeen, firstSeen);
  for (const [alias, kind] of [[`url:${url.replace(/^https?:\/\//, '')}`, 'url'], ...aliases]) {
    db.prepare('INSERT INTO posting_aliases (alias, posting_id, kind, created_at) VALUES (?, ?, ?, ?)').run(alias, id, kind, firstSeen);
  }
  return { id, company, title, url };
}

export function insertReview(db, { postingId, stage = 'fetch', state = 'due', lane = 'new', firstSeen = T0, nextDue = T0, decision = null, code = null, holdOwner = null, flags = [], deadline = null }) {
  db.prepare(`INSERT INTO reviews (posting_id, stage, state, decision, code, lane, flags_json, attempts, paid_attempts, lost_attempts, next_due,
      lease_generation, evidence_json, dep_hashes_json, deadline_json, hold_owner, hold_since, first_seen, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0, '{}', '{}', ?, ?, ?, ?, ?)`)
    .run(postingId, stage, state, decision, code, lane, JSON.stringify(flags), nextDue, JSON.stringify(deadline ?? {}), holdOwner, holdOwner ? firstSeen : null, firstSeen, firstSeen);
}

// A file-backed database that can be closed mid-transaction and reopened, to simulate a killed process.
export async function tempDb() {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  if (!schemaMigrations.some((item) => item.version === 6)) {
    throw new Error('NOT IMPLEMENTED [L1]: migration 006-funnel is not registered in schemaMigrations');
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cj-funnel-v3-'));
  const file = path.join(directory, 'journal.db');
  let db = openDatabase(file);
  migrate(db);
  return {
    directory,
    get db() { return db; },
    reopen() { try { db.close(); } catch { /* already closed */ } db = openDatabase(file); return db; },
    async cleanup() { try { db.close(); } catch { /* closed */ } await rm(directory, { recursive: true, force: true }); },
  };
}

// Thrown by test hooks to simulate the process being killed at that point. Implementations must let it
// propagate (no catch-and-continue, no cleanup) — see spec section 7.2 and the runReview hooks in the plan's frozen contract.
export class Crash extends Error {
  constructor(point) { super(`simulated crash at ${point}`); this.name = 'Crash'; this.point = point; }
}
