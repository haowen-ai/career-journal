import { classifyEmailWithRules } from './rules.mjs';
import { validateEmailDecision, validateRoleFitDecision } from './structured-llm.mjs';

// Role fit uses the same order as email: Jev, then the structured LLM, then
// the caller's deterministic rule decision, then manual review.
async function decideRoleFit(input, adapters) {
  let ruleDecision = null;
  try { ruleDecision = input.ruleDecision ? validateRoleFitDecision(input.ruleDecision) : null; }
  catch { ruleDecision = null; }

  let shadow;
  let jevAttempted = false;
  let jevOutcome = 'not-enabled';
  const jev = adapters.jev;
  if (jev?.accessState === 'enabled' && typeof jev.decide === 'function') {
    jevAttempted = true;
    let candidate = null;
    try {
      candidate = validateRoleFitDecision(await jev.decide(input));
      jevOutcome = 'returned';
    } catch {
      candidate = null;
      jevOutcome = 'error-or-invalid';
    }
    if (candidate && jev.mode === 'active' && (candidate.confidence ?? 0) >= (jev.threshold ?? 0.8)) {
      return { decision: candidate, engine: 'jev', applied: true, jevAttempted, jevOutcome: 'applied' };
    }
    if (candidate) shadow = candidate;
  }

  if (typeof adapters.structuredLlm === 'function') {
    let candidate = null;
    try {
      candidate = validateRoleFitDecision(await adapters.structuredLlm(input));
    } catch {
      candidate = null;
    }
    const threshold = Number.isFinite(Number(adapters.structuredLlmThreshold))
      ? Number(adapters.structuredLlmThreshold)
      : 0.8;
    if (candidate && (candidate.confidence ?? 0) >= threshold) {
      return { decision: candidate, engine: 'structured-llm', applied: true, jevAttempted, jevOutcome, ...(shadow ? { shadow } : {}) };
    }
  }
  if (ruleDecision) {
    return { decision: ruleDecision, engine: 'rules', applied: true, jevAttempted, jevOutcome, ...(shadow ? { shadow } : {}) };
  }
  return { decision: { fit: null }, engine: 'manual-review', applied: false, jevAttempted, jevOutcome, ...(shadow ? { shadow } : {}) };
}

export async function decide(input, adapters = {}) {
  if (input?.kind === 'role-fit') return decideRoleFit(input, adapters);
  if (input?.kind !== 'email-classification') throw new Error(`Unsupported decision kind: ${input?.kind ?? 'missing'}`);
  const ruleDecision = classifyEmailWithRules(input.text);

  let shadow;
  let jevAttempted = false;
  let jevOutcome = 'not-enabled';
  const jev = adapters.jev;
  if (jev?.accessState === 'enabled' && typeof jev.decide === 'function') {
    jevAttempted = true;
    let candidate = null;
    try {
      candidate = validateEmailDecision(await jev.decide(input));
      jevOutcome = 'returned';
    } catch {
      candidate = null;
      jevOutcome = 'error-or-invalid';
    }
    if (candidate && jev.mode === 'shadow') shadow = candidate;
    if (candidate && jev.mode === 'active'
      && candidate.classification !== 'unknown'
      && (candidate.confidence ?? 0) >= (jev.threshold ?? 0.8)) {
      return { decision: candidate, engine: 'jev', applied: true, jevAttempted, jevOutcome: 'applied' };
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
      return { decision: candidate, engine: 'structured-llm', applied: true, jevAttempted, jevOutcome, ...(shadow ? { shadow } : {}) };
    }
  }
  if (ruleDecision.classification !== 'unknown') {
    return { decision: ruleDecision, engine: 'rules', applied: true, jevAttempted, jevOutcome, ...(shadow ? { shadow } : {}) };
  }
  return { decision: ruleDecision, engine: 'manual-review', applied: false, jevAttempted, jevOutcome, ...(shadow ? { shadow } : {}) };
}
