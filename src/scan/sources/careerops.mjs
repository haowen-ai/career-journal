import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectCareerOpsScan, runCareerOpsScan } from '../../integrations/careerops.mjs';
import { htmlToText } from '../text.mjs';
import { httpUrl, isoDate, sourceError, text, uniqueStrings } from './common.mjs';
import { nativeListingId } from '../listing-key.mjs';

export function parseCareerOpsRoles(result) {
  return (Array.isArray(result?.roles) ? result.roles : []).map((item) => {
    item ??= {};
    const url = httpUrl(item.url);
    return {
      // listingId: the board's own id for this listing (listing-key.mjs), the seen key of the incremental scan.
      source: 'careerops', sourceId: text(item.id) || url, listingId: nativeListingId({ ...item, url }), partition: item.partition ?? 'all',
      company: text(item.company), title: text(item.title), url,
      invalid: item.invalid || (!text(item.title) ? 'missing title' : !text(item.company) ? 'missing company' : !url ? 'missing http(s) URL' : null),
      locations: uniqueStrings(Array.isArray(item.locations) ? item.locations : [item.location]), offices: item.offices ?? [],
      remote: typeof item.remote === 'boolean' ? item.remote : null, workplaceType: item.workplaceType ?? null,
      employmentType: item.employmentType ?? null, requisitionId: item.requisitionId ?? item.jobReqId ?? null,
      postedAt: isoDate(item.postedAt), description: htmlToText(item.description ?? ''), listed: item.listed !== false,
      categories: uniqueStrings(item.categories ?? []), terms: uniqueStrings(item.terms ?? []), degrees: uniqueStrings(item.degrees ?? []),
      completeness: { locations: 'partial', arrangement: 'unknown', description: item.description ? 'full' : 'none', employment_type: 'absent', ...item.completeness },
    };
  });
}

// One partition report of the bridge as a source health row. `count` is the number of rows it delivered.
function partitionSource(part, count) {
  const { spoolFile, ...health } = part;
  return { ...health, source: 'careerops', rawCount: count, count,
    truncated: Boolean(part.truncated || part.capDetected),
    // A list that failed stays an error even when a cap warning was printed before the failure;
    // only a list that was read can be partial.
    status: part.status === 'error' ? 'error' : part.capDetected || part.truncated ? 'partial' : part.status,
    ...(part.error ? { detail: part.error } : {}) };
}

export function parseCareerOpsRaw(result) {
  // A spooled scan keeps its roles on disk (one file per entry); the bridge's own counts stand in.
  const spooled = result?.spooled === true && Array.isArray(result?.partitions);
  const roles = spooled ? [] : parseCareerOpsRoles(result);
  const countOf = (part) => spooled ? Number(part.count ?? 0) : roles.filter((role) => role.partition === part.partition).length;
  // An empty partition list next to an empty inventory means every portals.yml entry is turned off;
  // only a bridge that sends no partition list at all is the legacy display-line bridge.
  const allDisabled = Array.isArray(result?.partitions) && !result.partitions.length && Array.isArray(result?.configuredPartitions) && !result.configuredPartitions.length && !roles.length;
  const partitions = result?.partitions?.length ? result.partitions
    : allDisabled ? [{ partition: 'all', status: 'disabled', count: 0, detail: 'every CareerOps entry is enabled: false' }]
    : [{ partition: 'all', status: 'partial', count: roles.length, detail: 'legacy display-line bridge' }];
  const sources = partitions.map((part) => partitionSource(part, countOf(part)));
  // Preserve rows even if a bridge omits their partition health.
  for (const role of roles) if (!sources.some((part) => part.partition === role.partition)) sources.push({ source: 'careerops', partition: role.partition,
    status: 'partial', count: roles.filter((r) => r.partition === role.partition).length, rawCount: roles.filter((r) => r.partition === role.partition).length,
    truncated: false, detail: 'legacy display-line bridge; missing partition health' });
  return { roles, sources, ...(Array.isArray(result?.configuredPartitions) ? { configuredPartitions: result.configuredPartitions } : {}),
    ...(spooled ? { spoolFiles: partitions.map((part) => part.spoolFile ?? null) } : {}),
    status: sources.every((p) => p.status === 'error') ? 'failed' : sources.some((p) => p.status !== 'ok') ? 'partial' : 'ok' };
}

const SPOOL_PREFIX = 'career-journal-scan-spool-';
const STALE_SPOOL_MS = 2 * 86_400_000;

// A scan that was killed cannot remove its spool folder; folders older than two days are removed
// by the next scan. Younger ones may belong to a scan that is still running.
export function sweepStaleSpools(directory = os.tmpdir(), now = Date.now()) {
  let names = [];
  try { names = readdirSync(directory); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(SPOOL_PREFIX)) continue;
    const target = path.join(directory, name);
    try {
      const details = statSync(target);
      if (!details.isDirectory() || now - details.mtimeMs < STALE_SPOOL_MS) continue;
      rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch { /* gone already, or not ours to remove */ }
  }
  return removed;
}

