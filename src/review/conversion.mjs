// Program types that are not a conversion path by nature (fellowships, residencies, academic or student
// research programs) need a quoted conversion statement from the official page. A Jev-direct accept cannot
// supply one, so the worker sends such postings on to the Codex tiers (redesign B11). Generic defaults;
// a data home can replace them with review-policy.json conversionProof.titlePatterns (regex sources, case-insensitive).
export const DEFAULT_CONVERSION_PROOF_PATTERNS = Object.freeze([
  '\\bfellow(?:s|ship|ships)?\\b',
  '\\bresidency\\b',
  // "resident" only in a program context (not e.g. a resident advisor or a residential role).
  '\\b(?:ai|ml|research|science|scientist|engineering|technology|tech|program|programme)\\s+residents?\\b',
  '\\bresidents?\\s+(?:program|programme|researcher|scientist)\\b',
  '\\bresearch\\s+training\\s+program(?:me)?\\b',
  '\\bstudent\\s+researchers?\\b',
  '\\bacademic\\s+summer\\s+research\\b',
  '\\bsummer\\s+research\\s+(?:program|programme|scholars?)\\b',
]);

const compiled = new Map();
function patternsOf(policy) {
  const configured = policy?.conversionProof?.titlePatterns;
  if (configured !== undefined && (!Array.isArray(configured) || !configured.every((item) => typeof item === 'string'))) {
    throw new Error('review policy conversionProof.titlePatterns must be an array of strings');
  }
  const sources = configured ?? DEFAULT_CONVERSION_PROOF_PATTERNS;
  const key = JSON.stringify(sources);
  if (!compiled.has(key)) compiled.set(key, sources.map((source) => new RegExp(source, 'iu')));
  return compiled.get(key);
}

export function needsConversionProof(title, policy) {
  const text = String(title ?? '');
  return patternsOf(policy).some((pattern) => pattern.test(text));
}
