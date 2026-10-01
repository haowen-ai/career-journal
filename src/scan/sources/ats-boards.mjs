import { htmlToText } from '../text.mjs';
import { companyFromBoard, fetchJson, httpUrl, isoDate, sourceError, text, uniqueStrings } from './common.mjs';

// Official public job-board APIs, read-only, for the companies the user lists
// in profile.sources.atsBoards. The parsers are tolerant: unknown fields are
// ignored and records without an id, title, or http(s) link are skipped.

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
  for (const job of jobs) {
    const url = httpUrl(job?.absolute_url);
    if (job?.id == null || !text(job?.title) || !url) continue;
    const officeLocations = (Array.isArray(job.offices) ? job.offices : []).map((office) => office?.location || office?.name);
    const locations = uniqueStrings(splitLocations(job.location?.name));
    roles.push({
      source: 'greenhouse',
      sourceId: String(job.id),
      company: company || text(job.company_name) || companyFromBoard(board),
      title: text(job.title),
      locations: locations.length ? locations : uniqueStrings(officeLocations),
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
  for (const posting of postings) {
    const url = httpUrl(posting?.hostedUrl ?? posting?.applyUrl);
    if (!text(posting?.id) || !text(posting?.text) || !url) continue;
    const categories = posting.categories ?? {};
    const lists = (Array.isArray(posting.lists) ? posting.lists : [])
      .map((list) => [text(list?.text), htmlToText(list?.content ?? '')].filter(Boolean).join('\n'));
    roles.push({
      source: 'lever',
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
      remote: text(posting.workplaceType).toLowerCase() === 'remote',
    });
  }
  return roles;
}

// Ashby: { jobs: [{ id, title, jobUrl, applyUrl, location, secondaryLocations: [{ location }], department,
// team, employmentType, publishedAt, isListed, isRemote, workplaceType, descriptionPlain, descriptionHtml }] }
export function parseAshby(payload, { board, company } = {}) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const roles = [];
  for (const job of jobs) {
    if (job?.isListed === false) continue;
    const url = httpUrl(job?.jobUrl ?? job?.applyUrl);
    if (!text(job?.id) || !text(job?.title) || !url) continue;
    const secondary = (Array.isArray(job.secondaryLocations) ? job.secondaryLocations : []).map((item) => item?.location ?? item?.locationName);
    roles.push({
      source: 'ashby',
      sourceId: text(job.id),
      company: company || companyFromBoard(board),
      title: text(job.title),
      locations: uniqueStrings([job.location ?? job.locationName, ...secondary]),
      url,
      postedAt: isoDate(job.publishedAt ?? job.publishedDate),
      description: text(job.descriptionPlain) || htmlToText(job.descriptionHtml ?? ''),
      categories: uniqueStrings([job.department, job.team, job.employmentType]),
      remote: job.isRemote === true || text(job.workplaceType).toLowerCase() === 'remote',
    });
  }
  return roles;
}

const PARSERS = Object.freeze({ greenhouse: parseGreenhouse, lever: parseLever, ashby: parseAshby });

export async function fetchAtsBoard(entry, fetchImpl, options = {}) {
  const endpoint = ATS_ENDPOINTS[entry.ats];
  if (!endpoint) throw new Error(`Unsupported job board: ${entry.ats}`);
  const url = endpoint(entry.board);
  const payload = await fetchJson(fetchImpl, url, options);
  return { url, roles: PARSERS[entry.ats](payload, entry) };
}

// One failing board never stops the others; its error is reported instead.
export async function fetchAtsBoards(boards, fetchImpl, options = {}) {
  const outcomes = await Promise.all((boards ?? []).map(async (entry) => {
    try {
      const { url, roles } = await fetchAtsBoard(entry, fetchImpl, options);
      return { source: { source: entry.ats, board: entry.board, url, status: 'ok', count: roles.length }, roles };
    } catch (error) {
      return {
        source: { source: entry.ats, board: entry.board, url: ATS_ENDPOINTS[entry.ats]?.(entry.board) ?? null, status: 'error', count: 0, detail: sourceError(error) },
        roles: [],
      };
    }
  }));
  return { sources: outcomes.map((item) => item.source), roles: outcomes.flatMap((item) => item.roles) };
}
