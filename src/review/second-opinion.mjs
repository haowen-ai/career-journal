import { resolveSecretReference } from '../secrets/reference.mjs';

export function createSecondOpinion(policy) {
  const config = policy.judge?.secondOpinion;
  if (!config) return undefined;
  if (config.runner !== 'jev') throw new Error('Second opinion runner must be jev');
  return createJevAdapter(config);
}

// System One accepts exactly one noul question for each ask, for either role.
export function createJevAdapter(config) {
  const model = config.model ?? 'jev-latest';
  return {
    id: `jev:${model}`, runner: 'jev', model,
    async ask({ state, question }) {
      // Resolve credentials only at dispatch, and never expose transport errors
      // or response bodies that might contain the authorization header.
      try {
        const secretRef = process.env.TYPESAFE_API_KEY ? 'env:TYPESAFE_API_KEY'
          : `keychain:career-journal-typesafe:${process.env.USER}`;
        const { value: key } = await resolveSecretReference(secretRef);
        const response = await fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, state, questions: { eligible: { type: 'noul', instructions: question } } }),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error('Jev HTTP error');
        const payload = await response.json();
        const probability = payload?.answers?.eligible?.noul;
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid Jev probability');
        return { probability, usage: payload.usage };
      } catch {
        throw new Error('Jev second opinion request failed');
      }
    },
  };
}
