import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  atsBoardPattern, atsProviders, authorizationStatuses, degreeLevels, directionIds, profilePath, readProfile,
} from '../domain/profile.mjs';

// Reads only the profile fields the role scan needs. The complete profile
// contract (writing, interview rounds, answers sheet) belongs to the profile
// domain module: the workspace profile is read through it, and an explicit
// --profile file is read here and stays tolerant of fields the scan does not use.

export const DIRECTION_IDS = directionIds;
export const DEGREE_LEVELS = degreeLevels;
export const AUTHORIZATION_STATUSES = authorizationStatuses;
export const ATS_KINDS = atsProviders;

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

// The workspace profile, under .career-journal/ or a legacy .jobops/ workspace.
export function defaultProfilePath(home) {
  return profilePath(path.resolve(home));
}

function fail(field, message) {
  throw new Error(`Profile ${field} ${message}`);
}

function object(value, field) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail(field, 'must be an object');
  return value;
}

function optionalString(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') fail(field, 'must be text');
  return value.trim() || null;
}

function stringList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(field, 'must be a list of text values');
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function enumValue(value, allowed, field) {
  if (value == null) return null;
  if (!allowed.includes(value)) fail(field, `must be one of: ${allowed.join(', ')}`);
  return value;
}

function directions(value) {
  const input = object(value, 'search.directions');
  const result = {};
  for (const key of ['primary', 'secondary']) {
    const list = stringList(input[key], `search.directions.${key}`);
    for (const id of list) if (!DIRECTION_IDS.includes(id)) fail(`search.directions.${key}`, `contains unknown direction "${id}"; use: ${DIRECTION_IDS.join(', ')}`);
    result[key] = list;
  }
  result.secondary = result.secondary.filter((id) => !result.primary.includes(id));
  return result;
}

function locations(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail('search.locations', 'must be a list');
  return value.map((item, index) => {
    const field = `search.locations[${index}]`;
    const entry = object(item, field);
    const label = optionalString(entry.label, `${field}.label`);
    if (!label) fail(`${field}.label`, 'is required');
    const match = stringList(entry.match, `${field}.match`).map((term) => term.toLowerCase());
    return { label, match: match.length ? match : [label.toLowerCase()] };
  });
}

function atsBoards(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail('sources.atsBoards', 'must be a list');
  return value.map((item, index) => {
    const field = `sources.atsBoards[${index}]`;
    const entry = object(item, field);
    const ats = enumValue(entry.ats, ATS_KINDS, `${field}.ats`);
    if (!ats) fail(`${field}.ats`, `is required (${ATS_KINDS.join(', ')})`);
    const board = optionalString(entry.board, `${field}.board`);
    if (!board || !atsBoardPattern.test(board)) fail(`${field}.board`, 'must be the public board name from the company job-board URL');
    const company = optionalString(entry.company, `${field}.company`);
    return { ats, board, ...(company ? { company } : {}) };
  });
}

function simplify(value) {
  const input = object(value, 'sources.simplify');
  if (input.enabled != null && typeof input.enabled !== 'boolean') fail('sources.simplify.enabled', 'must be true or false');
  const url = optionalString(input.url, 'sources.simplify.url');
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { fail('sources.simplify.url', 'must be an https URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail('sources.simplify.url', 'must be an https URL without credentials');
  }
  return { enabled: input.enabled === true, url };
}

export function normalizeScanProfile(raw) {
  const profile = object(raw, 'root');
  if (profile.schemaVersion !== undefined && profile.schemaVersion !== 1) fail('schemaVersion', `${profile.schemaVersion} is not supported by this scan`);
  const search = object(profile.search, 'search');
  const candidate = object(profile.candidate, 'candidate');
  const degree = object(candidate.degree, 'candidate.degree');
  const authorization = object(candidate.authorization, 'candidate.authorization');
  const pace = object(profile.pace, 'pace');
  const sources = object(profile.sources, 'sources');
  if (search.remoteOk != null && typeof search.remoteOk !== 'boolean') fail('search.remoteOk', 'must be true or false');
  if (authorization.needsSponsorship != null && typeof authorization.needsSponsorship !== 'boolean') fail('candidate.authorization.needsSponsorship', 'must be true or false');
  if (sources.careerOps != null && typeof sources.careerOps !== 'boolean') fail('sources.careerOps', 'must be true or false');
  const graduation = optionalString(degree.graduation, 'candidate.degree.graduation');
  if (graduation && !MONTH.test(graduation)) fail('candidate.degree.graduation', 'must be YYYY-MM');
  const scanTime = optionalString(pace.scanTime, 'pace.scanTime');
  if (scanTime && !TIME.test(scanTime)) fail('pace.scanTime', 'must be HH:MM');
  return {
    search: {
      jobType: optionalString(search.jobType, 'search.jobType'),
      season: optionalString(search.season, 'search.season'),
      directions: directions(search.directions),
      locations: locations(search.locations),
      remoteOk: search.remoteOk === true,
      exclusions: stringList(search.exclusions, 'search.exclusions'),
    },
    candidate: {
      degree: {
        level: enumValue(degree.level ?? null, DEGREE_LEVELS, 'candidate.degree.level'),
        graduation,
      },
      authorization: {
        status: enumValue(authorization.status ?? null, AUTHORIZATION_STATUSES, 'candidate.authorization.status'),
        needsSponsorship: authorization.needsSponsorship === true,
      },
    },
    pace: { scanTime },
    sources: {
      atsBoards: atsBoards(sources.atsBoards),
      careerOps: sources.careerOps === true,
      simplify: simplify(sources.simplify),
    },
  };
}

const missingProfile = (file) => new Error(`No search profile found at ${file}. Complete the profile interview first, or pass --profile <path>.`);

export async function loadScanProfile(home, { path: explicitPath } = {}) {
  if (!explicitPath) {
    // The workspace profile goes through the profile module, which finds legacy .jobops/
    // workspaces and applies the full profile validation before the scan's own checks.
    const profile = await readProfile(path.resolve(home));
    if (!profile) throw missingProfile(defaultProfilePath(home));
    return normalizeScanProfile(profile);
  }
  const file = path.resolve(String(explicitPath));
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw missingProfile(file);
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Search profile is not valid JSON: ${file}`); }
  return normalizeScanProfile(parsed);
}
