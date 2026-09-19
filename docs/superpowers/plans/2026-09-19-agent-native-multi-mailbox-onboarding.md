# Agent-native multi-mailbox onboarding implementation plan

> Execute this plan inline with `superpowers:executing-plans` and verify every behavior through tests before release

**Goal:** Make CAREER JOURNAL onboarding ask Agent users only which discovered mailbox accounts they use for job search, support one or many selected accounts, and use the current Agent as the semantic fallback when Jev is unavailable

**Constraints:** Preserve read-only mail access, evidence gates, exact README one-line prompt, existing IMAPS support for standalone deployments, local-only secret handling, and backward compatibility with single-account workspaces

## Task 1: Lock the Agent onboarding contract with failing tests

- Add bilingual documentation tests for host account discovery, plural account selection, login guidance, and the absence of Base URL/API key requirements in Agent mode
- Add configuration tests for a credential-free `host-agent` model provider and multiple selected accounts
- Add registry tests for stable multi-account task bindings

## Task 2: Implement Agent-native provider and multi-account bindings

- Add `host-agent` to setup and doctor behavior
- Store selected mailbox IDs in the mail-sync task configuration while retaining the legacy primary account column
- Reset registrations and cursors when the selected mailbox set changes

## Task 3: Verify trusted host mailboxes and run all selected accounts

- Add explicit trusted-host mailbox verification based on an account observed through the host integration
- Allow host batches for every selected mailbox without cross-account cursor collisions
- Make mail-sync and doctor require fresh evidence for every selected mailbox

## Task 4: Rewrite bilingual onboarding and release documentation

- Update AGENTS, both skills, both Getting Started guides, README feature copy, PRD, and changelogs
- Explain Agent mode versus standalone CLI/API mode, optional Jev, current-Agent fallback, and multiple mailboxes
- Bump the prerelease version

## Task 5: Validate, review, publish, and test as a new user

- Run targeted tests, the complete suite, release checker, documentation links, diff checks, and secret scans
- Review the whole branch, merge to main, push the tag, and publish the GitHub prerelease
- Test a fresh clone by using the exact README one-line prompt contract and test the previous-version upgrade path

## Review focus

- Agent mode must never ask for an IMAP host, model Base URL, or extra model API key unless the user explicitly chooses standalone mode
- Selecting several mailboxes must not let one healthy mailbox hide a stale or unverified mailbox
- A self-attested host batch alone must not satisfy mailbox verification
- Existing single-account and IMAPS workspaces must continue to work
