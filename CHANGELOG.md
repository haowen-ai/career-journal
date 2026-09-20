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

## [0.1.0-alpha.22] - 2026-09-19

### Added

- Added regression coverage proving that enabled Jev and configured structured-LLM providers evaluate recruiting emails before local rules

### Changed

- Jev now evaluates every recruiting email first when enabled; unusable Jev results fall back to the configured structured LLM, then local rules, and finally manual review
- Rewrote the public Chinese README with a DeepSeek editorial pass and simplified the Chinese onboarding guide and Skill copy for everyday readers

### Fixed

- Removed documentation and runtime behavior that could bypass Jev for emails already recognized by deterministic rules

### Security

- Jev credentials remain in the configured private secret store and are never added to Git, prompts, logs, exports, or backups

## [0.1.0-alpha.21] - 2026-09-19

### Added

- Added CI coverage that verifies Codex scheduler checks under an explicitly controlled host timezone

### Changed

- Scheduler verification now accepts the runtime host timezone as an explicit dependency for deterministic agent and test execution

### Fixed

- Fixed Codex scheduler tests that passed only when the test machine happened to use the configured task timezone

### Security

- None

## [0.1.0-alpha.20] - 2026-09-19

### Added

- Added regression coverage for host mail runs that try to reuse an earlier sync

### Changed

- Agent mail collection now reads the saved cursor first, uses an overlap window, paginates every result page, and imports every matching message before advancing the cursor

### Fixed

- Prevented `mail-sync` from reporting a successful daily check when the host mailbox had not been synchronized during the preceding 30 minutes
- Prevented same-day recruiting messages from being silently skipped when a host batch was built from an inferred or stale cursor

### Security

- The stricter mail gate remains read-only and stores no mailbox credentials or authentication links

## [0.1.0-alpha.19] - 2026-09-19

### Added

- Added macOS Keychain secret references for Jev in the form `keychain:SERVICE:ACCOUNT`

### Changed

- Agent-managed Jev setup can keep the TypeSafe key in Keychain instead of requiring a long-lived shell environment variable

### Fixed

- Closed the gap between the private local credential onboarding promise and the Jev adapter's environment-only implementation

### Security

- Keychain values are resolved only at request time and are never written to config, logs, prompts, exports, or backups

## [0.1.0-alpha.18] - 2026-09-19

### Added

- Added one optional Jev enablement offer after the core Agent onboarding gates pass `doctor`

### Changed

- Agent-managed onboarding keeps `host-agent` active unless the user chooses Jev or a configured Jev capability is already discoverable

### Fixed

- Fixed first-run guidance that silently skipped Jev for users who already have access

### Security

- Jev credentials must enter through a private local path; the Agent must never request an API key or secret in chat or an Agent prompt

## [0.1.0-alpha.17] - 2026-09-19

### Added

- Added support for registering `mail-sync` and `deadline-review` to one shared Codex heartbeat with exact 20:00 and 20:15 branches
- Added explicit Agent-hosted Apple Mail synchronization instructions using bounded `email sync-host` batches

### Changed

- Codex onboarding now creates one heartbeat with `BYMINUTE=0,15` and verifies both CAREER JOURNAL task bindings against the same saved definition

### Fixed

- Fixed onboarding failure when Codex allows only one heartbeat for the current task
- Fixed the incorrect assumption that Agent-managed Apple Mail requires a separate callable adapter

### Security

- Host email remains read-only, batch files stay in the private data workspace, and mailbox credentials are never stored

## [0.1.0-alpha.16] - 2026-09-19

### Added

- Added an Apple Mail inventory procedure that opens the main window, expands `All Inboxes`, enumerates every top-level account, and cross-checks Mail Settings > Accounts
- Added regression coverage that prevents a selected message's mailbox from being treated as the complete account inventory

### Changed

- Agent onboarding must show the complete discovered account list before asking which one or more accounts are used for job search

### Fixed

- Fixed Apple Mail discovery that could report only the account associated with the currently selected message

### Security

- Account-settings inspection is read-only and must not modify Mail configuration

## [0.1.0-alpha.15] - 2026-09-19

### Added

- Added a current-checkout gate to the one-line Agent setup flow so an existing stale clone is safely fast-forwarded or replaced with an isolated fresh clone
- Added release tests that reject Agent onboarding instructions which request IMAP connection details or external model credentials

