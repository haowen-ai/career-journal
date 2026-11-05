import { readFileSync } from 'node:fs';
import { resolveSecretReference } from '../secrets/reference.mjs';
import { JUDGMENT_SCHEMA_PATH } from './prompt.mjs';
import { validForcedDecision, validJudgment } from './judge.mjs';

// The Claude API judge runner: the same contract as codexExecAdapter (ready, judge(request, { attemptId,
// outputPath, signal }) -> { status, output, rawText, usage, transportRetries, errorCode?, error? }), one
// structured `messages.create` call per judgment through the official SDK. Failures carry a stable errorCode,
// so the worker's identical-failure breaker stops a run on an outage instead of storming the API:
//   auth            401/403 or no API key          billing       402 or billing_error
//   rate_limited    429 after the SDK's retries     unavailable   network, timeout or 5xx
//   invalid_output  not JSON or not the schema      refused       stop_reason refusal
// Error text is built here from the status and error type only; it never carries the key or a response body.

export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// The SDK is loaded on first use, so a home that never configures a Claude runner (and a checkout without
// `npm install`) runs exactly as before. A missing SDK fails adapter.ready with a clear message.
let sdkPromise;
let sdk;
export function loadClaudeSdk() {
  sdkPromise ??= Promise.all([import('@anthropic-ai/sdk'), import('@anthropic-ai/sdk/version')])
    .then(([main, version]) => { sdk = { ...main, VERSION: version.VERSION }; return sdk; })
    .catch((error) => { sdkPromise = undefined; throw new Error(`Claude runner needs the @anthropic-ai/sdk package (run npm install): ${error.code ?? error.message}`); });
  return sdkPromise;
}
const POSTING_MARK = '<<<POSTING';
const STRING_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

export class ClaudeJudgeError extends Error {
  constructor(message, { code, status = 'error' } = {}) { super(message); this.name = 'ClaudeJudgeError'; this.code = code; this.status = status; }
}

const typeOfValue = (value) => (value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value === 'number' ? 'number' : typeof value);

// The API accepts a subset of JSON Schema (no pattern, no type arrays). Keep what it enforces (types, enum,
// anyOf, $ref/$defs, required, additionalProperties false) and move the rest into the description; the
// caller validates the full schema again (schemaValid), so nothing is lost.
export function apiSchema(rule) {
  if (!rule || typeof rule !== 'object') return rule;
  const { $schema, $defs, $ref, anyOf, type, enum: values, description, title, properties, required, additionalProperties, items, format, minItems, ...rest } = rule;
  const out = {};
  if ($defs) out.$defs = Object.fromEntries(Object.entries($defs).map(([key, value]) => [key, apiSchema(value)]));
  if ($ref) return { ...out, $ref };
  const types = Array.isArray(type) ? type : type ? [type] : values ? [...new Set(values.map(typeOfValue))] : [];
  if (anyOf) out.anyOf = anyOf.map(apiSchema);
  else if (types.length > 1) {
    const branches = types.map((one) => apiSchema({ ...rule, $defs: undefined, description: undefined, title: undefined, type: one,
      enum: values ? values.filter((value) => typeOfValue(value) === one || (one === 'number' && typeOfValue(value) === 'integer')) : undefined }));
    return { ...out, anyOf: branches, ...(description ? { description } : {}), ...(title ? { title } : {}) };
  } else if (types.length === 1) out.type = types[0];
  if (values && out.type !== 'null') out.enum = values;
  const extra = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  if (out.type === 'object') {
    out.properties = Object.fromEntries(Object.entries(properties ?? {}).map(([key, value]) => [key, apiSchema(value)]));
    if (required) out.required = required;
    out.additionalProperties = false;
  } else if (out.type === 'array') {
    if (items) out.items = apiSchema(items);
    if (minItems === 0 || minItems === 1) out.minItems = minItems; else if (minItems !== undefined) extra.minItems = minItems;
  } else if (out.type === 'string' && format !== undefined) {
    if (STRING_FORMATS.has(format)) out.format = format; else extra.format = format;
  }
  if (title) out.title = title;
  const notes = Object.entries(extra).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ');
  if (description || notes) out.description = [description, notes ? `{${notes}}` : null].filter(Boolean).join('\n\n');
  return out;
}

