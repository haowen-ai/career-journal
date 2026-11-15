import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { executeCareerOpsProcess, MAX_RAW_SCAN_BYTES, parseResultLine, partitionEvent, splitLines } from './careerops-process.mjs';
import { fileURLToPath } from 'node:url';

const MAX_REQUEST_BYTES = 1_000_000;
const ACTIONS = new Set(['prepare', 'verify']);
const MATERIAL_KINDS = new Set(['resume', 'cover-letter']);
// Read-only role scans fall back to this bridge when the CareerOps checkout has no adapter.
export const BUILT_IN_SCAN_BRIDGE = fileURLToPath(new URL('./careerops-scan-bridge.mjs', import.meta.url));

async function exists(file) {
  try { await access(file, constants.R_OK); return true; } catch { return false; }
}

export async function detectCareerOps(config = {}) {
  if (!config.root) return { ok: false, code: 'missing', detail: 'CareerOps is not configured; install it and set its root path' };
  const root = path.resolve(config.root);
  const packageFile = path.join(root, 'package.json');
  const configuredEntrypoint = config.entrypoint ?? 'career-journal-adapter.mjs';
  let entrypoint = path.join(root, configuredEntrypoint);
  if (!(await exists(packageFile))) return { ok: false, code: 'missing', detail: `CareerOps is not installed or configured at ${root}` };
  let metadata;
  try { metadata = JSON.parse(await readFile(packageFile, 'utf8')); }
  catch { return { ok: false, code: 'invalid-installation', detail: 'CareerOps package metadata is unreadable' }; }
  if (metadata.name !== 'career-ops') return { ok: false, code: 'invalid-installation', detail: 'Configured directory is not the career-ops package' };
  if (config.pinnedVersion && metadata.version !== config.pinnedVersion) {
    return {
      ok: false,
      code: 'version-mismatch',
      installedVersion: metadata.version,
      detail: `CareerOps ${metadata.version} is installed; ${config.pinnedVersion} is required`,
    };
  }
  if (!(await exists(entrypoint))) {
    return { ok: false, code: 'bridge-missing', installedVersion: metadata.version, detail: `CareerOps adapter bridge is missing: ${entrypoint}` };
  }
  return { ok: true, code: 'ready', installedVersion: metadata.version, entrypoint, root, detail: `CareerOps ${metadata.version} is ready` };
}

const executeProcess = executeCareerOpsProcess;

function validateRequest(request) {
  if (!ACTIONS.has(request?.action)) throw new Error(`Unsupported CareerOps action: ${request?.action ?? 'missing'}`);
  if (!request.applicationId || typeof request.applicationId !== 'string') throw new Error('CareerOps request requires applicationId');
  if (!MATERIAL_KINDS.has(request.materialKind)) throw new Error('CareerOps material request requires resume or cover-letter materialKind');
  const structured = { ...request, lifecycle: 'draft' };
  const serialized = JSON.stringify(structured);
  if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw new Error('CareerOps structured request is too large');
  return { structured, serialized };
}

async function validateResult(result, request) {
  if (!result || result.ok !== true) throw new Error('CareerOps did not report a successful result');
  if (result.applicationId !== request.applicationId) throw new Error('CareerOps result application association does not match the request');
  if (result.lifecycle !== 'draft') throw new Error('CareerOps material output must use the draft lifecycle');
  if (typeof result.outputPath !== 'string' || !result.outputPath) throw new Error('CareerOps result is missing outputPath');
  if (!['passed', 'failed', 'pending'].includes(result.verification)) throw new Error('CareerOps result has an invalid verification state');
  try {
    if (!(await stat(result.outputPath)).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`CareerOps output does not exist: ${result.outputPath}`);
  }
  return result;
}

export async function runCareerOps(request, config = {}, dependencies = {}) {
  const { structured, serialized } = validateRequest(request);
  const health = await detectCareerOps(config);
  if (!health.ok) throw new Error(health.detail);
  const execute = dependencies.execute ?? executeProcess;
  const execution = await execute({
    command: config.nodeExecutable ?? process.execPath,
    args: [health.entrypoint, 'material', structured.action],
    cwd: health.root,
    stdin: serialized,
    timeoutMs: config.timeoutMs ?? 120_000,
  });
  if (execution.exitCode !== 0) {
    const detail = String(execution.stderr ?? '').trim().slice(0, 2_000);
    throw new Error(`CareerOps ${structured.action} failed${detail ? `: ${detail}` : ''}`);
  }
  let result;
  try { result = JSON.parse(String(execution.stdout ?? '')); }
  catch { throw new Error('CareerOps returned invalid JSON'); }
  return validateResult(result, structured);
}