### Changed

- Agent onboarding now attempts host mailbox discovery before asking any mailbox question and asks only which discovered account or accounts are used for job search
- Missing Jev now selects the current Agent automatically; Jev access, model endpoints, and model keys are no longer first-run questions in Agent mode

### Fixed

- Removed contradictory PRD requirements that sent Agent-managed users into the standalone IMAPS and OpenAI-compatible setup path

### Security

- Existing modified checkouts are left untouched; onboarding uses a fresh isolated clone instead of overwriting local work

## [0.1.0-alpha.14] - 2026-09-19

### Added

- Added Agent-native mailbox onboarding that discovers signed-in host accounts and supports one or more user-selected job-search mailboxes
- Added trusted-host mailbox verification and the credential-free `host-agent` semantic fallback

### Changed

- One `mail-sync` task now covers every selected mailbox while preserving legacy single-mailbox workspaces
- Agent-managed onboarding no longer asks for IMAP settings or an external model Base URL and API key when the host already provides those capabilities

### Fixed

- Fixed first-run instructions that treated Agent-managed and standalone CLI/API setup as the same flow
- Made `doctor` require fresh verification and a successful read-only sync for every selected mailbox

### Security

- Host mailbox proof stores only the connector, selected address, local account label, and verification time; credentials remain in the host mail integration

## [0.1.0-alpha.13] - 2026-09-19

### Added

- Added an optional post-setup history-import interview for existing applications
- Added bounded sources for history review: read-only mailbox evidence, files, spreadsheets, or a guided interview

### Changed

- Kept the public one-sentence README setup request unchanged while moving the history-import behavior into repository instructions and the CAREER JOURNAL Skill
- Required Agents to present deduplicated candidate records for confirmation before writing them

### Fixed

- Prevented onboarding Agents from silently skipping the question about existing application history
- Kept unknown application dates, statuses, rejection reasons, and submitted-material identities empty instead of inferring them

### Security

- Historical mailbox review remains read-only, user-bounded, and optional

## [0.1.0-alpha.12] - 2026-09-19

### Added

- Added paired English and Simplified Chinese Getting Started guides for email, automation, CLI, backup, upgrade, and troubleshooting details
- Added a fully English product screenshot and localized synthetic preview data for the English landing page

### Changed

- Rebuilt both READMEs as concise product landing pages with a one-sentence Agent setup request at the top
- Made the setup entry explicitly usable with Codex, Claude Code, Cursor, and other repository-aware coding Agents
- Moved operational instructions out of the product landing page and linked to the detailed bilingual guides

### Fixed

- Prevented the English product preview from showing Chinese interface or synthetic event text
- Removed the duplicate two-option onboarding flow from the public landing page

### Security

- The one-line Agent setup keeps credentials in environment variables or an external secret store and asks users only for unavoidable authentication or account choices

## [0.1.0-alpha.11] - 2026-09-19

### Added

- Added two alternative Agent-first onboarding entries to the README: share only the repository URL, or copy a complete setup prompt
- Added repository-level Agent instructions that cover CAREER JOURNAL setup, TypeSafe Skill installation, account handoff, automation registration, verification, and the first run

### Changed

- Reduced new-workspace onboarding to two required daily tasks: `mail-sync` at 20:00 and `deadline-review` at 20:15 in the computer's detected time zone
- Made the Agent responsible for cloning, configuration commands, scheduler setup, verification, and `doctor`, leaving the user only unavoidable login, authorization, and account choices

### Fixed

- Removed the unrelated daily consolidation and scheduled backup jobs from the default onboarding flow while preserving them for existing-workspace compatibility and on-demand use
- Updated setup, doctor, smoke tests, bilingual documentation, the PRD, and repository Skills to enforce the same two-task contract

### Security

- Kept mailbox passwords and Jev or LLM API keys out of prompts, configuration values, logs, and Git; onboarding uses environment-variable names or an external secret store

## [0.1.0-alpha.10] - 2026-09-19

### Added

- Added CLI setup options for an OpenAI-compatible decision provider, including base URL, model name, environment-only key reference, and confidence threshold
- Added runtime construction of the structured-LLM email classifier from the saved provider configuration

### Changed

