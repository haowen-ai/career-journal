import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRelease } from '../../scripts/check-release.mjs';

test('release checker validates versions, bilingual docs, licenses, attribution, secrets, and local imports', async () => {
  const report = await checkRelease(process.cwd());
  assert.equal(report.ok, true, report.errors.join('\n'));
  for (const check of ['version-consistency', 'attribution', 'licenses', 'changelog', 'bilingual-docs', 'bilingual-core-contracts', 'product-readme', 'tracked-secrets', 'local-imports']) {
    assert.equal(report.checks.some((item) => item.id === check && item.ok), true, `missing ${check}`);
  }
});
