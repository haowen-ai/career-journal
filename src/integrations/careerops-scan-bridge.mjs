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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIDE_TITLE_FILTER = Object.freeze([
  'word:intern', 'word:interns', 'stem:internship', 'co-op', 'word:coop', 'stem:apprentice',
  'summer analyst', 'summer associate', 'working student',
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

function run(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`CareerOps scan stopped (${signal}) after at most ${timeoutMs}ms`));
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

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  const command = process.argv[2];
  if (command !== 'scan') {
    process.stderr.write(`The built-in CareerOps bridge only supports "scan"; "${command ?? ''}" needs the CareerOps career-journal-adapter.mjs bridge.\n`);
    process.exitCode = 1;
    return;
  }
  const request = JSON.parse((await readStdin()) || '{}');
  if (request.action !== 'scan' || request.readOnly !== true) throw new Error('The bridge accepts only a read-only scan request');
  const { roles } = await scanCareerOps(process.cwd());
  process.stdout.write(`${JSON.stringify({ ok: true, roles })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
