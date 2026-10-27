import { htmlToText } from '../text.mjs';
import { companyFromBoard, httpUrl, isoDate, sourceError, text, uniqueStrings } from './common.mjs';

// Official public job-board APIs, read-only, for the companies the user lists
// in profile.sources.atsBoards. The parsers are tolerant: unknown fields are
// ignored; malformed rows are preserved with an invalid reason.

export const ATS_ENDPOINTS = Object.freeze({
  greenhouse: (board) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`,
  lever: (board) => `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`,
  ashby: (board) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`,
});

function splitLocations(value) {
  return text(value).split(/\s*(?:;|\||\n)\s*/).filter(Boolean);
}

// Greenhouse: { jobs: [{ id, title, absolute_url, location: { name }, offices[], departments[],
// content (entity-escaped HTML), first_published, updated_at, requisition_id, company_name }] }
export function parseGreenhouse(payload, { board, company } = {}) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const roles = [];
  for (let job of jobs) {
    job ??= {};
    const url = httpUrl(job.absolute_url);
    const invalid = job.id == null ? 'missing id' : !text(job.title) ? 'missing title' : !url ? 'missing http(s) URL' : null;
    const officeLocations = (Array.isArray(job.offices) ? job.offices : []).map((office) => office?.location || office?.name);
    const locations = uniqueStrings(splitLocations(job.location?.name));
    roles.push({
      source: 'greenhouse', partition: `greenhouse:${board}`, invalid, listed: true,
      offices: Array.isArray(job.offices) ? job.offices : [], remote: null, workplaceType: null, employmentType: null, terms: [], degrees: [],
      completeness: { locations: 'complete', arrangement: 'unknown', description: 'full', employment_type: 'absent' },
      sourceId: job.id == null ? null : String(job.id),
      company: company || text(job.company_name) || companyFromBoard(board),
      title: text(job.title),
      locations: uniqueStrings([...locations, ...officeLocations]),
      url,
      postedAt: isoDate(job.first_published ?? job.updated_at),
      description: htmlToText(job.content ?? ''),
      categories: uniqueStrings((Array.isArray(job.departments) ? job.departments : []).map((item) => item?.name)),
      requisitionId: text(job.requisition_id) || null,
    });
  }
  return roles;
}

// Lever: [{ id, text, hostedUrl, categories: { location, allLocations[], team, department, commitment },
// createdAt (ms), descriptionPlain, description, lists: [{ text, content }], additionalPlain, workplaceType }]
export function parseLever(payload, { board, company } = {}) {
  const postings = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const roles = [];
  for (let posting of postings) {
    posting ??= {};
    const url = httpUrl(posting.hostedUrl ?? posting.applyUrl);
    const invalid = !text(posting.id) ? 'missing id' : !text(posting.text) ? 'missing title' : !url ? 'missing http(s) URL' : null;
    const categories = posting.categories ?? {};
    const lists = (Array.isArray(posting.lists) ? posting.lists : [])
      .map((list) => [text(list?.text), htmlToText(list?.content ?? '')].filter(Boolean).join('\n'));
    roles.push({
      source: 'lever', partition: `lever:${board}`, invalid, listed: true, offices: [], terms: [], degrees: [], requisitionId: null,
      workplaceType: text(posting.workplaceType) || null, employmentType: text(categories.commitment) || null,
      completeness: { locations: 'complete', arrangement: posting.workplaceType ? 'known' : 'unknown', description: 'full', employment_type: categories.commitment ? 'explicit' : 'absent' },
      sourceId: text(posting.id),
      company: company || companyFromBoard(board),
      title: text(posting.text),
      locations: uniqueStrings(Array.isArray(categories.allLocations) && categories.allLocations.length ? categories.allLocations : [categories.location]),
      url,
      postedAt: isoDate(posting.createdAt),
      description: [
        text(posting.descriptionPlain) || htmlToText(posting.description ?? ''),
        ...lists,
        text(posting.additionalPlain) || htmlToText(posting.additional ?? ''),
      ].filter(Boolean).join('\n'),
      categories: uniqueStrings([categories.team, categories.department, categories.commitment]),
      remote: posting.workplaceType ? text(posting.workplaceType).toLowerCase() === 'remote' : null,
    });
  }
  return roles;
}