- Made Jev the preferred semantic engine and the configured structured LLM the automatic fallback when Jev is missing, unavailable, shadowed, malformed, unknown, or below threshold
- Marked Jev as a newly released early-access integration, based on TypeSafe AI's September 15, 2026 announcement
- Updated the English README, Simplified Chinese README, PRD, repository Skill, and dependency contract to describe the same decision order

### Fixed

- Prevented a missing or failed Jev call from sending every ambiguous recruiting email directly to manual review when a valid structured model provider is available
- Kept manual review as the final fallback when neither decision provider returns a valid, confident classification

### Security

- Kept Jev and model API keys outside configuration, prompts, logs, and Git by accepting only `env:VARIABLE` references

## [0.1.0-alpha.9] - 2026-09-19

### Added

- None

### Changed

- Rewrote the Simplified Chinese README in natural mainland Chinese while preserving the documented commands, links, product behavior, and third-party attribution
- Replaced the opaque wording around the four daily jobs with their exact purposes, default times, and the external schedulers that actually execute them

### Fixed

- Clarified that setup stores task configuration only and that completed onboarding requires real scheduler definitions plus matching successful runs
- Replaced literal technical translations with plain explanations for mailbox evidence, external imports, Jev decisions, and CareerOps material validation
- Updated documentation tests to validate the required safety meaning without forcing the previous literal Chinese wording

### Security

- Kept passwords and API keys represented only by environment-variable names or placeholder references in public documentation

## [0.1.0-alpha.8] - 2026-09-19

### Added

- None

### Changed

- Updated the previous-version upgrade smoke to create a valid synthetic read-only mailbox configuration for alpha.6 and newer workspaces
- Made the upgrade gate discover and preserve either the current CAREER JOURNAL identity or a legacy Job Search Ops identity

### Fixed

- Fixed the alpha.6-to-current upgrade gate, which still passed the removed `--skip-email` option and failed before testing any migration
- Removed hard-coded `.jobops`, `jobops-local-backup`, and `jobops.db` assumptions from the cross-version smoke test

### Security

- The synthetic upgrade fixture stores only environment-variable references and never connects to a mailbox

## [0.1.0-alpha.7] - 2026-09-19

### Added

- Added `--jev-secret-ref env:VARIABLE` setup support so Jev access can be enabled without storing a literal API key
- Added contract tests for the TypeSafe v1 request and Choice response, malformed output, low confidence, missing credentials, transient overloads, and untrusted endpoints
- Added bilingual Jev onboarding and architecture guidance based on the official TypeSafe Agent Skill and current API documentation

### Changed

- Made Jev the primary semantic classifier for ambiguous recruiting messages while retaining deterministic rules for explicit cases
- Routed unavailable, shadow, malformed, or below-threshold Jev results to manual review instead of a generic LLM
- Centralized the recruiting-email Choice question and its criteria for review and calibration

### Fixed

- Replaced the obsolete `question` and `choices` payload with the v1 `state`, `model`, and `questions` contract
- Parsed `answers.classification.choice` and `confidence` instead of treating the answer object as a classification
- Added bounded retries for documented HTTP 429 and 529 responses while leaving authentication failures non-retriable

### Security

- Restricted Jev credentials to `env:VARIABLE` references and pinned credential-bearing requests to `https://api.typesafe.ai/v1/systemone`
- Kept literal API keys out of configuration, logs, examples, exports, backups, and Git

## [0.1.0-alpha.6] - 2026-09-19

### Added

- Added `career-journal` as the primary CLI, repository Skill, launcher, package binary, and fresh-install identity
- Added upgrade coverage for legacy `.jobops` workspaces, `jobops-*` automations, and the `jobops` CLI alias
- Added a reproducible synthetic dashboard fixture and a SHA-256 manifest gate for the published product screenshot
- Added bounded host-managed email batches with deterministic matching, deduplication, independent cursors, and retry-safe ingestion
- Added a built-in certificate-verified IMAPS client for live account verification and read-only `EXAMINE` / `BODY.PEEK[]` sync
- Added direct `email verify-imap` and `email sync-imap` commands
- Added live scheduler probes for Codex heartbeats, launchd, cron, and Windows Task Scheduler, plus matching external-run evidence for all four daily tasks
- Added paired English and Simplified Chinese orchestration Skills and product requirements, with release checks for both language contracts

### Changed

