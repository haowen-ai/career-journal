import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ANSWERS_TARGET, hardRules, profileQuestions, profileRounds, questionByKey, questionsForRound,
} from '../../src/domain/profile-questions.mjs';
import {
  authorizationStatuses, defaultProfile, degreeLevels, directionIds, getProfileValue, jobTypes, notifyChannels,
  profileFields, setProfileValue, transcriptPolicies, validateProfile,
} from '../../src/domain/profile.mjs';

const chinese = /[\u4e00-\u9fff]/;
const types = new Set(['choice', 'multi-choice', 'boolean', 'confirm', 'text', 'month', 'path', 'url', 'locations', 'integer', 'time']);
const named = (value) => Boolean(value) && typeof value.en === 'string' && value.en.trim() !== '' && typeof value.zh === 'string' && value.zh.trim() !== '';
const bilingual = (value) => named(value) && chinese.test(value.zh);

test('every interview question is complete, bilingual, and points at a profile field or the answers sheet', () => {
  const keys = new Set();
  for (const question of profileQuestions) {
    assert.match(question.key, /^[a-z][a-z0-9-]*$/, question.key);
    assert.equal(keys.has(question.key), false, `duplicate key ${question.key}`);
    keys.add(question.key);
    assert.ok([1, 2, 3, 4].includes(question.round), question.key);
    assert.match(question.group, /^[a-z][a-z0-9-]*$/, question.key);
    assert.ok(named(question.label), `${question.key} label`);
    assert.ok(bilingual(question.prompts), `${question.key} prompts`);
    assert.ok(types.has(question.type), `${question.key} type ${question.type}`);
    assert.equal(typeof question.required, 'boolean', question.key);
    assert.equal(typeof question.allowOther, 'boolean', question.key);
    assert.ok(Array.isArray(question.options), question.key);
    for (const option of question.options) {
      assert.ok(Object.hasOwn(option, 'value'), question.key);
      assert.ok(named(option.label), `${question.key} option ${JSON.stringify(option.value)}`);
    }
    if (['choice', 'multi-choice', 'boolean', 'confirm'].includes(question.type)) assert.ok(question.options.length >= 2, question.key);
    if (question.target === ANSWERS_TARGET) assert.equal(question.round, 3, question.key);
    else {
      assert.notEqual(question.round, 3, question.key);
      assert.ok(profileFields.includes(question.target), `${question.key} target ${question.target}`);
    }
    assert.equal(questionByKey(question.key), question);
  }
  assert.equal(questionByKey('no-such-question'), null);
  assert.ok(Object.isFrozen(profileQuestions) && Object.isFrozen(profileQuestions[0].prompts) && Object.isFrozen(profileQuestions[0].options));
});

test('the four rounds cover the interview described in the 2.0 design', () => {
  assert.deepEqual(profileRounds.map((round) => [round.round, round.id]), [[1, 'search'], [2, 'materials'], [3, 'answers'], [4, 'pace']]);
  for (const round of profileRounds) {
    assert.ok(bilingual(round.title) && bilingual(round.intro), `round ${round.round}`);
    assert.ok(questionsForRound(round.round).length > 0, `round ${round.round}`);
  }
  const keysIn = (round) => questionsForRound(round).map((question) => question.key);
  assert.deepEqual(keysIn(1), ['job-type', 'season', 'directions-primary', 'directions-secondary', 'locations', 'remote-ok', 'degree-level', 'major', 'graduation', 'authorization-status', 'needs-sponsorship', 'exclusions']);
  assert.deepEqual(keysIn(2), ['resume-path', 'transcript-path', 'transcript-policy', 'linkedin', 'github', 'website', 'experience-confirmed']);
  for (const key of ['legal-name', 'preferred-name', 'email', 'phone', 'address', 'gender', 'race-ethnicity', 'veteran-status', 'disability-status',
    'languages', 'availability', 'full-time-availability', 'notice-period', 'salary-expectation', 'first-generation',
    'relatives-government', 'relatives-at-company', 'non-compete', 'certifications']) {
    assert.equal(questionByKey(key)?.round, 3, key);
  }
  assert.deepEqual(keysIn(4), ['batch-size', 'scan-time', 'notify']);
  assert.ok(questionsForRound(3).every((question) => question.target === ANSWERS_TARGET));
  assert.deepEqual(questionsForRound(3).filter((question) => question.required).map((question) => question.key), ['legal-name', 'email', 'phone', 'address']);
});

