import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { openHomeDatabase } from '../runtime/home.mjs';
import { redact } from '../runtime/redact.mjs';
import { loadReviewInputs, dependencyHash } from '../review/inputs.mjs';
import { createJudgeAdapters } from '../review/judge.mjs';
import { createSecondOpinion } from '../review/second-opinion.mjs';
import { createJevSplit } from '../review/jev-split.mjs';
import { runReview } from '../review/worker.mjs';
import { createCompanySizeResolver } from '../review/company-size-runtime.mjs';
import { commandFetcher, builtinFetcher, politeFetcher, validateSnapshot, closedPageWording, isStubText } from '../review/fetch.mjs';
import { bootstrapExisting } from '../funnel/bootstrap.mjs';
import { resolvePosting, duplicateGroups } from '../funnel/identity.mjs';
import { segmentSections } from '../review/clauses.mjs';
import { reviewExitCode, writeReceipt, readRunReceipt, readCurrentReceipt, finalizeDailyReceipt, localDate } from '../review/receipt.mjs';
import { reviewReport } from '../review/report.mjs';
import { nightlySummary } from '../review/summary.mjs';
import { postingLedger } from '../review/ledger.mjs';
import { matchMailHits } from '../review/mail.mjs';
import { annotateMail, unhide, deliver, deliveryPolicy, logReview, parseJson } from '../review/deliver.mjs';
import { claimItem, atomic } from '../review/lease.mjs';
import { redecideReviews } from '../review/redecide.mjs';
import { releaseHolds } from '../review/release-holds.mjs';
import { reclassifyReviews } from '../review/reclassify.mjs';
import { rejudgeReviews, settleBacklog, holdReview } from '../review/backlog.mjs';
import { loadScanProfile } from '../scan/profile-input.mjs';
import { profileOption, scanPolicy } from './scan.mjs';

const usage = ['Usage: career-journal review run|redecide|reclassify|release-holds|rejudge|settle-backlog|hold|bootstrap|list|report|receipt|attach|add|annotate|unhide|resolve|ledger|audit|daily-finalize|eval',
  '  review run [--budget <n>] [--max-fetches <n>] [--deadline-min <m>] [--deadline-at <time>] [--concurrency <n>]   limits optional; omitted or 0 = unbounded',
  '  review rejudge (--code <a,b> [--company <name>] [--since <date>] | --leads | --posting <id,...>) [--apply]   dry run unless --apply',
  '  review settle-backlog [--apply] [--profile <path>]   dry run unless --apply',
  '  review hold --posting <id> --code <code> --reason <text>',
  '  review list [--held] [--json]',
  '  review attach --posting <id> --file <page>   a gone page settles closed; a page with no posting body is refused; exits 75 (busy) while a live run leases the posting',
  '  review report [--run-id <id>] [--lang zh]   review receipt [--run-id <id>] [--summary [zh]]'].join('\n');
const listOption = (value, name) => {
  const items = [value].flat().flatMap((item) => (typeof item === 'string' ? item.split(',') : [])).map((item) => item.trim()).filter(Boolean);
  if (!items.length) throw new Error(`${name} requires a value`);
  return items;
};
// An item leased by a live run (fresh heartbeat of its owner) must not be written under it (redesign B6).
const leasedByLiveRun = (db, postingId, now) => {
  const row = db.prepare('SELECT state,lease_owner,lease_until FROM reviews WHERE posting_id=?').get(postingId);
  if (row?.state !== 'leased' || !(row.lease_until > now)) return false;
  return db.prepare("SELECT heartbeat_at FROM runs WHERE owner=? AND status='running'").all(row.lease_owner)
    .some((run) => Date.parse(now) - Date.parse(run.heartbeat_at) <= 600000);
};
const activeRun = (db, now) => db.prepare("SELECT run_id FROM runs WHERE kind IN ('scan','review') AND status='running' AND heartbeat_at>=?").get(new Date(Date.parse(now) - 600000).toISOString());
const required = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value; };
function numberOption(value, name, { zero = false, integer = true } = {}) {
  const result = Number(value);
  if (value === undefined || value === true || Array.isArray(value) || !Number.isFinite(result) || (integer && !Number.isInteger(result)) || result < (zero ? 0 : Number.EPSILON)) throw new Error(`${name} requires a ${zero ? 'nonnegative' : 'positive'} ${integer ? 'integer' : 'number'}`);
  return result;
}
// Goal 5: a normal review run has no quantity or time caps. The attempt, fetch and stage-deadline limits are
// optional: omitted (flag and review-policy budgets) or 0 means unbounded, so `review run` finishes all due work.
// An explicit positive value is kept. Per-call adapter timeouts still guard a single hung call.
function limitOption(value, name, { integer = true } = {}) {
  if (value === undefined || value === null) return Infinity;
  const result = numberOption(value, name, { zero: true, integer });
  return result === 0 ? Infinity : result;
}
const isBusy = (db, now) => db.prepare("SELECT heartbeat_at FROM runs WHERE kind='review' AND status='running'").all().some((row) => Date.parse(now) - Date.parse(row.heartbeat_at) <= 600000);

