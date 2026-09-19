# Job Search Ops

[English](README.md) | [简体中文](README.zh-CN.md)

Job Search Ops is a local-first, evidence-driven application tracker for people and AI agents. It keeps roles, status events, recruiting email evidence, deadlines, and the exact material lifecycle in one SQLite database. A generated resume remains a draft until the exact uploaded file is confirmed.

This is an alpha release. Core tracking is usable without an email account, model key, CareerOps, or Jev access.

## What it does

- **Tracks every application:** company, role, current stage, dates, next actions, and a time-stamped event history
- **Separates facts from assumptions:** recruiting messages become review candidates before they can change an application status
- **Preserves the material lifecycle:** generated, verified, and actually submitted files remain distinct
- **Supports application materials:** combines CareerOps with built-in U.S. resume rules and optional personal rules
- **Runs locally:** stores records in SQLite and serves a loopback-only dashboard and JSON API
- **Prepares daily routines:** generates portable tasks for mail review, deadlines, consolidation, and backups in the computer's own time zone

## Product preview

![Job Search Ops dashboard showing example applications](docs/assets/dashboard-preview.svg)

*Synthetic example data. The dashboard runs locally on `127.0.0.1` and can be searched or filtered by application status.*

## Core workflows

### Track applications and decisions

Create a role, add evidence-backed events, record deadlines, and see the current stage without overwriting its history. Manual updates remain available even when no email or AI provider is configured.

### Review recruiting evidence

Read-only email evidence is attached to the relevant application and reviewed before it changes a status. Marketing mail is not treated as recruiting progress, and a received timestamp is not silently reused as an application date.

### Create and verify application materials

The CareerOps bridge can prepare a role-specific resume or cover letter. Job Search Ops records whether a file is a draft, passed its rules, or was confirmed as the exact submitted artifact.

### Run daily checks

Portable automation definitions support mail review, deadline review, daily consolidation, and local backups. Each task has its own cursor, advances only after success, and stays quiet when nothing actionable changed.

```mermaid
flowchart LR
    A[Job description] --> C[CareerOps material workflow]
    B[Candidate evidence and resume rules] --> C
    C --> D[Verified draft]
    D -->|User confirms upload| E[Submitted artifact]
    F[Read-only email or manual update] --> G[Review candidate]
    G -->|Evidence accepted| H[Application timeline]
```

## Who it is for

- **Codex users** who want a repository-aware Skill to configure and operate the workspace
- **API and CLI users** who want deterministic local workflows with an optional OpenAI-compatible model
- **Job seekers** who want application records, materials, and evidence together without handing their database to a hosted service

## Install

### Requirements

- Node.js 24 or newer
- Git for installation and updates
- Optional capabilities only when you use their workflows

### Quick Start

Clone and initialize a private local data directory:

```sh
git clone https://github.com/haowenchen0811/job-search-ops.git
cd job-search-ops
node ./bin/jobops.mjs setup --home "$HOME/job-search" --skip-email
node ./bin/jobops.mjs doctor --home "$HOME/job-search"
node ./bin/jobops.mjs start --home "$HOME/job-search"
```

Use `node ./bin/jobops.mjs ...` or the included `./jobops ...` launcher from the clone. To install the bare `jobops` command globally, run `npm link` with a Node.js installation that includes npm.

On first setup, Job Search Ops detects the computer's IANA time zone. Later setup runs preserve the saved value unless the user explicitly passes `--timezone <IANA-zone>`.

`--skip-email` is useful for a first trial. To use email evidence, configure an account explicitly; setup never assumes a school, work, or personal address:

```sh
node ./bin/jobops.mjs email configure --home "$HOME/job-search" --provider manual-eml --address candidate@example.com
```

The commands below are executed by the documentation test against a new temporary home:

<!-- quickstart-smoke:start -->
```sh
$REPO/bin/jobops.mjs setup --home $JOBOPS_HOME --timezone UTC --skip-email
$REPO/bin/jobops.mjs doctor --home $JOBOPS_HOME
$REPO/bin/jobops.mjs application add --home $JOBOPS_HOME --company ExampleCorp --role DataScientist
$REPO/bin/jobops.mjs event add --home $JOBOPS_HOME --id examplecorp-datascientist --event-id example-submit --type application_submitted --title Submitted --status-after applied
$REPO/bin/jobops.mjs application list --home $JOBOPS_HOME --json
$REPO/bin/jobops.mjs automation configure --home $JOBOPS_HOME --task daily-consolidation --time 22:00 --enabled
```
<!-- quickstart-smoke:end -->

## Two Runtime Modes

### Codex-native

Open the cloned repository in Codex and ask it to set up Job Search Ops. Codex discovers the repo-local `job-search-ops` Skill, runs `jobops doctor`, and routes resume or cover-letter work through the separate `careerops-materials` Skill. The Skills name every dependency and preserve the difference between status evidence and submitted-artifact evidence.

### Local API and OpenAI-compatible models

Run `jobops start --home <data-directory>` for the loopback dashboard and JSON API. Deterministic rules work without a model. An optional OpenAI-compatible provider can point to a hosted, local, or self-managed endpoint through `.jobops/config.json`; credentials must be environment-variable references such as `env:MODEL_API_KEY`, never literal secrets.

## Common Commands

```sh
jobops application add --home ~/job-search --company "Example" --role "Engineer"
jobops event add --home ~/job-search --id example-engineer --type application_submitted --title "Application submitted" --status-after applied
jobops email configure --home ~/job-search --provider manual-eml --address candidate@example.com
jobops email import-eml --home ~/job-search --account manual-eml:candidate@example.com --id example-engineer --file message.eml
jobops export json --home ~/job-search --output applications.json
jobops start --home ~/job-search
```