// Ashby: { jobs: [{ id, title, jobUrl, applyUrl, location, secondaryLocations: [{ location }], department,
// team, employmentType, publishedAt, isListed, isRemote, workplaceType, descriptionPlain, descriptionHtml }] }
export function parseAshby(payload, { board, company } = {}) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const roles = [];
  for (let job of jobs) {
    job ??= {};
    const url = httpUrl(job.jobUrl ?? job.applyUrl);
    const invalid = !text(job.id) ? 'missing id' : !text(job.title) ? 'missing title' : !url ? 'missing http(s) URL' : null;
    const secondary = (Array.isArray(job.secondaryLocations) ? job.secondaryLocations : []).map((item) => item?.location ?? item?.locationName);
    roles.push({
      source: 'ashby', partition: `ashby:${board}`, invalid, listed: job.isListed !== false, offices: [], terms: [], degrees: [], requisitionId: null,
      workplaceType: text(job.workplaceType) || null, employmentType: text(job.employmentType) || null,
      completeness: { locations: 'complete', arrangement: typeof job.isRemote === 'boolean' || job.workplaceType ? 'known' : 'unknown', description: 'full', employment_type: job.employmentType ? 'explicit' : 'absent' },
      sourceId: text(job.id),
      company: company || companyFromBoard(board),
      title: text(job.title),
      locations: uniqueStrings([job.location ?? job.locationName, ...secondary]),
      url,
      postedAt: isoDate(job.publishedAt ?? job.publishedDate),
      description: text(job.descriptionPlain) || htmlToText(job.descriptionHtml ?? ''),
      categories: uniqueStrings([job.department, job.team, job.employmentType]),
      remote: typeof job.isRemote === 'boolean' ? job.isRemote : job.workplaceType ? text(job.workplaceType).toLowerCase() === 'remote' : null,
    });
  }
  return roles;
}

const PARSERS = Object.freeze({ greenhouse: parseGreenhouse, lever: parseLever, ashby: parseAshby });

export async function fetchAtsBoard(entry, fetchImpl, options = {}) {
  const endpoint = ATS_ENDPOINTS[entry.ats];
  if (!endpoint) throw new Error(`Unsupported job board: ${entry.ats}`);
  const url = endpoint(entry.board);
  const payload = await fetchSourceJson(fetchImpl, url, options);
  return { url, roles: PARSERS[entry.ats](payload, entry) };
}

// One failing board never stops the others; its error is reported instead.
export async function fetchAtsBoards(boards, fetchImpl, options = {}) {
  const outcomes = await Promise.all((boards ?? []).map(async (entry) => {
    try {
      const { url, roles } = await fetchAtsBoard(entry, fetchImpl, options);
      return { source: { source: entry.ats, partition: `${entry.ats}:${entry.board}`, board: entry.board, url, status: 'ok', count: roles.length, rawCount: roles.length, truncated: false }, roles };
    } catch (error) {
      return {
        source: { source: entry.ats, partition: `${entry.ats}:${entry.board}`, rawCount: 0, truncated: false, board: entry.board, url: ATS_ENDPOINTS[entry.ats]?.(entry.board) ?? null, status: 'error', count: 0, detail: sourceError(error) },
        roles: [],
      };
    }
  }));
  return { sources: outcomes.map((item) => item.source), batches: outcomes.map((item) => ({ source: item.source.source, partition: item.source.partition, rawCount: item.roles.length, records: item.roles })), roles: outcomes.flatMap((item) => item.roles) };
}


// Bound transport and body consumption, including slow streaming responses.
export async function fetchSourceJson(fetchImpl, url, { timeoutMs = 30_000, maxBytes = 10_000_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Role scan requires a fetch implementation');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`timed out after ${timeoutMs}ms`)); }, timeoutMs); });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'error'}`);
      if (Number(response.headers?.get?.('content-length')) > maxBytes) { controller.abort(); throw new Error('response exceeds byte limit'); }
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = []; let length = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maxBytes) { controller.abort(); await reader.cancel(); throw new Error('response exceeds byte limit'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('response is not valid JSON'); }
      }
      let payload;
      try { payload = await response.json(); } catch { throw new Error('response is not valid JSON'); }
      if (Buffer.byteLength(JSON.stringify(payload)) > maxBytes) throw new Error('response exceeds byte limit');
      return payload;
    })()]);
  } finally { clearTimeout(timer); }
}
