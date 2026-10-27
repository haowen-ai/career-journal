# Synthetic fixture origins

Every public fixture in this repository is invented. No line below describes a real employer, requisition, candidate
or mailbox. One line per fixture: path — invented origin.

## Shared test data

- `test-utils/funnel-v3-fixtures.mjs` — invented employers (Example Corp, Example Bank, Program Match Example …), postings, invented requisition ids and candidate facts for the funnel tests
- `test-utils/scan-fixtures.mjs` — loader and offline fetch stub for the files under `test/fixtures/scan/`

## Scan sources (`test/fixtures/scan/`)

- `scan/profile.json` — invented search profile (internship, New York and Seattle)
- `scan/greenhouse-examplecorp.json` — invented Greenhouse board for Example Corp, including two malformed rows
- `scan/lever-examplelabs.json` — invented Lever postings for Example Labs
- `scan/ashby-examplequant.json` — invented Ashby board for Example Quant, including one unlisted posting
- `scan/simplify-listings.json` — invented Simplify-format listings, including one inactive listing
- `scan/careerops-scan.json` — invented CareerOps scan output, including one role without a link

## Judge smoke set (`test/fixtures/judge-smoke/`)

- `judge-smoke/manifest.json` — synthetic smoke-set manifest (cases, expected decisions, gate)
- `judge-smoke/profiles/intern-summer` (profile `intern-summer`) — invented graduate student seeking a Summer 2027 internship
- `judge-smoke/profiles/coop` (profile `coop`) — invented undergraduate seeking a 2027 co-op
- `judge-smoke/profiles/newgrad` (profile `newgrad`) — invented recent graduate seeking a full-time role starting in 2027
- `judge-smoke/profiles/experienced` (profile `experienced`) — invented experienced data scientist seeking a full-time role starting in 2027
- `judge-smoke/cases/is-eligible` (case `is-eligible`) — invented summer internship that matches every fact
- `judge-smoke/cases/is-or-clause` (case `is-or-clause`) — invented internship whose OR requirement the candidate meets through Python
- `judge-smoke/cases/is-preferred-only` (case `is-preferred-only`) — invented internship where undergraduate standing is only preferred
- `judge-smoke/cases/is-confident-wrong` (case `is-confident-wrong`) — invented internship closed to graduate students in a required bullet
- `judge-smoke/cases/is-unknown-fact` (case `is-unknown-fact`) — invented internship requiring a certificate no fact covers
- `judge-smoke/cases/is-wrong-page` (case `is-wrong-page`) — invented page with the same title but a different requisition
- `judge-smoke/cases/is-incomplete-page` (case `is-incomplete-page`) — invented page that returned only a title line
- `judge-smoke/cases/co-eligible` (case `co-eligible`) — invented Chicago co-op that matches every fact
- `judge-smoke/cases/co-wrong-area` (case `co-wrong-area`) — invented co-op outside every policy area
- `judge-smoke/cases/co-confident-wrong` (case `co-confident-wrong`) — invented co-op requiring two prior rotations the candidate lacks
- `judge-smoke/cases/ng-eligible` (case `ng-eligible`) — invented new-grad analyst role that matches every fact
- `judge-smoke/cases/ng-or-clause` (case `ng-or-clause`) — invented new-grad role met through Tableau
- `judge-smoke/cases/ng-confident-wrong` (case `ng-confident-wrong`) — invented new-grad role requiring an active clearance the candidate lacks
- `judge-smoke/cases/ex-eligible` (case `ex-eligible`) — invented senior role that matches every fact
- `judge-smoke/cases/ex-preferred-only` (case `ex-preferred-only`) — invented senior role where a PhD is only preferred
- `judge-smoke/cases/ex-confident-wrong` (case `ex-confident-wrong`) — invented director role requiring ten years of leadership against six years of experience
- `judge-smoke/cases/ex-unknown-fact` (case `ex-unknown-fact`) — invented senior role requiring a language no fact covers
