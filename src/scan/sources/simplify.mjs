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

export async function fetchSimplify(settings, fetchImpl, options = {}) {
  if (!settings?.enabled) return { sources: [{ source: 'simplify', status: 'skipped', count: 0, detail: 'opt-in source is not enabled' }], roles: [] };
  if (!settings.url) return { sources: [{ source: 'simplify', status: 'skipped', count: 0, detail: 'enabled but no URL is configured' }], roles: [] };
  try {
    const roles = parseSimplify(await fetchJson(fetchImpl, settings.url, options));
    return { sources: [{ source: 'simplify', url: settings.url, status: 'ok', count: roles.length }], roles };
  } catch (error) {
    return { sources: [{ source: 'simplify', url: settings.url, status: 'error', count: 0, detail: sourceError(error) }], roles: [] };
  }
}
