import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTER_REASON_CODES,
  checkAuthorization,
  checkDegree,
  checkDirection,
  checkJobType,
  checkReturnOffer,
  checkSeason,
  filterRole,
  parseSeason,
  rankLocation,
} from '../../src/scan/filter.mjs';
import { normalizeScanProfile } from '../../src/scan/profile-input.mjs';

function profile(overrides = {}) {
  const base = {
    search: {
      jobType: 'internship',
      season: 'Summer 2027',
      directions: { primary: ['ai-ml', 'data-science', 'data-analytics'], secondary: ['quant'] },
      locations: [
        { label: 'New York, NY', match: ['new york', 'nyc', 'manhattan'] },
        { label: 'Seattle, WA', match: ['seattle'] },
      ],
      remoteOk: true,
      exclusions: ['no-return-offer'],
    },
    candidate: {
      degree: { level: 'masters', graduation: '2027-12' },
      authorization: { status: 'permanent-resident', needsSponsorship: false },
    },
  };
  return normalizeScanProfile({
    ...base,
    ...overrides,
    search: { ...base.search, ...overrides.search },
    candidate: {
      degree: { ...base.candidate.degree, ...overrides.candidate?.degree },
      authorization: { ...base.candidate.authorization, ...overrides.candidate?.authorization },
    },
  });
}

const role = (fields) => ({ source: 'test', sourceId: '1', company: 'Example Corp', title: 'Machine Learning Intern', locations: ['New York, NY'], url: 'https://example.com/jobs/1', description: '', ...fields });

test('every drop reason starts with a known code and reads as a sentence', () => {
  const dropped = [
    role({ title: 'Machine Learning Engineer' }),
    role({ title: 'Machine Learning Intern - Fall 2026' }),
    role({ title: 'Software Engineer Intern' }),
    role({ title: 'Machine Learning Intern (PhD)' }),
    role({ description: 'Open to rising juniors.' }),
    role({ description: 'Must be a U.S. citizen.' }),
    role({ description: 'An active TS/SCI clearance is required.' }),
    role({ description: 'There is no return offer for this program.' }),
    role({ locations: ['Austin, TX'] }),
  ];
  for (const item of dropped) {
    const result = filterRole(item, profile());
    assert.equal(result.keep, false, item.title);
    assert.ok(result.reasons.length > 0);
    for (const reason of result.reasons) {
      const code = reason.slice(0, reason.indexOf(':'));
      assert.ok(FILTER_REASON_CODES.includes(code), reason);
      assert.ok(reason.length > code.length + 20, `reason should explain itself: ${reason}`);
    }
  }
});

test('season matching reads the profile term from titles, listed terms, and internship sentences', () => {
  assert.deepEqual(parseSeason('Summer 2027'), { term: 'Summer', year: 2027 });
  assert.deepEqual(parseSeason('2027 summer internship'), { term: 'Summer', year: 2027 });
  const wanted = profile();
  assert.equal(checkSeason(role({ title: 'ML Intern, Summer 2027' }), wanted).ok, true);
  assert.equal(checkSeason(role({ title: "ML Intern - Summer '27" }), wanted).ok, true);
  assert.equal(checkSeason(role({ title: '2027 Summer ML Intern' }), wanted).ok, true);
  assert.equal(checkSeason(role({ title: 'ML Intern' }), wanted).ok, true, 'a title without a term is kept');
  assert.match(checkSeason(role({ title: 'ML Intern - Fall 2026' }), wanted).reason, /^season: title names Fall 2026; profile wants Summer 2027$/);
  assert.match(checkSeason(role({ title: 'ML Intern 2026' }), wanted).reason, /title names 2026/);
  assert.equal(checkSeason(role({ title: 'ML Intern 2026-2027' }), wanted).ok, true);
  assert.match(checkSeason(role({ title: 'ML Intern', terms: ['Fall 2026', 'Spring 2027'] }), wanted).reason, /listed for Fall 2026, Spring 2027/);
  assert.equal(checkSeason(role({ title: 'ML Intern', terms: ['Summer 2027'] }), wanted).ok, true);
  assert.match(checkSeason(role({ title: 'ML Intern', description: 'Join our Fall 2026 co-op program.' }), wanted).reason, /posting mentions only Fall 2026/);
  assert.equal(checkSeason(role({ title: 'ML Intern', description: 'Interviews take place in Fall 2026. The summer internship runs 12 weeks.' }), wanted).ok, true,
    'an interview date is not the internship term');
  assert.equal(checkSeason(role({ title: 'ML Intern - Fall 2026' }), profile({ search: { season: null } })).ok, true);
});

