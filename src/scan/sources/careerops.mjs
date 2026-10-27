import { detectCareerOpsScan, runCareerOpsScan } from '../../integrations/careerops.mjs';
import { htmlToText } from '../text.mjs';
import { httpUrl, isoDate, sourceError, text, uniqueStrings } from './common.mjs';

export function parseCareerOpsRoles(result) {
  return (Array.isArray(result?.roles) ? result.roles : []).map((item) => {
    item ??= {};
    const url = httpUrl(item.url);
    return {
      source: 'careerops', sourceId: text(item.id) || url, partition: item.partition ?? 'all',
      company: text(item.company), title: text(item.title), url,
      invalid: item.invalid || (!text(item.title) ? 'missing title' : !text(item.company) ? 'missing company' : !url ? 'missing http(s) URL' : null),
      locations: uniqueStrings(Array.isArray(item.locations) ? item.locations : [item.location]), offices: item.offices ?? [],
      remote: typeof item.remote === 'boolean' ? item.remote : null, workplaceType: item.workplaceType ?? null,
      employmentType: item.employmentType ?? null, requisitionId: item.requisitionId ?? item.jobReqId ?? null,
      postedAt: isoDate(item.postedAt), description: htmlToText(item.description ?? ''), listed: item.listed !== false,
      categories: uniqueStrings(item.categories ?? []), terms: uniqueStrings(item.terms ?? []), degrees: uniqueStrings(item.degrees ?? []),
      completeness: { locations: 'partial', arrangement: 'unknown', description: item.description ? 'full' : 'none', employment_type: 'absent', ...item.completeness },
    };
  });
}

export function parseCareerOpsRaw(result) {
  const roles = parseCareerOpsRoles(result);
  const partitions = result?.partitions?.length ? result.partitions : [{ partition: 'all', status: 'partial', count: roles.length, detail: 'legacy display-line bridge' }];
  const sources = partitions.map((part) => {
    const count = roles.filter((role) => role.partition === part.partition).length;
    return { ...part, source: 'careerops', rawCount: count, count,
      truncated: Boolean(part.truncated || part.capDetected),
      status: part.capDetected || part.truncated ? 'partial' : part.status,
      ...(part.error ? { detail: part.error } : {}) };
  });
  // Preserve rows even if a bridge omits their partition health.
  for (const role of roles) if (!sources.some((part) => part.partition === role.partition)) sources.push({ source: 'careerops', partition: role.partition,
    status: 'partial', count: roles.filter((r) => r.partition === role.partition).length, rawCount: roles.filter((r) => r.partition === role.partition).length,
    truncated: false, detail: 'legacy display-line bridge; missing partition health' });
  return { roles, sources, ...(Array.isArray(result?.configuredPartitions) ? { configuredPartitions: result.configuredPartitions } : {}),
    status: sources.every((p) => p.status === 'error') ? 'failed' : sources.some((p) => p.status !== 'ok') ? 'partial' : 'ok' };
}

export async function fetchCareerOpsRoles(enabled, careerOpsConfig, dependencies = {}) {
  const skipped = (detail) => ({ sources: [{ source: 'careerops', partition: 'all', status: 'skipped', count: 0, rawCount: 0, truncated: false, detail }], batches: [], roles: [] });
  if (!enabled) return skipped('not enabled in the profile');
  const health = await (dependencies.detect ?? detectCareerOpsScan)(careerOpsConfig ?? {});
  if (!health.ok) return skipped(`CareerOps not detected: ${health.detail}`);
  try {
    const parsed = parseCareerOpsRaw(await runCareerOpsScan(careerOpsConfig ?? {}, dependencies));
    return { ...parsed, batches: parsed.sources.map((part) => ({ source: 'careerops', partition: part.partition,
      records: parsed.roles.filter((role) => role.partition === part.partition), rawCount: part.rawCount })) };
  } catch (error) {
    return { sources: [{ source: 'careerops', partition: 'all', status: 'error', count: 0, rawCount: 0, truncated: false, detail: sourceError(error) }], batches: [], roles: [] };
  }
}
