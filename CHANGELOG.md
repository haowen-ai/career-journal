# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

All notable changes are documented here. This project follows Semantic Versioning.

## [Unreleased]

### Added

- None

### Changed

- None

### Fixed

- None

### Security

- None

## [0.1.0-alpha.6] - 2026-09-19

### Added

- Added `career-journal` as the primary CLI, repository Skill, launcher, package binary, and fresh-install identity
- Added upgrade coverage for legacy `.jobops` workspaces, `jobops-*` automations, and the `jobops` CLI alias
- Added a reproducible synthetic dashboard fixture and a SHA-256 manifest gate for the published product screenshot

### Changed

- Renamed the GitHub repository and canonical package metadata to CAREER JOURNAL and `career-journal`
- New workspaces now store configuration, data, artifacts, backups, and scheduler definitions under `.career-journal/`
- New workspaces use `career-journal-*`, `io.career-journal.*`, and `CareerJournal-*` scheduler identifiers; upgraded tasks retain their existing platform identities
- Replaced the product preview records with recognizable big-company examples, each visibly marked `Demo` with a `DEMO-*` identifier

### Fixed

- Added an explicit conflict error when both configurations exist, preventing a new workspace from silently shadowing a valid legacy workspace
- Preserved legacy automation IDs during reconfiguration so upgrades do not create duplicate scheduled tasks
- Kept the published `jobops-adapter.mjs` CareerOps bridge as a fallback while preferring `career-journal-adapter.mjs` for new setups

### Security

- Workspace conflict detection prevents writes from being split across two local data roots
- Existing loopback-only dashboard, credential-reference, and redacted-export boundaries remain unchanged
- README disclaimers and preview tests make clear that the example companies do not represent real applications, outcomes, affiliations, or endorsements

## [0.1.0-alpha.5] - 2026-09-19

### Added

- Added the bilingual CAREER JOURNAL dashboard with five application summaries, combined search and status filters, and expandable timelines and material records
- Added a privacy-filtered `/api/dashboard` snapshot that returns application details without artifact storage paths or raw event-source payloads
- Added a real browser screenshot generated from a temporary workspace containing only synthetic applications and materials
- Added locally bundled Tabler Icons 3.47.0 assets with the upstream MIT license and bilingual attribution
- Published bilingual dogfood evidence for the `v0.1.0-alpha.4` public tag

### Changed

- Renamed the public product to CAREER JOURNAL while retaining the existing `jobops` command for compatibility
- Changed the friendly local dashboard address to `http://career-journal.localhost:<port>`
- The dashboard now selects the browser language on first use, preserves an explicit English or Chinese choice, and sorts applications by the latest recorded activity
- Both READMEs now display the actual responsive application UI instead of an illustrated preview

### Fixed

- Replaced the separate minimal public dashboard with the same information hierarchy as the proven personal tracker: summary, search, filters, application facts, next-step guidance, event history, and material lifecycle
- Fixed the public interface gap that hid event and material history even though the local database already stored it

### Security

- Dashboard event sources are reduced to a controlled category before reaching the browser, and artifact storage paths remain private
- The committed product screenshot contains fictional companies, roles, dates, identifiers, events, and file names only
- The server remains loopback-only and accepts the exact `career-journal.localhost` Host and Origin in addition to standard loopback names

## [0.1.0-alpha.4] - 2026-09-19

### Added

- Added the reserved `job-search-ops.localhost` browser hostname without requiring DNS or hosts-file configuration
- Added integration coverage for the friendly dashboard URL, matching Origin hostname, and valid IPv6 loopback URL formatting
- Published bilingual dogfood evidence for the `v0.1.0-alpha.3` public tag

### Changed

- The default `jobops start` output and public onboarding now use `http://job-search-ops.localhost:<port>` instead of a raw loopback IP
- The product preview now displays the friendly local URL

### Fixed

- Replaced the developer-oriented `127.0.0.1` address in the new-user experience with a readable local product address

### Security

- The server continues to bind only to a loopback interface and accepts only the existing loopback hosts plus the exact `job-search-ops.localhost` Host and Origin

## [0.1.0-alpha.3] - 2026-09-19

### Added

- Added an interface preview with synthetic application data and accessible SVG metadata
- Added product, core-workflow, and intended-user sections in English and Simplified Chinese
- Added a release gate that enforces product-first README order and the presence of the interface preview
- Published bilingual dogfood evidence for the `v0.1.0-alpha.2` public tag

### Changed

- Reorganized both README home pages so visitors understand the product and see its interface before installation instructions

### Fixed

- Replaced the install-first landing experience with a product-oriented project introduction

### Security

- The public interface preview contains only synthetic companies, roles, dates, and statuses

## [0.1.0-alpha.2] - 2026-09-19

### Added

- Complete Simplified Chinese onboarding, attribution, CareerOps bridge, and built-in resume-rule documentation with English/Chinese navigation
- Opinionated reusable U.S. resume defaults derived from the project author's workflow, including the Education → Experience → Skills structure and final-PDF audit
- Configurable personal Skill or rule-file layering through `--material-rules`
- Published dogfood evidence for the `v0.1.0-alpha.1` public tag

### Changed

- First setup now documents and verifies computer time-zone detection; daily automations inherit the saved workspace time zone when no override is supplied
- CareerOps material requests now receive the built-in defaults followed by configured personal rule files
- Public contribution templates now provide English and Simplified Chinese prompts

### Fixed

- Removed the developer-specific Chicago time zone from new-user setup and automation examples
- Release checks now fail when paired bilingual public documentation or resume rules are missing

### Security

- Personal rules are stored as explicit file references; the public default contains no candidate contact details, education facts, or credentials

## [0.1.0-alpha.1] - 2026-09-19

### Added

- Local SQLite application, event, artifact, email, automation, and decision records
- Loopback dashboard and JSON API
- Read-only manual EML ingestion with deduplication and authentication-link redaction
- Portable daily task definitions and scheduler rendering for macOS, Linux, and Windows
- OpenAI-compatible structured provider, deterministic routing, and optional Jev shadow or active adapter
- Repo-local Job Search Ops and CareerOps material Skills
- Attribution, release checks, and tested onboarding documentation

### Changed

- None; this is the first public alpha

### Fixed

- Upgrade dogfood resolves the target revision before checking out the older source revision, so `HEAD` cannot drift to the old commit
- Failed or locked migrations no longer replace live SQLite files, preventing concurrent-write data loss
- Cross-origin, invalid-Host, and non-JSON local API mutations are rejected
- Automation runs no longer report success for unavailable handlers; local backup performs real work
- Email identity collisions detect changed content and decision/event writes are atomic
- Event command retries preserve ingestion timestamps and the documented aliases now work
- Repeated setup preserves the existing timezone unless a new timezone is supplied
- Doctor distinguishes configured and usable model, email, Jev, storage, and CareerOps capabilities
- Backups preserve safe environment-variable references while excluding secret values
- CareerOps material output must exist, match the application, and is archived with its verification state

### Security

- Credentials are referenced through environment variables and excluded from exports
- Submitted artifacts require explicit confirmation

[Unreleased]: https://github.com/haowenchen0811/career-journal/compare/v0.1.0-alpha.6...HEAD
[0.1.0-alpha.6]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.1
