import { executeCareerOpsProcess } from '../integrations/careerops-process.mjs';
import { providerRequisition } from '../funnel/identity.mjs';

export function commandFetcher({ argv, timeoutMs, maxBytes = 2_000_000, runImpl }) {
  if (!Array.isArray(argv) || !argv.length || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Fetcher requires argv and a positive timeoutMs');
  return { async fetch(request) {
    const controller = new AbortController();
    let failure;
    const timer = setTimeout(() => { failure = 'timeout'; controller.abort(); }, timeoutMs);
    const execute = runImpl ?? executeCareerOpsProcess;
    try {
      const execution = Promise.resolve().then(() => execute({ command: argv[0], args: argv.slice(1), argv, stdin: JSON.stringify(request), signal: controller.signal, timeoutMs, maxBytes }));
      let result;
      if (runImpl) result = await Promise.race([execution, new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve(null), { once: true }))]);
      else result = await execution;
      if (failure) return { ok: false, error: failure };
      if (Buffer.byteLength(result.stdout ?? '') > maxBytes) return { ok: false, error: 'too_large' };
      if ((result.exitCode ?? 0) !== 0) return { ok: false, error: `fetch command exited ${result.exitCode}` };
      return JSON.parse(result.stdout);
    } catch (error) { return { ok: false, error: error.code === 'PROCESS_TOO_LARGE' ? 'too_large' : failure ?? error.message }; }
    finally { clearTimeout(timer); }
  } };
}