- Renamed the GitHub repository and canonical package metadata to CAREER JOURNAL and `career-journal`
- New workspaces now store configuration, data, artifacts, backups, and scheduler definitions under `.career-journal/`
- New workspaces use `career-journal-*`, `io.career-journal.*`, and `CareerJournal-*` scheduler identifiers; upgraded tasks retain their existing platform identities
- Replaced the product preview records with recognizable big-company examples, each visibly marked `Demo` with a `DEMO-*` identifier
- Completed onboarding now requires a user-selected read-only mailbox plus a successful sync and one matching successful run for all four daily tasks within 36 hours
- Manual EML import remains available as a one-off fallback but no longer satisfies daily mailbox health
- Re-running setup now preserves custom schedules, notification policies, enabled state, and valid registrations unless the user explicitly changes them
- Backups now retain an explicit artifact metadata index while omitting artifact payloads by default
- Email onboarding now passes only after live IMAPS verification and a successful read-only sync within the freshness window; host connector JSON remains import-only and self-attested

### Fixed

- Added an explicit conflict error when both configurations exist, preventing a new workspace from silently shadowing a valid legacy workspace
- Preserved legacy automation IDs during reconfiguration so upgrades do not create duplicate scheduled tasks
- Kept the published `jobops-adapter.mjs` CareerOps bridge as a fallback while preferring `career-journal-adapter.mjs` for new setups
- Doctor no longer treats an email address, manual EML import, or generated scheduler definition as proof of a working daily workflow
- Changing a mailbox connector or task schedule now invalidates the old verification until the sync or external registration succeeds again
- Rebinding `mail-sync` to a different mailbox now clears the old cursor and execution health, and onboarding status follows the currently bound mailbox
- Existing databases with pending migrations are reported without being modified by setup, doctor, or ordinary runtime commands
- Migration dry-runs now inspect existing databases read-only without changing their journal mode
- Host batches now reject stale cursors, out-of-order fetches, changed replays, account or connector mismatches, and scheduler ID mismatches
- IMAP pagination now consumes the oldest bounded UID page and advances only to the highest fetched UID, preventing permanent gaps when more than 200 messages match
- Host batch evidence, events, and both cursors now commit atomically, so a stale or competing batch leaves no partial writes
- Scheduler verification now rejects pending claims, mismatched commands, malformed cron marker blocks, and unverified external runs
- Codex, launchd, cron, and Windows probes now reject malformed or duplicate definitions, extra recurrence fields, extra triggers or actions, and schedules that do not run exactly once per day at the configured local time
- Launchd verification now checks the schedule and time zone loaded by `launchd` as well as the on-disk plist, preventing an edited but unreloaded file from satisfying the gate
- Windows task creation now uses correct command-line quoting, refuses to overwrite a task created during a race, and deletes only a task that CAREER JOURNAL successfully created before verification failed
- Caller-authored host batches can no longer target an IMAPS account or establish live mailbox health; only a successful direct TLS fetch can advance IMAP verification and sync state
- Direct mailbox synchronization no longer counts as an observed scheduler run; only `automation run` with the verified external ID can establish that evidence
- Windows scheduler discovery and failed-install rollback now fail closed when the query is ambiguous or cleanup cannot be confirmed
- Generated OS scheduler commands now carry the registered external ID; native `mail-sync` installation is blocked until a secure scheduler credential provider is available

### Security

- Workspace conflict detection prevents writes from being split across two local data roots
- Existing loopback-only dashboard, credential-reference, and redacted-export boundaries remain unchanged
- README disclaimers and preview tests make clear that the example companies do not represent real applications, outcomes, affiliations, or endorsements
- CAREER JOURNAL stores only the host connector label and normalized evidence; mailbox passwords, OAuth tokens, cookies, and connector credentials remain with the host
- Failed email batches keep both mailbox and task cursors unchanged, and input size limits bound the host-sync surface
- Host mailbox setup rejects credential references, account listings omit them, and backups remove mailbox verification, sync health, and scheduler attestations so restores must verify again
- Secret-free backups no longer copy arbitrary artifact files, which may contain credentials or other private payloads
- Public setup rejects reserved or example email domains, and IMAP credentials remain environment-variable references rather than config, export, heartbeat prompt, or backup values

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

[Unreleased]: https://github.com/haowenchen0811/career-journal/compare/v0.1.0-alpha.8...HEAD
[0.1.0-alpha.8]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.1
