// Regressions from the 2026-10-27 real-data trial run of `review run` on the screening funnel (rulings T1–T3).
// What the trial showed, read-only from its stderr and database:
//   - T1: the run judged its items and then crashed while writing the receipt with
//     "Cannot read properties of undefined (reading 'maxWaitNights')": the breach check reads
//     policy.serviceTargets.maxWaitNights, but the shipped config/review-policy.example.json (and the user's
//     policy) has no serviceTargets block.
//   - T2: exploration-lane items (no_student_signal, out_of_direction) were held for the user, e.g. full-time
//     legal and lead roles held as missing_fact / requirement_unclear / user_review "function_unclear".
//   - T3: the awaiting-user list repeats one line per posting, so a single missing fact asked many times over.
// Rulings:
//   T1 serviceTargets is optional; missing keys default to { agedAfterDays: 2, agedReserveShare: 0.25,
//      maxWaitNights: 7 }. The run finishes and writes its receipt.
//   T2 An exploration-lane item is never held for the user. An eligible decision is delivered normally with the
//      flag `found_by_sampling`; any other outcome (not_eligible, unclear, any hold code) ends as
//      done / not_eligible with code equal to its lane (no_student_signal or out_of_direction). The receipt
//      counts them as `sampling: { judged, found }`. No user question is created. Other lanes are unchanged.
//   T3 Awaiting-user holds are grouped by the missing fact, so one answer resolves many postings: `review report`
//      and the receipt list each distinct missing fact id (or, when the hold cites none, the normalized
//      question) once, with the count and the posting list, ordered by count descending.
//      Receipt contract used here: `receipt.awaiting_user` keeps its per-posting entries (existing tests read
//      them) and `receipt.awaiting_user_summary` is [{ key, count, postings }] where key is the fact id or the
//      normalized question and postings lists posting ids.
// Synthetic data only: every employer, posting, fact id and URL is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, load, insertPosting, insertReview, reviewOf, fakeJudge, fakeFetcher, T0, at } from '../../test-utils/funnel-v3.mjs';
import { REVIEW_POLICY, SNAPSHOTS, JUDGMENTS, judgment, page, snapshotTitle, reviewInputs } from '../../test-utils/funnel-v3-fixtures.mjs';

const workerModule = () => load('B6', './src/review/worker.mjs', ['runReview']);
const reportModule = () => load('B7', './src/review/report.mjs', ['reviewReport']);

// ------------------------------------------------------------------ harness (as in the lane B tests)

function queue() {
  const pages = {};
  return {
    pages,
    add(db, { id, text, lane = 'new', firstSeen = T0 }) {
      const url = `https://job-boards.greenhouse.io/examplecorp/jobs/${id}`;
      insertPosting(db, { id, url, company: 'Example Corp', title: snapshotTitle(text), firstSeen });
      insertReview(db, { postingId: id, stage: 'fetch', firstSeen, nextDue: T0, lane });
      pages[url] = page(url, text);
      return url;
    },
  };
}

function runOptions(db, { now = T0, runId = 'review-trial', budget = 10, answers = {}, pages = {}, inputs, ...rest } = {}) {
  return {
    db, runId, owner: 'worker-a', now, budget, deadlineMs: 600_000, attemptDir: null, sleep: async () => {},
    fetcher: fakeFetcher(pages),
    judges: { primary: fakeJudge({ tier: 'primary', answers }), escalation: fakeJudge({ tier: 'escalation', answers }) },
    inputs: inputs ?? (() => reviewInputs()),
    hooks: {},
    ...rest,
  };
}

const applicationOf = (db, postingId) => db.prepare('SELECT a.* FROM postings p JOIN applications a ON a.id = p.application_id WHERE p.id = ?').get(postingId);
const flagsOf = (db, postingId) => JSON.parse(reviewOf(db, postingId).flags_json ?? '[]');

// A required clause that cites one fact id the candidate's facts do not contain, so the decision is missing_fact.
const KUBERNETES = 'Hands-on experience operating Kubernetes clusters.';
function requirementPosting(title, clause) {
  return SNAPSHOTS.missingFact.replace('Platform Data Intern', title).replace(KUBERNETES, clause);
}
const citing = (factId, clause) => ({ output: judgment({ criteria: [{ key: 'requirement', status: 'conflicts', quote: clause, clause_alternatives: [], fact_ids: [factId] }] }) });
const retitled = (snapshot, title) => snapshot.replace(snapshotTitle(snapshot), title);

