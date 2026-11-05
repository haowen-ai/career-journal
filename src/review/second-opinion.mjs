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

// An operational Jev failure (not an answer). Message and fields are built here from the HTTP status or
// the failure class only, so they never carry the credential or a response body.
export class JevError extends Error {
  constructor(message, { kind, status = null } = {}) { super(message); this.name = 'JevError'; this.kind = kind; this.status = status; }
}
// The structured result every Jev caller records: { kind, status, message }.
export function jevFailure(error) {
  if (error instanceof JevError || error?.name === 'JevError') return { kind: error.kind ?? 'error', status: error.status ?? null, message: error.message };
  return { kind: 'error', status: null, message: String(error?.message ?? error ?? 'Jev request failed').slice(0, 300) };
}

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
  const wait = (attempt) => new Promise((done) => setTimeout(done, retryDelayMs * attempt));
  return {
    id: `jev:${model}`, runner: 'jev', model,
    async ask({ state, question }) {
      // Resolve credentials only at dispatch. Errors are rebuilt from their class and status only: transport
      // errors and response bodies might contain the authorization header.
      let key;
      try { key = await resolveKey(); } catch { throw new JevError('Jev credentials unavailable', { kind: 'credentials' }); }
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
          if (attempt < TRIES) { await wait(attempt); continue; }
          if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new JevError('Jev timeout', { kind: 'timeout' });
          const code = /^[A-Z][A-Z0-9_]{2,40}$/.test(String(error?.cause?.code ?? error?.code ?? '')) ? ` ${error.cause?.code ?? error.code}` : '';
          throw new JevError(`Jev network error${code}`, { kind: 'network' });
        }
        if (!response.ok) {
          if (transient(response.status) && attempt < TRIES) { await wait(attempt); continue; }
          throw new JevError(`Jev HTTP ${response.status}`, { kind: [401, 403].includes(response.status) ? 'auth' : 'http', status: response.status });
        }
        let payload;
        try { payload = await response.json(); } catch { throw new JevError('Jev response is not JSON', { kind: 'invalid_response', status: response.status }); }
        const probability = payload?.answers?.eligible?.noul;
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new JevError('Invalid Jev probability', { kind: 'invalid_response', status: response.status });
        return { probability, usage: payload.usage };
      }
    },
  };
}
