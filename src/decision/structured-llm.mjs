import { EMAIL_CLASSIFICATIONS } from './rules.mjs';

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
