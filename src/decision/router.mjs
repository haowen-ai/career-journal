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
    let candidate;
    try {
      candidate = validateEmailDecision(await jev.decide(input));
    } catch {
      candidate = null;
    }
    if (candidate && jev.mode === 'shadow') shadow = candidate;
    if (candidate && jev.mode === 'active' && (candidate.confidence ?? 0) >= (jev.threshold ?? 0.8)) {
      return { decision: candidate, engine: 'jev', applied: true };
    }
  }

  if (typeof adapters.structuredLlm === 'function') {
    const decision = validateEmailDecision(await adapters.structuredLlm(input));
    return { decision, engine: 'structured-llm', applied: shadow ? false : true, ...(shadow ? { shadow } : {}) };
  }
  return { decision: ruleDecision, engine: 'rules', applied: true, ...(shadow ? { shadow } : {}) };
}