test('job type keeps internships for an internship search and drops them for a full-time search', () => {
  assert.equal(checkJobType(role({ title: 'Data Science Co-op' }), profile()).ok, true);
  assert.equal(checkJobType(role({ title: 'Machine Learning', categories: ['Intern'] }), profile()).ok, true);
  assert.match(checkJobType(role({ title: 'Staff Data Scientist' }), profile()).reason, /^job-type: "Staff Data Scientist" does not look like an internship/);
  assert.match(checkJobType(role({ title: 'Data Science Intern' }), profile({ search: { jobType: 'full-time' } })).reason, /is an internship; profile wants full-time/);
});

test('direction keyword maps match title or category per direction id', () => {
  const wanted = profile();
  assert.deepEqual(checkDirection(role({ title: 'Machine Learning Intern' }), wanted).matches.map((item) => item.id), ['ai-ml']);
  assert.deepEqual(checkDirection(role({ title: 'Intern', categories: ['Data Science'] }), wanted).matches, [{ id: 'data-science', where: 'category', term: 'data science' }]);
  assert.deepEqual(checkDirection(role({ title: 'Quantitative Trading Intern' }), wanted).matches.map((item) => item.id), ['quant']);
  assert.equal(checkDirection(role({ title: 'Email Intern' }), wanted).ok, false, '"ai" must match whole words only');
  assert.match(checkDirection(role({ title: 'Marketing Intern' }), wanted).reason,
    /^direction: title and categories match none of the profile directions \(AI \/ machine learning, data science, data analytics, quantitative research or trading\)$/);
  assert.equal(checkDirection(role({ title: 'Marketing Intern' }), profile({ search: { directions: { primary: ['ai-ml', 'other'] } } })).ok, true);
  assert.equal(checkDirection(role({ title: 'Backend Engineer Intern' }), profile({ search: { directions: { primary: ['software-engineering'] } } })).ok, true);
});

test('degree eligibility drops PhD-only and undergraduate-only roles for a masters candidate', () => {
  const masters = profile();
  assert.match(checkDegree(role({ title: 'Research Scientist Intern, PhD' }), masters).reason, /^degree-phd-only: title .* is for PhD students; profile degree is masters$/);
  assert.match(checkDegree(role({ description: 'Candidates must be currently enrolled in a Ph.D. program.' }), masters).reason, /^degree-phd-only: PhD-only wording/);
  assert.equal(checkDegree(role({ title: 'Research Intern (MS/PhD)' }), masters).ok, true);
  assert.equal(checkDegree(role({ description: "Currently pursuing a Master's or PhD in Computer Science." }), masters).ok, true);
  assert.match(checkDegree(role({ degrees: ['PhD'] }), masters).reason, /listed degrees are PhD/);

  for (const wording of [
    'Open to rising juniors only.',
    'You are a current sophomore or junior.',
    'Applicants must be current sophomores/juniors.',
    'This role is for undergraduate students only.',
    'Sophomores and juniors are encouraged to apply.',
  ]) {
    assert.match(checkDegree(role({ description: wording }), masters).reason ?? '', /^degree-undergrad-only: /, wording);
  }
  assert.match(checkDegree(role({ title: 'Analytics Intern (Undergraduate)' }), masters).reason, /is for undergraduates/);
  assert.equal(checkDegree(role({ description: "Rising seniors and master's students are eligible." }), masters).ok, true);
});

test('degree eligibility never drops a role just because it mentions a bachelor\'s degree', () => {
  for (const wording of [
    "Currently pursuing a Bachelor's degree in Statistics.",
    "Bachelor's degree required.",
    'Pursuing a B.S. in Computer Science or a related field.',
    "Must be enrolled in a bachelor's program at an accredited university.",
  ]) {
    assert.equal(checkDegree(role({ description: wording }), profile()).ok, true, wording);
  }
  assert.equal(checkDegree(role({ description: 'Open to rising juniors.' }), profile({ candidate: { degree: { level: 'bachelors' } } })).ok, true);
  assert.equal(checkDegree(role({ title: 'Research Intern, PhD' }), profile({ candidate: { degree: { level: 'phd' } } })).ok, true);
});

