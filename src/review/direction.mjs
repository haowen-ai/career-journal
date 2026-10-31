import { readFile } from 'node:fs/promises';
import path from 'node:path';

// User rule (2026-10-29): a lead's role direction must be AI / machine learning / data science / data analytics,
// or a data-heavy product/tech PM. The judge's function dimension let buyer, claims, operations, generic PM and
// generic software engineering roles through. This filter runs after the verdict, at delivery and in the
// startup pass, and never enters a judge dependency hash, so editing its file re-judges nothing.
//   profile/role-direction.json { rule, allow[], block[], requireAllow[], allowFunctions[], neutral }
//     Each entry is a case-insensitive regular expression. allow, block and requireAllow test the posting title;
//     allowFunctions tests the judge's function label (e.g. ai_ml, data_engineering).
//     allow          an AI/ML/data signal; a title with one is always in direction.
//     block          an out-of-direction function (buyer, claims, sales, operations ...); out unless the title is
//                    allowed. A function label never overrides it: the judge labelled a claims role 'analytics'.
//     requireAllow   a borderline class (software engineering, generic PM, IT ...); out unless the title or the
//                    judge's function label is allowed.
//     neutral        'allow' (the default when missing) or 'deny': what a title matching none of the lists is.
//                    With 'deny' it is out (reason 'neutral') and no function label rescues it (2026-10-31: the
//                    judge labelled a pricing, a risk-management and a media-tools role analytics/engineering).
export const DIRECTION_FILE = 'role-direction.json';
export const DIRECTION_CODE = 'role_direction';

function patterns(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`Cannot load ${DIRECTION_FILE}: ${field} must be a list of non-empty strings`);
  }
  return value.map((source) => {
    try { return new RegExp(source, 'iu'); } catch (error) { throw new Error(`Cannot load ${DIRECTION_FILE}: ${field} has an invalid pattern ${JSON.stringify(source)}: ${error.message}`, { cause: error }); }
  });
}

export function directionRules(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Cannot load ${DIRECTION_FILE}: expected an object`);
  const neutral = raw.neutral ?? 'allow';
  if (!['allow', 'deny'].includes(neutral)) throw new Error(`Cannot load ${DIRECTION_FILE}: neutral must be "allow" or "deny"`);
  return { allow: patterns(raw.allow, 'allow'), block: patterns(raw.block, 'block'), requireAllow: patterns(raw.requireAllow, 'requireAllow'),
    allowFunctions: patterns(raw.allowFunctions, 'allowFunctions'), neutral };
}

// A missing file means no direction filter; a malformed one fails loudly.
export async function loadDirectionRules(profileDir) {
  let text;
  try { text = await readFile(path.join(profileDir, DIRECTION_FILE), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot load ${DIRECTION_FILE}: ${error.message}`, { cause: error });
  }
  try { return directionRules(JSON.parse(text)); } catch (error) {
    if (error.message.startsWith(`Cannot load ${DIRECTION_FILE}`)) throw error;
    throw new Error(`Cannot load ${DIRECTION_FILE}: ${error.message}`, { cause: error });
  }
}

// { ok, reason, match } for a title and, when known, the judge's function label.
// Without rules every title is in direction.
export function roleDirection(title, rules, { functionValue = null } = {}) {
  const text = String(title ?? '');
  if (!rules) return { ok: true, reason: null, match: null };
  const found = (list) => list.find((pattern) => pattern.test(text));
  const allowed = found(rules.allow);
  if (allowed) return { ok: true, reason: 'allow', match: text.match(allowed)[0] };
  const blocked = found(rules.block);
  if (blocked) return { ok: false, reason: 'block', match: text.match(blocked)[0] };
  const borderline = found(rules.requireAllow);
  if (borderline) {
    const label = typeof functionValue === 'string' && functionValue.trim() ? functionValue : null;
    if (label && rules.allowFunctions.some((pattern) => pattern.test(label))) return { ok: true, reason: 'allow_function', match: label };
    return { ok: false, reason: 'require_allow', match: text.match(borderline)[0] };
  }
  if (rules.neutral === 'deny') return { ok: false, reason: 'neutral', match: null };
  return { ok: true, reason: null, match: null };
}

export const directionNote = (result) => (result.reason === 'neutral' ? 'title has no AI/ML/data signal'
  : `${result.reason === 'block' ? 'out-of-direction title' : 'title needs an AI/ML/data signal'}: ${result.match}`);

// User rule (2026-10-31): pure software engineering is out of direction even when the title rules let the role
// through ("Software Engineer Intern" labelled engineering, "Full-Stack Developer Intern" labelled
// software_engineering, a media-tools developer labelled engineering all reached the queue as eligible). The judge's
// function label is free text, so it is normalised (lowercase; spaces, '/' and '-' as '_') before matching.
// A label is software engineering when it names software/engineering/swe/full stack/frontend/backend/developer/qa
// work and carries no AI, ML, data, analytics, research, quant or science signal. ai and ml are matched as words
// (with genai/openai/aiops, llm/mlops, aiml) so that html or email do not count as AI/ML signals.
export const OUT_OF_DIRECTION_CODE = 'out_of_direction';
const SWE_FUNCTION = /software|engineer|(?:^|_)swe(?:_|$)|full_?stack|front_?end|back_?end|develop(?:er|ment)|(?:^|_)qa(?:_|$)/;
const DIRECTION_FUNCTION = /(?:^|_)(?:gen|open)?ai(?:ops)?(?:_|$)|(?:^|_)(?:llms?|ml(?:ops)?)(?:_|$)|(?:^|_)aiml(?:_|$)|machine_learning|deep_learning|data|analytic|research|quant|scien|statistic|intelligen|(?:^|_)nlp(?:_|$)|computer_vision/;
export const normalizedFunction = (value) => (typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s/-]+/g, '_') : '');

export function softwareEngineeringFunction(value) {
  const label = normalizedFunction(value);
  return Boolean(label) && SWE_FUNCTION.test(label) && !DIRECTION_FUNCTION.test(label);
}

// The title's own AI/ML/data signal keeps a software-labelled role: the profile/role-direction.json allow patterns,
// or (also without that file) a plain AI/ML/data word in the title.
const TITLE_SIGNAL = /\b(?:A\.?I|ML|machine learning|deep learning|LLMs?|GenAI|NLP|computer vision|data|analytics?|statistic(?:s|al)?|quant\w*|scien\w*|research)\b/i;
export const titleAllowed = (title, rules) => TITLE_SIGNAL.test(String(title ?? '')) || (rules?.allow ?? []).some((pattern) => pattern.test(String(title ?? '')));

// An eligible role whose judge function label is pure software engineering and whose title has no allowed signal.
// Like every direction rule it needs profile/role-direction.json: without the file nothing is filtered.
export const softwareOnlyRole = (title, functionValue, rules) => Boolean(rules) && softwareEngineeringFunction(functionValue) && !titleAllowed(title, rules);
export const softwareNote = (functionValue) => `software engineering function: ${functionValue}`;