// The "## Awaiting you" section of an English report, up to the next heading.
function awaitingSection(report) {
  const lines = report.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Awaiting you');
  assert.ok(start >= 0, `report has an Awaiting you section:\n${report}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}
const occurrences = (lines, pattern) => lines.join('\n').match(new RegExp(pattern, 'gi'))?.length ?? 0;

// ------------------------------------------------------------------ T1

test('[B] a review policy without serviceTargets uses the defaults and the run finishes with its receipt (trial T1)', async () => {
  const { runReview } = await workerModule();
  const db = freshDb();
  // The user's policy, like config/review-policy.example.json, has neither serviceTargets nor freshness.
  const { serviceTargets, freshness, ...policy } = REVIEW_POLICY;
  assert.equal(serviceTargets.maxWaitNights, 3, 'fixture sanity: the full fixture policy would breach at 3 nights');
  const q = queue();
  q.add(db, { id: 'p-five-nights', text: SNAPSHOTS.eligible, firstSeen: at(-5) });
  q.add(db, { id: 'p-eight-nights', text: SNAPSHOTS.eligible, firstSeen: at(-8) });
  // Budget 0 leaves both items due, so the receipt must age them against the service target.
  const receipt = await runReview(runOptions(db, { budget: 0, pages: q.pages, inputs: () => reviewInputs({ policy }) }));
  assert.equal(receipt.finished, T0, 'the run finishes');
  assert.ok(['ok', 'partial'].includes(receipt.status), `run status ${receipt.status}`);
  const breached = receipt.breaches.map((item) => item.postingId);
  assert.ok(breached.includes('p-eight-nights'), `8 nights waiting is past the default maxWaitNights of 7: ${JSON.stringify(receipt.breaches)}`);
  assert.equal(breached.includes('p-five-nights'), false, '5 nights waiting is within the default maxWaitNights of 7');
  const row = db.prepare('SELECT status, receipt_json FROM runs WHERE run_id = ?').get('review-trial');
  assert.ok(row && ['ok', 'partial'].includes(row.status), `the run row is closed, not left running: ${row?.status}`);
  assert.equal(JSON.parse(row.receipt_json).finished, T0, 'the receipt is written to the run row');
});

// ------------------------------------------------------------------ T2

test('[B] exploration-lane items are never held for the user: eligible is delivered as found_by_sampling, anything else ends not_eligible with the lane as code (trial T2)', async () => {
  const { runReview } = await workerModule();
  const { reviewReport } = await reportModule();
  const db = freshDb();
  const q = queue();
  const answers = {};
  const urls = {};
  urls.found = q.add(db, { id: 'p-sample-found', lane: 'no_student_signal', text: retitled(SNAPSHOTS.eligible, 'Data Science Intern Sampled') });
  answers['p-sample-found'] = { output: JUDGMENTS.eligible };
  const factClause = 'Experience running production container clusters.';
  urls.fact = q.add(db, { id: 'p-sample-fact', lane: 'out_of_direction', text: requirementPosting('Lead Data Scientist Example', factClause) });
  answers['p-sample-fact'] = citing('cluster-ops', factClause);
  urls.function = q.add(db, { id: 'p-sample-function', lane: 'no_student_signal', text: retitled(SNAPSHOTS.sales, 'Revenue Insights Analyst Sampled') });
  answers['p-sample-function'] = { output: JUDGMENTS.sales };
  urls.conflict = q.add(db, { id: 'p-sample-conflict', lane: 'out_of_direction', text: retitled(SNAPSHOTS.undergradOnly, 'Analytics Intern Sampled') });
  answers['p-sample-conflict'] = { output: JUDGMENTS.undergradOnly };
  // Control: the same missing-fact outcome in an ordinary lane is still held for the user.
  q.add(db, { id: 'p-control', lane: 'new', text: requirementPosting('Platform Data Intern Control', factClause) });
  answers['p-control'] = citing('cluster-ops', factClause);

  // Budget 40 gives an exploration share of ceil(40 * 0.10) = 4, so all four sampled items are judged.
  const receipt = await runReview(runOptions(db, { budget: 40, answers, pages: q.pages }));

  const found = reviewOf(db, 'p-sample-found');
  assert.equal(found.state, 'done');
  assert.equal(found.decision, 'eligible');
  assert.ok(flagsOf(db, 'p-sample-found').includes('found_by_sampling'), `an eligible exploration item carries found_by_sampling: ${found.flags_json}`);
  assert.equal(applicationOf(db, 'p-sample-found')?.skip_reason ?? null, null, 'and is delivered as a visible application');

  for (const [id, lane, judged] of [['p-sample-fact', 'out_of_direction', 'missing_fact'], ['p-sample-function', 'no_student_signal', 'user_review'], ['p-sample-conflict', 'out_of_direction', 'degree']]) {
    const row = reviewOf(db, id);
    assert.deepEqual({ state: row.state, decision: row.decision, code: row.code, hold_owner: row.hold_owner },
      { state: 'done', decision: 'not_eligible', code: lane, hold_owner: null }, `${id} (judged ${judged}) ends not_eligible with its lane as code`);
    const app = applicationOf(db, id);
    assert.equal(/^待核/.test(app?.skip_reason ?? ''), false, `${id} leaves no held application: ${app?.skip_reason}`);
  }

  const control = reviewOf(db, 'p-control');
  assert.deepEqual({ state: control.state, code: control.code, hold_owner: control.hold_owner }, { state: 'held', code: 'missing_fact', hold_owner: 'user' },
    'an ordinary-lane missing fact is still held for the user');
  assert.deepEqual(receipt.awaiting_user.map((item) => item.postingId), ['p-control'], 'only the ordinary-lane item awaits the user');
  assert.deepEqual(receipt.sampling ?? receipt.counts?.sampling, { judged: 4, found: 1 }, `receipt counts sampling: ${JSON.stringify(receipt)}`);

  const awaiting = awaitingSection(reviewReport(db, { receipt }));
  for (const url of Object.values(urls)) assert.equal(awaiting.join('\n').includes(url), false, `no user question for the sampled ${url}`);
});

// ------------------------------------------------------------------ T3

test('[B] the report and the receipt group awaiting-user holds by missing fact (or normalized question), with count and postings, by count descending (trial T3)', async () => {
  const { runReview } = await workerModule();
  const { reviewReport } = await reportModule();
  const db = freshDb();
  const q = queue();
  const answers = {};
  // Three postings worded differently that all need the same unknown fact: one answer resolves all three.
  const clusterClauses = {
    'p-fact-alpha': 'Hands-on experience operating Kubernetes clusters.',
    'p-fact-bravo': 'Experience running production container clusters.',
    'p-fact-charlie': 'Practical knowledge of container orchestration platforms.',
  };
  const urls = {};
  for (const [id, clause] of Object.entries(clusterClauses)) {
    urls[id] = q.add(db, { id, text: requirementPosting(`Platform Data Intern ${id.slice(7)}`, clause) });
    answers[id] = citing('cluster-ops', clause);
  }
  const clearance = 'Must hold an active security clearance.';
  urls['p-clear-delta'] = q.add(db, { id: 'p-clear-delta', text: requirementPosting('Platform Data Intern delta', clearance) });
  answers['p-clear-delta'] = citing('clearance-active', clearance);
  // Two user_review holds that cite no fact share one question.
  for (const id of ['p-sales-echo', 'p-sales-foxtrot']) {
    urls[id] = q.add(db, { id, text: retitled(SNAPSHOTS.sales, `Revenue Insights Analyst Intern ${id.slice(8)}`) });
    answers[id] = { output: JUDGMENTS.sales };
  }

  const receipt = await runReview(runOptions(db, { budget: 20, answers, pages: q.pages }));
  assert.equal(receipt.awaiting_user.length, 6, `fixture sanity: six holds await the user: ${JSON.stringify(receipt.awaiting_user)}`);

  const SALES_QUESTION = 'would you like to consider this sales role';
  const ids = (postings) => (postings ?? []).map((item) => (typeof item === 'string' ? item : item.postingId)).sort();
  const summary = receipt.awaiting_user_summary;
  assert.ok(Array.isArray(summary), `receipt.awaiting_user_summary lists the groups: ${JSON.stringify(receipt)}`);
  assert.equal(summary.length, 3, `one group per missing fact or question (not one per cited constraint such as degree): ${JSON.stringify(summary)}`);
  assert.deepEqual({ key: summary[0].key, count: summary[0].count, postings: ids(summary[0].postings) },
    { key: 'cluster-ops', count: 3, postings: ['p-fact-alpha', 'p-fact-bravo', 'p-fact-charlie'] });
  assert.match(String(summary[1].key), new RegExp(SALES_QUESTION, 'i'), 'a hold citing no fact is grouped by its question');
  assert.deepEqual({ count: summary[1].count, postings: ids(summary[1].postings) }, { count: 2, postings: ['p-sales-echo', 'p-sales-foxtrot'] });
  assert.deepEqual({ key: summary[2].key, count: summary[2].count, postings: ids(summary[2].postings) },
    { key: 'clearance-active', count: 1, postings: ['p-clear-delta'] });

  const awaiting = awaitingSection(reviewReport(db, { receipt }));
  const groups = [['cluster-ops', 3], [SALES_QUESTION, 2], ['clearance-active', 1]];
  for (const [key] of groups) assert.equal(occurrences(awaiting, key), 1, `"${key}" is listed once:\n${awaiting.join('\n')}`);
  const headers = groups.map(([key]) => awaiting.findIndex((line) => new RegExp(key, 'i').test(line)));
  assert.ok(headers[0] < headers[1] && headers[1] < headers[2], `groups ordered by count descending:\n${awaiting.join('\n')}`);
  groups.forEach(([key, count], index) => {
    assert.match(awaiting[headers[index]], new RegExp(`(^|\\D)${count}(\\D|$)`), `the "${key}" group shows its count ${count}`);
  });
  const members = { 0: ['p-fact-alpha', 'p-fact-bravo', 'p-fact-charlie'], 1: ['p-sales-echo', 'p-sales-foxtrot'], 2: ['p-clear-delta'] };
  for (const [index, postings] of Object.entries(members)) {
    const block = awaiting.slice(headers[index], headers[Number(index) + 1] ?? awaiting.length).join('\n');
    for (const id of postings) {
      assert.ok(block.includes(urls[id]), `${id} is listed under its group "${groups[index][0]}":\n${awaiting.join('\n')}`);
      assert.equal(occurrences(awaiting, urls[id].replaceAll('.', '\\.')), 1, `${id} is listed once`);
    }
  }
});

// ------------------------------------------------------------------ T4: parallel fetching across hosts
// Live drain (2026-10-27): 4,001 of 4,002 due items sat at stage fetch while only two judges ran; the worker
// fetched each batch one posting at a time (`for … await fetchItem(row)`). Ruling: a fetch batch runs in parallel,
// up to `concurrency` requests in flight, still at most one request at a time per host.

test('[B] a fetch batch runs in parallel across hosts and stays one-at-a-time per host (trial T4)', async () => {
  const { runReview } = await workerModule();
  const db = freshDb();
  const pages = {};
  let inFlight = 0; let maxInFlight = 0; const hostBusy = new Map(); let hostOverlap = false;
  const text = SNAPSHOTS.eligible;
  const add = (id, host) => {
    const url = `https://${host}/jobs/${id}`;
    insertPosting(db, { id, url, company: 'Example Corp', title: snapshotTitle(text) });
    insertReview(db, { postingId: id, stage: 'fetch', firstSeen: T0, nextDue: T0, lane: 'new' });
    pages[url] = async () => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      if (hostBusy.get(host)) hostOverlap = true;
      hostBusy.set(host, true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      hostBusy.set(host, false); inFlight -= 1;
      return page(url, text);
    };
  };
  for (let i = 0; i < 6; i += 1) add(`p-${i}`, `jobs${i}.example.test`);
  add('p-same-a', 'shared.example.test'); add('p-same-b', 'shared.example.test');
  await runReview(runOptions(db, { budget: 40, concurrency: 4, pages }));
  assert.ok(maxInFlight >= 3, `fetches overlap across hosts (max in flight ${maxInFlight})`);
  assert.ok(maxInFlight <= 4, `no more than concurrency in flight (max ${maxInFlight})`);
  assert.equal(hostOverlap, false, 'one request at a time per host');
});

