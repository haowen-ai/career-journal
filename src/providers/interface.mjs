import { createOpenAICompatibleProvider } from './openai-compatible.mjs';

export function createProvider(config, fetchImpl = globalThis.fetch, env = process.env) {
  if (!config || config.provider !== 'openai-compatible') {
    throw new Error(`Unsupported model provider: ${config?.provider ?? 'missing'}`);
  }
  return createOpenAICompatibleProvider(config, fetchImpl, env);
}
