import { EMAIL_CLASSIFICATIONS, ROLE_FIT_CHOICES } from './rules.mjs';

export function validateEmailDecision(value) {
  if (!value || typeof value !== 'object' || !EMAIL_CLASSIFICATIONS.includes(value.classification)) {
    throw new Error('Invalid email classification');
  }
  if (value.confidence !== undefined && (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) {
    throw new Error('Invalid email classification confidence');
  }
  return {
    classification: value.classification,
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    ...(value.usage
      && Number.isInteger(value.usage.input_tokens) && value.usage.input_tokens >= 0
      && Number.isInteger(value.usage.output_tokens) && value.usage.output_tokens >= 0
      ? { usage: { input_tokens: value.usage.input_tokens, output_tokens: value.usage.output_tokens } }
      : {}),
  };
}

export async function classifyWithStructuredLlm(provider, text) {
  const decision = await provider.structured({
    system: 'Classify a recruiting email. Return only the requested JSON object.',
    input: String(text ?? ''),
    schema: {
      properties: {
        classification: { type: 'string', enum: EMAIL_CLASSIFICATIONS },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['classification', 'confidence'],
    },
  });
  return validateEmailDecision(decision);
}

export function validateRoleFitDecision(value) {
  if (!value || typeof value !== 'object' || !ROLE_FIT_CHOICES.includes(value.fit)) {
    throw new Error('Invalid role fit decision');
  }
  if (value.confidence !== undefined && value.confidence !== null
    && (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) {
    throw new Error('Invalid role fit confidence');
  }
  return {
    fit: value.fit,
    ...(value.confidence === undefined || value.confidence === null ? {} : { confidence: value.confidence }),
    ...(value.usage
      && Number.isInteger(value.usage.input_tokens) && value.usage.input_tokens >= 0
      && Number.isInteger(value.usage.output_tokens) && value.usage.output_tokens >= 0
      ? { usage: { input_tokens: value.usage.input_tokens, output_tokens: value.usage.output_tokens } }
      : {}),
  };
}

export function roleFitPrompt(input) {
  const criteria = input?.criteria ?? {};
  return [
    'Criteria:',
    ...ROLE_FIT_CHOICES.map((choice) => `- ${choice}: ${String(criteria[choice] ?? '')}`),
    '',
    'Role:',
    String(input?.text ?? ''),
  ].join('\n');
}

export async function rateRoleFitWithStructuredLlm(provider, input) {
  const decision = await provider.structured({
    system: 'Rate how well a job posting fits the candidate search directions. Choose exactly one of high, medium, or low using the criteria. Return only the requested JSON object.',
    input: roleFitPrompt(input),
    schema: {
      properties: {
        fit: { type: 'string', enum: ROLE_FIT_CHOICES },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['fit', 'confidence'],
    },
  });
  return validateRoleFitDecision(decision);
}
