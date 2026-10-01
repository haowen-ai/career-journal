import { detectCareerOps, runCareerOpsScan } from '../../integrations/careerops.mjs';
import { htmlToText } from '../text.mjs';
import { httpUrl, isoDate, sourceError, text, uniqueStrings } from './common.mjs';

// CareerOps portal scans, only when the profile enables them and the pinned
// CareerOps installation with its bridge is detected. The bridge runs a
// read-only scan; CAREER JOURNAL only reads the role list it prints.

export function parseCareerOpsRoles(result) {
  const roles = [];
  for (const item of Array.isArray(result?.roles) ? result.roles : []) {
    const url = httpUrl(item?.url);
    if (!text(item?.title) || !text(item?.company) || !url) continue;
    roles.push({
      source: 'careerops',
      sourceId: text(item.id) || url,
      company: text(item.company),
      title: text(item.title),
      locations: uniqueStrings(Array.isArray(item.locations) ? item.locations : [item.location]),
      url,
      postedAt: isoDate(item.postedAt),
      description: htmlToText(item.description ?? ''),
      categories: uniqueStrings(Array.isArray(item.categories) ? item.categories : []),
    });
  }
  return roles;
}

export async function fetchCareerOpsRoles(enabled, careerOpsConfig, dependencies = {}) {
  if (!enabled) return { sources: [{ source: 'careerops', status: 'skipped', count: 0, detail: 'not enabled in the profile' }], roles: [] };
  const detect = dependencies.detect ?? detectCareerOps;
  const health = await detect(careerOpsConfig ?? {});
  if (!health.ok) return { sources: [{ source: 'careerops', status: 'skipped', count: 0, detail: `CareerOps not detected: ${health.detail}` }], roles: [] };
  try {
    const roles = parseCareerOpsRoles(await runCareerOpsScan(careerOpsConfig ?? {}, dependencies));
    return { sources: [{ source: 'careerops', status: 'ok', count: roles.length }], roles };
  } catch (error) {
    return { sources: [{ source: 'careerops', status: 'error', count: 0, detail: sourceError(error) }], roles: [] };
  }
}