// ------------------------------------------------------------------ T5: a continuous judge pool
// Live drain (2026-10-27): about 110 postings per hour with concurrency 8. Judge batches ran under Promise.all, so
// every batch waited for its slowest item (a primary call plus an escalation), leaving most slots idle.
// Ruling: judging runs as a pool that keeps up to `concurrency` items in flight and refills a slot as soon as an
// item finishes; fetching ahead keeps the pool supplied.

test('[B] the judge pool refills free slots instead of waiting for the slowest item of a batch (trial T5)', async () => {
  const { runReview } = await workerModule();
  const db = freshDb();
  const q = queue();
  const ids = [];
  for (let i = 0; i < 12; i += 1) { const id = `p-pool-${i}`; ids.push(id); q.add(db, { id, text: SNAPSHOTS.eligible }); }
  let inFlight = 0; let maxInFlight = 0;
  const delayFor = (postingId) => (postingId === 'p-pool-0' || postingId === 'p-pool-4' || postingId === 'p-pool-8' ? 400 : 40);
  const slowJudge = (tier) => {
    const base = fakeJudge({ tier, answers: () => JUDGMENTS.eligible });
    return { ...base, async judge(request, context) {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayFor(request.postingId ?? context?.postingId)));
      inFlight -= 1;
      return base.judge(request, context);
    } };
  };
  const started = Date.now();
  await runReview(runOptions(db, { budget: 60, concurrency: 4, pages: q.pages, judges: { primary: slowJudge('primary'), escalation: slowJudge('escalation') } }));
  const elapsed = Date.now() - started;
  for (const id of ids) assert.equal(reviewOf(db, id).state, 'done', `${id} judged`);
  // Batches of 4 would wait 400 ms three times (≥ 1200 ms); a refilling pool finishes in roughly one slow call plus a few fast ones.
  assert.ok(elapsed < 900, `pool finished in ${elapsed} ms`);
  assert.ok(maxInFlight <= 4, `never more than concurrency in flight (${maxInFlight})`);
});