export function reviewSizeResolver(context, inputs, runtime = {}) {
  const parts = runtime.review?.companySize ?? {};
  return createCompanySizeResolver({ profileDir: path.join(context.root, '.career-journal', 'profile'), reviewPolicy: inputs.policy,
    askJev: parts.askJev, askModel: parts.askModel, runImpl: parts.runImpl, jevAdapter: parts.jev, claudeClient: parts.claudeClient });
}

export async function reviewWithContext(context, runtime = {}, options = {}) {
  const now = runtime.now?.() ?? new Date().toISOString();
  const runId = options['run-id'] ?? `review-${randomUUID()}`;
  if (isBusy(context.db, now)) return { schema: 1, kind: 'review', run_id: runId, status: 'busy', run_date: localDate(now, context.config.timezone), finished: null };
  const inputs = await loadReviewInputs(context.root);
  const budgets = inputs.policy.budgets ?? {};
  const judges = runtime.review?.judges ?? createJudgeAdapters(inputs.policy);
  const secondOpinion = runtime.review?.secondOpinion ?? createSecondOpinion(inputs.policy);
  const jev = runtime.review?.jev ?? createJevSplit(inputs.policy);
  const fetcher = runtime.review?.fetcher ?? politeFetcher(inputs.policy.fetcher?.argv
    ? commandFetcher(inputs.policy.fetcher) : builtinFetcher({ fetchImpl: runtime.fetch ?? globalThis.fetch, timeoutMs: inputs.policy.fetcher?.timeoutMs ?? 30000 }));
  const receipt = await runReview({ db: context.db, runId, parentRunId: options['parent-run-id'], owner: `review-${process.pid}`,
    now, budget: limitOption(options.budget ?? budgets.attempts, '--budget'),
    maxFetches: limitOption(options['max-fetches'] ?? budgets.fetches, '--max-fetches'),
    concurrency: numberOption(options.concurrency ?? budgets.concurrency ?? 1, '--concurrency'),
    deadlineMs: limitOption(options['deadline-min'] ?? budgets.deadlineMin, '--deadline-min', { integer: false }) * 60000,
    deadlineAt: options['deadline-at'], fetcher, judges, secondOpinion, jev, attemptDir: path.join(context.root, '.career-journal', 'attempts'),
    inputs: () => loadReviewInputs(context.root), hooks: runtime.review?.hooks ?? {},
    // Company size is decided once per company before the judge loop (hook in worker.mjs): one Jev question,
    // then one codex call when Jev is in between. Tests and callers may inject the whole resolver or its parts.
    resolveCompanySizes: runtime.review?.resolveCompanySizes ?? reviewSizeResolver(context, inputs, runtime) });
  receipt.run_date = localDate(now, context.config.timezone);
  if (receipt.status !== 'busy') {
    context.db.prepare('UPDATE runs SET receipt_json=? WHERE run_id=?').run(redact(JSON.stringify(receipt)), receipt.run_id);
    await writeReceipt(context.root, receipt);
  }
  return receipt;
}