Email access is optional and read-only. Setup never invents or defaults to a personal, work, or school address. The alpha supports explicit manual EML import; future OAuth adapters must preserve the same read-only boundary.

## Application Materials and CareerOps

[career-ops](https://github.com/career-ops-hq/career-ops) is an independent MIT-licensed project by Santiago Fernández de Valderrama. It is optional for core tracking and required for a verified resume or cover-letter workflow.

1. Install the pinned CareerOps version listed in `config/dependency-manifest.yml`
2. Configure its root during setup: `jobops setup --home ~/job-search --careerops-root /path/to/career-ops`
3. Run `jobops doctor --home ~/job-search`
4. In Codex, use the `careerops-materials` Skill; API clients can call `jobops material prepare|verify --request request.json`

The alpha child-process adapter expects the configured CareerOps installation to expose the documented `jobops-adapter.mjs` JSON bridge. If the bridge or pinned version is missing, material verification stays unavailable and any fallback must remain an **Unverified Draft**.

### Built-in and personal resume rules

Job Search Ops ships the project author's reusable resume rules in [`config/material-rules/us-resume-default.md`](config/material-rules/us-resume-default.md). They add opinionated defaults that CareerOps does not impose: Education → Experience → Skills only, three bullets per employer, 11 point body text, no Projects or Summary, certification under Skills, concise achievement bullets, and a rule-by-rule final-PDF audit.

The built-in rules apply to U.S. English resumes and can be overridden by a user's explicit instruction. A user can also add a personal Skill or rule file without editing the repository:

```sh
jobops setup --home ~/job-search --material-rules /path/to/personal-resume-skill/SKILL.md
```

The `careerops-materials` Skill loads the built-in defaults and every configured personal rule file, then records any overrides in the artifact audit. Resume-only rules never apply automatically to cover-letter prose.

## Email and Decision Providers

- **No email configured:** tracking, dashboard, exports, and manual updates still work
- **Read-only email:** store only provider/address metadata and secret references; importing an email creates a review candidate and never changes final status by itself
- **OpenAI-compatible provider:** optional structured fallback configured with base URL, model, and an environment-variable secret reference
- **Jev:** optional TypeSafe decision adapter. Keep `accessState: waitlisted` or `unavailable` until access exists; do not add a key you do not have. In shadow mode its decision is recorded but not applied. Rules and structured-model fallbacks remain available

## Daily Automations

Four portable tasks are included: `mail-sync`, `deadline-review`, `daily-consolidation`, and `local-backup`.

```sh
jobops automation configure --home ~/job-search --task deadline-review --time 20:00 --enabled
jobops automation configure --home ~/job-search --task daily-consolidation --time 22:00 --enabled
jobops automation list --home ~/job-search
jobops automation run --home ~/job-search --task deadline-review --dry-run
jobops automation install --home ~/job-search --task deadline-review
```

When `--timezone` is omitted, automation uses the workspace time zone detected during setup. `install` prepares a platform-specific scheduler definition under `.jobops/schedulers/`; it does not register it with the operating system. Review it, then load it with `launchctl` on macOS, `crontab` on Linux, or `schtasks` on Windows. Each task keeps its own cursor, advances it only after success, and stays quiet when nothing actionable changed. In this alpha, `local-backup` has an executable handler; tasks whose adapters are unavailable fail visibly and do not record a successful run.

If you manually registered a definition, remove the OS registration before deleting its file:

```sh
# macOS: use the exact plist path you loaded
launchctl bootout "gui/$(id -u)" "/path/to/io.job-search-ops.deadline-review.plist"
# Linux: remove the exact jobops-deadline-review line from the current crontab
crontab -l | grep -v 'jobops-deadline-review' | crontab -
# Windows
schtasks /Delete /TN "JobSearchOps-deadline-review" /F
```

Then run `jobops automation uninstall --home ~/job-search --task deadline-review` to remove the prepared definition. Its result deliberately distinguishes definition removal from OS scheduler removal.

## Data and Privacy

Data stays under the home you choose. `.jobops/` contains configuration, SQLite data, immutable artifact copies, and prepared scheduler files. Exports omit secret references. Authentication links from imported mail are redacted. The project does not submit applications, send email, or contact recruiters.

## Update, Migration, Backup, and Uninstall

```sh
jobops update --check
jobops backup create --home ~/job-search --output ~/job-search-backup
jobops migrate --home ~/job-search --dry-run
jobops migrate --home ~/job-search --apply
```

Back up before an upgrade, pull a tagged release, run `jobops update --check`, and apply only the reported migration. To uninstall, run `jobops automation uninstall` for each installed task, preserve or export the selected data home, then delete the cloned repository. Delete the data home only when you also want to remove all local records and archived artifacts.

## Architecture

- `src/domain` owns application, event, status, and artifact rules
- `src/storage` owns versioned SQLite migrations
- `src/email`, `src/providers`, and `src/integrations` isolate optional services
- `src/automation` renders portable task definitions
- `src/server` serves the loopback dashboard and API
- `.agents/skills` provides Codex orchestration without copying third-party workflows

## Development and Releases

```sh
node --test
node scripts/check-release.mjs
```

Versions follow SemVer. Every release updates `VERSION`, `package.json`, and `CHANGELOG.md`; alpha tags use `v0.1.0-alpha.N`. Fresh-clone and previous-version upgrade smoke tests are release gates.

Public user documentation must ship in both English and Simplified Chinese. The release checker fails when the paired onboarding, attribution, or integration documentation is missing.

## Acknowledgements

Job Search Ops integrates with and learns from third-party open-source work without claiming it as its own. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the preserved license texts in `LICENSES/`. The project name is distinct from the third-party career-ops trademark and does not imply endorsement.

## License

Job Search Ops is released under the MIT License. See [LICENSE](LICENSE).
