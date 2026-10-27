import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function dependencyHash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

async function readInput(file, { json = false, optional = false } = {}) {
  try {
    const text = await readFile(file, 'utf8');
    return json ? JSON.parse(text) : text;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error(`Cannot load ${path.basename(file)}: ${error.message}`, { cause: error });
  }
}

export async function loadReviewInputs(home) {
  const root = path.resolve(home, '.career-journal');
  const profile = path.join(root, 'profile');
  const [facts, policy, screeningPolicy, provenance, screening, fit] = await Promise.all([
    readInput(path.join(profile, 'facts.json'), { json: true }),
    readInput(path.join(profile, 'review-policy.json'), { json: true }),
    readInput(path.join(profile, 'screening-policy.json'), { json: true }),
    readInput(path.join(profile, 'review-provenance.json'), { json: true }),
    readInput(path.join(profile, 'screening-rules.md')),
    readInput(path.join(profile, 'fit-rules.md')),
  ]);
  const [text, evalRecord] = await Promise.all([
    readInput(path.resolve(root, policy.resumeTextPath ?? 'profile/resume.txt'), { optional: true }),
    readInput(path.join(root, 'runs', 'eval-latest.json'), { json: true, optional: true }),
  ]);
  return { facts, policy, screeningPolicy, provenance, rules: { screening, fit }, resume: text === null ? null : { text, hash: dependencyHash(text) }, evalRecord };
}

export function judgeDependencies({ inputs, adapter, skeletonVersion, schemaHash, decideVersion }) {
  if (adapter.runner === 'codex' && adapter.ready && adapter.cliVersion === null) throw new Error('Await judge adapter.ready before computing dependencies');
  const parts = {
    facts: dependencyHash(inputs.facts),
    rules: dependencyHash(inputs.rules),
    policy: dependencyHash({ policy: inputs.policy, screeningPolicy: inputs.screeningPolicy, provenance: inputs.provenance }),
    resume: dependencyHash(inputs.resume?.text ?? null),
    schema: schemaHash,
    prompt: dependencyHash(skeletonVersion),
    model: dependencyHash({ runner: adapter.runner, model: adapter.model, tier: adapter.tier, effort: adapter.effort ?? null, cliVersion: adapter.cliVersion ?? null }),
    decide: decideVersion,
  };
  return { hash: dependencyHash(parts), parts };
}

export function evalCurrent(record, deps) {
  const currentParts = deps?.parts ?? deps ?? {};
  const previous = record?.deps?.parts ?? record?.deps;
  const changed = Object.keys(currentParts).filter((part) => !previous || previous[part] !== currentParts[part]);
  return { current: Boolean(previous) && changed.length === 0, changed };
}
