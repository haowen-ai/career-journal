#!/usr/bin/env node
// Built-in read-only scan bridge for a pinned CareerOps checkout that does not ship its
// own career-journal-adapter.mjs. It runs CareerOps's own `scan.mjs --dry-run --json`
// inside the CareerOps root and prints the role list of the bridge contract
// (docs/integrations/careerops-bridge.md). CareerOps code is executed, never copied.
//
// A dry run writes nothing, and the bridge also points the scan history and pipeline at
// a temporary folder, so CareerOps data is never touched. CareerOps's title and location
// filters are tuned for its own pipeline; CAREER JOURNAL filters every role itself, so the
// scan reads a temporary copy of portals.yml whose title filter keeps internship and co-op
// titles and whose location filter is removed. The companies tracked there are unchanged.
//
//   node careerops-scan-bridge.mjs scan     (cwd: the CareerOps root)
//   stdin:  { "action": "scan", "readOnly": true }
//   stdout: { "ok": true, "roles": [...] }

import { executeCareerOpsProcess, installCareerOpsShutdown, MAX_RAW_SCAN_BYTES, parseResultLine, partitionEvent, PARTITION_EVENT, splitLines } from './careerops-process.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeListingId } from '../scan/listing-key.mjs';

export const WIDE_TITLE_FILTER = Object.freeze([
  'word:intern', 'word:interns', 'stem:internship', 'co-op', 'word:coop', 'stem:apprentice',
  'summer analyst', 'summer associate', 'working student', 'placement', 'word:student', 'stem:fellow',
  'stem:residen', 'graduate program', 'early career', 'university program', 'campus program', 'currently enrolled', 'class of',
]);

const REPLACED_SECTIONS = new Set(['title_filter', 'location_filter']);
const MAX_FIELD_CHARS = 4000;
const IDENTITY_FIELDS = new Set(['id', 'sourceId', 'source', 'company', 'company_name', 'title', 'url',
  'applyUrl', 'hostedUrl', 'jobUrl', 'location', 'locations', 'requisitionId', 'jobReqId', 'partition', 'listingId', 'externalId']);

// The listing ids each baselined list already has (CAREER JOURNAL writes them, src/scan/sources/careerops.mjs):
// { partition: [ids] } as a Map of Sets. No file, no known listings.
export function readKnownListings(file) {
  if (!file) return new Map();
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return new Map(Object.entries(parsed ?? {}).map(([partition, ids]) => [partition, new Set(Array.isArray(ids) ? ids.map(String) : [])]));
}

// Rewrites portals.yml text: drops the top-level title_filter and location_filter blocks and
// appends an internship-only title filter. Every other block, including tracked_companies,
// is kept as written.
export function widenPortals(text) {
  const kept = [];
  let skipping = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1];
    if (key) skipping = REPLACED_SECTIONS.has(key);
    if (!skipping) kept.push(line);
  }
  const filter = ['title_filter:', '  positive:', ...WIDE_TITLE_FILTER.map((term) => `    - ${JSON.stringify(term)}`), '  negative: []'];
  return `${kept.join('\n').replace(/\s*$/, '')}\n\n${filter.join('\n')}\n`;
}

const SUFFIX = /\s+\[(?:Trust: [^\]]*|BLACKLISTED[^\]]*)\]/g;

