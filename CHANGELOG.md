# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [Unreleased]

### Added

- Published dogfood evidence for the `v0.1.0-alpha.1` public tag, including fresh-clone, upgrade, review-fix, and release-gate results

### Changed

- None

### Fixed

- None

### Security

- None

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

[Unreleased]: https://github.com/haowenchen0811/job-search-ops/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/haowenchen0811/job-search-ops/releases/tag/v0.1.0-alpha.1
