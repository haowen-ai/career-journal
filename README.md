# CAREER JOURNAL

[简体中文](README.zh-CN.md) · [Getting Started](docs/getting-started.md) · [Changelog](CHANGELOG.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

A local-first job-search workspace for people and AI agents. CAREER JOURNAL keeps applications, recruiting evidence, submitted materials, and next actions together without sending the database to a hosted service.

## One-line setup

Paste this one sentence into **Codex, Claude Code, Cursor, or another repository-aware coding Agent**:

```text
Get the latest version of CAREER JOURNAL from https://github.com/haowenchen0811/career-journal and set it up automatically; if an existing checkout is present, fast-forward it safely or use a fresh isolated clone, then read the latest AGENTS.md and complete onboarding.
```

The Agent handles cloning, setup, mailbox configuration, local time-zone detection, daily schedules, verification, and the first run. You only step in for an unavoidable login, authorization, or account choice. [Read the full setup guide →](docs/getting-started.md)

## Product preview

![English CAREER JOURNAL dashboard showing synthetic example applications](docs/assets/dashboard-preview.en.png)

*Real browser capture with synthetic big-company examples. Company names are illustrative and do not represent real applications, outcomes, affiliations, or endorsements. No personal data is included.*

## What it does

- Tracks each application, status change, deadline, interview, and next action
- Imports existing applications from a bounded mailbox review, files, spreadsheets, or a guided interview after the user confirms the proposed records
- Discovers signed-in mail accounts, then reads the one or more accounts the user selects in read-only mode
- Keeps generated drafts, verified files, and the exact submitted resume or cover letter distinct
- Runs locally with SQLite and a browser dashboard at `http://career-journal.localhost:<port>`
- Sends every recruiting email to the newly released **Jev** first when Jev is enabled, then falls back in order to a configured language model, local rules, and manual review when Jev is unavailable or cannot return a valid result

## Built for Agent workflows

The repository tells a compatible Agent how to configure the workspace from end to end. It supports Codex and Claude Code as well as other coding Agents that can read repository instructions and create scheduled jobs. Resume and cover-letter work can route through the independent [CareerOps](https://github.com/career-ops-hq/career-ops) project plus CAREER JOURNAL's built-in U.S. resume rules.

## Documentation

- [Getting started and Agent setup](docs/getting-started.md)
- [Email, automation, CLI, backup, and upgrade guide](docs/getting-started.md#email-integration)
- [CareerOps bridge](docs/integrations/careerops-bridge.md)
- [Product requirements](docs/superpowers/specs/2026-09-19-job-search-ops-prd-design.en.md)
- [Release history](CHANGELOG.md)

## Open source

CAREER JOURNAL is released under the [MIT License](LICENSE). Third-party projects and preserved license texts are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES](LICENSES).
