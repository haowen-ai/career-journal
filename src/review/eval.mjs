import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadReviewInputs, dependencyHash } from './inputs.mjs';
import { createJudgeAdapters } from './judge.mjs';
import { validateSnapshot } from './fetch.mjs';
import { buildJudgeRequest } from './prompt.mjs';
import { segmentSections } from './clauses.mjs';
import { decide } from './decide.mjs';
import { redact } from '../runtime/redact.mjs';

const PROFILE_FILES = ['facts.json','review-policy.json','screening-policy.json','review-provenance.json','screening-rules.md','fit-rules.md','resume.txt','profile.json'];
async function readBounded(file) {
  if ((await stat(file)).size > 2_000_000) throw new Error(`Evaluation file too_large: ${path.basename(file)}`);
  return readFile(file, 'utf8');
}
function within(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Evaluation paths must be relative');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Evaluation path escapes the set');
  return resolved;
}
export async function saveEvalRecord(home, record) {
  const directory = path.join(home, '.career-journal', 'runs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { rename } = await import('node:fs/promises');
  const tmp = path.join(directory, `eval-${randomUUID()}.tmp`);
  await writeFile(tmp, `${redact(JSON.stringify(record, null, 2))}\n`, { mode: 0o600 });
  await rename(tmp, path.join(directory, 'eval-latest.json'));
}

export async function runEval({ setDir, judges, concurrency = 3 }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Evaluation concurrency must be positive');
  const manifestText = await readBounded(path.join(setDir, 'manifest.json'));
  const manifest = JSON.parse(manifestText);
  if (!manifest.setId || !manifest.profiles || !Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error('Invalid evaluation manifest');
  for (const key of ['maxFalseAccepts','maxFalseRejects','maxUnexpectedUnclear']) if (!Number.isInteger(manifest.gate?.[key]) || manifest.gate[key] < 0) throw new Error(`Evaluation gate requires ${key}`);
  const work = await mkdtemp(path.join(os.tmpdir(), 'cj-eval-'));
  const profiles = new Map(); const deps = {}; const fixtures = { manifest: manifestText }; const seenIds = new Set();
  try {
    for (const [id, relative] of Object.entries(manifest.profiles)) {
      const directory = within(setDir, relative);
      // Reuse the production home loader; the source set remains read-only.
      const home = path.join(work, `profile-${profiles.size}`);
      const destination = path.join(home, '.career-journal', 'profile');
      await mkdir(destination, { recursive: true, mode: 0o700 });
      for (const name of PROFILE_FILES) {
        try {
          const content = await readBounded(path.join(directory, name));
          fixtures[`${relative}/${name}`] = content;
          await writeFile(path.join(destination, name), content, { mode: 0o600 });
        } catch (error) { if (!(['resume.txt','profile.json'].includes(name) && error.code === 'ENOENT')) throw error; }
      }
      const inputs = await loadReviewInputs(home);
      const adapters = judges ?? createJudgeAdapters(inputs.policy);
      profiles.set(id, { inputs, adapters }); deps[id] = {};
      for (const tier of ['primary','escalation']) {
        const request = await buildJudgeRequest({ posting: {}, snapshot: { text: '' }, sections: [], inputs, adapter: adapters[tier], tier });
        deps[id][tier] = request.deps.parts;
      }
    }
    const cases = new Array(manifest.cases.length);
    const metrics = { falseAccepts: 0, falseRejects: 0, unexpectedUnclear: 0, codeMismatches: 0, adapterErrors: 0, cases: cases.length, escalations: 0 };
    let next = 0;
    const execute = async () => {
      for (;;) {
        const index = next++; if (index >= manifest.cases.length) return;
        const item = manifest.cases[index];
        if (typeof item.id !== 'string' || seenIds.has(item.id)) throw new Error('Evaluation case ids must be unique strings');
        seenIds.add(item.id);
        const profile = profiles.get(item.profile); if (!profile) throw new Error(`Unknown evaluation profile: ${item.profile}`);
        if (!['eligible','not_eligible','unclear'].includes(item.expected?.decision) || !Array.isArray(item.expected.acceptable) || !item.expected.acceptable.every((d) => ['eligible','not_eligible','unclear'].includes(d))) throw new Error(`Invalid expected decision: ${item.id}`);
        const text = await readBounded(within(setDir, item.fetch)); fixtures[item.fetch] = text;
        const snapshot = JSON.parse(text);
        const identity = validateSnapshot(item.posting, snapshot);
        let verdict; let escalated = false; let adapterError = false;
        const attempts = [];
        if (!identity.identityOk) verdict = { decision: 'unclear', code: identity.reason, escalate: false };
        else {
          for (const tier of ['primary','escalation']) {
            const adapter = profile.adapters[tier];
            const request = await buildJudgeRequest({ posting: { ...item.posting, id: item.id }, snapshot, sections: segmentSections(snapshot.text), inputs: profile.inputs, adapter, tier });
            const attemptId = randomUUID(); const outputPath = path.join(work, `${attemptId}.json`);
            let result;
            try { result = await adapter.judge(request, { attemptId, outputPath }); }
            catch (error) { result = { status: 'error', error: error.message }; }
            attempts.push({ tier, status: result.status, error: result.error ?? null });
            if (tier === 'escalation') { escalated = true; metrics.escalations += 1; }
            if (result.status !== 'ok') { verdict = { decision: 'unclear', code: `judge_${result.status}` }; adapterError = true; break; }
            verdict = decide({ snapshotText: snapshot.text, judgment: result.output, facts: profile.inputs.facts, policy: profile.inputs.policy, tier,
              firstSeen: item.posting.firstSeen, jobType: profile.inputs.profile?.search?.jobType });
            if (tier === 'primary' && verdict.escalate) continue;
            break;
          }
        }
        const falseAccept = verdict.decision === 'eligible' && item.expected.decision !== 'eligible';
        const falseReject = verdict.decision === 'not_eligible' && ['eligible','unclear'].includes(item.expected.decision);
        const unexpectedUnclear = verdict.decision === 'unclear' && !item.expected.acceptable.includes('unclear');
        const codeMismatch = item.expected.code != null && verdict.code !== item.expected.code;
        metrics.falseAccepts += Number(falseAccept); metrics.falseRejects += Number(falseReject); metrics.unexpectedUnclear += Number(unexpectedUnclear);
        metrics.codeMismatches += Number(codeMismatch); metrics.adapterErrors += Number(adapterError);
        cases[index] = { id: item.id, profile: item.profile, decision: verdict.decision, code: verdict.code, escalated, identity, attempts,
          expected: item.expected, falseAccept, falseReject, unexpectedUnclear, verdict };
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, execute));
    const pass = metrics.falseAccepts <= manifest.gate.maxFalseAccepts && metrics.falseRejects <= manifest.gate.maxFalseRejects
      && metrics.unexpectedUnclear <= manifest.gate.maxUnexpectedUnclear && metrics.codeMismatches === 0 && metrics.adapterErrors === 0;
    const record = { setId: manifest.setId, fixtureHash: dependencyHash(fixtures), deps, passedAt: pass ? new Date().toISOString() : null, metrics };
    return { cases, metrics, pass, record };
  } finally { await rm(work, { recursive: true, force: true }); }
}
