const transitions = new Map([
  ['lead', new Set(['lead', 'prepared', 'applied', 'withdrawn'])],
  ['prepared', new Set(['prepared', 'applied', 'withdrawn'])],
  ['applied', new Set(['applied', 'assessment', 'interview', 'rejected', 'withdrawn', 'offer'])],
  ['assessment', new Set(['assessment', 'interview', 'rejected', 'withdrawn', 'offer'])],
  ['interview', new Set(['interview', 'rejected', 'withdrawn', 'offer'])],
  ['offer', new Set(['offer', 'accepted', 'declined', 'withdrawn'])],
  ['rejected', new Set(['rejected'])],
  ['withdrawn', new Set(['withdrawn'])],
  ['accepted', new Set(['accepted'])],
  ['declined', new Set(['declined'])],
]);

// A submitted application reopens a withdrawal the review or dedupe made (never the user's own withdrawal).
export function isSubmittedReopen(from, to, { eventType, skipOwner }) {
  return from === 'withdrawn' && to === 'applied' && eventType === 'submitted' && skipOwner !== 'user';
}

export function assertStatusTransition(from, to, context = {}) {
  if (isSubmittedReopen(from, to, context)) return true;
  if (!transitions.has(from) || !transitions.get(from).has(to)) throw new Error(`Invalid status transition: ${from} -> ${to}`);
  return true;
}

// liftedRule: the withdrawal applied a company rule the user has since lifted (never a user's own withdrawal).
export function assertReviewRestore(from, to, { actor, lastActor, automated = false, systemReview = false, liftedRule = false }) {
  if (from !== 'withdrawn' || to !== 'lead' || actor !== 'review-worker' || !(lastActor === 'review-worker' || automated || (systemReview || liftedRule) && lastActor !== 'user')) throw new Error('Invalid review restore');
  return true;
}

export const applicationStatuses = Object.freeze([...transitions.keys()]);

