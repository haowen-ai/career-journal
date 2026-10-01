import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { workspaceDirectory } from '../config/store.mjs';
import { ANSWERS_TARGET, profileQuestions, profileRounds, questionByKey } from './profile-questions.mjs';

export const PROFILE_SCHEMA_VERSION = 1;
export const jobTypes = Object.freeze(['internship', 'full-time', 'co-op', 'other']);
export const directionIds = Object.freeze(['ai-ml', 'data-science', 'data-analytics', 'data-engineering', 'software-engineering', 'quant', 'product', 'other']);
export const degreeLevels = Object.freeze(['bachelors', 'masters', 'phd', 'mba', 'other']);
export const authorizationStatuses = Object.freeze(['citizen', 'permanent-resident', 'visa', 'other']);
export const transcriptPolicies = Object.freeze(['required-only', 'never']);
export const notifyChannels = Object.freeze(['desktop', 'none']);
export const atsProviders = Object.freeze(['greenhouse', 'lever', 'ashby']);
// The board token from a company's official job-board URL, such as boards.greenhouse.io/<token>.
export const atsBoardPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const COMMON_SECTION = Object.freeze({ title: 'Common form answers', heading: '## Common form answers · 常用表单答案', match: /^## Common form answers\b/ });
const LEARNED_SECTION = Object.freeze({ title: 'Learned while applying', heading: '## Learned while applying · 申请中补充', match: /^## Learned while applying\b/ });
const TABLE_HEADER = Object.freeze(['| Question · 问题 | Answer · 答案 |', '|---|---|']);

export function profileDirectory(home) {
  return path.join(workspaceDirectory(home), 'profile');
}

export function profilePath(home) {
  return path.join(profileDirectory(home), 'profile.json');
}

export function answersPath(home) {
  return path.join(profileDirectory(home), 'answers.md');
}

export function defaultProfile() {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    updatedAt: null,
    search: {
      jobType: null,
      season: null,
      directions: { primary: [], secondary: [] },
      locations: [],
      remoteOk: null,
      exclusions: [],
    },
    candidate: {
      degree: { level: null, major: null, graduation: null },
      authorization: { status: null, needsSponsorship: null },
    },
    materials: {
      resumePath: null,
      transcriptPath: null,
      transcriptPolicy: 'required-only',
      links: { linkedin: null, github: null, website: null },
      experienceConfirmed: false,
    },
    pace: { batchSize: 5, scanTime: '08:00', notify: 'desktop' },
    sources: {
      atsBoards: [],
      careerOps: false,
      simplify: { enabled: false, url: null },
    },
    interview: { roundsCompleted: [], skipped: [] },
  };
}

export function answersTemplate() {
  return `# Answers sheet · 答案表

Private to you. This file lives only in your CAREER JOURNAL data home; never commit it to a repository or paste it into logs.
仅供你本人使用。此文件只保存在你的 CAREER JOURNAL 数据目录中；不要提交到任何仓库，也不要贴进日志。

Each row is \`| question | answer (source, date) |\`. A question that starts with a key in backticks, such as \`legal-name\`, comes from the profile interview. When a question appears more than once, the last row wins.
每行格式为 \`| 问题 | 答案（来源，日期）|\`。以反引号中的键开头的问题（例如 \`legal-name\`）来自资料问答。同一问题出现多次时，以最后一行为准。

${COMMON_SECTION.heading}

${TABLE_HEADER.join('\n')}

${LEARNED_SECTION.heading}

${TABLE_HEADER.join('\n')}
`;
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const join = (prefix, key) => (prefix ? `${prefix}.${key}` : key);

const nonEmptyText = (max) => (value) => (typeof value === 'string' && value.trim() && value.length <= max
  ? null
  : `must be non-empty text of at most ${max} characters`);
const oneOf = (values) => (value) => (values.includes(value) ? null : `must be one of: ${values.join(', ')}`);
const nullable = (rule) => (value) => (value === null ? null : rule(value));
const boolean = (value) => (typeof value === 'boolean' ? null : 'must be true or false');
const integer = (min, max) => (value) => (Number.isInteger(value) && value >= min && value <= max ? null : `must be a whole number from ${min} to ${max}`);
const pattern = (regex, description) => (value) => (typeof value === 'string' && regex.test(value) ? null : `must be ${description}`);

function isoDateTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value))
    ? null
    : 'must be an ISO 8601 date-time';
}

function webUrl({ httpsOnly = false } = {}) {
  const expected = httpsOnly ? 'an https URL' : 'an http or https URL';
  const protocols = httpsOnly ? ['https:'] : ['http:', 'https:'];
  return (value) => {
    if (typeof value !== 'string') return `must be ${expected}`;
    let url;
    try { url = new URL(value); } catch { return `must be ${expected}`; }
    if (!protocols.includes(url.protocol)) return `must be ${expected}`;
    if (url.username || url.password) return 'must not contain credentials';
    return null;
  };
}

function localPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\0')) return 'must be a local file path';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) return 'must be a local file path, not a URL';
  if (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^~(?:$|[\\/])/.test(value)) {
    return 'must be an absolute path or start with ~/';
  }
  return null;
}

