// Adaptive judge concurrency (AIMD). budgets.concurrency (or --concurrency) is the ceiling; the run starts at
// min(ceiling, budgets.concurrencyStart). A rate-limited answer (HTTP 429, or 529 overloaded) halves the effective
// concurrency, at most once per budgets.rateLimitCoolSeconds, never below 1; budgets.rateLimitIncreaseAfter
// consecutive successes raise it by one, up to the ceiling. The worker puts a rate-limited posting back after a
// backoff instead of failing it, and such answers never feed the identical-failure breaker. Rate limiting that
// continues at concurrency 1 for RATE_LIMIT_STALL_MS is reported as stalled, and the run stops as 'rate_limited'.

export const RATE_LIMIT_DEFAULTS = Object.freeze({ concurrencyStart: 10, rateLimitCoolSeconds: 30, rateLimitIncreaseAfter: 20 });
export const RATE_LIMIT_STALL_MS = 600_000;
export const RATE_LIMIT_CODES = Object.freeze(['rate_limited', 'overloaded']);
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

// Transient network failures (claude-judge errorCode 'unavailable': network, timeout, other 5xx) are retried on the same
// posting after the same backoff, up to budgets.unavailableRetries times per posting (default 5); they never feed the
// identical-failure breaker. When judgments have answered only 'unavailable' for budgets.unavailableStallMinutes
// (default 10) with no successful answer in between, the run stops as 'network_unavailable' and the postings stay due.
export const UNAVAILABLE_DEFAULTS = Object.freeze({ unavailableRetries: 5, unavailableStallMinutes: 10 });
export const isUnavailable = (result) => Boolean(result) && result.status !== 'ok' && result.status !== 'quota' && result.errorCode === 'unavailable';
export function unavailableSettings(budgets = {}) {
  const retries = budgets?.unavailableRetries ?? UNAVAILABLE_DEFAULTS.unavailableRetries;
  if (!Number.isInteger(retries) || retries < 0) throw new Error('review-policy budgets.unavailableRetries must be a whole number, 0 or more');
  const minutes = budgets?.unavailableStallMinutes ?? UNAVAILABLE_DEFAULTS.unavailableStallMinutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) throw new Error('review-policy budgets.unavailableStallMinutes must be a positive number');
  return { retries, stallMs: minutes * 60_000 };
}

export const isRateLimited = (result) => Boolean(result) && result.status !== 'ok' && RATE_LIMIT_CODES.includes(result.errorCode);

// Reads the optional budgets fields; configs without them get the defaults. Throws on an invalid value.
export function rateControlSettings(budgets = {}) {
  const value = (key) => budgets?.[key] ?? RATE_LIMIT_DEFAULTS[key];
  const start = value('concurrencyStart');
  if (!Number.isInteger(start) || start < 1) throw new Error('review-policy budgets.concurrencyStart must be a positive integer');
  const cool = value('rateLimitCoolSeconds');
  if (typeof cool !== 'number' || !Number.isFinite(cool) || cool < 0) throw new Error('review-policy budgets.rateLimitCoolSeconds must be a non-negative number');
  const increaseAfter = value('rateLimitIncreaseAfter');
  if (!Number.isInteger(increaseAfter) || increaseAfter < 1) throw new Error('review-policy budgets.rateLimitIncreaseAfter must be a positive integer');
  return { start, coolMs: cool * 1000, increaseAfter };
}

// retry-after when the API sent one (capped at the stall window), otherwise 2s doubling to a 60s ceiling.
export function rateLimitBackoffMs({ retryAfterMs, streak = 1 } = {}) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.min(retryAfterMs, RATE_LIMIT_STALL_MS);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, streak - 1));
}

export function createRateControl({ max, start = RATE_LIMIT_DEFAULTS.concurrencyStart, coolMs = RATE_LIMIT_DEFAULTS.rateLimitCoolSeconds * 1000,
  increaseAfter = RATE_LIMIT_DEFAULTS.rateLimitIncreaseAfter, stallMs = RATE_LIMIT_STALL_MS, clock = Date.now } = {}) {
  if (!Number.isInteger(max) || max < 1) throw new Error('Rate control requires a positive integer maximum concurrency');
  const initial = Math.min(max, start);
  let effective = initial;
  let peak = initial;
  let successes = 0;
  let lastCut = -Infinity;
  let stalledSince = null;
  let backoffs = 0;
  let cuts = 0;
  let inFlight = 0;
  const waiters = [];
  const pump = () => {
    while (waiters.length && inFlight < effective) { inFlight += 1; waiters.shift()(); }
  };
  return {
    get effective() { return effective; },
    get inFlight() { return inFlight; },
    // A slot for one API call; resolves once fewer than `effective` calls are in flight.
    acquire() {
      if (!waiters.length && inFlight < effective) { inFlight += 1; return Promise.resolve(); }
      return new Promise((resolve) => { waiters.push(resolve); });
    },
    release() { inFlight = Math.max(0, inFlight - 1); pump(); },
    success() {
      stalledSince = null;
      successes += 1;
      if (successes >= increaseAfter) {
        successes = 0;
        if (effective < max) { effective += 1; peak = Math.max(peak, effective); pump(); }
      }
    },
    rateLimited() {
      const at = clock();
      backoffs += 1;
      successes = 0;
      let cut = false;
      if (effective > 1 && at - lastCut >= coolMs) {
        effective = Math.max(1, Math.floor(effective / 2));
        lastCut = at; cuts += 1; cut = true;
      }
      if (effective === 1) stalledSince ??= at; else stalledSince = null;
      return { cut, stalled: stalledSince !== null && at - stalledSince >= stallMs };
    },
    stats() { return { max, start: initial, peak, final: effective, rate_limit_backoffs: backoffs, cuts }; },
  };
}
