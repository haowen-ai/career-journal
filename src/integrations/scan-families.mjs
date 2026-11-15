// Shared-infrastructure limits for the CareerOps scan (plan 2026-11-14 v6, r2-r5).
//
// A "family" is the pool of hosts that may share one rate limit: the provider id, and for a provider listed in
// `splitByHost` the provider plus its request host without the first label (Workday rate-limits per cluster:
// `workday|wd5.myworkdayjobs.com`). The bridge gives each family at most `lanes` lanes at once and at most
// `requestsPerMinute` requests in any 60 seconds, so a higher overall concurrency never sends a shared pool more
// than the configured budget. Limits only delay work; they never stop or shorten a list.
//
// Config (careerOps.scanFamilies), every value a positive integer; unset means no limit at all:
//   { "splitByHost": ["workday"], "lanes": { "default": 1, "<family>": n }, "requestsPerMinute": { "default": 30, "<family>": n } }
// A family with a single lane is never limited: its one lane reads its hosts one request after another, as before.

export const RATE_WINDOW_MS = 60_000;
const KEYS = new Set(['splitByHost', 'lanes', 'requestsPerMinute']);

const problem = (detail) => new Error(`careerOps.scanFamilies: ${detail}`);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function limits(value, name) {
  if (value === undefined) return { map: new Map(), fallback: Infinity };
  if (!isPlainObject(value)) throw problem(`${name} must be an object of positive integers`);
  const map = new Map();
  let fallback = Infinity;
  for (const [family, limit] of Object.entries(value)) {
    if (!Number.isInteger(limit) || limit < 1) throw problem(`${name}.${family} must be a positive integer`);
    if (family === 'default') fallback = limit; else map.set(family, limit);
  }
  return { map, fallback };
}

// Validated settings, or null when the config is not set. Anything malformed is an error, never ignored.
export function parseScanFamilies(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw problem('must be an object');
  for (const key of Object.keys(value)) if (!KEYS.has(key)) throw problem(`unknown key ${key}`);
  const split = value.splitByHost === undefined ? [] : value.splitByHost;
  if (!Array.isArray(split) || split.some((id) => typeof id !== 'string' || !id)) throw problem('splitByHost must be a list of provider ids');
  const lanes = limits(value.lanes, 'lanes');
  const rate = limits(value.requestsPerMinute, 'requestsPerMinute');
  return { splitByHost: new Set(split), lanes: lanes.map, lanesDefault: lanes.fallback,
    requestsPerMinute: rate.map, requestsPerMinuteDefault: rate.fallback };
}

// The host a split provider sends its requests to: `api` first, as the providers themselves read it.
function requestHost(entry = {}) {
  for (const key of ['api', 'careers_url', 'url', 'board_url', 'feed_url']) {
    try { const url = new URL(String(entry[key])); if (/^https?:$/.test(url.protocol)) return url.host.toLowerCase(); } catch { /* not a URL */ }
  }
  return null;
}

const hostFamily = (id, host) => { const labels = host.split('.'); return `${id}|${labels.length > 2 ? labels.slice(1).join('.') : host}`; };

// The family an entry is scheduled under. For a split provider this is a guess from the entry's URLs (used for lane
// caps only); its request budget follows each request's real host (familyOfRequest).
export function familyOf(providerId, entry, splitByHost = new Set()) {
  if (!providerId) return null;
  const id = String(providerId);
  if (!splitByHost.has(id)) return id;
  const host = requestHost(entry);
  return host ? hostFamily(id, host) : id;
}

// The family one request is budgeted under: a split provider by the host the request really goes to.
export function familyOfRequest(providerId, url, splitByHost, fallback) {
  const id = providerId == null ? null : String(providerId);
  if (!id || !splitByHost.has(id)) return fallback;
  try { return hostFamily(id, new URL(String(url)).host.toLowerCase()); } catch { return fallback; }
}

// Sliding-window request budget per family. A slot is held from the moment it is granted until the call that
// used it has ended, and then for RATE_WINDOW_MS more (Codex plan review r4/r5): every request that really goes
// out inside any 60-second window still holds its slot at the end of that window, so no window sees more than
// the budget, whatever the caller awaits between taking the slot and sending. Grants are first come, first served.
export function createFamilyLimiter({ requestsPerMinute, now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const pools = new Map();
  const pool = (family) => {
    if (!pools.has(family)) pools.set(family, { held: 0, expiries: [], queue: Promise.resolve(), wake: null });
    return pools.get(family);
  };
  const ready = async (state, limit) => {
    for (;;) {
      const time = now();
      while (state.expiries.length && state.expiries[0] <= time) state.expiries.shift();
      if (state.held + state.expiries.length < limit) return;
      // Every slot is in use: wait for the oldest to expire, or for a call to end (that starts an expiry).
      const woken = new Promise((resolve) => { state.wake = resolve; });
      await (state.expiries.length ? Promise.race([delay(state.expiries[0] - time), woken]) : woken);
      state.wake = null;
    }
  };
  return {
    async acquire(family) {
      const limit = requestsPerMinute(family);
      const started = now();
      if (!Number.isFinite(limit)) return { waitedMs: 0, release() {} };
      const state = pool(family);
      const turn = state.queue.then(() => ready(state, limit));
      state.queue = turn.catch(() => {});
      await turn;
      state.held += 1;
      let released = false;
      return { waitedMs: now() - started, release() {
        if (released) return;
        released = true;
        state.held -= 1;
        const at = now() + RATE_WINDOW_MS;
        // Kept in order; a later release never expires earlier.
        state.expiries.push(Math.max(at, state.expiries.at(-1) ?? at));
        state.wake?.();
      } };
    },
  };
}