function list(itemRule, { identity = (item) => item } = {}) {
  return (value) => {
    if (!Array.isArray(value)) return 'must be a JSON list';
    const seen = new Set();
    for (const [index, item] of value.entries()) {
      const message = itemRule(item);
      if (message) return `[${index}] ${message}`;
      const id = identity(item);
      if (seen.has(id)) return `[${index}] repeats ${JSON.stringify(id)}`;
      seen.add(id);
    }
    return null;
  };
}

function exactFields(value, fields, example) {
  if (!isObject(value)) return `must be an object such as ${example}`;
  const extra = Object.keys(value).find((key) => !fields.includes(key));
  return extra ? `has unknown field ${extra}` : null;
}

function location(value) {
  const shape = exactFields(value, ['label', 'match'], '{"label":"New York, NY","match":["new york","nyc"]}');
  if (shape) return shape;
  const label = nonEmptyText(120)(value.label);
  if (label) return `label ${label}`;
  if (!Array.isArray(value.match) || !value.match.length) return 'match must be a non-empty list of lowercase place names';
  if (value.match.some((term) => typeof term !== 'string' || !term.trim() || term.length > 80)) return 'match terms must be non-empty text of at most 80 characters';
  return null;
}

function atsBoard(value) {
  const shape = exactFields(value, ['ats', 'board', 'company'], '{"ats":"greenhouse","board":"examplecorp","company":"ExampleCorp"}');
  if (shape) return shape;
  const ats = oneOf(atsProviders)(value.ats);
  if (ats) return `ats ${ats}`;
  if (typeof value.board !== 'string' || !atsBoardPattern.test(value.board)) {
    return 'board must be the board name from the official job-board URL (letters, digits, dot, dash, or underscore)';
  }
  if (Object.hasOwn(value, 'company')) {
    const company = nonEmptyText(120)(value.company);
    if (company) return `company ${company}`;
  }
  return null;
}

// The role scan needs at least one usable source: a company job board, CareerOps, or the
// opt-in SimplifyJobs list together with its URL.
export function hasScanSource(profile) {
  const sources = isObject(profile?.sources) ? profile.sources : {};
  return (Array.isArray(sources.atsBoards) && sources.atsBoards.length > 0)
    || sources.careerOps === true
    || (sources.simplify?.enabled === true && typeof sources.simplify.url === 'string' && sources.simplify.url.trim() !== '');
}

const questionKey = (value) => (typeof value === 'string' && questionByKey(value) ? null : 'must be a profile question key');