export async function reviewCommand(parsed, io, runtime = {}) {
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  const options = parsed.options;
  const now = runtime.now?.() ?? new Date().toISOString();
  const emit = (value) => io.out(redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
  try {
    switch (parsed.subcommand) {
      case 'run': { const receipt = await reviewWithContext(context, runtime, options); emit(receipt); return reviewExitCode(receipt); }
      case 'release-holds': {
        if (isBusy(context.db, now)) throw new Error('A review run is active');
        const inputs = await loadReviewInputs(context.root);
        if (isBusy(context.db, now)) throw new Error('A review run is active');
        emit(releaseHolds(context.db, { now, provenance: inputs.provenance, inputs })); return 0;
      }
      case 'redecide': {
        if (options.held !== true || options.done !== undefined && options.done !== true) throw new Error('Usage: career-journal review redecide --held [--done] [--posting <id>]... [--json]');
        const postingIds = options.posting === undefined ? null : [options.posting].flat();
        if (postingIds && !postingIds.every((id) => typeof id === 'string' && id.trim())) throw new Error('--posting requires a posting id');
        if (isBusy(context.db, now)) throw new Error('A review run is active');
        const inputs = await loadReviewInputs(context.root);
        const judges = runtime.review?.judges ?? createJudgeAdapters(inputs.policy);
        await Promise.all(Object.values(judges).map((adapter) => adapter.ready));
        if (isBusy(context.db, now)) throw new Error('A review run is active');
        emit(await redecideReviews(context.db, { inputs, judges, held: true, done: options.done === true, now, postingIds }));
        return 0;
      }
      case 'reclassify': {
        const dryRun = options['dry-run'] === true;
        const batch = numberOption(options.batch ?? 500, '--batch');
        if (!dryRun && isBusy(context.db, now)) throw new Error('A review run is active');
        const profile = await loadScanProfile(context.root, { path: profileOption(parsed) });
        emit(reclassifyReviews(context.db, { policy: await scanPolicy(context), profile, now, dryRun, batch }));
        return 0;
      }
      case 'rejudge': {
        const apply = options.apply === true;
        if (apply && activeRun(context.db, now)) { emit({ status: 'busy', reason: 'a scan or review run is active' }); return 75; }
        const inputs = await loadReviewInputs(context.root);
        emit(rejudgeReviews(context.db, { now, apply, companyAliases: deliveryPolicy(inputs).companyAliases ?? {},
          codes: options.code === undefined ? null : listOption(options.code, '--code'), leads: options.leads === true,
          postings: options.posting === undefined ? null : listOption(options.posting, '--posting'),
          company: options.company === undefined ? null : required(options.company, '--company'),
          since: options.since === undefined ? null : required(options.since, '--since') }));
        return 0;
      }
      case 'settle-backlog': {
        const apply = options.apply === true;
        if (apply && activeRun(context.db, now)) { emit({ status: 'busy', reason: 'a scan or review run is active' }); return 75; }
        const profile = await loadScanProfile(context.root, { path: profileOption(parsed) });
        emit(settleBacklog(context.db, { policy: await scanPolicy(context), profile, now, apply }));
        return 0;
      }
      case 'hold': {
        const postingId = required(options.posting, '--posting');
        if (leasedByLiveRun(context.db, postingId, now)) { emit({ postingId, status: 'busy' }); return 75; }
        const inputs = await loadReviewInputs(context.root);
        const result = holdReview(context.db, { postingId, code: required(options.code, '--code'), reason: required(options.reason, '--reason'), now, policy: deliveryPolicy(inputs) });
        emit(result); return result.status === 'busy' ? 75 : 0;
      }
      case 'bootstrap': { const inputs = await loadReviewInputs(context.root); emit(bootstrapExisting(context.db, { provenance: inputs.provenance, policy: inputs.screeningPolicy, now })); return 0; }
      case 'list': {
        const rows = context.db.prepare(`SELECT r.*,p.company,p.title,p.canonical_url url FROM reviews r JOIN postings p ON p.id=r.posting_id${options.held ? " WHERE r.state='held'" : ''} ORDER BY r.first_seen,r.posting_id`).all();
        emit(rows); return 0;
      }
      case 'report': {
        const runId = options['run-id'];
        const row = runId && context.db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId);
        const receipt = runId ? await readRunReceipt(context.root, runId) ?? (row && parseJson(row.receipt_json)) : null;
        if (runId && !receipt) throw new Error(`Receipt not found: ${runId}`);
        const parent = receipt?.parent_run_id;
        const scans = context.db.prepare(`SELECT receipt_json FROM runs WHERE kind='scan'${parent ? ' AND parent_run_id=?' : " ORDER BY started_at DESC LIMIT 1"}`).all(...(parent ? [parent] : [])).map((r) => parseJson(r.receipt_json));
        emit(reviewReport(context.db, { receipt, sourceReceipts: scans, lang: options.lang ?? 'en' })); return 0;
      }
      case 'receipt': {
        let result;
        if (options['run-id']) result = await readRunReceipt(context.root, options['run-id']);
        else {
          const current = await readCurrentReceipt(context.root, { date: localDate(now, context.config.timezone) });
          if (['stale','missing'].includes(current.state)) { emit({ state: current.state }); return 2; }
          result = current.receipt;
        }
        if (!result) throw new Error('Current receipt missing');
        // --summary [zh]: one plain line (status, fetched/stored, judged, eligible, due left, holds, stop reason), then errors.
        emit(options.summary ? `${nightlySummary(result, { lang: options.summary === 'zh' ? 'zh' : 'en' })}${result.errors?.length ? `; ${JSON.stringify(result.errors)}` : ''}` : result); return reviewExitCode(result);
      }
      case 'daily-finalize': {
        const raw = options.stage === undefined ? [] : [options.stage].flat();
        if (!raw.length) throw new Error('--stage is required');
        const stages = raw.map((value) => {
          const match = /^([^=]+)=(ok|partial|failed|busy|unknown|interrupted)(?::(.+))?$/.exec(value);
          if (!match) throw new Error(`Invalid stage: ${value}`);
          return { name: match[1], status: match[2], ...(match[3] ? { runId: match[3] } : {}) };
        });
        const receipt = await finalizeDailyReceipt(context.db, context.root, { dailyId: required(options['run-id'], '--run-id'), stages, now, timezone: context.config.timezone });
        emit(receipt); return reviewExitCode(receipt);
      }
      case 'add': {
        const url = required(options.url, '--url'); const company = required(options.company, '--company'); const title = required(options.title, '--title');
        const result = atomic(context.db, () => {
          const resolved = resolvePosting(context.db, { source: 'manual', sourceId: url, company, title, url }, { now });
          context.db.prepare(`INSERT INTO reviews(posting_id,stage,state,lane,flags_json,next_due,first_seen,updated_at) VALUES (?,'fetch','due','new','["manual"]',?,?,?) ON CONFLICT(posting_id) DO NOTHING`).run(resolved.postingId, now, now, now);
          return resolved;
        });
        emit({ ...result, manual: true }); return 0;
      }
      case 'attach': {
        const postingId = required(options.posting, '--posting'); const file = required(options.file, '--file');
        if ((await stat(file)).size > 2_000_000) throw new Error('Attachment too_large');
        const content = await readFile(file, 'utf8');
        const posting = context.db.prepare('SELECT * FROM postings WHERE id=?').get(postingId);
        if (!posting) throw new Error('Unknown posting');
        let result; try { result = JSON.parse(content); } catch { result = { text: content }; }
        if (result.ok !== undefined && !validateSnapshot(posting, result).identityOk) throw new Error('Attachment identity validation failed');
        if (!result.text?.trim()) throw new Error('Attachment text is empty');
        // The page decides before any model sees it: a gone page settles closed, a page with no posting body is refused.
        const closed = closedPageWording(result.text);
        if (!closed && isStubText(result.text)) throw new Error('Attachment too_short: the page shows no posting');
        const inputs = closed ? await loadReviewInputs(context.root) : null;
        if (leasedByLiveRun(context.db, postingId, now)) { emit({ postingId, status: 'busy' }); return 75; }
        let busy = false;
        atomic(context.db, () => {
          if (leasedByLiveRun(context.db, postingId, now)) { busy = true; return; }
          context.db.prepare(`INSERT INTO snapshots(id,posting_id,content_hash,fetched_at,final_url,method,identity_ok,fields_json,sections_json,text) VALUES (?,?,?,?,?,'manual',1,?,?,?)`)
            .run(randomUUID(), postingId, dependencyHash({ text: result.text, title: result.title, requisitionId: result.requisitionId, locations: result.locations, jsonLd: result.jsonLd }), now, result.finalUrl ?? posting.canonical_url, JSON.stringify({ ...result, text: undefined }), JSON.stringify(segmentSections(result.text)), result.text);
          context.db.prepare("UPDATE reviews SET state='due',stage='judge',next_due=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE posting_id=?").run(now, now, postingId);
          if (closed) {
            const fence = claimItem(context.db, postingId, { owner: 'review-attach', now }); if (!fence) throw new Error('Review is leased');
            context.db.prepare("UPDATE postings SET availability='closed_verified',updated_at=? WHERE id=?").run(now, postingId);
            deliver(context.db, { postingId, fence, now, policy: deliveryPolicy(inputs), verdict: { decision: 'not_eligible', code: 'closed_verified' } });
          }
        });
        if (busy) { emit({ postingId, status: 'busy' }); return 75; }
        emit({ postingId, method: 'manual', ...(closed ? { closed } : {}) }); return 0;
      }
      case 'annotate': {
        if (options.hits) {
          const file = required(options.hits, '--hits'); if ((await stat(file)).size > 20_000_000) throw new Error('Mail batch too_large');
          const hits = (await readFile(file, 'utf8')).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
          const matches = matchMailHits(context.db, hits, { now });
          atomic(context.db, () => matches.forEach((match, index) => {
            if (match.postingId) annotateMail(context.db, { postingId: match.postingId, match: match.match, messageId: hits[index].messageId, subject: hits[index].subject, received: hits[index].receivedAt, matched: match.token, now });
          })); emit(matches);
        } else {
          annotateMail(context.db, { postingId: required(options.posting, '--posting'), match: options.mail, messageId: options['message-id'], subject: options.subject, received: options.received, matched: options.matched, now }); emit({ annotated: true });
        } return 0;
      }
      case 'unhide': { unhide(context.db, { postingId: required(options.posting, '--posting'), now }); emit({ unhidden: true }); return 0; }
      case 'resolve': {
        const postingId = required(options.posting, '--posting');
        const decision = ({ ok: 'eligible', skip: 'not_eligible' })[options.result] ?? options.decision ?? options.result;
        if (!['eligible','not_eligible'].includes(decision)) throw new Error('--result must be eligible or not_eligible');
        const reason = required(options.reason, '--reason');
        const row = context.db.prepare('SELECT * FROM reviews WHERE posting_id=?').get(postingId); if (!row) throw new Error('Unknown review');
        const inputs = await loadReviewInputs(context.root);
        atomic(context.db, () => {
          const fence = claimItem(context.db, postingId, { owner: 'user-resolve', now }); if (!fence) throw new Error('Review is leased');
          deliver(context.db, { postingId, fence, now, policy: deliveryPolicy(inputs), explicit: true, verdict: { ...parseJson(row.evidence_json), decision, code: decision === 'not_eligible' ? 'user_declined' : null } });
          logReview(context.db, postingId, { now, kind: 'user', payload: { decision, reason, actor: 'user' } });
        }); emit({ postingId, decision }); return 0;
      }
      case 'ledger': { const ids = options.posting ? [options.posting].flat() : context.db.prepare('SELECT id FROM postings WHERE merged_into IS NULL').all().map((p) => p.id); emit(postingLedger(context.db, ids)); return 0; }
      case 'audit': { if (!options.duplicates) throw new Error('--duplicates is required'); emit(duplicateGroups(context.db, { since: options.since })); return 0; }
      case 'eval': {
        const { runEval, saveEvalRecord } = await import('../review/eval.mjs');
        const inputs = await loadReviewInputs(context.root);
        const judges = runtime.review?.judges ?? createJudgeAdapters(inputs.policy);
        const secondOpinion = runtime.review?.secondOpinion ?? createSecondOpinion(inputs.policy);
        const jev = runtime.review?.jev ?? createJevSplit(inputs.policy);
        const result = await runEval({ setDir: required(options.set, '--set'), judges, secondOpinion, jev,
          judgePolicy: inputs.policy.judge, concurrency: numberOption(options.concurrency ?? 3, '--concurrency') });
        if (result.pass) await saveEvalRecord(context.root, result.record);
        emit(result); return result.pass ? 0 : 1;
      }
      default: throw new Error(usage);
    }
  } finally { context.db.close(); }
}
