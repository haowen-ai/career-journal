// Decide once: a nightly run may (re)judge only open work. Every automatic path that
// re-queues a review or restores an application asks this one predicate.
// evidence_changed: the scan saw new evidence about the posting itself (not a rule edit) for a system drop.
// It reopens the review only; it never restores a withdrawn application (deliver.mjs restoreAuthorized).
export const REOPEN_AUTHORIZATIONS = Object.freeze(['rejudge', 'cap_release', 'relist', 'evidence_changed']);
const OPEN_STATES = new Set(['due', 'held', 'leased', 'failed']);

export function autoReopenAllowed({ review = null, application = null, authorization = null } = {}) {
  if (authorization != null) return REOPEN_AUTHORIZATIONS.includes(authorization);
  if (!review) return true; // never reviewed: new work, not a reopen
  if (OPEN_STATES.has(review.state)) return true;
  return review.decision === 'eligible' && application?.status === 'lead';
}
