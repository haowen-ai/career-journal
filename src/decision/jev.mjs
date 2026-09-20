import { EMAIL_CLASSIFICATIONS } from './rules.mjs';
import { resolveSecretReference } from '../secrets/reference.mjs';

export const JEV_EMAIL_QUESTION = Object.freeze({
  type: 'choice',
  instructions: 'Choose the single recruiting workflow outcome best supported by this email. Choose unknown when the message does not provide enough evidence.',
  criteria: Object.freeze({
    application_confirmation: 'Confirms that a specific application was submitted or received, without requiring another hiring step',
    assessment: 'Requires or invites an online assessment, coding challenge, take-home exercise, questionnaire, or similar evaluation',
    interview: 'Invites or schedules an interview, recruiter screen, hiring-manager conversation, or recorded video response',
    rejection: 'States that the candidate will not move forward for the specific application',
    offer: 'Communicates an employment or internship offer for the specific application',
    marketing: 'A newsletter, job alert, talent-community message, or other promotional content without an application-specific status update',
    unknown: 'The message is ambiguous, administrative, or does not support any other outcome',
  }),
});

function apiEndpoint(value) {
  const url = new URL(value ?? 'https://api.typesafe.ai/v1/systemone');
  if (url.origin !== 'https://api.typesafe.ai' || url.pathname.replace(/\/$/, '') !== '/v1/systemone' || url.search || url.hash) {
    throw new Error('Jev endpoint must be https://api.typesafe.ai/v1/systemone');
  }
  return 'https://api.typesafe.ai/v1/systemone';
}

export function createJevAdapter(config, fetchImpl = globalThis.fetch, env = process.env, capabilities = {}) {
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
      const endpoint = apiEndpoint(config.baseUrl);
      const { value: secret } = await resolveSecretReference(config.secretRef, { ...capabilities, env });
      const retryDelaysMs = Array.isArray(config.retryDelaysMs) ? config.retryDelaysMs : [250, 750];
      let response;
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify({
            state: String(input?.text ?? ''),
            model: config.model ?? 'jev-latest',
            questions: { classification: JEV_EMAIL_QUESTION },
          }),
        });
        if (response.ok || ![429, 529].includes(response.status) || attempt === retryDelaysMs.length) break;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(retryDelaysMs[attempt]) || 0)));
      }
      if (!response.ok) throw new Error(`Jev request failed with HTTP ${response.status}`);
      const payload = await response.json();
      const answer = payload?.answers?.classification;
      if (answer?.type !== 'choice'
        || !EMAIL_CLASSIFICATIONS.includes(answer.choice)
        || !Number.isFinite(answer.confidence)
        || answer.confidence < 0
        || answer.confidence > 1) {
        throw new Error('Invalid Jev classification response');
      }
      const usage = payload?.usage;
      const validUsage = usage
        && Number.isInteger(usage.input_tokens) && usage.input_tokens >= 0
        && Number.isInteger(usage.output_tokens) && usage.output_tokens >= 0;
      return {
        classification: answer.choice,
        confidence: answer.confidence,
        ...(validUsage ? { usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } } : {}),
      };
    },
  };
}