test('choice options use the profile vocabulary and every option value is accepted by validation', () => {
  const values = (key) => questionByKey(key).options.map((option) => option.value);
  assert.deepEqual(values('job-type'), [...jobTypes]);
  assert.deepEqual(values('directions-primary'), [...directionIds]);
  assert.deepEqual(values('directions-secondary'), [...directionIds]);
  assert.deepEqual(values('degree-level'), [...degreeLevels]);
  assert.deepEqual(values('authorization-status'), [...authorizationStatuses]);
  assert.deepEqual(values('transcript-policy'), [...transcriptPolicies]);
  assert.deepEqual(values('notify'), [...notifyChannels]);

  for (const question of profileQuestions.filter((item) => item.target !== ANSWERS_TARGET)) {
    for (const option of question.options) {
      let value = option.value;
      if (question.type === 'multi-choice') value = [option.value];
      if (question.type === 'locations') value = [option.value];
      const profile = setProfileValue(defaultProfile(), question.target, value);
      if (question.key === 'directions-secondary') profile.search.directions.primary = [];
      assert.deepEqual(validateProfile(profile), { ok: true, errors: [] }, `${question.key} ${JSON.stringify(option.value)}`);
    }
    if (question.default !== undefined) assert.deepEqual(getProfileValue(defaultProfile(), question.target), question.default, question.key);
    if (question.example !== undefined) {
      const profile = setProfileValue(defaultProfile(), question.target, question.example);
      assert.deepEqual(validateProfile(profile), { ok: true, errors: [] }, `${question.key} example`);
    }
  }
  for (const option of questionByKey('locations').options) {
    assert.ok(option.value.match.every((term) => term === term.toLowerCase()), option.value.label);
  }
});

test('free-text questions allow Other, and voluntary disclosures allow prefer not to say', () => {
  for (const question of profileQuestions) {
    if (['text', 'path', 'url', 'month', 'locations'].includes(question.type)) assert.equal(question.allowOther, true, question.key);
    if (question.target === ANSWERS_TARGET && question.options.length) assert.equal(question.allowOther, true, question.key);
  }
  for (const key of ['gender', 'race-ethnicity', 'veteran-status', 'disability-status', 'first-generation']) {
    assert.ok(questionByKey(key).options.some((option) => option.value === 'prefer-not-to-say'), key);
    assert.equal(questionByKey(key).required, false, key);
  }
  assert.match(questionByKey('transcript-path').prompts.en, /only when a site makes the transcript a required field/);
  assert.match(questionByKey('transcript-path').prompts.zh, /必填/);
  assert.match(questionByKey('experience-confirmed').prompts.en, /one bullet per line, each starting with "• "/);
  assert.match(questionByKey('salary-expectation').options[0].label.en, /posted range/);
});

test('round 4 shows the fixed hard rules in both languages', () => {
  assert.equal(hardRules.length, 6);
  for (const rule of hardRules) {
    assert.match(rule.id, /^never-[a-z-]+$/);
    assert.ok(rule.en.trim() && chinese.test(rule.zh), rule.id);
  }
  const english = hardRules.map((rule) => rule.en).join('\n');
  for (const pattern of [/final submit/i, /passwords or verification codes/i, /CAPTCHA/, /consent/i, /e-signature/i, /essays/i, /assessments/i, /personal data/i]) {
    assert.match(english, pattern);
  }
  assert.ok(Object.isFrozen(hardRules) && Object.isFrozen(hardRules[0]));
});

test('question data contains only placeholder personal details', async () => {
  const source = await readFile('src/domain/profile-questions.mjs', 'utf8');
  for (const email of source.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) assert.match(email, /@example\.com$/, email);
  for (const phone of source.match(/\+1[\s-]?\d{3}[\s-]?\d{3,4}(?:[\s-]?\d{4})?/g) ?? []) assert.match(phone, /^\+1 555 01\d\d$/, phone);
  assert.doesNotMatch(source, /\/Users\/|C:\\\\Users\\\\/);
  assert.equal(questionByKey('legal-name').example, 'Alex Example');
  assert.equal(questionByKey('email').example, 'alex@example.com');
  assert.equal(questionByKey('phone').example, '+1 555 0100');
});