const fieldRules = Object.freeze({
  schemaVersion: (value) => (value === PROFILE_SCHEMA_VERSION ? null : `must be ${PROFILE_SCHEMA_VERSION}`),
  updatedAt: nullable(isoDateTime),
  'search.jobType': nullable(oneOf(jobTypes)),
  'search.season': nullable(nonEmptyText(80)),
  'search.directions.primary': list(oneOf(directionIds)),
  'search.directions.secondary': list(oneOf(directionIds)),
  'search.locations': list(location, { identity: (item) => item.label.trim().toLowerCase() }),
  'search.remoteOk': nullable(boolean),
  'search.exclusions': list(nonEmptyText(200), { identity: (item) => item.trim().toLowerCase() }),
  'candidate.degree.level': nullable(oneOf(degreeLevels)),
  'candidate.degree.major': nullable(nonEmptyText(120)),
  'candidate.degree.graduation': nullable(pattern(/^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/, 'a year and month in YYYY-MM form, such as 2027-05')),
  'candidate.authorization.status': nullable(oneOf(authorizationStatuses)),
  'candidate.authorization.needsSponsorship': nullable(boolean),
  'materials.resumePath': nullable(localPath),
  'materials.transcriptPath': nullable(localPath),
  'materials.transcriptPolicy': oneOf(transcriptPolicies),
  'materials.links.linkedin': nullable(webUrl()),
  'materials.links.github': nullable(webUrl()),
  'materials.links.website': nullable(webUrl()),
  'materials.experienceConfirmed': boolean,
  'pace.batchSize': integer(1, 10),
  'pace.scanTime': pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour time in HH:MM form, such as 08:00'),
  'pace.notify': oneOf(notifyChannels),
  'sources.atsBoards': list(atsBoard, { identity: (item) => `${item.ats}:${item.board.toLowerCase()}` }),
  'sources.careerOps': boolean,
  'sources.simplify.enabled': boolean,
  'sources.simplify.url': nullable(webUrl({ httpsOnly: true })),
  'interview.roundsCompleted': list(integer(1, 4)),
  'interview.skipped': list(questionKey),
});

const textFields = new Set([
  'search.jobType', 'search.season', 'candidate.degree.level', 'candidate.degree.major', 'candidate.degree.graduation',
  'candidate.authorization.status', 'materials.resumePath', 'materials.transcriptPath', 'materials.transcriptPolicy',
  'materials.links.linkedin', 'materials.links.github', 'materials.links.website', 'pace.scanTime', 'pace.notify',
  'sources.simplify.url',
]);
const materialFileFields = Object.freeze(['materials.resumePath', 'materials.transcriptPath']);
const managedFields = new Set(['schemaVersion', 'updatedAt']);

export const profileFields = Object.freeze(Object.keys(fieldRules).filter((field) => !managedFields.has(field)));

const objectChildren = new Map();
for (const leaf of Object.keys(fieldRules)) {
  const parts = leaf.split('.');
  for (let index = 0; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('.');
    if (!objectChildren.has(prefix)) objectChildren.set(prefix, new Set());
    objectChildren.get(prefix).add(parts[index]);
  }
}

function getPath(object, dotted) {
  let node = object;
  for (const part of dotted.split('.')) {
    if (!isObject(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

export function validateProfile(profile) {
  const errors = [];
  const visit = (value, prefix) => {
    if (!isObject(value)) {
      errors.push(`${prefix || 'profile'} must be an object`);
      return;
    }
    const children = objectChildren.get(prefix);
    for (const key of Object.keys(value)) {
      if (!children.has(key)) errors.push(`Unknown profile field: ${join(prefix, key)}`);
    }
    for (const key of children) {
      const field = join(prefix, key);
      if (!Object.hasOwn(value, key)) {
        errors.push(`${field} is missing`);
        continue;
      }
      const rule = fieldRules[field];
      if (!rule) {
        visit(value[key], field);
        continue;
      }
      const message = rule(value[key]);
      if (message) errors.push(`${field}${message.startsWith('[') ? '' : ' '}${message}`);
    }
  };
  visit(profile, '');
  if (!errors.length) {
    const { primary, secondary } = profile.search.directions;
    const overlap = secondary.filter((id) => primary.includes(id));
    if (overlap.length) errors.push(`search.directions.secondary repeats primary directions: ${overlap.join(', ')}`);
  }
  return { ok: errors.length === 0, errors };
}

function assertValid(profile, label) {
  const { ok, errors } = validateProfile(profile);
  if (!ok) throw new Error(`${label}: ${errors.join('; ')}`);
}

function withDefaults(defaults, value) {
  if (!isObject(defaults) || !isObject(value)) return value === undefined ? defaults : value;
  const merged = {};
  for (const [key, fallback] of Object.entries(defaults)) merged[key] = Object.hasOwn(value, key) ? withDefaults(fallback, value[key]) : fallback;
  for (const [key, item] of Object.entries(value)) if (!Object.hasOwn(merged, key)) merged[key] = item;
  return merged;
}

function tidy(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(tidy);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, tidy(item)]));
  return value;
}

// Trims text, turns blank optional text into null, and lowercases location match terms.
export function normalizeProfile(profile) {
  const next = tidy(profile);
  if (!isObject(next)) return next;
  const defaults = defaultProfile();
  for (const field of Object.keys(fieldRules)) {
    if (getPath(next, field) !== '' || getPath(defaults, field) !== null) continue;
    const parts = field.split('.');
    let node = next;
    for (const part of parts.slice(0, -1)) node = node[part];
    node[parts.at(-1)] = null;
  }
  const locations = getPath(next, 'search.locations');
  if (Array.isArray(locations)) {
    for (const item of locations) {
      if (isObject(item) && Array.isArray(item.match)) {
        item.match = [...new Set(item.match.map((term) => (typeof term === 'string' ? term.toLowerCase() : term)))];
      }
    }
  }
  return next;
}

export function resolveProfileKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('A profile key is required, such as search.jobType');
  const candidate = key.trim();
  const question = questionByKey(candidate);
  if (question) {
    if (question.target === ANSWERS_TARGET) {
      throw new Error(`${candidate} is a form answer kept in answers.md; save it with profile answer --key ${candidate} --answer <text>`);
    }
    return question.target;
  }
  if (managedFields.has(candidate)) throw new Error(`${candidate} is managed by CAREER JOURNAL and cannot be set`);
  if (!fieldRules[candidate] && !objectChildren.has(candidate)) {
    throw new Error(`Unknown profile key: ${candidate}. Run career-journal profile questions --json to see the profile fields`);
  }
  return candidate;
}

