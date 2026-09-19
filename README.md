# Job Search Ops

Job Search Ops is a local-first, evidence-driven application tracker for people and AI agents. It keeps roles, status events, recruiting email evidence, deadlines, and the exact material lifecycle in one SQLite database. A generated resume remains a draft until the exact uploaded file is confirmed.

This is an alpha release. Core tracking is usable without an email account, model key, CareerOps, or Jev access.

## Requirements

- Node.js 24 or newer
- Git for installation and updates
- Optional capabilities only when you use their workflows

## Quick Start

Clone and initialize a private local data directory:

```sh
git clone https://github.com/OWNER/job-search-ops.git
cd job-search-ops
node ./bin/jobops.mjs setup --home "$HOME/job-search" --timezone America/Chicago --skip-email
node ./bin/jobops.mjs doctor --home "$HOME/job-search"
node ./bin/jobops.mjs start --home "$HOME/job-search"
```

The commands below are executed by the documentation test against a new temporary home:

<!-- quickstart-smoke:start -->
```sh
$REPO/bin/jobops.mjs setup --home $JOBOPS_HOME --timezone UTC --skip-email
$REPO/bin/jobops.mjs doctor --home $JOBOPS_HOME
$REPO/bin/jobops.mjs application add --home $JOBOPS_HOME --company ExampleCorp --role DataScientist
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

## Email and Decision Providers

- **No email configured:** tracking, dashboard, exports, and manual updates still work
- **Read-only email:** store only provider/address metadata and secret references; importing an email creates a review candidate and never changes final status by itself
- **OpenAI-compatible provider:** optional structured fallback configured with base URL, model, and an environment-variable secret reference
- **Jev:** optional TypeSafe decision adapter. Keep `accessState: waitlisted` or `unavailable` until access exists; do not add a key you do not have. In shadow mode its decision is recorded but not applied. Rules and structured-model fallbacks remain available

## Daily Automations

Four portable tasks are included: `mail-sync`, `deadline-review`, `daily-consolidation`, and `local-backup`.

```sh
jobops automation configure --home ~/job-search --task deadline-review --time 20:00 --timezone America/Chicago --enabled
jobops automation configure --home ~/job-search --task daily-consolidation --time 22:00 --timezone America/Chicago --enabled
jobops automation list --home ~/job-search
jobops automation run --home ~/job-search --task deadline-review --dry-run
jobops automation install --home ~/job-search --task deadline-review
```

`install` writes a platform-specific scheduler definition under `.jobops/schedulers/`. Review it, then load it with `launchctl` on macOS, `crontab` on Linux, or `schtasks` on Windows. Each task keeps its own cursor, advances it only after success, and stays quiet when nothing actionable changed.

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

## Acknowledgements

Job Search Ops integrates with and learns from third-party open-source work without claiming it as its own. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the preserved license texts in `LICENSES/`. The project name is distinct from the third-party career-ops trademark and does not imply endorsement.

## License

Job Search Ops is released under the MIT License. See [LICENSE](LICENSE).
