import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { openHomeDatabase } from '../runtime/home.mjs';
import { redact } from '../runtime/redact.mjs';
import { loadReviewInputs, dependencyHash } from '../review/inputs.mjs';
import { createJudgeAdapters } from '../review/judge.mjs';
import { createSecondOpinion } from '../review/second-opinion.mjs';
import { runReview } from '../review/worker.mjs';
import { commandFetcher, builtinFetcher, politeFetcher, validateSnapshot } from '../review/fetch.mjs';
import { bootstrapExisting } from '../funnel/bootstrap.mjs';
import { resolvePosting, duplicateGroups } from '../funnel/identity.mjs';
import { segmentSections } from '../review/clauses.mjs';
import { reviewExitCode, writeReceipt, readRunReceipt, readCurrentReceipt, finalizeDailyReceipt, localDate } from '../review/receipt.mjs';
import { reviewReport } from '../review/report.mjs';
import { postingLedger } from '../review/ledger.mjs';
import { matchMailHits } from '../review/mail.mjs';
import { annotateMail, unhide, deliver, logReview, parseJson } from '../review/deliver.mjs';
import { claimItem, atomic } from '../review/lease.mjs';
import { redecideReviews } from '../review/redecide.mjs';

const usage = 'Usage: career-journal review run|redecide|bootstrap|list|report|receipt|attach|add|annotate|unhide|resolve|ledger|audit|daily-finalize|eval';
const required = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value; };
function numberOption(value, name, { zero = false, integer = true } = {}) {
  const result = Number(value);
  if (value === undefined || value === true || Array.isArray(value) || !Number.isFinite(result) || (integer && !Number.isInteger(result)) || result < (zero ? 0 : Number.EPSILON)) throw new Error(`${name} requires a ${zero ? 'nonnegative' : 'positive'} ${integer ? 'integer' : 'number'}`);
  return result;
}
const isBusy = (db, now) => db.prepare("SELECT heartbeat_at FROM runs WHERE kind='review' AND status='running'").all().some((row) => Date.parse(now) - Date.parse(row.heartbeat_at) <= 600000);

export async function reviewWithContext(context, runtime = {}, options = {}) {
  const now = runtime.now?.() ?? new Date().toISOString();
  const runId = options['run-id'] ?? `review-${randomUUID()}`;
  if (isBusy(context.db, now)) return { schema: 1, kind: 'review', run_id: runId, status: 'busy', run_date: localDate(now, context.config.timezone), finished: null };
  const inputs = await loadReviewInputs(context.root);
  const budgets = inputs.policy.budgets;
  if (!budgets) throw new Error('Review policy requires budgets');
  const judges = runtime.review?.judges ?? createJudgeAdapters(inputs.policy);
  const secondOpinion = runtime.review?.secondOpinion ?? createSecondOpinion(inputs.policy);
  const fetcher = runtime.review?.fetcher ?? politeFetcher(inputs.policy.fetcher?.argv
    ? commandFetcher(inputs.policy.fetcher) : builtinFetcher({ fetchImpl: runtime.fetch ?? globalThis.fetch, timeoutMs: inputs.policy.fetcher?.timeoutMs ?? 30000 }));
  const receipt = await runReview({ db: context.db, runId, parentRunId: options['parent-run-id'], owner: `review-${process.pid}`,
    now, budget: numberOption(options.budget ?? budgets.attempts, '--budget', { zero: true }),
    maxFetches: numberOption(options['max-fetches'] ?? budgets.fetches, '--max-fetches', { zero: true }),
    concurrency: numberOption(options.concurrency ?? budgets.concurrency, '--concurrency'),
    deadlineMs: numberOption(options['deadline-min'] ?? budgets.deadlineMin, '--deadline-min', { integer: false }) * 60000,
    deadlineAt: options['deadline-at'], fetcher, judges, secondOpinion, attemptDir: path.join(context.root, '.career-journal', 'attempts'),
    inputs: () => loadReviewInputs(context.root), hooks: runtime.review?.hooks ?? {} });
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
      case 'redecide': {
        if (options.held !== true || options.done !== undefined && options.done !== true) throw new Error('Usage: career-journal review redecide --held [--done] [--json]');
        if (isBusy(context.db, now)) throw new Error('A review run is active');
        const inputs = await loadReviewInputs(context.root);
        const judges = runtime.review?.judges ?? createJudgeAdapters(inputs.policy);
        await Promise.all(Object.values(judges).map((adapter) => adapter.ready));
        if (isBusy(context.db, now)) throw new Error('A review run is active');
        emit(await redecideReviews(context.db, { inputs, judges, held: true, done: options.done === true, now }));
        return 0;
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
        emit(options.summary ? `${result.run_id}: ${result.status}${result.stop_reason ? ` (${result.stop_reason})` : ''}${result.errors?.length ? `; ${JSON.stringify(result.errors)}` : ''}` : result); return reviewExitCode(result);
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
        atomic(context.db, () => {
          context.db.prepare(`INSERT INTO snapshots(id,posting_id,content_hash,fetched_at,final_url,method,identity_ok,fields_json,sections_json,text) VALUES (?,?,?,?,?,'manual',1,?,?,?)`)
            .run(randomUUID(), postingId, dependencyHash({ text: result.text, title: result.title, requisitionId: result.requisitionId, locations: result.locations, jsonLd: result.jsonLd }), now, result.finalUrl ?? posting.canonical_url, JSON.stringify({ ...result, text: undefined }), JSON.stringify(segmentSections(result.text)), result.text);
          context.db.prepare("UPDATE reviews SET state='due',stage='judge',next_due=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE posting_id=?").run(now, now, postingId);
        }); emit({ postingId, method: 'manual' }); return 0;
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
          deliver(context.db, { postingId, fence, now, policy: inputs.screeningPolicy, verdict: { ...parseJson(row.evidence_json), decision, code: decision === 'not_eligible' ? 'user_declined' : null } });
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
        const result = await runEval({ setDir: required(options.set, '--set'), judges, secondOpinion,
          judgePolicy: inputs.policy.judge, concurrency: numberOption(options.concurrency ?? 3, '--concurrency') });
        if (result.pass) await saveEvalRecord(context.root, result.record);
        emit(result); return result.pass ? 0 : 1;
      }
      default: throw new Error(usage);
    }
  } finally { context.db.close(); }
}