// One spooled entry, read and parsed when the scan ingests it. `records` is not enumerable, so
// copying a batch never loads its rows.
function spooledBatch(directory, source, spoolFile) {
  const batch = { source: 'careerops', partition: source.partition, rawCount: source.rawCount };
  Object.defineProperty(batch, 'records', { enumerable: false, get() {
    if (!spoolFile) return [];
    if (typeof spoolFile !== 'string' || path.basename(spoolFile) !== spoolFile || !/^\d+\.json$/.test(spoolFile)) throw new Error(`CareerOps scan named an invalid spool file for ${source.partition}`);
    return parseCareerOpsRoles({ roles: JSON.parse(readFileSync(path.join(directory, spoolFile), 'utf8')) });
  } });
  return batch;
}

// With `onBatch`, each spooled entry is handed over as a batch the moment the bridge reports it finished
// (user 2026-11-09: a finished company is stored at once, not after the slowest one), and the returned
// `batches` leave those entries out; `sources` still lists every partition. An error thrown by onBatch
// stops the fetch and is thrown from here.
// `knownListings` ({ partition: Set(listing ids) }): written to the spool folder for the bridge, whose providers
// then skip detail requests for those listings (the rows themselves are still listed and delivered). `watermarks`
// ({ partition: ISO }) and `earlyStop` ({ providers, marginHours }) go in the same file: a listed provider may stop
// paging a date-ordered list early (plan 2026-11-14 v3.1). `laneWeights` ({ entry name: ms }, the previous scan's fetch
// times) lets the bridge start the slowest hosts first (plan v4). File: { known, watermarks, earlyStop, elapsed }.
export const KNOWN_LISTINGS_FILE = 'known-listings.json';
export async function fetchCareerOpsRoles(enabled, careerOpsConfig, dependencies = {}, { onBatch, knownListings = null, watermarks = null, earlyStop = null, laneWeights = null } = {}) {
  const skipped = (detail) => ({ sources: [{ source: 'careerops', partition: 'all', status: 'skipped', count: 0, rawCount: 0, truncated: false, detail }], batches: [], roles: [] });
  if (!enabled) return skipped('not enabled in the profile');
  const health = await (dependencies.detect ?? detectCareerOpsScan)(careerOpsConfig ?? {});
  if (!health.ok) return skipped(`CareerOps not detected: ${health.detail}`);
  // The built-in bridge writes each entry's roles here instead of printing them all at once.
  // The caller removes the folder with dispose() after the last batch is ingested.
  sweepStaleSpools();
  const spoolDir = mkdtempSync(path.join(os.tmpdir(), SPOOL_PREFIX));
  // Cleanup must never replace the scan's own result or error.
  const dispose = () => { try { rmSync(spoolDir, { recursive: true, force: true }); } catch { /* swept by a later scan */ } };
  // Partitions already handed to onBatch, by name (a name can in principle repeat, so they are counted).
  const delivered = new Map();
  const deliveredSources = [];
  let batchError;
  const live = onBatch ? { onPartition: (part) => {
    const source = partitionSource(part, Number(part.count ?? 0));
    delivered.set(source.partition, (delivered.get(source.partition) ?? 0) + 1);
    deliveredSources.push(source);
    try { onBatch(spooledBatch(spoolDir, source, part.spoolFile ?? null)); } catch (error) { batchError = error; throw error; }
  } } : {};
  const pending = (partition) => {
    const count = delivered.get(partition) ?? 0;
    if (count) delivered.set(partition, count - 1);
    return !count;
  };
  try {
    let knownListingsFile;
    const hasKnown = knownListings && Object.keys(knownListings).length;
    const hasWeights = laneWeights && Object.keys(laneWeights).length;
    if (hasKnown || hasWeights) {
      knownListingsFile = path.join(spoolDir, KNOWN_LISTINGS_FILE);
      writeFileSync(knownListingsFile, JSON.stringify({
        known: hasKnown ? Object.fromEntries(Object.entries(knownListings).map(([partition, ids]) => [partition, [...ids]])) : {},
        watermarks: watermarks ?? {}, ...(earlyStop ? { earlyStop } : {}), ...(hasWeights ? { elapsed: laneWeights } : {}) }));
    }
    const parsed = parseCareerOpsRaw(await (dependencies.run ?? runCareerOpsScan)({ ...(careerOpsConfig ?? {}), scanSpoolDir: spoolDir, ...(knownListingsFile ? { knownListingsFile } : {}) }, { ...dependencies, ...live }));
    if (parsed.spoolFiles) {
      const { spoolFiles, ...rest } = parsed;
      return { ...rest, dispose, batches: parsed.sources.flatMap((source, index) => pending(source.partition) ? [spooledBatch(spoolDir, source, spoolFiles[index])] : []) };
    }
    dispose();
    return { ...parsed, batches: parsed.sources.filter((part) => pending(part.partition)).map((part) => ({ source: 'careerops', partition: part.partition,
      records: parsed.roles.filter((role) => role.partition === part.partition), rawCount: part.rawCount })) };
  } catch (error) {
    dispose();
    if (batchError && error === batchError) throw error;
    // Entries already stored keep their own status; the scan failure is reported beside them.
    return { sources: [...deliveredSources, { source: 'careerops', partition: 'all', status: 'error', count: 0, rawCount: 0, truncated: false, detail: sourceError(error) }], batches: [], roles: [] };
  }
}
