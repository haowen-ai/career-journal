// Shared helpers for read-only scan sources. Every source takes an injectable
// fetch so tests never touch the network.

export async function fetchJson(fetchImpl, url, { timeoutMs = 30_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Role scan requires a fetch implementation');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'error'}`);
    try { return await response.json(); }
    catch { throw new Error('response is not valid JSON'); }
  } catch (error) {
    if (timedOut || error?.name === 'AbortError') throw new Error(`timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function isoDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function httpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

export function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

export function uniqueStrings(values) {
  return [...new Set(values.flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => text(value))
    .filter(Boolean))];
}

export function companyFromBoard(board) {
  return String(board).split(/[-_.]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

export function sourceError(error) {
  return error instanceof Error ? error.message : String(error);
}
