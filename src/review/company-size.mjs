import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { companyKey } from '../scan/dedupe.mjs';

// Company size is decided once per COMPANY, outside the posting judgment.
//   profile/company-size.json { rule, large[], small[], defenseExcluded[], decided[] }
//     large/small: names the user (or an earlier review) settled by hand. decided[]: decisions made by
//     ensureCompanySizes, each { company, size: 'large'|'small', by, probability?, reason?, at }.
//   Names are compared through companyKey with the alias map (company-overrides.json `aliases`).
// No file means no size rule: every company passes.
export const SIZE_FILE = 'company-size.json';
export const SIZE_THRESHOLDS = Object.freeze({ accept: 0.7, reject: 0.3 });
export const SIZE_QUESTION = (company) => `Is this statement true: "${company}" is a large employer, meaning a well-known brand, or 1,000 or more employees, or a latest valuation or market capitalization of $10 billion or more.`;
const SIZES = new Set(['large', 'small']);

function list(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) throw new Error(`Cannot load ${SIZE_FILE}: ${field} must be a list of non-empty strings`);
  return value.map((item) => item.trim());
}
function decisions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item?.company === 'string' && item.company.trim() && SIZES.has(item.size))) {
    throw new Error(`Cannot load ${SIZE_FILE}: decided must be a list of { company, size: "large" | "small" }`);
  }
  return value;
}

// sizes: the in-memory view. Explicit lists win over decided[]; a name in both lists counts as small.
export function companySizes({ large = [], small = [], decided = [], defenseExcluded = [], aliases = {}, enabled = true } = {}) {
  const key = (name) => companyKey(name, aliases);
  const explicit = new Map();
  const learned = new Map();
  for (const name of large) explicit.set(key(name), 'large');
  for (const name of small) explicit.set(key(name), 'small');
  for (const entry of decided) learned.set(key(entry.company), entry.size);
  return {
    enabled, aliases, defenseExcluded, decided: [...decided],
    key,
    sizeOf(name) {
      if (!name || !String(name).trim()) return null;
      const k = key(name);
      return explicit.get(k) ?? learned.get(k) ?? null;
    },
    record(entry) { this.decided.push(entry); if (!explicit.has(key(entry.company))) learned.set(key(entry.company), entry.size); },
  };
}

export async function readSizeFile(profileDir) {
  const file = path.join(profileDir, SIZE_FILE);
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot load ${SIZE_FILE}: ${error.message}`, { cause: error });
  }
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`Cannot load ${SIZE_FILE}: ${error.message}`, { cause: error }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Cannot load ${SIZE_FILE}: expected an object`);
  return { ...data, large: list(data.large, 'large'), small: list(data.small, 'small'), defenseExcluded: list(data.defenseExcluded, 'defenseExcluded'), decided: decisions(data.decided) };
}

// The alias map is read from company-overrides.json (loaded by overrides.mjs); callers that already
// have it pass { aliases } to avoid a second read.
export async function loadCompanySizes(profileDir, { aliases } = {}) {
  if (aliases === undefined) {
    const { loadUserOverrides } = await import('./overrides.mjs');
    aliases = (await loadUserOverrides(profileDir, { sizes: false })).aliases;
  }
  const data = await readSizeFile(profileDir);
  if (!data) return companySizes({ aliases, enabled: false });
  return companySizes({ ...data, aliases });
}

// 'large' | 'small' | 'unknown'. Without a size rule every company passes as 'large'.
export function companySizeGate(company, sizes) {
  if (!sizes || sizes.enabled === false) return 'large';
  return sizes.sizeOf(company) ?? 'unknown';
}

// One file writer per path in this process: appends run one after another, each re-reading the file
// so concurrent decisions never overwrite each other, and each lands by atomic rename.
const writers = new Map();
export function saveSizeDecisions(profileDir) {
  const file = path.join(profileDir, SIZE_FILE);
  return (entries) => {
    const previous = writers.get(file) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      let data = {};
      try { data = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const decided = [...(Array.isArray(data.decided) ? data.decided : []), ...[entries].flat()];
      const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(temp, `${JSON.stringify({ ...data, decided }, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, file);
    });
    writers.set(file, next);
    return next;
  };
}

const errorText = (error) => String(error?.message ?? error ?? 'unknown error');
const probabilityOf = (answer) => (typeof answer === 'number' ? answer : answer?.probability);

// For each distinct unknown company: one Jev question; >= accept → large, <= reject → small; between →
// askModel(company, context) must return { size: 'large'|'small', reason }. An operational failure of
// either decides nothing: the company stays unknown and is returned in failed[] with the real error.
const inflight = new Map();
export async function ensureCompanySizes({ companies = [], sizes, askJev, askModel, save, now = new Date().toISOString(), thresholds = SIZE_THRESHOLDS, question = SIZE_QUESTION } = {}) {
  const result = { decided: [], failed: [], known: [] };
  if (!sizes || sizes.enabled === false) return result;
  const distinct = new Map();
  for (const name of companies) {
    if (!name || !String(name).trim()) continue;
    const k = sizes.key(name);
    if (!distinct.has(k)) distinct.set(k, String(name).trim());
  }
  const decideOne = async (company) => {
    let probability;
    try {
      const answer = await askJev(question(company), { company });
      probability = probabilityOf(answer);
      if (!Number.isFinite(probability)) throw new Error(`Jev returned no probability${answer?.error ? `: ${answer.error}` : ''}`);
    } catch (error) { return { company, failed: true, stage: 'jev', error: errorText(error) }; }
    if (probability >= thresholds.accept) return { company, size: 'large', by: 'jev', probability, at: now };
    if (probability <= thresholds.reject) return { company, size: 'small', by: 'jev', probability, at: now };
    try {
      const answer = await askModel(company, { probability, question: question(company) });
      if (!SIZES.has(answer?.size)) throw new Error(`model returned no size${answer?.error ? `: ${answer.error}` : ''}`);
      return { company, size: answer.size, by: 'model', probability, reason: typeof answer.reason === 'string' ? answer.reason : null, at: now };
    } catch (error) { return { company, failed: true, stage: 'model', probability, error: errorText(error) }; }
  };
  await Promise.all([...distinct].map(async ([k, company]) => {
    if (sizes.sizeOf(company)) { result.known.push(company); return; }
    let pending = inflight.get(k);
    const owner = !pending;
    if (owner) {
      pending = (async () => {
        const outcome = await decideOne(company);
        if (outcome.failed) return outcome;
        const entry = Object.fromEntries(Object.entries(outcome).filter(([, value]) => value !== undefined && value !== null));
        await save(entry);
        sizes.record(entry);
        return entry;
      })().finally(() => inflight.delete(k));
      inflight.set(k, pending);
    }
    let outcome;
    try { outcome = await pending; } catch (error) { outcome = { company, failed: true, stage: 'save', error: errorText(error) }; }
    if (!owner && !outcome.failed && !sizes.sizeOf(company)) sizes.record(outcome);
    if (outcome.failed) result.failed.push({ company, stage: outcome.stage, error: outcome.error, ...(outcome.probability != null ? { probability: outcome.probability } : {}) });
    else if (owner) result.decided.push(outcome);
    else result.known.push(company);
  }));
  return result;
}