// Joins the receipt's added_urls (stdout) with the "+ Company | Title | Location" lines the
// scan prints for the same offers, in the same order (stderr in --json mode).
export function parseScanOutput(stdout, stderr) {
  const last = String(stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
  let receipt;
  try { receipt = JSON.parse(last ?? ''); } catch { throw new Error('CareerOps scan printed no JSON receipt'); }
  const urls = Array.isArray(receipt?.added_urls) ? receipt.added_urls : [];
  const lines = String(stderr ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('+ '));
  if (lines.length !== urls.length) throw new Error(`CareerOps scan listed ${lines.length} offers but returned ${urls.length} links`);
  const roles = [];
  urls.forEach((url, index) => {
    const parts = lines[index].slice(2).replace(SUFFIX, '').split(' | ').map((part) => part.trim());
    if (parts.length < 3) return;
    // CareerOps joins several offices with " | " too, so everything after the title is a location.
    // A title that itself contains " | " is rare and loses its tail to the locations.
    roles.push({
      id: url,
      company: parts[0],
      title: parts[1],
      url,
      locations: parts.slice(2).filter((location) => location && location !== 'N/A'),
      // The receipt date is the scan date, not the posting date, so no posting date is reported.
      postedAt: null,
      description: '',
    });
  });
  return { roles, errors: Array.isArray(receipt.errors) ? receipt.errors.length : 0 };
}

function run(command, args, options) {
  return executeCareerOpsProcess({ command, args, ...options });
}

export async function scanCareerOps(root, { execute = run, env = process.env, timeoutMs } = {}) {
  const portals = env.CAREER_OPS_PORTALS || path.join(root, 'portals.yml');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'career-journal-careerops-'));
  try {
    const widened = path.join(temporary, 'portals.yml');
    await writeFile(widened, widenPortals(await readFile(portals, 'utf8')));
    const execution = await execute(process.execPath, ['scan.mjs', '--dry-run', '--json'], {
      cwd: root,
      timeoutMs,
      env: {
        ...env,
        CAREER_OPS_ROOT: temporary,
        CAREER_OPS_PORTALS: widened,
        CAREER_OPS_SCAN_HISTORY: path.join(temporary, 'scan-history.tsv'),
        CAREER_OPS_PIPELINE: path.join(temporary, 'pipeline.md'),
      },
    });
    // Exit code 2 means some boards failed; the receipt still lists the rest.
    if (![0, 2].includes(execution.exitCode)) {
      throw new Error(`CareerOps scan exited with ${execution.exitCode}: ${String(execution.stderr ?? '').trim().slice(-1_000)}`);
    }
    return parseScanOutput(execution.stdout, execution.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// CareerOps HTTP helpers abort after 10 s; large official boards (Lever's Spotify list is
// about 0.8 MB) sometimes take longer. Calls without their own timeout get this one, and an
// entry can set `timeout_ms` in portals.yml.
export const DEFAULT_ENTRY_TIMEOUT_MS = 30_000;
// Hosts read at the same time when config careerOps.scanConcurrency is not set.
export const DEFAULT_SCAN_CONCURRENCY = 8;
// A transient failure is retried in the same run so one slow response does not drop a board
// for the night. A definite answer (404, a parse error, a missing provider) is not retried.
export const RETRY_DELAYS_MS = Object.freeze([2_000, 5_000]);
const TRANSIENT_MESSAGE = /\babort|\btimed? ?out\b|timeout|fetch failed|socket|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR/i;

export function isTransientError(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (Number.isInteger(status) && status > 0) return status === 429 || status >= 500;
  return TRANSIENT_MESSAGE.test(`${error?.name ?? ''} ${error?.message ?? ''} ${error?.cause?.code ?? ''} ${error?.cause?.message ?? ''}`);
}

function withEntryTimeout(ctx, entry) {
  const configured = Number(entry.timeout_ms ?? entry.timeoutMs);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ENTRY_TIMEOUT_MS;
  const wrapped = { ...ctx };
  for (const name of ['fetchJson', 'fetchText', 'fetchResponse']) {
    if (typeof ctx?.[name] === 'function') wrapped[name] = (url, opts = {}) => ctx[name](url, { timeoutMs, ...opts });
  }
  return wrapped;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Default per-fetch ceilings of CareerOps providers (career-ops providers/*.mjs). A list that ends
// exactly at its effective ceiling was cut off silently, so it is reported as `cap`, never as a
// complete census. Entries can raise them: SuccessFactors `max_jobs` (default 1,000), Oracle Cloud
// `max_pages` x 200 (default 25 pages), SmartRecruiters `max_pages` x 100 (default 50 pages),
// Workday `max_pages` x 20, Radancy `max_jobs` (default 2,000), JibeApply `max_pages` x 10 (default 50 pages).
export const PROVIDER_CEILINGS = Object.freeze({ successfactors: 1_000, oraclecloud: 5_000, smartrecruiters: 5_000 });
const PAGE_SIZES = Object.freeze({ oraclecloud: 200, smartrecruiters: 100 });

const positive = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

// The number of jobs at which a provider stops on its own for this entry, or null when unknown.
export function providerCeiling(providerId, entry = {}, portals = {}) {
  if (providerId === 'workday') {
    const maxPages = positive(entry.max_pages ?? entry.maxPages ?? entry.workday?.max_pages ?? portals.workday?.max_pages) ?? 100;
    return maxPages * 20;
  }
  if (providerId === 'radancy' || providerId === 'successfactors') {
    return positive(entry.max_jobs ?? entry.maxJobs) ?? (providerId === 'radancy' ? 2_000 : PROVIDER_CEILINGS.successfactors);
  }
  if (providerId === 'jibeapply') {
    // 10 jobs per page; max_pages defaults to 50 and is bounded by the provider's 5,000-page cap.
    return Math.min(positive(entry.max_pages ?? entry.maxPages) ?? 50, 5_000) * 10;
  }
  if (PAGE_SIZES[providerId]) {
    const maxPages = positive(entry.max_pages ?? entry.maxPages);
    return maxPages ? maxPages * PAGE_SIZES[providerId] : PROVIDER_CEILINGS[providerId];
  }
  return PROVIDER_CEILINGS[providerId] ?? null;
}

const CAP_LINE = /\btruncat(?:ed|ion)\b|\bpartial (?:result|census)|\b(?:page|result) (?:limit|cap)\b/i;
// The entry a console.error call belongs to: cap warnings are attributed to the entry that printed
// them, also while other entries are fetched beside it.
const entryScope = new AsyncLocalStorage();

// The first http(s) address an entry names, careers page first.
// A provider says it read only part of a list in one of three shapes (CareerOps 1.40
// lib/board-truncation.mjs and its older forks): the canonical `jobs.truncated`, either `true` or
// a structured `{ reason, fetched?, total? }`; or a legacy tag such as `workdayTruncated`,
// `peoplesoftIncomplete` or `capDetected` whose value is `true`, a reason string or an object.
// Returns the reason, or null when the list is complete. `keywordSearch` is a marker, not a tag.
const LEGACY_TRUNCATION_TAG = /^[a-z][A-Za-z0-9]*(?:Truncated|Incomplete|Partial)$|^(?:partial|capDetected)$/;
export function providerTruncation(jobs) {
  if (!Array.isArray(jobs)) return null;
  const reasonOf = (value) => (typeof value === 'string' && value ? value
    : value && typeof value === 'object' && typeof value.reason === 'string' && value.reason ? value.reason : 'incomplete');
  const canonical = jobs.truncated;
  if (canonical === true || (canonical && typeof canonical === 'object')) return reasonOf(canonical);
  for (const [key, value] of Object.entries(jobs)) {
    if (!LEGACY_TRUNCATION_TAG.test(key) || !value) continue;
    if (value === true || typeof value === 'string' || typeof value === 'object') return value === true ? 'incomplete' : reasonOf(value);
  }
  return null;
}

export function entryUrl(entry = {}) {
  for (const key of ['careers_url', 'api', 'url', 'board_url', 'feed_url']) {
    try { const url = new URL(String(entry[key])); if (/^https?:$/.test(url.protocol)) return url.href; } catch { /* not a URL */ }
  }
  return null;
}

// Entries are grouped by the host they read: entries of one host are not fetched at the same time.
export function entryHost(entry = {}) {
  const url = entryUrl(entry);
  return url ? new URL(url).host.toLowerCase() : null;
}

// portals.yml `keyword_search: { terms: [...], min_total: N }` tells every provider that supports it
// to read a board bigger than `min_total` jobs through the site's own keyword search, one query per
// term, instead of paging the whole board (user 2026-11-09: 「可以直接在他们官网做筛选」). An entry
// keeps its own `keywords` / `keyword_min_total`; `keywords: false` turns the search off for it.
// `keyword_search.providers.<id>.terms` overrides the term list for one provider (Workday's full-text
// search matches "co-op" in almost every posting, so it gets a list without it).
export function withKeywordDefaults(entry = {}, portals = {}, providerId = null) {
  if (entry.keywords === false) { const { keywords, ...rest } = entry; return rest; }
  const defaults = portals?.keyword_search;
  if (!defaults || typeof defaults !== 'object') return entry;
  const out = { ...entry };
  const perProvider = providerId && defaults.providers && typeof defaults.providers === 'object' ? defaults.providers[providerId] : null;
  const terms = Array.isArray(perProvider?.terms) ? perProvider.terms : defaults.terms;
  if (!Array.isArray(entry.keywords) && Array.isArray(terms) && terms.length) out.keywords = terms.map(String);
  if (out.keyword_min_total == null && positive(defaults.min_total)) out.keyword_min_total = positive(defaults.min_total);
  // The site facet values that count as student roles: plain words the providers escape and match as whole
  // words (never a regular expression from configuration, so a bad pattern cannot stall the scan).
  if (out.facet_values == null && Array.isArray(defaults.facet_values) && defaults.facet_values.length) {
    out.facet_values = defaults.facet_values.map((value) => String(value).trim()).filter(Boolean);
  }
  return out;
}

// How a big board was read, for the receipt and for source health: the site's own facet (field and
// values) or a keyword search (terms). Both carry the "keyword search" detail prefix that health uses.
export function searchMeta(search) {
  const boardTotal = Number.isFinite(search.boardTotal) ? search.boardTotal : null;
  const board = boardTotal ?? 'unknown';
  if (search.mode === 'facet' && search.facet && typeof search.facet === 'object') {
    const values = Array.isArray(search.facet.values) ? search.facet.values.map(String) : [];
    return { mode: 'facet', boardTotal, facetName: String(search.facet.name ?? ''), facetValues: values,
      detail: `keyword search (facet ${search.facet.name ?? '?'} = ${values.join(' | ') || '?'}, board ${board})` };
  }
  const terms = positive(search.terms) ?? 0;
  return { mode: 'keywords', boardTotal, keywordTerms: terms, detail: `keyword search (${terms} terms, board ${board})` };
}

// Fetches every enabled entry. `concurrency` hosts are read at the same time (default: one, in
// order); entries of one host stay sequential. With `spoolDir` each entry's roles are written to
// `<index>.json` there and the returned report carries no role text, so the size of a scan is
// bounded by its largest entry instead of by the whole inventory. `onPartition(meta)` is called with each
// entry's partition report (the same object the returned `partitions` keeps) as soon as that entry is done
// and its spool file is written, so the caller can store it while the other entries are still fetched.
// `knownListings` (Map partition → Set of listing ids, see readKnownListings): a provider of such a list gets
// `ctx.isKnownListing(job)` and may skip per-listing detail requests for known ones (plan 2026-11-14 v2 step 2).
// It must still return every listing of the list: the journal skips known rows itself and health counts the list.
export async function collectCareerOpsRaw({ portals, providers, resolveProvider, makeHttpCtx, sleep = defaultSleep, retryDelaysMs = RETRY_DELAYS_MS,
  concurrency = 1, spoolDir, onPartition, knownListings = new Map() }) {
  // `enabled: false` turns an entry off (CareerOps's own scan skips it too); it then leaves the
  // configured inventory, so its partition is retired instead of failing every night.
  const entries = [...(portals.tracked_companies ?? []), ...(portals.job_boards ?? [])].filter((entry) => entry?.enabled !== false);
  const rolesByEntry = entries.map(() => []);
  const partitions = new Array(entries.length);
  const configuredPartitions = new Array(entries.length);
  const originalError = console.error;
  console.error = (...args) => {
    const scope = entryScope.getStore();
    if (scope && CAP_LINE.test(args.map(String).join(' '))) scope.capDetected = true;
    originalError(...args);
  };
  const fetchEntry = (entry, index) => entryScope.run({ capDetected: false }, async () => {
    const scope = entryScope.getStore();
    let provider;
    let partition = `unknown:${entry.name ?? entry.board ?? entry.url ?? ''}`;
    let attempts = 0;
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    try {
      const resolved = await resolveProvider(entry, providers);
      provider = resolved?.provider ?? resolved;
      if (typeof provider === 'string') provider = providers.get?.(provider) ?? providers[provider];
      if (!provider?.fetch) throw new Error('No provider for configured entry');
      partition = `${provider.id ?? resolved.id ?? resolved.providerId ?? 'unknown'}:${entry.name ?? entry.board ?? entry.url ?? ''}`;
      const request = withKeywordDefaults(entry, portals, provider.id ?? resolved.id ?? resolved.providerId ?? null);
      const known = knownListings.get(partition);
      let jobs;
      for (;;) {
        attempts += 1;
        scope.capDetected = false;
        try {
          const ctx = withEntryTimeout(await makeHttpCtx(request, portals), request);
          if (known?.size) ctx.isKnownListing = (job) => known.has(nativeListingId(job));
          jobs = await provider.fetch(request, ctx);
          break;
        } catch (error) {
          if (attempts > retryDelaysMs.length || !isTransientError(error)) throw error;
          originalError(`careerops bridge: ${partition} attempt ${attempts} failed (${error.message}); retrying`);
          await sleep(retryDelaysMs[attempts - 1]);
        }
      }
      if (!Array.isArray(jobs)) throw new Error('Provider returned no job array');
      // A keyword search returns the merged hits of several queries, so the whole-board ceiling does
      // not apply; the provider marks a capped query itself (jobs.truncated).
      const search = jobs.keywordSearch && typeof jobs.keywordSearch === 'object' ? jobs.keywordSearch : null;
      const ceiling = search ? null : providerCeiling(provider.id, entry, portals);
      if (ceiling != null && jobs.length >= ceiling) scope.capDetected = true;
      const capDetected = scope.capDetected;
      const truncationReason = providerTruncation(jobs);
      const truncated = capDetected || truncationReason != null;
      const roles = [];
      for (const job of jobs) {
        const role = { ...job, company: job?.company ?? entry.name, partition,
          locations: job?.locations ?? (job?.location ? [job.location] : []), requisitionId: job?.requisitionId ?? job?.jobReqId ?? null };
        for (const [key, value] of Object.entries(role)) {
          if (typeof value === 'string' && value.length > MAX_FIELD_CHARS && !IDENTITY_FIELDS.has(key)) {
            // Copy only the bounded prefix; a sliced string can retain the full provider text.
            role[key] = Buffer.from(value.slice(0, MAX_FIELD_CHARS), 'utf16le').toString('utf16le');
          }
        }
        roles.push(role);
      }
      let spoolFile;
      if (spoolDir && roles.length) {
        spoolFile = `${index}.json`;
        await writeFile(path.join(spoolDir, spoolFile), JSON.stringify(roles));
      } else rolesByEntry[index] = roles;
      partitions[index] = { partition, status: truncated ? 'partial' : 'ok', count: jobs.length, rawCount: jobs.length, truncated, capDetected, attempts, elapsedMs: elapsed(),
        ...(truncationReason ? { truncationReason } : {}),
        // A partial list also gets a browser read (src/scan/browser-list.mjs); it needs the same pointers.
        ...(truncated && entry.name ? { company: String(entry.name) } : {}), ...(truncated && entryUrl(entry) ? { careersUrl: entryUrl(entry) } : {}),
        ...(capDetected && ceiling != null && jobs.length >= ceiling ? { ceiling } : {}), ...(spoolFile ? { spoolFile } : {}),
        // Source health keeps keyword counts and whole-board counts apart by this detail prefix.
        ...(search ? searchMeta(search) : {}) };
    } catch (error) {
      // The company and its careers page travel with a failed list, for the browser read that follows it.
      partitions[index] = { partition, status: 'error', count: 0, rawCount: 0, error: error.message, truncated: scope.capDetected, capDetected: scope.capDetected, attempts, elapsedMs: elapsed(),
        ...(entry.name ? { company: String(entry.name) } : {}), ...(entryUrl(entry) ? { careersUrl: entryUrl(entry) } : {}) };
    } finally { configuredPartitions[index] = partition; }
    onPartition?.(partitions[index]);
  });
  try {
    // One lane per host, in configured order; an entry without a readable host gets its own lane.
    const lanes = new Map();
    entries.forEach((entry, index) => {
      const key = entryHost(entry) ?? `entry:${index}`;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(index);
    });
    const queue = [...lanes.values()];
    const limit = Math.max(1, Math.min(positive(concurrency) ?? 1, queue.length || 1));
    await Promise.all(Array.from({ length: limit }, async () => {
      for (let lane = queue.shift(); lane; lane = queue.shift()) for (const index of lane) await fetchEntry(entries[index], index);
    }));
  } finally { console.error = originalError; }
  return { roles: spoolDir ? [] : rolesByEntry.flat(), partitions, configuredPartitions, ...(spoolDir ? { spooled: true } : {}) };
}

// The middle hop: runs the worker in a child process and passes each partition event line on to its own
// stdout (`write`) the moment it arrives, so the caller can store finished entries during the fetch. The
// worker's result line is returned, and printed once by main().
export async function scanCareerOpsRaw(root, { execute = run, env = process.env, timeoutMs, write = (text) => process.stdout.write(text) } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'career-journal-careerops-raw-'));
  try {
    const portals = path.join(temporary, 'portals.yml');
    await writeFile(portals, await readFile(env.CAREER_OPS_PORTALS || path.join(root, 'portals.yml')));
    const execution = await execute(process.execPath, [fileURLToPath(import.meta.url), 'scan-raw', '--worker'], {
      cwd: root, timeoutMs, maxBytes: MAX_RAW_SCAN_BYTES,
      env: { ...env, CAREER_OPS_ROOT: temporary, CAREER_OPS_PORTALS: portals },
      onStdout: splitLines((line) => { if (partitionEvent(line)) write(`${line}\n`); }),
    });
    if (execution.exitCode !== 0) throw new Error(`CareerOps raw scan exited with ${execution.exitCode}: ${String(execution.stderr ?? '').slice(-1000)}`);
    let result;
    try { result = parseResultLine(execution.stdout); } catch { throw new Error('CareerOps raw scan printed invalid JSON'); }
    if (!Array.isArray(result.roles)) throw new Error('CareerOps raw scan printed no role array');
    return result;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function rawWorker(root) {
  // Only absent raw entrypoints permit fallback; fetch/import failures in a present provider stay errors.
  const { existsSync } = await import('node:fs');
  const base = [root, path.join(root, 'scripts')].find((candidate) => existsSync(path.join(candidate, 'providers', '_registry.mjs')));
  if (!base || !existsSync(path.join(base, 'providers', '_http.mjs')) || !existsSync(path.join(base, 'plugins', '_engine.mjs'))) {
    const legacy = await scanCareerOps(root);
    return { ...legacy, partitions: [{ partition: 'all', status: 'partial', count: legacy.roles.length, rawCount: legacy.roles.length,
      truncated: false, detail: 'legacy display-line bridge' }] };
  }
  const require = createRequire(path.join(root, 'package.json'));
  const yaml = require('js-yaml');
  const portals = yaml.load(await readFile(process.env.CAREER_OPS_PORTALS, 'utf8'));
  const registry = await import(pathToFileURL(path.join(base, 'providers', '_registry.mjs')).href);
  const http = await import(pathToFileURL(path.join(base, 'providers', '_http.mjs')).href);
  const plugins = await import(pathToFileURL(path.join(base, 'plugins', '_engine.mjs')).href);
  let providers = await registry.loadProviders(path.join(base, 'providers'));
  providers = await plugins.mergeProviderPlugins(providers, { root: base }) ?? providers;
  // Both are set by CAREER JOURNAL (config careerOps.scanConcurrency; a spool folder it owns and removes).
  const spoolDir = process.env.CAREER_JOURNAL_SCAN_SPOOL || undefined;
  return collectCareerOpsRaw({ portals, providers, resolveProvider: registry.resolveProvider, makeHttpCtx: http.makeHttpCtx,
    concurrency: positive(process.env.CAREER_JOURNAL_SCAN_CONCURRENCY) ?? DEFAULT_SCAN_CONCURRENCY, spoolDir,
    knownListings: readKnownListings(process.env.CAREER_JOURNAL_KNOWN_LISTINGS),
    // A spooled entry is announced as soon as its file is written: one complete JSON line per entry, before
    // the result line that main() prints last. The roles stay in the file, so each line is small.
    ...(spoolDir ? { onPartition: (partition) => process.stdout.write(`${JSON.stringify({ event: PARTITION_EVENT, partition })}\n`) } : {}) });
}

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  const command = process.argv[2];
  if (!['scan', 'scan-raw'].includes(command)) {
    process.stderr.write(`The built-in CareerOps bridge only supports "scan"; "${command ?? ''}" needs the CareerOps career-journal-adapter.mjs bridge.\n`);
    process.exitCode = 1;
    return;
  }
  const worker = process.argv.includes('--worker');
  if (!worker) {
    const request = JSON.parse((await readStdin()) || '{}');
    if (!['scan', 'scan-raw'].includes(request.action) || request.readOnly !== true) throw new Error('The bridge accepts only a read-only scan request');
  }
  const result = command === 'scan' ? await scanCareerOps(process.cwd()) : worker ? await rawWorker(process.cwd()) : await scanCareerOpsRaw(process.cwd());
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installCareerOpsShutdown();
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
