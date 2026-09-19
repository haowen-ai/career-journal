import { classifyEmailWithRules } from './rules.mjs';
import { validateEmailDecision } from './structured-llm.mjs';

export async function decide(input, adapters = {}) {
  if (input?.kind !== 'email-classification') throw new Error(`Unsupported decision kind: ${input?.kind ?? 'missing'}`);
  const ruleDecision = classifyEmailWithRules(input.text);
  if (ruleDecision.classification !== 'unknown') {
    return { decision: ruleDecision, engine: 'rules', applied: true };
  }

  let shadow;
  const jev = adapters.jev;
  if (jev?.accessState === 'enabled' && typeof jev.decide === 'function') {
    let candidate = null;
    try {
      candidate = validateEmailDecision(await jev.decide(input));
    } catch {
      candidate = null;
    }
    if (candidate && jev.mode === 'shadow') shadow = candidate;
    if (candidate && jev.mode === 'active'
      && candidate.classification !== 'unknown'
      && (candidate.confidence ?? 0) >= (jev.threshold ?? 0.8)) {
      return { decision: candidate, engine: 'jev', applied: true };
    }
    if (candidate && jev.mode === 'active') shadow = candidate;
  }

  if (typeof adapters.structuredLlm === 'function') {
    let candidate = null;
    try {
      candidate = validateEmailDecision(await adapters.structuredLlm(input));
    } catch {
      candidate = null;
    }
    const threshold = Number.isFinite(Number(adapters.structuredLlmThreshold))
      ? Number(adapters.structuredLlmThreshold)
      : 0.8;
    if (candidate
      && candidate.classification !== 'unknown'
      && (candidate.confidence ?? 0) >= threshold) {
      return { decision: candidate, engine: 'structured-llm', applied: true, ...(shadow ? { shadow } : {}) };
    }
  }
  return { decision: ruleDecision, engine: 'manual-review', applied: false, ...(shadow ? { shadow } : {}) };
}
