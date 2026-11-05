import test from 'node:test';
import assert from 'node:assert/strict';
import { autoReopenAllowed } from '../../src/review/reopen-policy.mjs';

test('open reviews and queued eligible roles may be re-judged; settled history may not', () => {
  for (const state of ['due', 'held', 'leased', 'failed']) assert.equal(autoReopenAllowed({ review: { state } }), true);
  assert.equal(autoReopenAllowed({ review: { state: 'done', decision: 'eligible' }, application: { status: 'lead' } }), true);
  assert.equal(autoReopenAllowed({ review: { state: 'done', decision: 'eligible' }, application: { status: 'withdrawn' } }), false);
  assert.equal(autoReopenAllowed({ review: { state: 'done', decision: 'eligible' }, application: { status: 'applied' } }), false);
  for (const decision of ['not_eligible', 'unclear', 'dropped', 'reused']) assert.equal(autoReopenAllowed({ review: { state: 'done', decision } }), false);
  assert.equal(autoReopenAllowed({}), true);
});

test('only the named authorizations lift the rule', () => {
  const settled = { review: { state: 'done', decision: 'not_eligible' } };
  for (const authorization of ['rejudge', 'cap_release', 'relist']) assert.equal(autoReopenAllowed({ ...settled, authorization }), true);
  assert.equal(autoReopenAllowed({ ...settled, authorization: 'anything-else' }), false);
});
