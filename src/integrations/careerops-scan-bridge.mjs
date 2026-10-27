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

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIDE_TITLE_FILTER = Object.freeze([
  'word:intern', 'word:interns', 'stem:internship', 'co-op', 'word:coop', 'stem:apprentice',
  'summer analyst', 'summer associate', 'working student', 'placement', 'word:student', 'stem:fellow',
  'stem:residen', 'graduate program', 'early career', 'university program', 'campus program', 'currently enrolled', 'class of',
]);

const REPLACED_SECTIONS = new Set(['title_filter', 'location_filter']);
const DEFAULT_TIMEOUT_MS = 18 * 60 * 1000;

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

function run(command, args, { cwd, env, timeoutMs, maxBytes = 50_000_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let failure = null;
    let killTimer;
    const stop = (message) => {
      if (failure) return;
      failure = new Error(message);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const timer = setTimeout(() => stop(`CareerOps scan timed out after ${timeoutMs}ms`), timeoutMs);
    let bytes = 0;
    const append = (chunk, stream) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { stop('CareerOps scan exceeded output byte limit'); return; }
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
    child.once('error', (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (signal) reject(new Error(`CareerOps scan stopped (${signal}) after at most ${timeoutMs}ms`));
      else resolve({ exitCode, stdout, stderr });
    });
  });
}

export async function scanCareerOps(root, { execute = run, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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

// Each fetch is sequential: stderr cap messages belong only to the current entry.
export async function collectCareerOpsRaw({ portals, providers, resolveProvider, makeHttpCtx }) {
  const roles = [];
  const partitions = [];
  const entries = [...(portals.tracked_companies ?? []), ...(portals.job_boards ?? [])];
  for (const entry of entries) {
    let provider;
    let partition = `unknown:${entry.name ?? entry.board ?? entry.url ?? ''}`;
    const originalError = console.error;
    let capDetected = false;
    try {
      const resolved = await resolveProvider(entry, providers);
      provider = resolved?.provider ?? resolved;
      if (typeof provider === 'string') provider = providers.get?.(provider) ?? providers[provider];
      if (!provider?.fetch) throw new Error('No provider for configured entry');
      partition = `${provider.id ?? resolved.id ?? resolved.providerId ?? 'unknown'}:${entry.name ?? entry.board ?? entry.url ?? ''}`;
      console.error = (...args) => {
        const line = args.map(String).join(' ');
        if (provider.id === 'workday' && /truncated at/i.test(line)) capDetected = true;
        originalError(...args);
      };
      const jobs = await provider.fetch(entry, await makeHttpCtx(entry, portals));
      if (!Array.isArray(jobs)) throw new Error('Provider returned no job array');
      const maxPages = Number(entry.max_pages ?? entry.maxPages ?? entry.workday?.max_pages ?? portals.workday?.max_pages ?? 100);
      if (provider.id === 'workday' && Number.isFinite(maxPages) && maxPages > 0 && jobs.length >= maxPages * 20) capDetected = true;
      const truncated = jobs.workdayTruncated === true || capDetected;
      for (const job of jobs) roles.push({ ...job, company: job?.company ?? entry.name, partition,
        locations: job?.locations ?? (job?.location ? [job.location] : []), requisitionId: job?.requisitionId ?? job?.jobReqId ?? null });
      partitions.push({ partition, status: truncated ? 'partial' : 'ok', count: jobs.length, rawCount: jobs.length, truncated, capDetected });
    } catch (error) {
      partitions.push({ partition, status: 'error', count: 0, rawCount: 0, error: error.message, truncated: capDetected, capDetected });
    } finally { console.error = originalError; }
  }
  return { roles, partitions };
}

export async function scanCareerOpsRaw(root, { execute = run, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'career-journal-careerops-raw-'));
  try {
    const portals = path.join(temporary, 'portals.yml');
    await writeFile(portals, await readFile(env.CAREER_OPS_PORTALS || path.join(root, 'portals.yml')));
    const execution = await execute(process.execPath, [fileURLToPath(import.meta.url), 'scan-raw', '--worker'], {
      cwd: root, timeoutMs,
      env: { ...env, CAREER_OPS_ROOT: temporary, CAREER_OPS_PORTALS: portals },
    });
    if (execution.exitCode !== 0) throw new Error(`CareerOps raw scan exited with ${execution.exitCode}: ${String(execution.stderr ?? '').slice(-1000)}`);
    let result;
    try { result = JSON.parse(String(execution.stdout)); } catch { throw new Error('CareerOps raw scan printed invalid JSON'); }
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
  let providers = await registry.loadProviders();
  providers = await plugins.mergeProviderPlugins(providers, portals) ?? providers;
  return collectCareerOpsRaw({ portals, providers, resolveProvider: registry.resolveProvider, makeHttpCtx: http.makeHttpCtx });
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
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