export function getProfileValue(profile, key) {
  return getPath(profile, resolveProfileKey(key));
}

export function setProfileValue(profile, key, value) {
  const field = resolveProfileKey(key);
  const next = structuredClone(profile);
  const parts = field.split('.');
  let node = next;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
  return next;
}

// Command-line values are JSON when they parse as JSON; text fields keep plain text such as 2027-05 or 08:00.
export function parseProfileValue(key, raw) {
  if (typeof raw !== 'string') throw new Error('A profile value is required: JSON, or plain text for text fields');
  const field = resolveProfileKey(key);
  let parsed;
  let isJson = true;
  try { parsed = JSON.parse(raw.trim()); } catch { isJson = false; }
  if (textFields.has(field)) return isJson && (parsed === null || typeof parsed === 'string') ? parsed : raw;
  return isJson ? parsed : raw;
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function writePrivateFile(file, content) {
  await ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.new`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function withFileLock(file, task, { timeoutMs = 10_000, staleMs = 60_000 } = {}) {
  const lock = `${file}.lock`;
  await ensurePrivateDirectory(path.dirname(file));
  const started = Date.now();
  for (;;) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for another career-journal command to finish writing ${path.basename(file)}; if none is running, delete ${lock}`);
      }
      await pause(5 + Math.floor(Math.random() * 20));
    }
  }
  try { return await task(); } finally { await rm(lock, { force: true }); }
}

export async function readProfile(home) {
  const file = profilePath(home);
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let raw;
  try { raw = JSON.parse(text); } catch (error) { throw new Error(`Profile ${file} is not valid JSON: ${error.message}`); }
  if (!isObject(raw)) throw new Error(`Profile ${file} must contain a JSON object`);
  if (raw.schemaVersion !== PROFILE_SCHEMA_VERSION) throw new Error(`Unsupported profile schema: ${raw.schemaVersion}`);
  const profile = withDefaults(defaultProfile(), raw);
  assertValid(profile, `Profile ${file} is invalid`);
  return profile;
}

export async function writeProfile(home, profile, { now = new Date().toISOString() } = {}) {
  const next = normalizeProfile(profile);
  if (isObject(next)) next.updatedAt = now instanceof Date ? now.toISOString() : now;
  assertValid(next, 'Invalid profile');
  await writePrivateFile(profilePath(home), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// Material paths are absolute or start with ~/, so they mean the same file from any working directory.
export function resolveMaterialPath(file) {
  if (file === '~') return os.homedir();
  if (file.startsWith('~/') || file.startsWith('~\\')) return path.join(os.homedir(), file.slice(2));
  return path.resolve(file);
}

async function isReadableFile(file) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.R_OK);
    return true;
  } catch { return false; }
}

