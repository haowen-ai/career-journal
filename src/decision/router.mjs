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
    const rawCandidate = await jev.decide(input);
    let candidate = null;
    try {
      candidate = validateEmailDecision(rawCandidate);
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
  return { decision: ruleDecision, engine: 'manual-review', applied: false, ...(shadow ? { shadow } : {}) };
}