// The role scan uses the CareerOps adapter when it is installed. The pinned upstream release
// ships no adapter, so a checkout that is otherwise ready scans through the built-in
// read-only bridge, which runs CareerOps's own dry-run scan. Material generation still
// needs the CareerOps adapter.
export async function detectCareerOpsScan(config = {}) {
  const health = await detectCareerOps(config);
  if (health.ok || health.code !== 'bridge-missing') return health;
  return {
    ok: true,
    code: 'ready',
    installedVersion: health.installedVersion,
    entrypoint: BUILT_IN_SCAN_BRIDGE,
    root: path.resolve(config.root),
    builtInBridge: true,
    detail: `CareerOps ${health.installedVersion} is ready; scans use the built-in read-only bridge`,
  };
}

// Read-only role scan through the same pinned bridge:
//   node <careerops-root>/career-journal-adapter.mjs scan
// stdin: { "action": "scan", "readOnly": true }
// stdout: { "ok": true, "roles": [{ id, company, title, url, locations[] | location, postedAt, description }] }
// The built-in bridge with a spool folder also prints one `{"event":"partition","partition":{...}}` line per
// finished entry before the result line; `dependencies.onPartition(partition)` is called for each of them
// while the scan runs. If it throws, the scan is stopped and its error is the scan's error.
export async function runCareerOpsScan(config = {}, dependencies = {}) {
  const health = await detectCareerOpsScan(config);
  if (!health.ok) throw new Error(health.detail);
  const execute = dependencies.execute ?? executeProcess;
  const { onPartition } = dependencies;
  let partitionError;
  const controller = onPartition ? new AbortController() : null;
  const live = onPartition ? { signal: controller.signal, onStdout: splitLines((line) => {
    const partition = partitionError ? null : partitionEvent(line);
    if (!partition) return;
    try { onPartition(partition); } catch (error) { partitionError = error; controller.abort(); }
  }) } : {};
  let execution;
  try {
    execution = await execute({
      command: config.nodeExecutable ?? process.execPath,
      args: [health.entrypoint, health.builtInBridge ? 'scan-raw' : 'scan'],
      cwd: health.root,
      stdin: JSON.stringify({ action: health.builtInBridge ? 'scan-raw' : 'scan', readOnly: true }),
      // Portal scans have no time cap unless the caller supplies one.
      timeoutMs: config.scanTimeoutMs,
      maxBytes: MAX_RAW_SCAN_BYTES,
      // The built-in bridge writes each entry's roles into the spool folder (so its output stays small)
      // and reads this many hosts at once. Other bridges ignore both.
      ...(config.scanSpoolDir || config.scanConcurrency || config.knownListingsFile ? { env: { ...process.env,
        ...(config.scanSpoolDir ? { CAREER_JOURNAL_SCAN_SPOOL: String(config.scanSpoolDir) } : {}),
        ...(config.scanConcurrency ? { CAREER_JOURNAL_SCAN_CONCURRENCY: String(config.scanConcurrency) } : {}),
        // Listing ids each baselined list already has (src/funnel/seen.mjs); the built-in bridge passes them to providers.
        ...(config.knownListingsFile ? { CAREER_JOURNAL_KNOWN_LISTINGS: String(config.knownListingsFile) } : {}) } } : {}),
      ...live,
    });
  } catch (error) { throw partitionError ?? error; }
  if (partitionError) throw partitionError;
  if (execution.exitCode !== 0) {
    const detail = String(execution.stderr ?? '').trim().slice(0, 2_000);
    throw new Error(`CareerOps scan failed${detail ? `: ${detail}` : ''}`);
  }
  let result;
  // Only the last line is the result; earlier lines are partition events.
  try { result = parseResultLine(execution.stdout); }
  catch { throw new Error('CareerOps scan returned invalid JSON'); }
  if (!result || result.ok !== true || !Array.isArray(result.roles)) throw new Error('CareerOps scan did not report a successful role list');
  return result;
}