const schemaCache = new Map();
function schemaFor(schemaPath) {
  if (!schemaCache.has(schemaPath)) schemaCache.set(schemaPath, apiSchema(JSON.parse(readFileSync(schemaPath, 'utf8'))));
  return schemaCache.get(schemaPath);
}

// The rendered judge prompt is rules, facts, resume and policy, then the delimited posting. The stable head goes
// to `system` with a cache breakpoint, so it is cached across postings; the posting (and any forced-decision
// question after it) is the user turn. The posting block escapes its own markers, so the first one is the real one.
export function splitPrompt(prompt) {
  const text = String(prompt);
  const at = text.indexOf(POSTING_MARK);
  if (at <= 0) return { system: null, user: text };
  return { system: text.slice(0, at).trimEnd(), user: text.slice(at) };
}

export function claudeRequestParams({ model, effort, maxTokens, prompt, schema, system }) {
  const parts = system === undefined ? splitPrompt(prompt) : { system, user: prompt };
  return {
    model,
    max_tokens: maxTokens,
    ...(parts.system ? { system: [{ type: 'text', text: parts.system, cache_control: { type: 'ephemeral' } }] } : {}),
    messages: [{ role: 'user', content: parts.user }],
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
  };
}

function classify(error) {
  if (error instanceof ClaudeJudgeError) return error;
  if (!sdk) return new ClaudeJudgeError('Claude API call failed', { code: 'adapter_error' });
  const { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } = sdk;
  if (error instanceof APIUserAbortError) return new ClaudeJudgeError('Claude API call cancelled', { code: 'cancelled' });
  if (error instanceof APIConnectionTimeoutError) return new ClaudeJudgeError('Claude API timeout', { code: 'unavailable', status: 'timeout' });
  if (error instanceof APIConnectionError) return new ClaudeJudgeError('Claude API network error', { code: 'unavailable' });
  if (error instanceof APIError) {
    const { status, type } = error;
    const label = `Claude API HTTP ${status ?? 'none'}${type ? ` ${type}` : ''}`;
    if (status === 402 || type === 'billing_error') return new ClaudeJudgeError(label, { code: 'billing' });
    if (status === 401 || status === 403) return new ClaudeJudgeError(label, { code: 'auth' });
    if (status === 429) return new ClaudeJudgeError(label, { code: 'rate_limited' });
    if (status >= 500) return new ClaudeJudgeError(label, { code: 'unavailable' });
    return new ClaudeJudgeError(label, { code: `http_${status ?? 'none'}` });
  }
  return new ClaudeJudgeError('Claude API call failed', { code: 'adapter_error' });
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Claude judge ${name} must be positive`);
  return value;
}

// One structured call: returns { output, rawText, usage } or throws ClaudeJudgeError. Shared by the judge
// adapter and the company-size model call.
export function claudeCaller({ model, effort = 'low', maxTokens = 4096, timeoutMs = 120000, maxRetries = 2, secretRef, client, createClient, resolveSecret = resolveSecretReference } = {}) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('Claude judge configuration requires model');
  if (!CLAUDE_EFFORTS.includes(effort)) throw new Error(`Claude judge effort must be one of ${CLAUDE_EFFORTS.join(', ')}`);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('Claude judge maxTokens must be a positive integer');
  positive(timeoutMs, 'timeoutMs');
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('Claude judge maxRetries must be a non-negative integer');
  const ref = secretRef ?? (process.env.ANTHROPIC_API_KEY ? 'env:ANTHROPIC_API_KEY' : `keychain:career-journal-anthropic:${process.env.USER}`);
  let clientPromise = client ? loadClaudeSdk().then(() => client) : undefined;
  const getClient = () => {
    clientPromise ??= (async () => {
      const { default: Anthropic } = await loadClaudeSdk();
      let apiKey;
      try { ({ value: apiKey } = await resolveSecret(ref)); } catch { throw new ClaudeJudgeError('Claude API key unavailable', { code: 'auth' }); }
      if (!apiKey) throw new ClaudeJudgeError('Claude API key unavailable', { code: 'auth' });
      return (createClient ?? ((options) => new Anthropic(options)))({ apiKey, maxRetries, timeout: timeoutMs });
    })().catch((error) => { clientPromise = undefined; throw error; });
    return clientPromise;
  };
  const call = async ({ prompt, schema, system, validate, signal }) => {
    const params = claudeRequestParams({ model, effort, maxTokens, prompt, schema, system });
    let message;
    try {
      const api = await getClient();
      message = await api.messages.create(params, { signal, timeout: timeoutMs, maxRetries });
    } catch (error) { throw classify(error); }
    const usage = message?.usage ?? null;
    if (message?.stop_reason === 'refusal') throw Object.assign(new ClaudeJudgeError('Claude refused the request', { code: 'refused', status: 'refused' }), { usage });
    const rawText = (message?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('');
    const invalid = (why) => Object.assign(new ClaudeJudgeError(`Claude output ${why}`, { code: 'invalid_output', status: 'invalid' }), { usage, rawText });
    let output;
    try { output = JSON.parse(rawText); } catch {
      throw invalid(message?.stop_reason === 'max_tokens' ? 'stopped at max_tokens before the JSON was complete' : 'is not JSON');
    }
    if (validate && !validate(output)) throw invalid('does not match the schema');
    return { output, rawText, usage };
  };
  return { call, model, effort, maxTokens, timeoutMs, maxRetries };
}

export function claudeApiAdapter({ model, effort = 'low', tier, maxTokens = 4096, timeoutMs = 120000, maxRetries = 2, secretRef, schemaPath = JUDGMENT_SCHEMA_PATH, client, createClient, resolveSecret } = {}) {
  if (!['primary', 'escalation'].includes(tier)) throw new Error('Judge configuration requires tier primary or escalation');
  const caller = claudeCaller({ model, effort, maxTokens, timeoutMs, maxRetries, secretRef, client, createClient, resolveSecret });
  const adapter = {
    id: `claude:${tier}:${model}`, runner: 'claude', model, tier, effort,
    // Part of the judge dependency hash (judgeDependencies: runner, model, tier, effort, cliVersion), like codex's CLI version.
    cliVersion: null,
    timeoutMs, maxTransportRetries: maxRetries, maxTokens,
    async judge(request, { attemptId, signal } = {}) {
      if (typeof attemptId !== 'string' || !attemptId) throw new Error('Judge configuration requires attemptId');
      await adapter.ready;
      const finish = (status, extra = {}) => ({ status, output: null, rawText: '', usage: null, transportRetries: 0, ...extra });
      try {
        const { output, rawText, usage } = await caller.call({ prompt: request.prompt, schema: schemaFor(request.schemaPath ?? schemaPath),
          validate: request.forceDecision ? validForcedDecision : validJudgment, signal });
        return finish('ok', { output, rawText, usage });
      } catch (error) {
        const failure = classify(error);
        return finish(failure.status, { errorCode: failure.code, error: failure.message, usage: error.usage ?? null, rawText: error.rawText ?? '' });
      }
    },
  };
  adapter.ready = loadClaudeSdk().then(({ VERSION }) => { adapter.cliVersion = `anthropic-sdk-${VERSION}`; });
  adapter.ready.catch(() => {}); // callers see the error when they await ready or judge
  return adapter;
}
