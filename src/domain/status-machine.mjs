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

export function assertStatusTransition(from, to) {
  if (!transitions.has(from) || !transitions.get(from).has(to)) throw new Error(`Invalid status transition: ${from} -> ${to}`);
  return true;
}

export const applicationStatuses = Object.freeze([...transitions.keys()]);

