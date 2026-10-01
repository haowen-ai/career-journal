import { decide } from '../decision/router.mjs';
import { DIRECTION_KEYWORDS, directionLabel, matchDirections } from './directions.mjs';

const MAX_DESCRIPTION_CHARS = 6000;

// Criteria text for the high/medium/low choice, built only from the profile.
export function fitCriteria(profile) {
  const primary = profile?.search?.directions?.primary ?? [];
  const secondary = profile?.search?.directions?.secondary ?? [];
  const primaryText = primary.length ? primary.map(directionLabel).join(', ') : 'the candidate\'s main search directions';
  return {
    high: `The main work of the role is in one of the candidate's primary directions: ${primaryText}.`,
    medium: secondary.length
      ? `The main work is in one of the candidate's secondary directions (${secondary.map(directionLabel).join(', ')}), or the role only partly overlaps a primary direction.`
      : 'The role only partly overlaps a primary direction.',
    low: 'The main work of the role is outside the candidate\'s primary and secondary directions.',
  };
}

// Deterministic fallback: primary direction in the title is high, secondary
// is medium, anything else is low.
export function ruleFit(role, profile, keywordMap = DIRECTION_KEYWORDS) {
  const titleOnly = { title: role?.title ?? '', categories: [] };
  const primary = matchDirections(titleOnly, profile?.search?.directions?.primary ?? [], keywordMap)[0];
  if (primary) return { fit: 'high', note: `primary direction ${primary.id} ("${primary.term}") in the title` };
  const secondary = matchDirections(titleOnly, profile?.search?.directions?.secondary ?? [], keywordMap)[0];
  if (secondary) return { fit: 'medium', note: `secondary direction ${secondary.id} ("${secondary.term}") in the title` };
  return { fit: 'low', note: 'no primary or secondary direction in the title' };
}

export function roleFitText(role) {
  const description = String(role?.description ?? '');
  return [
    `Company: ${role?.company ?? ''}`,
    `Title: ${role?.title ?? ''}`,
    `Locations: ${(role?.locations ?? []).join('; ') || 'not stated'}`,
    ...(role?.categories?.length ? [`Categories: ${role.categories.join('; ')}`] : []),
    '',
    description.length > MAX_DESCRIPTION_CHARS ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}...` : description,
  ].join('\n');
}

const ENGINE_LABELS = Object.freeze({ jev: 'Jev', 'structured-llm': 'structured LLM' });

export async function scoreFit(role, profile, adapters = {}, { rulesOnly = false } = {}) {
  const rule = ruleFit(role, profile);
  if (rulesOnly) {
    return { fit: rule.fit, confidence: null, engine: 'rules', applied: true, ruleBased: true, note: `Rule-based fit (dry run, no semantic provider called): ${rule.note}` };
  }
  const routed = await decide({
    kind: 'role-fit',
    text: roleFitText(role),
    criteria: fitCriteria(profile),
    ruleDecision: { fit: rule.fit },
  }, adapters);
  const confidence = routed.decision.confidence ?? null;
  const ruleBased = routed.engine === 'rules';
  const jevNote = routed.jevAttempted && routed.engine !== 'jev' ? `; Jev ${routed.jevOutcome === 'returned' ? 'result not applied' : 'was unavailable'}` : '';
  const note = ruleBased
    ? `Rule-based fit (no semantic provider decided${jevNote}): ${rule.note}`
    : routed.engine === 'manual-review'
      ? 'Fit needs manual review'
      : `Fit by ${ENGINE_LABELS[routed.engine] ?? routed.engine}${confidence === null ? '' : ` (confidence ${confidence})`}${jevNote}`;
  return {
    fit: routed.decision.fit ?? null,
    confidence,
    engine: routed.engine,
    applied: routed.applied,
    ruleBased,
    note,
    jevAttempted: routed.jevAttempted,
    jevOutcome: routed.jevOutcome,
    ...(routed.shadow ? { shadow: routed.shadow } : {}),
  };
}