const plainText = (html) => String(html ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  .replace(/<\/(?:p|div|h[1-6]|li|section)>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (v) => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[v]).trim();

export function builtinFetcher({ fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Fetcher timeoutMs must be positive');
  return { async fetch(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const read = async (url) => {
      const response = await fetchImpl(url, { signal: controller.signal });
      let text = ''; let bytes = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader(); const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 2_000_000) { await reader.cancel(); throw new Error('too_large'); }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } else { text = await response.text(); if (Buffer.byteLength(text) > 2_000_000) throw new Error('too_large'); }
      return { response, text };
    };
    try {
      const req = providerRequisition(request.url);
      let api;
      if (req?.provider === 'greenhouse') api = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(req.tenant)}/jobs/${req.id}`;
      if (req?.provider === 'lever') api = `https://api.lever.co/v0/postings/${encodeURIComponent(req.tenant)}/${req.id}`;
      if (req?.provider === 'ashby') api = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(req.tenant)}`;
      if (api) {
        const { response, text } = await read(api);
        if (response.ok) {
          let data = JSON.parse(text);
          if (req.provider === 'ashby') data = data.jobs?.find((job) => job.id === req.id);
          if (data) {
            const offices = data.offices ?? data.categories?.allLocations ?? data.secondaryLocations ?? [];
            const location = data.location?.name ?? data.location ?? data.categories?.location;
            return { ok: true, httpStatus: 200, finalUrl: request.url, method: 'ats_api', title: data.title ?? data.text,
              company: request.known?.company, requisitionId: String(data.id ?? req.id), locations: [location, ...offices.map((o) => o.name ?? o)].filter(Boolean), offices,
              remote: data.isRemote ?? null, workplaceType: data.workplaceType ?? null, employmentType: data.employmentType ?? data.categories?.commitment,
              text: req.provider === 'lever' ? [data.descriptionPlain || data.description,
                ...(data.lists ?? []).flatMap((list) => [list.text, list.content]), data.additionalPlain || data.additional]
                .filter(Boolean).map(plainText).join('\n\n')
                : plainText(data.content ?? data.descriptionHtml ?? data.descriptionPlain ?? data.description ?? ''), jsonLd: null, closedWording: null };
          }
        }
      }
      const { response, text } = await read(request.url);
      let job;
      const visit = (value) => {
        if (Array.isArray(value)) return value.map(visit).find(Boolean);
        if (value && typeof value === 'object') return [value['@type']].flat().includes('JobPosting') ? value : visit(value['@graph']);
        return null;
      };
      for (const match of text.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try { job ??= visit(JSON.parse(match[1])); } catch { /* malformed JSON-LD falls back to page text */ }
      }
      return { ok: response.ok, httpStatus: response.status, finalUrl: response.url || request.url, method: job ? 'jsonld' : 'html',
        title: job?.title ?? plainText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1] ?? ''),
        company: job?.hiringOrganization?.name, requisitionId: job?.identifier?.value ?? null,
        locations: [job?.jobLocation].flat().filter(Boolean), offices: [], remote: job?.jobLocationType ?? null,
        employmentType: job?.employmentType, text: plainText(job?.description ?? text), jsonLd: job ?? null,
        closedWording: /(?:position (?:has been |is )?(?:filled|closed)|no longer accepting applications|job is no longer available)/i.exec(plainText(text))?.[0] ?? null };
    } catch (error) { return { ok: false, error: controller.signal.aborted ? 'timeout' : error.message }; }
    finally { clearTimeout(timer); }
  } };
}

export function politeFetcher(inner, { perHost = 1, minGapMs = 1000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), clock = Date.now } = {}) {
  if (!Number.isInteger(perHost) || perHost < 1 || minGapMs < 0) throw new Error('Invalid host fetch limits');
  const hosts = new Map();
  return { async fetch(request) {
    const host = new URL(request.url).host;
    const state = hosts.get(host) ?? { queue: Promise.resolve(), active: 0, waiters: [], nextStart: -Infinity };
    hosts.set(host, state);
    const before = state.queue;
    let release;
    state.queue = new Promise((resolve) => { release = resolve; });
    await before;
    if (state.active >= perHost) await new Promise((resolve) => state.waiters.push(resolve));
    const gap = state.nextStart - clock(); if (gap > 0) await sleep(gap);
    state.active += 1; state.nextStart = clock() + minGapMs; release();
    try { return await inner.fetch(request); }
    finally { state.active -= 1; state.waiters.shift()?.(); }
  } };
}

const normalize = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function validateSnapshot(posting, result) {
  const fail = (reason) => ({ identityOk: false, reason });
  if ([404, 410].includes(result.httpStatus)) return fail('not_found');
  if (!result.ok) return fail(result.error ?? 'fetch_failed');
  const url = posting.url ?? posting.canonical_url;
  try {
    const host = (value) => new URL(/^https?:/.test(value) ? value : `https://${value}`).hostname.replace(/^www\./, '');
    if (host(url) !== host(result.finalUrl ?? url)) return fail('host_mismatch');
  } catch { return fail('host_mismatch'); }
  const text = String(result.text ?? '');
  if (/\b(?:please sign in to continue|verify (?:that )?you are human|captcha|access denied|search results|enable javascript and cookies)\b/i.test(text)) return fail('challenge');
  const req = posting.requisition ?? posting.requisitionId ?? providerRequisition(/^https?:/.test(url) ? url : `https://${url}`)?.id;
  const fetchedReq = result.requisitionId;
  const workday = /myworkday(?:jobs|site)\.com/i.test(url);
  const reqKey = (id) => workday ? String(id).toUpperCase() : String(id);
  if (req && fetchedReq && reqKey(req) !== reqKey(fetchedReq)
    && !(workday && reqKey(req).replace(/-\d+$/, '') === reqKey(fetchedReq))) return fail('req_conflict');
  if (!(req && fetchedReq) && normalize(posting.title) !== normalize(result.title)) return fail('wrong_posting');
  const hasJob = result.jsonLd && ([result.jsonLd['@type']].flat().includes('JobPosting') || result.jsonLd.title);
  if (text.length < 600 && !hasJob && !/requirements|qualifications|required skills|minimum education/i.test(text)) return fail('too_short');
  return { identityOk: true, reason: null };
}
