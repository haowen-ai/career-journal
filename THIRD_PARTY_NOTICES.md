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

## Tabler Icons

- Project: [tabler/tabler-icons](https://github.com/tabler/tabler-icons)
- Author and maintainer: Paweł Kuna and contributors
- Version: 3.47.0
- License: MIT; preserved in `LICENSES/tabler-icons-MIT.txt`
- Use here: the dashboard's local arrow, clock, search, language, expand, and collapse SVG icons

The selected icons are stored locally so the dashboard remains usable without a CDN connection.

## Job-posting sources for role scans

CAREER JOURNAL 2.0 role scans read job postings only on the user's machine, at scan time, for the user's own search. The project bundles no job-posting data, keeps none in the repository, and redistributes none.

- **Official ATS job-board APIs (default):** the public job-board endpoints that Greenhouse, Lever, and Ashby publish for each employer's postings. Scans read only the boards of companies the user lists. These vendors are not affiliated with this project and do not endorse it
- **SimplifyJobs lists (opt-in):** the public internship and new-grad lists published by [SimplifyJobs](https://github.com/SimplifyJobs). They carry no open-source licence, so the source stays off until the user enables it and configures the list URL. When enabled, the list is read live on the user's machine; nothing from it is bundled, cached in the repository, or redistributed, and only the normalised leads the user keeps are stored in the user's own database
- **CareerOps portal scans (opt-in):** run through the existing CareerOps integration described above, under its MIT licence and attribution
