import { fetchJson, httpUrl, isoDate, sourceError, text, uniqueStrings } from './common.mjs';

// SimplifyJobs publishes its internship and new-grad lists without an
// open-source licence. This source is therefore opt-in and never a default:
// it runs only when the user sets sources.simplify.enabled and supplies the
// URL themselves, and the request is made live on the user's machine at scan
// time. There is no redistribution: CAREER JOURNAL does not bundle, cache,
// mirror, or republish any Simplify data. The only thing written is the
// normalised leads the user keeps, in the user's own local database.

// A listing looks like { id, company_name, title, url, locations[], active, is_visible,
// date_posted (epoch seconds), terms[], sponsorship, degrees[], category }.
export function parseSimplify(payload) {
  const listings = Array.isArray(payload) ? payload : Array.isArray(payload?.listings) ? payload.listings : [];
  const roles = [];
  for (const listing of listings) {
    if (listing?.active === false || listing?.is_visible === false) continue;
    const url = httpUrl(listing?.url);
    const id = text(listing?.id);
    if (!id || !text(listing?.title) || !text(listing?.company_name) || !url) continue;
    const details = [
      text(listing.sponsorship) ? `Sponsorship: ${text(listing.sponsorship)}` : '',
      Array.isArray(listing.degrees) && listing.degrees.length ? `Degrees: ${uniqueStrings(listing.degrees).join(', ')}` : '',
    ].filter(Boolean);
    roles.push({
      source: 'simplify',
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
  if (!settings?.enabled) return { sources: [{ source: 'simplify', status: 'skipped', count: 0, detail: 'opt-in source is not enabled' }], roles: [] };
  const urls = simplifyUrls(settings);
  if (!urls.length) return { sources: [{ source: 'simplify', status: 'skipped', count: 0, detail: 'enabled but no URL is configured' }], roles: [] };
  const sources = [];
  const roles = [];
  const seen = new Set();
  for (const url of urls) {
    try {
      // A listing that appears on more than one list is kept once, from the first list.
      const listRoles = parseSimplify(await fetchJson(fetchImpl, url, options)).filter((role) => !seen.has(role.sourceId));
      for (const role of listRoles) seen.add(role.sourceId);
      roles.push(...listRoles);
      sources.push({ source: 'simplify', url, status: 'ok', count: listRoles.length });
    } catch (error) {
      sources.push({ source: 'simplify', url, status: 'error', count: 0, detail: sourceError(error) });
    }
  }
  return { sources, roles };
}