test('citizenship, clearance, export-control, and sponsorship requirements follow the profile authorization', () => {
  const resident = profile();
  const citizenship = checkAuthorization(role({ description: 'Must be a U.S. citizen.' }), resident);
  assert.match(citizenship.reasons[0], /^citizenship: requires US citizenship .*; profile authorization is permanent-resident$/);
  assert.match(checkAuthorization(role({ description: 'Ability to obtain a security clearance.' }), resident).reasons[0], /^clearance: /);
  assert.match(checkAuthorization(role({ description: 'Sponsorship: U.S. Citizenship is Required' }), resident).reasons[0], /^citizenship: /);
  assert.equal(checkAuthorization(role({ description: 'U.S. citizenship or permanent residency required.' }), resident).ok, true);
  assert.equal(checkAuthorization(role({ description: 'Applicants must be U.S. persons under ITAR export control rules.' }), resident).ok, true);
  assert.equal(checkAuthorization(role({ description: 'We consider applicants without regard to citizenship status.' }), resident).ok, true);
  assert.equal(checkAuthorization(role({ description: 'No security clearance required.' }), resident).ok, true);
  assert.equal(checkAuthorization(role({ description: 'Must be a U.S. citizen. Active Secret clearance required.' }), profile({ candidate: { authorization: { status: 'citizen' } } })).ok, true);

  const visa = profile({ candidate: { authorization: { status: 'visa', needsSponsorship: true } } });
  assert.match(checkAuthorization(role({ description: 'U.S. citizenship or permanent residency required.' }), visa).reasons[0], /^citizenship: /);
  assert.match(checkAuthorization(role({ description: 'Applicants must be a U.S. person.' }), visa).reasons[0], /^export-control: /);
  assert.match(checkAuthorization(role({ description: 'We are unable to sponsor visas for this role.' }), visa).reasons[0], /^sponsorship: /);
  assert.match(checkAuthorization(role({ description: 'Candidates must not require sponsorship now or in the future.' }), visa).reasons[0], /^sponsorship: /);
  assert.equal(checkAuthorization(role({ description: 'We are unable to sponsor visas for this role.' }), resident).ok, true);
});

test('explicit no-return-offer wording is dropped only when the profile excludes it', () => {
  const wanted = profile();
  assert.match(checkReturnOffer(role({ description: 'This internship does not lead to a full-time position.' }), wanted).reason, /^no-return-offer: /);
  assert.match(checkReturnOffer(role({ description: 'Interns are not eligible for return offers.' }), wanted).reason, /^no-return-offer: /);
  assert.equal(checkReturnOffer(role({ description: 'There is no guarantee of a return offer.' }), wanted).ok, true);
  assert.equal(checkReturnOffer(role({ description: 'Strong interns may receive a return offer.' }), wanted).ok, true);
  assert.equal(checkReturnOffer(role({ description: 'There is no return offer.' }), profile({ search: { exclusions: [] } })).ok, true);
});

test('location rank follows profile order, then remote when allowed, then broad locations', () => {
  const wanted = profile();
  assert.deepEqual(rankLocation(role({ locations: ['New York, NY'] }), wanted), { ok: true, locRank: 1, matched: 'New York, NY' });
  assert.equal(rankLocation(role({ locations: ['Seattle, WA', 'NYC'] }), wanted).locRank, 1, 'best office wins');
  assert.equal(rankLocation(role({ locations: ['Seattle, WA'] }), wanted).locRank, 2);
  assert.equal(rankLocation(role({ locations: ['Remote - US'] }), wanted).locRank, 3);
  assert.equal(rankLocation(role({ locations: ['Austin, TX'], remote: true }), wanted).locRank, 3);
  assert.equal(rankLocation(role({ locations: ['United States'] }), wanted).locRank, 4);
  assert.equal(rankLocation(role({ locations: [] }), wanted).locRank, null);
  assert.match(rankLocation(role({ locations: ['Austin, TX'] }), wanted).reason, /^location: Austin, TX matches none of the profile locations \(New York, NY, Seattle, WA\)$/);
  assert.match(rankLocation(role({ locations: ['Remote'] }), profile({ search: { remoteOk: false } })).reason, /^remote: remote role \(Remote\) and profile does not accept remote$/);
  assert.equal(rankLocation(role({ locations: ['Sunnyvale, CA'] }), profile({ search: { locations: [{ label: 'NY', match: ['ny'] }] } })).ok, false,
    'match terms are whole words');
});

test('filterRole aggregates every reason and returns the location rank for kept roles', () => {
  const kept = filterRole(role({ title: 'Machine Learning Intern, Summer 2027', locations: ['Seattle, WA'] }), profile());
  assert.deepEqual({ keep: kept.keep, reasons: kept.reasons, locRank: kept.locRank }, { keep: true, reasons: [], locRank: 2 });
  const dropped = filterRole(role({ title: 'Marketing Intern - Fall 2026', locations: ['Austin, TX'] }), profile());
  assert.deepEqual(dropped.codes, ['season', 'direction', 'location']);
});
