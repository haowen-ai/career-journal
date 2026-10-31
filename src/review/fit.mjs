// Fit of an escalated posting (2026-10-31). The escalation judge answers one narrow question and is forced to
// decide; its fit assumes the candidate's gaps away, so taking it wholesale inflated fit (medium -> high,
// low -> medium). When both judgments carry a fit level the delivered fit is the lower one, with the note of the
// judgment whose level was chosen; a tie keeps the escalation's. A judgment without a valid level leaves the other.
// Not a judge dependency: decide.mjs is hashed, this file is not.
const FIT_ORDER = Object.freeze(['low', 'medium', 'high']);
const rank = (fit) => (fit && typeof fit === 'object' ? FIT_ORDER.indexOf(fit.level) : -1);

export function lowerFit(primary, escalation) {
  const p = rank(primary);
  const e = rank(escalation);
  if (p < 0) return escalation;
  if (e < 0) return primary;
  return p < e ? primary : escalation;
}
