# Third-Party Notices

[English](THIRD_PARTY_NOTICES.md) | [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

CAREER JOURNAL preserves credit for the independent work it integrates with. Inclusion here does not imply endorsement by any listed project.

## career-ops

- Project: [career-ops](https://github.com/career-ops-hq/career-ops)
- Author and maintainer: Santiago Fernández de Valderrama and contributors
- License: MIT; preserved in `LICENSES/career-ops-MIT.txt`
- Use here: pinned optional integration, material-routing Skill, capability checks, and adapter contract
- Trademark: the career-ops name and brand are governed by its separate trademark policy. CAREER JOURNAL uses the name only to describe compatibility and attribution

No career-ops source code is copied into this repository. Users install it separately when they want its material workflow.

## TypeSafe Agent Skills and Jev

- Project: [typesafe-ai/skills](https://github.com/typesafe-ai/skills)
- Author: TypeSafe AI
- License: MIT; preserved in `LICENSES/typesafe-ai-skills-MIT.txt`
- Use here: agent guidance for the primary Jev semantic decision adapter when a user configures access; no access is assumed

No TypeSafe Agent Skill source code is copied into this repository. The tracker continues to work without Jev. When Jev is enabled, it evaluates every recruiting email first; configured language models, local rules, and manual review provide the fallback path.

## SimplifyJobs listings

- Project: [SimplifyJobs](https://github.com/SimplifyJobs) internship and new-grad lists
- License: none published
- Use here: an opt-in role-scan source only. It is off by default; the user turns it on and supplies the list URL in their own profile, and the list is fetched live on the user's machine at scan time

No SimplifyJobs data is bundled, cached in this repository, mirrored, or redistributed. Only the normalised leads the user keeps are stored, in the user's own local database.

## Greenhouse, Lever, and Ashby public job-board APIs

- Endpoints: `boards-api.greenhouse.io`, `api.lever.co`, and `api.ashbyhq.com` public job-board APIs
- Use here: read-only, unauthenticated requests for the company boards the user lists in their profile. Nothing is submitted to these services and no job data is redistributed
- Trademarks: Greenhouse, Lever, and Ashby are trademarks of their owners and are named only to describe compatibility

## Tabler Icons

- Project: [tabler/tabler-icons](https://github.com/tabler/tabler-icons)
- Author and maintainer: Paweł Kuna and contributors
- Version: 3.47.0
- License: MIT; preserved in `LICENSES/tabler-icons-MIT.txt`
- Use here: the dashboard's local arrow, clock, search, language, expand, and collapse SVG icons

The selected icons are stored locally so the dashboard remains usable without a CDN connection.