export async function updateProfile(home, key, value, { now } = {}) {
  const field = resolveProfileKey(key);
  return withFileLock(profilePath(home), async () => {
    const current = (await readProfile(home)) ?? defaultProfile();
    const next = normalizeProfile(setProfileValue(current, field, value));
    assertValid(next, 'Invalid profile');
    for (const fileField of materialFileFields) {
      const file = getPath(next, fileField);
      if (typeof file === 'string' && file !== getPath(current, fileField) && !(await isReadableFile(resolveMaterialPath(file)))) {
        throw new Error(`${fileField} is not a readable file: ${resolveMaterialPath(file)}`);
      }
    }
    const profile = await writeProfile(home, next, { now });
    return { key: field, value: getPath(profile, field), profile };
  });
}

export async function readAnswers(home) {
  try { return await readFile(answersPath(home), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const separatorRow = (line) => /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line.trim());

function tableCells(line) {
  const cells = line.trim().split(/(?<!\\)\|/);
  return cells.slice(1, cells.length - 1).map((cell) => cell.trim());
}

// Rows of every Markdown table in answers.md, with the section heading and the interview key when present.
export function answerRows(text) {
  const rows = [];
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let section = null;
  for (const [index, line] of lines.entries()) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (!line.trim().startsWith('|') || separatorRow(line) || separatorRow(lines[index + 1] ?? '')) continue;
    const cells = tableCells(line);
    if (cells.length < 2) continue;
    const keyed = /^`([a-z0-9-]+)`\s*(.*)$/.exec(cells[0]);
    rows.push({ section, key: keyed ? keyed[1] : null, question: keyed ? keyed[2] : cells[0], answer: cells[1] });
  }
  return rows;
}

export function answeredKeys(text) {
  const latest = new Map();
  for (const row of answerRows(text)) if (row.key) latest.set(row.key, row.answer);
  return new Set([...latest].filter(([, answer]) => answer.trim()).map(([key]) => key));
}

function questionAnswered(question, profile, answered) {
  if (question.target === ANSWERS_TARGET) return answered.has(question.key);
  // Naming no companies is a complete answer when an opt-in source already feeds the scan.
  if (question.type === 'ats-boards') return hasScanSource(profile);
  const value = getPath(profile, question.target);
  if (question.type === 'confirm') return value === true;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function missingItems(profile, { answers = null } = {}) {
  const current = profile ?? defaultProfile();
  const answered = answeredKeys(answers);
  const skipped = new Set(getPath(current, 'interview.skipped') ?? []);
  return profileQuestions
    .filter((question) => question.required && !questionAnswered(question, current, answered))
    .map((question) => ({ round: question.round, key: question.key, target: question.target, skipped: skipped.has(question.key) }));
}

function calendarDate(now, timeZone) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error('The answer date must be a valid time');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const cell = (value) => value.replace(/\r?\n+/g, '<br>').replace(/(?<!\\)\|/g, '\\|').trim();

function rowKey(line) {
  if (!line.trim().startsWith('|')) return null;
  return /^`([a-z0-9-]+)`/.exec(tableCells(line)[0] ?? '')?.[1] ?? null;
}

function placeRow(text, section, row, replaceKey) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  const start = lines.findIndex((line) => section.match.test(line));
  if (start === -1) return `${[...lines, '', section.heading, '', ...TABLE_HEADER, row].join('\n')}\n`;
  let end = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line));
  if (end === -1) end = lines.length;
  if (replaceKey) {
    for (let index = end - 1; index > start; index -= 1) {
      if (rowKey(lines[index]) === replaceKey) {
        lines[index] = row;
        return `${lines.join('\n')}\n`;
      }
    }
  }
  let lastTableRow = -1;
  for (let index = start + 1; index < end; index += 1) if (lines[index].trim().startsWith('|')) lastTableRow = index;
  if (lastTableRow !== -1) {
    lines.splice(lastTableRow + 1, 0, row);
  } else {
    let last = end - 1;
    while (last > start && !lines[last].trim()) last -= 1;
    const block = ['', ...TABLE_HEADER, row];
    if (end < lines.length) block.push('');
    lines.splice(last + 1, end - last - 1, ...block);
  }
  return `${lines.join('\n')}\n`;
}

