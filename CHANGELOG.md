# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [Unreleased]

### Added

- Fresh-clone and upgrade findings will be recorded before the next release

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

### Security

- Credentials are referenced through environment variables and excluded from exports
- Submitted artifacts require explicit confirmation

[Unreleased]: https://github.com/OWNER/job-search-ops/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/OWNER/job-search-ops/releases/tag/v0.1.0-alpha.1
