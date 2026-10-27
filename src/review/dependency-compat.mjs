import { readFileSync } from 'node:fs';
import { dependencyHash, screeningPolicyParts } from './inputs.mjs';
import { JUDGMENT_SCHEMA_PATH } from './prompt.mjs';

// These two released file hashes rendered the same ordinary template. Map to
// its content hash, never to an arbitrary future template. Unknown hashes stay
// different. This is comparison only; cache provenance is never rewritten.
const LEGACY_PROMPTS = new Set([
  'sha256:a10fbb3d6e6e997880c5c90289d1877560e1d2844afb0a644d2599f584f53a07',
  'sha256:25ec4f1bd11d2a4dca62485f2c6a85be07d0e1b1b47ee8fcd7d14ad0ec219258',
]);
const NORMAL_TEMPLATE_HASH = 'sha256:bc31409ee86f2f4542c70d99f30b4aeec854c98c990fa4a67f2afd6e2d524625';
const LEGACY_CODE = new Set([
  'sha256:51b8e61ab92c09f72b59f2a82f5019de5117fac079b688765c15d985caa2e227',
  'sha256:51b415d03ca80c642e2c470c414a204b118d263329f8a1671ce99a10d038e136',
]);

export function dependencyComparison(db, inputs) {
  const jobType = inputs.profile?.search?.jobType ?? null;
  const inputPolicy = dependencyHash({ policy: screeningPolicyParts(inputs.policy), jobType });
  const judgmentPolicy = dependencyHash({ policy: screeningPolicyParts(inputs.policy), screeningPolicy: inputs.screeningPolicy,
    provenance: inputs.provenance, jobType });
  const inputPolicies = new Set();
  const judgmentPolicies = new Set();
  // Before P1, policy hashes included the judge configuration. Reconstruct
  // possible previous configurations from actual dispatch metadata. An exact
  // full-policy hash match proves that screening fields have not changed; a
  // missing witness remains a mismatch rather than guessing at old policy.
  const previous = db.prepare("SELECT DISTINCT runner,model,tier FROM attempts WHERE tier IN ('primary','escalation')").all();
  const choices = (tier) => {
    const current = inputs.policy.judge?.[tier];
    if (!current) return [undefined];
    const versions = [current, ...previous.filter((a) => a.tier === tier).map(({ runner, model }) => ({ ...current, runner, model }))];
    return [...new Map(versions.map((config) => [dependencyHash(config), config])).values()];
  };
  for (const primary of choices('primary')) for (const escalation of choices('escalation')) {
    const judge = { ...inputs.policy.judge, ...(primary && { primary }), ...(escalation && { escalation }) };
    const withoutOpinion = { ...judge }; delete withoutOpinion.secondOpinion;
    for (const config of [judge, withoutOpinion]) {
      const policy = inputs.policy.judge ? { ...inputs.policy, judge: config } : inputs.policy;
      inputPolicies.add(dependencyHash({ policy, jobType }));
      judgmentPolicies.add(dependencyHash({ policy, screeningPolicy: inputs.screeningPolicy, provenance: inputs.provenance, jobType }));
    }
  }
  const schemaText = readFileSync(JUDGMENT_SCHEMA_PATH, 'utf8');
  const rawSchema = dependencyHash(schemaText);
  const schema = dependencyHash(JSON.parse(schemaText));
  return {
    legacyCode: (hash) => LEGACY_CODE.has(hash),
    policyAlias: (hash) => judgmentPolicies.has(hash) ? judgmentPolicy : undefined,
    inputPolicyMatches: (previous, current) => previous === current || current === inputPolicy && inputPolicies.has(previous),
    parts(parts, current, { omit = [], policyAliases = {} } = {}) {
      return Object.fromEntries(Object.entries(parts ?? {}).filter(([key]) => !omit.includes(key)).map(([key, value]) => {
        if (key === 'prompt' && LEGACY_PROMPTS.has(value)) value = NORMAL_TEMPLATE_HASH;
        if (key === 'schema' && value === rawSchema) value = schema;
        if (key === 'policy') value = policyAliases[value] ?? (judgmentPolicies.has(value) ? judgmentPolicy : value);
        return [key, value];
      }));
    },
  };
}
