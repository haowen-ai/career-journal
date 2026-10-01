import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'scan');

export const FIXTURE_DIRECTORY = directory;
export const SIMPLIFY_URL = 'https://example.com/simplify/listings.json';
export const ATS_URLS = Object.freeze({
  greenhouse: 'https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs?content=true',
  lever: 'https://api.lever.co/v0/postings/examplelabs?mode=json',
  ashby: 'https://api.ashbyhq.com/posting-api/job-board/examplequant',
});

export async function readFixture(name) {
  return JSON.parse(await readFile(path.join(directory, name), 'utf8'));
}

export async function scanFixtures() {
  const [profile, greenhouse, lever, ashby, simplify, careerops] = await Promise.all([
    'profile.json', 'greenhouse-examplecorp.json', 'lever-examplelabs.json', 'ashby-examplequant.json', 'simplify-listings.json', 'careerops-scan.json',
  ].map(readFixture));
  return { profile, greenhouse, lever, ashby, simplify, careerops };
}

// A fetch that only answers the given URLs. Any other request fails the test,
// so no test can reach the live network.
export function fixtureFetch(routes, calls = []) {
  return async (url) => {
    const key = String(url);
    calls.push(key);
    if (!Object.hasOwn(routes, key)) throw new Error(`Unexpected network request in test: ${key}`);
    const route = routes[key];
    if (typeof route === 'number') return new Response('{"error":"fixture"}', { status: route });
    if (route instanceof Error) throw route;
    return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

export async function defaultRoutes(extra = {}) {
  const fixtures = await scanFixtures();
  return {
    [ATS_URLS.greenhouse]: fixtures.greenhouse,
    [ATS_URLS.lever]: fixtures.lever,
    [ATS_URLS.ashby]: fixtures.ashby,
    ...extra,
  };
}
