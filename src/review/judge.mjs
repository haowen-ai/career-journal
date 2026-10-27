import { executeCareerOpsProcess } from '../integrations/careerops-process.mjs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JUDGMENT_SCHEMA_PATH, FORCED_DECISION_SCHEMA_PATH } from './prompt.mjs';

export const QUOTA_PATTERNS = Object.freeze([/usage limit|rate limit reached|quota/i]);
const MAX_BYTES = 2_000_000;
const schema = JSON.parse(readFileSync(JUDGMENT_SCHEMA_PATH, 'utf8'));
const forcedSchema = JSON.parse(readFileSync(FORCED_DECISION_SCHEMA_PATH, 'utf8'));

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Judge configuration requires ${name}`);
  return value;
}

export function buildCodexArgv({ bin = 'codex', codexHome, model, effort, schemaPath, outputPath, workDir }) {
  required(codexHome, 'codexHome');
  required(model, 'model');
  const env = { ...process.env, CODEX_HOME: codexHome };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-s', 'read-only', '-C', required(workDir, 'workDir'), '-m', model];
  if (effort !== undefined && effort !== null) args.push('-c', `model_reasoning_effort=${required(effort, 'effort')}`);
  args.push('--output-schema', required(schemaPath, 'schemaPath'), '-o', required(outputPath, 'outputPath'), '--json', '-');
  return { command: bin, args, env };
}

// runImpl receives this same streaming/abort boundary; no implicit retries occur here.
function runCommand(spec) {
  return executeCareerOpsProcess({ ...spec, timeoutMs: spec.timeoutMs ?? 120000, maxBytes: spec.maxBytes ?? MAX_BYTES });
}

function schemaValid(value, rule) {
  if (rule.$ref) return schemaValid(value, schema.$defs[rule.$ref.split('/').at(-1)]);
  if (rule.anyOf) return rule.anyOf.some((choice) => schemaValid(value, choice));
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.pattern && (typeof value !== 'string' || !new RegExp(rule.pattern, 'u').test(value))) return false;
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  if (!types.some((type) => type === undefined || (type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type))) return false;
  if (Array.isArray(value)) return value.every((item) => schemaValid(item, rule.items ?? {}));
  if (value !== null && typeof value === 'object') {
    if ((rule.required ?? []).some((key) => !(key in value))) return false;
    return Object.entries(value).every(([key, item]) => rule.properties?.[key] ? schemaValid(item, rule.properties[key]) : rule.additionalProperties !== false);
  }
  return true;
}

export const validJudgment = (value) => schemaValid(value, schema);
export const validForcedDecision = (value) => schemaValid(value, forcedSchema);

async function versionOf(spec, timeoutMs, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await runCommand({ ...spec, args: ['--version'], timeoutMs, signal: controller.signal });
    if (controller.signal.aborted || result.tooLarge || result.exitCode !== 0) throw new Error(`codex --version failed (exit ${result.exitCode}, signal ${result.signal ?? 'none'}${controller.signal.aborted ? ', cancelled or timed out' : ''}): ${result.stderr.trim()}`);
    return result.stdout.trim();
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

export function codexExecAdapter({ bin = 'codex', codexHome, model, effort, tier, schemaPath = JUDGMENT_SCHEMA_PATH, workDir, timeoutMs = 120000, maxTransportRetries = 2, runImpl }) {
  required(codexHome, 'codexHome');
  required(model, 'model');
  if (workDir !== undefined) required(workDir, 'workDir');
  if (!['primary', 'escalation'].includes(tier)) throw new Error('Judge configuration requires tier primary or escalation');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Judge timeoutMs must be positive');
  if (!Number.isInteger(maxTransportRetries) || maxTransportRetries < 0) throw new Error('Judge maxTransportRetries must be a non-negative integer');
  const versionController = new AbortController();
  const adapter = {
    id: `codex:${tier}:${model}`, runner: 'codex', model, tier, effort: effort ?? null,
    cliVersion: runImpl ? 'injected' : null,
    timeoutMs, maxTransportRetries,
    async judge(request, { attemptId, outputPath, signal } = {}) {
      required(attemptId, 'attemptId');
      const attemptWorkDir = workDir ?? await mkdtemp(path.join(os.tmpdir(), 'career-journal-judge-'));
      const spec = buildCodexArgv({ bin, codexHome, model, effort, schemaPath: request.schemaPath ?? schemaPath, outputPath, workDir: attemptWorkDir });
      const controller = new AbortController();
      let stopReason;
      let transportRetries = 0;
      let usage = null;
      let quota = false;
      let refused = false;
      let pending = '';
      let stderr = '';
      let streamed = '';
      let bytes = 0;
      let completed = false;
      let invocation;
      let endWait;
      const cancelled = new Promise((resolve) => { endWait = resolve; });
      const stop = (reason) => {
        if (stopReason) return;
        stopReason = reason;
        controller.abort();
        if (!runImpl && adapter.cliVersion === null) versionController.abort();
        // A real child has its own SIGTERM→SIGKILL handler. A faulty injected runner
        // must not leave the adapter awaiting an unresolved promise forever either.
        endWait();
      };
      const onAbort = () => stop('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const event = (line) => {
        if (!line.trim() || stopReason) return;
        let parsed;
        try { parsed = JSON.parse(line); } catch { return; }
        const diagnostic = /error|warning|failed|retry|reconnect|rate_limit/i.test(String(parsed.type))
          ? parsed : /error|warning/i.test(String(parsed.item?.type)) ? parsed.item : null;
        const serialized = diagnostic ? JSON.stringify(diagnostic) : '';
        if (diagnostic && QUOTA_PATTERNS.some((pattern) => pattern.test(serialized))) quota = true;
        if (/refus(?:al|ed)/i.test(String(parsed.type)) || parsed.item?.type === 'refusal') refused = true;
        if (parsed.usage) usage = parsed.usage;
        if (diagnostic && /reconnect|retry(?:ing)?/i.test(serialized)) {
          transportRetries += 1;
          if (transportRetries > maxTransportRetries) stop('retry_cap');
        }
      };
      const onStdout = (chunk) => {
        if (stopReason) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) { stop('too_large'); return; }
        streamed += chunk;
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) event(line);
      };
      const onStderr = (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) { stop('too_large'); return; }
        stderr += chunk;
        if (QUOTA_PATTERNS.some((pattern) => pattern.test(stderr))) quota = true;
      };
      const finish = (status, extra = {}) => ({ status, output: null, rawText: '', usage, transportRetries, ...extra });
      try {
        if (!runImpl && !stopReason) {
          await adapter.ready;
        }
        if (stopReason) return finish(stopReason === 'timeout' ? 'timeout' : 'error', { error: stopReason });
        await rm(outputPath, { force: true });
        invocation = Promise.resolve().then(() => (runImpl ?? runCommand)({ ...spec, cwd: attemptWorkDir, stdin: request.prompt, timeoutMs, signal: controller.signal, maxBytes: MAX_BYTES, onStdout, onStderr, onLimit: () => stop('too_large') }));
        let result = await Promise.race([invocation, cancelled]);
        // Native processes own real capacity until close, including the kill grace.
        // Injected runners may ignore cancellation entirely, so their wait is bounded
        // independently by the adapter timer rather than trusted to settle.
        if (!result && !runImpl) result = await invocation;
        completed = Boolean(result);
        // Only parse the buffered suffix: injected runners may both stream and buffer.
        if (result && !stopReason) {
          const buffered = String(result.stdout ?? '');
          if (streamed && buffered.startsWith(streamed)) onStdout(buffered.slice(streamed.length));
          else if (!streamed) onStdout(buffered);
          event(pending);
          if (result.stderr && result.stderr !== stderr) onStderr(String(result.stderr));
        }
        if (stopReason) return finish(stopReason === 'timeout' ? 'timeout' : 'error', { error: stopReason });
        if (result.tooLarge) return finish('error', { error: 'too_large' });
        if (quota) return finish('quota', { error: stderr || 'Judge quota reached' });
        if (refused) return finish('refused');
        if (result.exitCode !== 0) return finish('error', { error: stderr || `Judge exited ${result.exitCode}` });
        const outputStat = await stat(outputPath);
        if (!outputStat.isFile() || outputStat.size > MAX_BYTES) return finish('invalid', { errorCode: 'output_missing_or_too_large', error: 'Judge output is missing or too large' });
        const rawText = await readFile(outputPath, 'utf8');
        let output;
        try { output = JSON.parse(rawText); } catch { return finish('invalid', { rawText, errorCode: 'output_not_json', error: 'Judge output is not JSON' }); }
        if (!(request.forceDecision ? validForcedDecision(output) : validJudgment(output))) return finish('invalid', { rawText, errorCode: 'output_schema', error: 'Judge output does not match judgment schema' });
        return finish('ok', { output, rawText });
      } catch (error) {
        if (error.code === 'ENOENT' && completed) return finish('invalid', { errorCode: 'output_missing', error: 'Judge output file is missing' });
        return finish(stopReason === 'timeout' ? 'timeout' : stopReason ? 'error' : error.code === 'ENOENT' && completed ? 'invalid' : 'error', { error: error.message });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (!workDir) await rm(attemptWorkDir, { recursive: true, force: true });
      }
    },
  };
  adapter.ready = runImpl ? Promise.resolve() : (async () => {
    const spec = buildCodexArgv({ bin, codexHome, model, effort, schemaPath, outputPath: '-', workDir: workDir ?? os.tmpdir() });
    adapter.cliVersion = await versionOf({ ...spec, cwd: workDir ?? os.tmpdir() }, timeoutMs, versionController.signal);
  })();
  // Construction stays synchronous; callers receive initialization errors when
  // awaiting ready or judge, rather than through an unhandled background rejection.
  adapter.ready.catch(() => {});
  return adapter;
}

export function createJudgeAdapters(reviewPolicy) {
  const make = (tier) => {
    const config = reviewPolicy?.judge?.[tier];
    required(config?.model, `${tier}.model`);
    required(config?.codexHome, `${tier}.codexHome`);
    if (config.runner !== 'codex') throw new Error(`Unsupported ${tier} judge runner: ${config.runner}`);
    return codexExecAdapter({ ...config, tier, schemaPath: config.schemaPath ?? JUDGMENT_SCHEMA_PATH });
  };
  return { primary: make('primary'), escalation: make('escalation') };
}
