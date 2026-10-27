import { resolveSecretReference } from '../secrets/reference.mjs';

export function createSecondOpinion(policy) {
  const config = policy.judge?.secondOpinion;
  if (!config) return undefined;
  if (config.runner !== 'jev') throw new Error('Second opinion runner must be jev');
  return createJevAdapter(config);
}

// System One accepts exactly one noul question for each ask, for either role.
// Network errors, 429 and 5xx are retried twice: one bad window must not push a
// whole nightly run onto the paid fallback.
const TRIES = 3;
const transient = (status) => status === 429 || status >= 500;

export function createJevAdapter(config) {
  const model = config.model ?? 'jev-latest';
  const retryDelayMs = config.retryDelayMs ?? 2000;
  let keyPromise;
  const resolveKey = () => {
    keyPromise ??= resolveSecretReference(process.env.TYPESAFE_API_KEY ? 'env:TYPESAFE_API_KEY'
      : `keychain:career-journal-typesafe:${process.env.USER}`).then(({ value }) => value)
      .catch((error) => { keyPromise = undefined; throw error; });
    return keyPromise;
  };
  return {
    id: `jev:${model}`, runner: 'jev', model,
    async ask({ state, question }) {
      // Resolve credentials only at dispatch, and never expose transport errors
      // or response bodies that might contain the authorization header.
      try {
        const key = await resolveKey();
        for (let attempt = 1; ; attempt += 1) {
          let response;
          try {
            response = await fetch('https://api.typesafe.ai/v1/systemone', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
              body: JSON.stringify({ model, state, questions: { eligible: { type: 'noul', instructions: question } } }),
              signal: AbortSignal.timeout(30000),
            });
          } catch (error) {
            if (attempt >= TRIES) throw error;
            await new Promise((done) => setTimeout(done, retryDelayMs * attempt));
            continue;
          }
          if (!response.ok) {
            if (transient(response.status) && attempt < TRIES) {
              await new Promise((done) => setTimeout(done, retryDelayMs * attempt));
              continue;
            }
            throw new Error('Jev HTTP error');
          }
          const payload = await response.json();
          const probability = payload?.answers?.eligible?.noul;
          if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid Jev probability');
          return { probability, usage: payload.usage };
        }
      } catch {
        throw new Error('Jev second opinion request failed');
      }
    },
  };
}
