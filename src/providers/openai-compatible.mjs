function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Model provider baseUrl must be a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Model provider baseUrl must be an HTTP(S) URL without credentials');
  }
  return parsed.href.replace(/\/$/, '');
}

function resolveSecret(secretRef, env) {
  if (!secretRef) return null;
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(secretRef);
  if (!match) throw new Error('Model credentials must use an env:VARIABLE secret reference');
  const secret = env[match[1]];
  if (!secret) throw new Error(`Model credential environment variable is unavailable: ${match[1]}`);
  return secret;
}

function validateRequired(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Structured model response must be a JSON object');
  for (const field of schema?.required ?? []) {
    if (!(field in value)) throw new Error(`Structured model response is missing required field: ${field}`);
  }
  return value;
}

export function createOpenAICompatibleProvider(config, fetchImpl = globalThis.fetch, env = process.env) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!config.model) throw new Error('Model provider requires a model');
  if (typeof fetchImpl !== 'function') throw new Error('Model provider requires a fetch implementation');
  const timeoutMs = Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : 30_000;

  return {
    name: 'openai-compatible',
    async structured({ system, input, schema = {} }) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const secret = resolveSecret(config.secretRef, env);
        const headers = { 'content-type': 'application/json' };
        if (secret) headers.authorization = `Bearer ${secret}`;
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: String(system ?? '') },
              { role: 'user', content: String(input ?? '') },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'career_journal_response',
                strict: true,
                schema: { type: 'object', additionalProperties: true, ...schema },
              },
            },
          }),
        });
        if (!response.ok) throw new Error(`Model provider request failed with HTTP ${response.status}`);
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('Model provider returned no structured content');
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch {
          throw new Error('Model provider returned invalid JSON');
        }
        return validateRequired(parsed, schema);
      } catch (error) {
        if (timedOut || error?.name === 'AbortError') throw new Error(`Model provider request timed out after ${timeoutMs}ms`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
