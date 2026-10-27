import { fetchSourceJson } from './ats-boards.mjs';
import { httpUrl, isoDate, sourceError, text, uniqueStrings } from './common.mjs';

export const DEFAULT_SIMPLIFY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 64_000_000;

// SimplifyJobs publishes its internship and new-grad lists without an
// open-source licence. This source is therefore opt-in and never a default:
// it runs only when the user sets sources.simplify.enabled and supplies the
// URL themselves, and the request is made live on the user's machine at scan
// time. There is no redistribution: CAREER JOURNAL does not bundle, cache,
// mirror, or republish any Simplify data. The only thing written is the
// normalised leads the user keeps, in the user's own local database.

// A listing looks like { id, company_name, title, url, locations[], active, is_visible,
// date_posted (epoch seconds), terms[], sponsorship, degrees[], category }.
export function parseSimplify(payload, { partition = 'simplify:1' } = {}) {
  const listings = Array.isArray(payload) ? payload : Array.isArray(payload?.listings) ? payload.listings : [];
  const roles = [];
  for (let listing of listings) {
    listing ??= {};
    const url = httpUrl(listing?.url);
    const id = text(listing?.id);
    const invalid = !id ? 'missing id' : !text(listing.title) ? 'missing title' : !text(listing.company_name) ? 'missing company' : !url ? 'missing http(s) URL' : null;
    const details = [
      text(listing.sponsorship) ? `Sponsorship: ${text(listing.sponsorship)}` : '',
      Array.isArray(listing.degrees) && listing.degrees.length ? `Degrees: ${uniqueStrings(listing.degrees).join(', ')}` : '',
    ].filter(Boolean);
    roles.push({
      source: 'simplify', partition, invalid, listed: listing.active !== false && listing.is_visible !== false,
      offices: [], remote: null, workplaceType: null, employmentType: null, requisitionId: text(listing.requisitionId) || null,
      completeness: { locations: 'partial', arrangement: 'unknown', description: 'tags', employment_type: 'absent' },
      sourceId: id,
      company: text(listing.company_name),
      title: text(listing.title),
      locations: uniqueStrings(Array.isArray(listing.locations) ? listing.locations : [listing.location]),
      url,
      postedAt: isoDate(listing.date_posted ?? listing.date_updated),
      description: details.join('\n'),
      categories: uniqueStrings([listing.category]),
      terms: uniqueStrings(Array.isArray(listing.terms) ? listing.terms : [listing.season]),
      degrees: uniqueStrings(Array.isArray(listing.degrees) ? listing.degrees : []),
    });
  }
  return roles;
}

// The configured list URLs in order: the original single `url` first, then any
// extra `urls` (for example a second Simplify list), without repeats.
export function simplifyUrls(settings) {
  return uniqueStrings([settings?.url, ...(Array.isArray(settings?.urls) ? settings.urls : [])]);
}

export async function fetchSimplify(settings, fetchImpl, options = {}) {
  if (!settings?.enabled) return { sources: [{ source: 'simplify', partition: 'all', rawCount: 0, truncated: false, status: 'skipped', count: 0, detail: 'opt-in source is not enabled' }], batches: [], roles: [] };
  const urls = simplifyUrls(settings);
  if (!urls.length) return { sources: [{ source: 'simplify', partition: 'all', rawCount: 0, truncated: false, status: 'skipped', count: 0, detail: 'enabled but no URL is configured' }], batches: [], roles: [] };
  const sources = [];
  const roles = [];
  const batches = [];
  const limits = {
    maxBytes: options.maxBytes ?? settings.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: Math.min(options.timeoutMs ?? Infinity, settings.timeoutMs ?? DEFAULT_SIMPLIFY_TIMEOUT_MS),
  };
  for (const [index, url] of urls.entries()) {
    const partition = `simplify:${index + 1}`;
    try {
      const payload = await fetchSourceJson(fetchImpl, url, limits);
      if (!Array.isArray(payload) && !Array.isArray(payload?.listings)) throw new Error('Malformed Simplify response: missing listing array');
      const listRoles = parseSimplify(payload, { partition });
      batches.push({ source: 'simplify', partition, rawCount: listRoles.length, records: listRoles });
      roles.push(...listRoles);
      sources.push({ source: 'simplify', partition, url, status: 'ok', count: listRoles.length, rawCount: listRoles.length, truncated: false });
    } catch (error) {
      sources.push({ source: 'simplify', partition, url, rawCount: 0, truncated: false, status: 'error', count: 0, detail: sourceError(error) });
    }
  }
  return { sources, batches, roles };
}
