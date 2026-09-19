import { EMAIL_CLASSIFICATIONS, classifyEmailWithRules } from './rules.mjs';

function resolveSecret(secretRef, env) {
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(secretRef ?? ''));
  if (!match) throw new Error('Jev credentials must use an env:VARIABLE secret reference');
  const value = env[match[1]];
  if (!value) throw new Error(`Jev credential environment variable is unavailable: ${match[1]}`);
  return value;
}

export function createJevAdapter(config, fetchImpl = globalThis.fetch, env = process.env) {
  const accessState = config?.accessState ?? 'waitlisted';
  const mode = config?.mode ?? 'shadow';
  const threshold = Number.isFinite(Number(config?.threshold)) ? Number(config.threshold) : 0.8;
  if (accessState !== 'enabled') {
    return { accessState, mode, threshold, async decide() { throw new Error('Jev access is not enabled'); } };
  }
  return {
    accessState,
    mode,
    threshold,
    async decide(input) {
      const secret = resolveSecret(config.secretRef, env);
      const response = await fetchImpl(config.baseUrl ?? 'https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          model: config.model ?? 'jev-latest',
          question: `Classify this recruiting email: ${input.text}`,
          choices: EMAIL_CLASSIFICATIONS,
        }),
      });
      if (!response.ok) throw new Error(`Jev request failed with HTTP ${response.status}`);
      const payload = await response.json();
      return payload?.answers?.classification ?? payload?.classification ?? classifyEmailWithRules('');
    },
  };
}
