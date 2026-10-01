import { normalizeText, termPattern } from './text.mjs';

// Keyword maps per profile direction id. Terms match whole words in the role
// title and in the job board's department or team categories. `other` has no
// keywords: a profile that lists it accepts roles outside the named directions.
export const DIRECTION_KEYWORDS = Object.freeze({
  'ai-ml': Object.freeze([
    'machine learning', 'ml', 'ai', 'artificial intelligence', 'deep learning', 'llm', 'llms', 'nlp',
    'natural language', 'computer vision', 'generative ai', 'genai', 'applied scientist', 'research scientist',
    'ai/ml', 'ml/ai', 'mlops', 'reinforcement learning', 'perception',
  ]),
  'data-science': Object.freeze([
    'data science', 'data scientist', 'statistician', 'statistics', 'decision science', 'causal inference',
    'experimentation', 'econometrics',
  ]),
  'data-analytics': Object.freeze([
    'data analyst', 'data analytics', 'analytics', 'business analyst', 'business intelligence', 'bi analyst',
    'insights analyst', 'product analyst', 'reporting analyst', 'operations analyst',
  ]),
  'data-engineering': Object.freeze([
    'data engineer', 'data engineering', 'analytics engineer', 'analytics engineering', 'etl', 'data platform',
    'data infrastructure', 'data pipeline', 'big data',
  ]),
  'software-engineering': Object.freeze([
    'software engineer', 'software engineering', 'software developer', 'software development', 'swe', 'sde',
    'backend', 'back end', 'frontend', 'front end', 'full stack', 'fullstack', 'developer', 'platform engineer',
    'infrastructure engineer', 'mobile engineer', 'site reliability',
  ]),
  quant: Object.freeze([
    'quant', 'quantitative', 'quantitative research', 'quantitative trading', 'trader', 'trading', 'strats',
    'algorithmic trading', 'quantitative developer', 'quantitative analyst',
  ]),
  product: Object.freeze([
    'product manager', 'product management', 'associate product manager', 'apm', 'product owner',
    'technical program manager', 'program manager',
  ]),
  other: Object.freeze([]),
});

const compiled = new Map();

function patternFor(term) {
  if (!compiled.has(term)) compiled.set(term, termPattern(term));
  return compiled.get(term);
}

// Returns the first keyword of a direction found in the text, or null.
export function matchDirectionKeyword(text, directionId, keywordMap = DIRECTION_KEYWORDS) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  for (const term of keywordMap[directionId] ?? []) {
    if (patternFor(term).test(normalized)) return term;
  }
  return null;
}

// Finds which profile directions a role matches, separately for its title and
// its categories, so fit rules can give the title precedence.
export function matchDirections(role, directionIds, keywordMap = DIRECTION_KEYWORDS) {
  const title = String(role?.title ?? '');
  const categories = (role?.categories ?? []).map(String).join(' | ');
  const matches = [];
  for (const id of directionIds) {
    const inTitle = matchDirectionKeyword(title, id, keywordMap);
    if (inTitle) { matches.push({ id, where: 'title', term: inTitle }); continue; }
    const inCategory = matchDirectionKeyword(categories, id, keywordMap);
    if (inCategory) matches.push({ id, where: 'category', term: inCategory });
  }
  return matches;
}

export function directionLabel(id) {
  return {
    'ai-ml': 'AI / machine learning',
    'data-science': 'data science',
    'data-analytics': 'data analytics',
    'data-engineering': 'data engineering',
    'software-engineering': 'software engineering',
    quant: 'quantitative research or trading',
    product: 'product management',
    other: 'other directions',
  }[id] ?? id;
}