// Records a form answer in answers.md. Free-form questions are appended under "Learned while applying";
// a round 3 interview key (options.key) keeps one row per key under "Common form answers".
export async function appendAnswer(home, question, answer, source = 'user', { key = null, now = new Date(), timeZone } = {}) {
  let questionText = question;
  if (key !== null) {
    const known = typeof key === 'string' ? questionByKey(key.trim()) : null;
    if (!known) throw new Error(`Unknown answer key: ${key}. Run career-journal profile questions --round 3 --json to see the keys`);
    if (known.target !== ANSWERS_TARGET) {
      throw new Error(`${known.key} is stored in profile.json; save it with profile set --key ${known.target} --value <value>`);
    }
    if (questionText === undefined || questionText === null) questionText = known.label.en;
  }
  if (typeof questionText !== 'string' || !questionText.trim()) throw new Error('A question is required');
  if (questionText.length > 500) throw new Error('The question must be at most 500 characters');
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('An answer is required');
  if (answer.length > 2000) throw new Error('The answer must be at most 2000 characters');
  const sourceName = typeof source === 'string' ? source.trim() : '';
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(sourceName)) throw new Error('The answer source must be a short lowercase word such as user or resume');
  const answerKey = key === null ? null : key.trim();
  const date = calendarDate(now, timeZone);
  const questionCell = answerKey ? `\`${answerKey}\` ${cell(questionText)}` : cell(questionText);
  const row = `| ${questionCell} | ${cell(answer)} (${sourceName}, ${date}) |`;
  const section = answerKey ? COMMON_SECTION : LEARNED_SECTION;
  const file = answersPath(home);
  await withFileLock(file, async () => {
    const current = (await readAnswers(home)) ?? answersTemplate();
    await writePrivateFile(file, placeRow(current, section, row, answerKey));
  });
  return { section: section.title, key: answerKey, question: questionText.trim(), answer: answer.trim(), source: sourceName, date };
}

function describeRound(round) {
  return `round ${round.round} (${round.id}) is missing ${round.missing.join(', ')}`;
}

export async function profileStatus(home) {
  const stored = await readProfile(home);
  const profile = stored ?? defaultProfile();
  const answers = await readAnswers(home);
  const missing = missingItems(profile, { answers });
  const rounds = profileRounds.map((round) => {
    const keys = missing.filter((item) => item.round === round.round).map((item) => item.key);
    return { round: round.round, id: round.id, complete: keys.length === 0, missing: keys };
  });
  const resumeSet = typeof profile.materials.resumePath === 'string';
  const resume = { set: resumeSet, readable: resumeSet && await isReadableFile(resolveMaterialPath(profile.materials.resumePath)) };
  const [search, materials] = rounds;
  const scanReasons = [];
  if (!stored) scanReasons.push('no profile yet; run the profile interview');
  else {
    if (!search.complete) scanReasons.push(describeRound(search));
    if (!hasScanSource(profile)) scanReasons.push('no scan sources; name companies to watch or turn on an opt-in source (round 4)');
  }
  const applyReasons = [];
  if (!stored) applyReasons.push('no profile yet; complete interview rounds 1 and 2');
  else {
    for (const round of [search, materials]) if (!round.complete) applyReasons.push(describeRound(round));
    if (resume.set && !resume.readable) applyReasons.push('the resume file is not readable');
  }
  const readiness = (reasons, ready) => ({
    ready: reasons.length === 0,
    detail: reasons.length ? `incomplete: ${reasons.join('; ')}` : `ready: ${ready}`,
  });
  return {
    exists: stored !== null,
    path: profilePath(home),
    answersPath: answersPath(home),
    answersExists: answers !== null,
    updatedAt: stored?.updatedAt ?? null,
    rounds,
    missing,
    resume,
    readiness: {
      scan: readiness(scanReasons, 'interview round 1 is complete and at least one scan source is set'),
      apply: readiness(applyReasons, 'interview rounds 1 and 2 are complete and the resume file is readable'),
    },
  };
}
