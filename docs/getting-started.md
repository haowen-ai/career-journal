# Getting Started

[Product overview](../README.md) | [简体中文](getting-started.zh-CN.md)

## Requirements

- Node.js 24 or newer
- Git for installation and updates
- A real read-only mailbox connection. Agent-managed setup can use accounts already signed in to the host mail app; standalone setup can use IMAPS over TLS
- An AI Agent or scheduler that can create the two required schedules
- The user's choice of which discovered account or accounts are used for job search

## One-line Agent setup

Paste this one sentence into Codex, Claude Code, Cursor, or another repository-aware coding Agent:

```text
Get the latest version of CAREER JOURNAL from https://github.com/haowen-ai/career-journal and set it up automatically; if an existing checkout is present, fast-forward it safely or use a fresh isolated clone, then read the latest AGENTS.md and complete onboarding.
```

The Agent first obtains a current checkout, then reads [`AGENTS.md`](../AGENTS.md) and the repository Skill, detects the computer's IANA time zone, configures the selected read-only mailboxes, creates the two required schedules, verifies them, runs them once, and finishes with `doctor`. In Codex it uses one shared Codex heartbeat for both times. The Agent itself acts as the host mail connector: it reads every message received in each selected account during the previous 24 hours without keyword prefiltering, generates a bounded read-only host sync batch, and imports it with `email sync-host`; it does not wait for a separate Apple Mail adapter. It then asks the user whether they want to import existing applications. The user only handles an unavoidable login, authorization, account choice, or confirmation of proposed history records.

On macOS, the Agent attempts discovery before asking any mailbox setup question. In Apple Mail it raises the main Mail window, shows the sidebar, expands `All Inboxes`, and enumerates every top-level account; the selected message's mailbox is not the complete account inventory. When labels hide addresses, it reads Mail Settings > Accounts without changing settings. If the account counts disagree, it must not report discovery complete. The Agent then asks only which one or more discovered accounts the user uses for job search. If none are accessible, it asks the user to sign in to Apple Mail or another supported mail app and then resumes. Jev does not block core setup: reuse an already configured Jev capability when present; otherwise use the current coding Agent. After core onboarding passes `doctor`, the Agent makes one optional Jev offer and asks whether the user wants to enable Jev now. If the user declines, skips it, or has no access, `host-agent` remains active. If the user chooses Jev, the Agent helps with the official TypeSafe console and Skill, but never asks the user to paste, send, or provide an API key or secret in chat or an Agent prompt. On macOS, the Agent stores a newly created key in Keychain and passes only `keychain:career-journal-typesafe:<local-account>` to CAREER JOURNAL. IMAPS and external model credentials belong only to the standalone CLI/API path below.

### Optional history import

After technical onboarding passes, the Agent asks the user whether they want to import existing applications. The user may choose a bounded read-only mailbox review, a file or spreadsheet, a short guided interview, or skip the step. The Agent prepares candidate records and asks the user to confirm them before writing. It does not infer missing dates, statuses, rejection reasons, or submitted materials, and it does not treat an old draft as the file actually submitted.

## Standalone CLI and API-host setup

Set the mailbox values to the real account you use for applications. Keep the app password or provider-issued credential in a protected environment or secret store; setup saves only its `env:VARIABLE` reference:

```sh
export CAREER_JOURNAL_HOME="$HOME/job-search"
export JOB_EMAIL="your-real-address"
export IMAP_HOST="your-provider-imaps-host"
export IMAP_USER="$JOB_EMAIL"
# Make CAREER_JOURNAL_IMAP_PASSWORD and TYPESAFE_API_KEY available through a protected environment or secret store.
# Setup stores only their env: references.
node ./bin/career-journal.mjs setup \
  --home "$CAREER_JOURNAL_HOME" \
  --email-provider imap \
  --email-address "$JOB_EMAIL" \
  --imap-host "$IMAP_HOST" \
  --imap-user "$IMAP_USER" \
  --secret-ref env:CAREER_JOURNAL_IMAP_PASSWORD \
  --jev-secret-ref env:TYPESAFE_API_KEY
node ./bin/career-journal.mjs email verify-imap \
  --home "$CAREER_JOURNAL_HOME" \
  --account "imap:$JOB_EMAIL"
```

On macOS, Jev can instead use a Keychain reference, such as `--jev-secret-ref keychain:career-journal-typesafe:$USER`. The key itself stays in Keychain and is never written to configuration, logs, prompts, exports, or backups.

If you do not have Jev access, omit `--jev-secret-ref` and configure the default structured-LLM path instead. The secret stays in the environment:

```sh
node ./bin/career-journal.mjs setup \
  --home "$CAREER_JOURNAL_HOME" \
  --model-provider openai-compatible \
  --model-base-url "$MODEL_BASE_URL" \
  --model-name "$MODEL_NAME" \
  --model-secret-ref env:MODEL_API_KEY
```

Setup detects the computer's IANA time zone and provisions these enabled task records in that zone:

| Local time | Task | Purpose |
|---|---|---|
| 20:00 | `mail-sync` | Verify and read the selected mailbox over TLS, then ingest recruiting updates |
| 20:15 | `deadline-review` | Review applications in assessment, interview, or offer stages |

The database records above do not wake the process. The commands below are the Codex path; native and other external schedulers are documented under Daily Automations. A Codex task supports one heartbeat, so create one shared Codex heartbeat with `FREQ=DAILY;BYHOUR=20;BYMINUTE=0,15;BYSECOND=0`. Its prompt branches on local time: 20:00 performs the read-only host mailbox sync and then runs `mail-sync`; 20:15 runs `deadline-review`, retrying mail first when that day's sync did not succeed. Register the same real automation ID to both task records:

```sh
node ./bin/career-journal.mjs automation register-external --home "$CAREER_JOURNAL_HOME" --task mail-sync --driver codex --external-id "$DAILY_AUTOMATION_ID"
node ./bin/career-journal.mjs automation register-external --home "$CAREER_JOURNAL_HOME" --task deadline-review --driver codex --external-id "$DAILY_AUTOMATION_ID"
```

Each registration prints one `codexCommandLine`. Put both strings verbatim on separate lines in the shared heartbeat prompt and state the detected IANA time zone. The Agent itself is the host connector: before the mail command it must read the complete rolling previous 24 hours for every selected account without keyword prefiltering, write one private read-only host sync batch per account, and call `email sync-host`. Then probe the same saved heartbeat against both task records and trigger each command once:

```sh
node ./bin/career-journal.mjs automation verify --home "$CAREER_JOURNAL_HOME" --task mail-sync
node ./bin/career-journal.mjs automation verify --home "$CAREER_JOURNAL_HOME" --task deadline-review
node ./bin/career-journal.mjs automation run --id career-journal-mail-sync --home "$CAREER_JOURNAL_HOME" --external-id "$DAILY_AUTOMATION_ID"
node ./bin/career-journal.mjs automation run --id career-journal-deadline-review --home "$CAREER_JOURNAL_HOME" --external-id "$DAILY_AUTOMATION_ID"
node ./bin/career-journal.mjs doctor --home "$CAREER_JOURNAL_HOME"
node ./bin/career-journal.mjs start --home "$CAREER_JOURNAL_HOME"
```

The IMAPS mail handler authenticates, opens the mailbox with `EXAMINE`, fetches with `BODY.PEEK[]`, and advances its UID cursor only after the local import commits. Agent-managed host accounts use trusted-host verification after the Agent has observed the matching signed-in account. An empty mailbox is a valid successful run. Onboarding is complete only when `doctor` reports PASS for every selected mailbox and both automations within the last 36 hours.

Use `node ./bin/career-journal.mjs ...` or the included `./career-journal ...` launcher from the clone. To install the bare `career-journal` command globally, run `npm link` with a Node.js installation that includes npm.

The dashboard opens at `http://career-journal.localhost:<port>`. The reserved `.localhost` domain needs no purchased domain, DNS record, or hosts-file change. The server still binds only to the local loopback interface and is not exposed to the LAN.

The commands below are a synthetic contract smoke test. They verify CLI wiring and batch validation only; synthetic IDs and the fixture do not prove a live mailbox or scheduler, and this block intentionally does not claim that onboarding passed:

<!-- quickstart-smoke:start -->
```sh
$REPO/bin/career-journal.mjs setup --home $CAREER_JOURNAL_HOME --timezone UTC --email-provider host --email-address candidate@school.edu --email-connector test
$REPO/bin/career-journal.mjs automation register-external --home $CAREER_JOURNAL_HOME --task mail-sync --driver test --external-id smoke-mail-sync
$REPO/bin/career-journal.mjs automation register-external --home $CAREER_JOURNAL_HOME --task deadline-review --driver test --external-id smoke-deadline-review
$REPO/bin/career-journal.mjs email sync-host --home $CAREER_JOURNAL_HOME --account host:candidate@school.edu --file $REPO/docs/examples/initial-mail-sync.json --dry-run
$REPO/bin/career-journal.mjs application add --home $CAREER_JOURNAL_HOME --company ExampleCorp --role DataScientist
$REPO/bin/career-journal.mjs event add --home $CAREER_JOURNAL_HOME --id examplecorp-datascientist --event-id example-submit --type application_submitted --title Submitted --status-after applied
$REPO/bin/career-journal.mjs application list --home $CAREER_JOURNAL_HOME --json
```
<!-- quickstart-smoke:end -->

## Agent and API modes

### Agent-managed onboarding

Give the repository URL and one-line setup request to Codex, Claude Code, Cursor, or another repository-aware coding Agent. The Agent discovers signed-in mail accounts, asks which one or more are used for job search, and configures those accounts without asking for IMAP details. In Codex it creates one shared ACTIVE heartbeat containing both required times, binds the same scheduler ID to both exact commands, reads the saved definition, and runs both commands once. The Agent itself acts as the host mail connector and produces the bounded `email sync-host` input from every message received in the selected mailbox during the previous 24 hours. After core onboarding passes `doctor`, it offers optional Jev configuration once. If the user declines or has no access, `host-agent` remains active without another model credential. Resume and cover-letter work routes through the separate `careerops-materials` Skill.

### Local API and semantic decisions

Run `career-journal start --home <data-directory>` for the loopback dashboard and JSON API. The standalone path uses the built-in IMAPS client plus a scheduler that can securely expose named environment variables to `mail-sync`. `automation install` can install and probe `deadline-review` on macOS, Linux, or Windows; the current native installer refuses native installation of `mail-sync` because those generated definitions do not yet have a safe cross-platform secret provider. When Jev is enabled, every message in the rolling 24-hour batch goes to Jev first. If Jev is unavailable or cannot return a valid high-confidence decision, CAREER JOURNAL tries the configured structured LLM, then local rules, and finally manual review. Every result remains review evidence and never changes an application status by itself.

## Email Integration

The complete built-in path is `--email-provider imap`. It connects with certificate-verified TLS, authenticates using an `env:VARIABLE` credential reference, opens the mailbox read-only, fetches without setting the Seen flag, and uses `UIDVALIDITY` plus UID as its resumable cursor:

```sh
node ./bin/career-journal.mjs email verify-imap --home "$CAREER_JOURNAL_HOME" --account "imap:$JOB_EMAIL"
node ./bin/career-journal.mjs email sync-imap --home "$CAREER_JOURNAL_HOME" --account "imap:$JOB_EMAIL" --external-task-id "$MAIL_SYNC_ID"
```

The scheduled form uses the stable task ID: `automation run --id career-journal-mail-sync --home <absolute-home> --external-id <registered-id>`. It invokes the same direct IMAPS sync. Verification is refreshed on every real sync. The scheduler process must receive the environment variable named by `secret-ref`; the value remains outside CAREER JOURNAL and must never be placed in a heartbeat prompt or OS scheduler definition. Credentials are never returned by `email list`, written to batch files, or copied into a backup.

`--email-provider host` means Codex, an API client, or another host owns mailbox authentication and read-only fetching. CAREER JOURNAL stores the provider name, address, connector label, cursors, and normalized evidence. It does not store the mailbox password, OAuth token, session cookie, or connector credential. A batch alone remains self-attested. After the Agent has actually observed the matching account through the host integration, it records a short-lived trusted-host proof:

```sh
career-journal email verify-host --home ~/job-search --account host:candidate@example.com --connector apple-mail --address candidate@example.com --external-id local-mail-account-id
```

The external ID is a stable local account label, not a credential. `doctor` requires this proof and a successful read-only sync for every selected mailbox within 36 hours.

The host writes a bounded JSON batch and invokes the local importer:

```json
{
  "accountId": "host:candidate@example.com",
  "connector": "gmail",
  "readOnly": true,
  "beforeCursor": null,
  "afterCursor": "provider-cursor-after-this-page",
  "runId": "unique-provider-run-id",
  "fetchedAt": "2026-09-19T01:05:00Z",
  "coverage": {
    "mode": "rolling-24h-all-messages",
    "windowStart": "2026-09-18T01:05:00Z",
    "windowEnd": "2026-09-19T01:05:00Z",
    "allMessages": true,
    "paginationComplete": true
  },
  "externalTaskId": "the-registered-mail-sync-id",
  "messages": [
    {
      "sourceId": "provider-message-id",
      "from": "recruiting@example.com",
      "to": "candidate@example.com",
      "subject": "Application update",
      "sentAt": "2026-09-19T01:00:00Z",
      "body": "Message text",
      "applicationId": "optional-known-application-id"
    }
  ]
}
```

```sh
career-journal email sync-host --home ~/job-search --account host:candidate@example.com --file /private/path/mail-batch.json
```

`accountId`, `connector`, and `externalTaskId` must match the configured mailbox and current mail task registration. Read the current cursor from `email list` immediately before building the batch; `beforeCursor` must copy that saved value exactly. `afterCursor` is the provider cursor after this fetch, and `runId` must be unique for the fetch. The host must query by received time only for the complete rolling previous 24 hours. It must not prefilter by sender, company, role, subject, recruiting keywords, or known applications. It must paginate every result page, include every message, and deduplicate by provider message ID. The importer rejects a host batch unless its coverage envelope declares `rolling-24h-all-messages`, the actual window bounds, `allMessages: true`, and `paginationComplete: true`. Enabled Jev therefore receives each imported message before CAREER JOURNAL decides whether it is job-search related. Import the complete batch successfully before running the mail automation command. CAREER JOURNAL rejects stale, incomplete, or out-of-order batches, writes all message evidence and both cursors in one transaction, and leaves no partial traces when a competing or failed batch loses. The file in `docs/examples/initial-mail-sync.json` is synthetic test data, not proof of a real connector. A manual EML import is a one-off fallback for an individual message; it does not provide daily mailbox coverage and does not satisfy `doctor`:

```sh
career-journal email configure --home ~/job-search --provider manual-eml --address "$JOB_EMAIL"
career-journal email import-eml --home ~/job-search --account "manual-eml:$JOB_EMAIL" --id example-engineer --file message.eml
```

## Common Commands

```sh
career-journal application add --home ~/job-search --company "Example" --role "Engineer"
career-journal event add --home ~/job-search --id example-engineer --type application_submitted --title "Application submitted" --status-after applied
career-journal email list --home ~/job-search
career-journal automation list --home ~/job-search
career-journal export json --home ~/job-search --output applications.json
career-journal start --home ~/job-search
```

## Application Materials and CareerOps

[career-ops](https://github.com/career-ops-hq/career-ops) is an independent MIT-licensed project by Santiago Fernández de Valderrama. It is optional for core tracking and required for a verified resume or cover-letter workflow.

1. Install the pinned CareerOps version listed in `config/dependency-manifest.yml`
2. Configure its root during setup: `career-journal setup --home ~/job-search --careerops-root /path/to/career-ops`
3. Run `career-journal doctor --home ~/job-search`
4. In Codex, use the `careerops-materials` Skill; API clients can call `career-journal material prepare|verify --request request.json`

The child-process adapter expects the configured CareerOps installation to expose the documented `career-journal-adapter.mjs` JSON bridge. If the bridge or pinned version is missing, material verification stays unavailable and any fallback must remain an **Unverified Draft**.

### Built-in and personal resume rules

CAREER JOURNAL ships the project author's reusable resume rules in [`config/material-rules/us-resume-default.md`](../config/material-rules/us-resume-default.md). They add opinionated defaults that CareerOps does not impose: Education → Experience → Skills only, three bullets per employer, 11 point body text, no Projects or Summary, certification under Skills, concise achievement bullets, and a rule-by-rule final-PDF audit.

The built-in rules apply to U.S. English resumes and can be overridden by a user's explicit instruction. A user can also add a personal Skill or rule file without editing the repository:

```sh
career-journal setup --home ~/job-search --material-rules /path/to/personal-resume-skill/SKILL.md
```

The `careerops-materials` Skill loads the built-in defaults and every configured personal rule file, then records any overrides in the artifact audit. Resume-only rules never apply automatically to cover-letter prose.

## Decision Providers

- **Jev first:** The newly released Jev entered TypeSafe AI early access on September 15, 2026. Once enabled, every message in the complete rolling 24-hour batch goes to Jev before CAREER JOURNAL decides whether it is recruiting-related. Configure access with `--jev-secret-ref env:TYPESAFE_API_KEY`; the v1 adapter sends `state` plus one typed Choice question and validates the returned choice and confidence
- **Structured LLM fallback:** used when Jev is unavailable, errors, or returns an invalid or low-confidence result. Standalone CLI/API mode can configure it with `--model-provider openai-compatible --model-base-url <url> --model-name <model> --model-secret-ref env:MODEL_API_KEY`
- **Local-rule fallback:** used after semantic providers are unavailable or fail, for explicit cases the application can verify directly
- **Manual review:** used only when the earlier paths cannot return a reliable decision

After the key exists in the environment, run `npm run test:jev-live` for an explicit three-request contract and classification smoke test. It reports classifications, confidence, and token usage without printing the key. This live test is never part of the ordinary offline test suite or daily automation, so it cannot spend credit silently.

## Daily Automations

Setup provisions only `mail-sync` at 20:00 and `deadline-review` at 20:15 in the detected computer time zone. These defaults can be changed explicitly during setup or with `automation configure`. `daily-consolidation` is retained only for upgrade compatibility, and `backup create` remains an optional on-demand command. Neither is created during new onboarding.

The scheduler that actually wakes the process lives outside CAREER JOURNAL. A Codex automation, service scheduler, or API host must create the required schedules. `register-external` records a pending claim after successful creation; it neither creates nor verifies a schedule. Do not register a placeholder ID. Codex uses one shared heartbeat for the required pair; native schedulers may use separate jobs.

- `mail-sync`: run `automation run --id career-journal-mail-sync --home <absolute-home> --external-id <registered-id>` in a host that securely supplies the configured IMAP environment variable
- `deadline-review`: run `automation run --id career-journal-deadline-review --home <absolute-home> --external-id <registered-id>`

Each task keeps its own cursor and records success only after its handler finishes. The mail cursor is not advanced after a partial or failed batch.

### Codex heartbeat registration

Create one shared heartbeat first and keep its automation ID. Register that same ID to `mail-sync` and `deadline-review` with driver `codex`; each command returns a `codexCommandLine` built from the absolute Node executable, repository CLI, data home, task ID, and external ID. Update the shared heartbeat so its prompt contains both returned strings **verbatim as standalone lines**, plus the detected IANA time zone and the local-time branch. Do not reconstruct or shorten either command. The Agent itself is the host connector and must generate and import each read-only host sync batch with `email sync-host` before the mail command. Run `automation verify` for both task records, then let the heartbeat invoke each exact line once. Verification reads `~/.codex/automations/<id>/automation.toml` and requires an ACTIVE daily heartbeat whose two times, time zone, commands, data home, and shared external ID match. A pending claim, screenshot, lookalike command, or direct run before verification does not pass this gate.

### Native schedulers

`automation install` installs and live-probes launchd on macOS, the current user's crontab on Linux, or Windows Task Scheduler. Native installation is available for `deadline-review`:

```sh
node ./bin/career-journal.mjs automation install --home "$CAREER_JOURNAL_HOME" --task deadline-review
node ./bin/career-journal.mjs automation list --home "$CAREER_JOURNAL_HOME"
```

Use the verified `registration.externalId` shown by `automation list` when triggering each task once. New installations use `io.career-journal.<task>` on macOS, `career-journal-<task>` on Linux, and `CareerJournal-<task>` on Windows. Native `mail-sync` installation is deliberately blocked for standalone credential-backed mail until a secure scheduler secret provider exists. Agent-managed host mail uses trusted-host verification after observing the real signed-in account. Run `doctor` only after every selected mailbox and both required tasks have current evidence.

If you manually registered a definition, remove the OS registration before deleting its file:

```sh
# macOS: use the exact plist path you loaded
launchctl bootout "gui/$(id -u)" "/path/to/io.career-journal.deadline-review.plist"
# Linux: remove the exact career-journal-deadline-review line from the current crontab
crontab -l | grep -v 'career-journal-deadline-review' | crontab -
# Windows
schtasks /Delete /TN "CareerJournal-deadline-review" /F
```

Then run `career-journal automation uninstall --home ~/job-search --task deadline-review` to remove the prepared definition. Its result deliberately distinguishes definition removal from OS scheduler removal.

## Data and Privacy

Data stays under the home you choose. `.career-journal/` contains configuration, SQLite data, immutable artifact copies, reports, backups, and prepared scheduler files. Exports omit secret references. Authentication links from imported mail are redacted. Keep temporary structured batches in a private path and delete them according to your local retention policy. The project does not submit applications, send email, or contact recruiters.

`backup create` writes the sanitized configuration, SQLite database, manifest, and `artifacts-index.json`. It deliberately omits artifact payloads because application files can contain credentials or other private content; preserve those originals separately in storage you control. The copied state also clears mailbox verification, sync execution health, and scheduler attestations, so a restored workspace must verify its mailbox and schedules again.

## Update, Migration, Backup, and Uninstall

```sh
career-journal update --check
career-journal backup create --home ~/job-search --output ~/job-search-backup
career-journal migrate --home ~/job-search --dry-run
career-journal migrate --home ~/job-search --apply
```

Back up before an upgrade, pull a tagged release, run `career-journal update --check`, and apply only the reported migration. The default backup preserves the artifact index and hashes, not the original files. To uninstall from Codex, remove the one shared heartbeat that carries both times; with an OS scheduler, remove the corresponding external jobs. Then run `career-journal automation uninstall` for prepared definitions, preserve or export the selected data home, and delete the cloned repository. Delete the data home only when you also want to remove all local records and archived artifacts.

### Compatibility with v0.1.0-alpha.5 and earlier

The legacy `jobops` CLI, `.jobops/` data directory, `jobops-adapter.mjs` bridge name, and related scheduler identifiers are recognized only to upgrade installations created by v0.1.0-alpha.5 or earlier. A legacy config that explicitly names `jobops-adapter.mjs` remains supported; a new config never falls back to that bridge automatically. New installations and integrations must use `career-journal`, `.career-journal/`, `career-journal-adapter.mjs`, and CAREER JOURNAL scheduler identifiers.

Legacy automation rows keep their existing `jobops-*`, `io.job-search-ops.*`, and `JobSearchOps-*` identities when definitions are regenerated, so installing an upgrade does not create a parallel OS task. Because scheduler definitions contain the clone's absolute path, unload the existing registration, run `career-journal automation install` after moving or renaming the clone, and reload the regenerated definition under the same legacy identity. On Linux, replace the existing `jobops-*` crontab line with the regenerated line. `automation uninstall` removes prepared legacy and current files but does not unload an OS registration.

## Architecture

- `src/domain` owns application, event, status, and artifact rules
- `src/storage` owns versioned SQLite migrations
- `src/email`, `src/providers`, and `src/integrations` isolate host-managed services
- `src/automation` stores schedules, probes real scheduler definitions, runs local handlers, and records verified registrations plus observed matching runs
- `src/server` serves the loopback dashboard and API
- `.agents/skills` provides Codex orchestration without copying third-party workflows

## Development and Releases

```sh
node --test
node scripts/check-release.mjs
```

Versions follow SemVer. Every release updates `VERSION`, `package.json`, and `CHANGELOG.md`; stable tags use `vMAJOR.MINOR.PATCH`, and prereleases add an `alpha`, `beta`, or `rc` identifier. Fresh-clone and previous-version upgrade smoke tests are release gates.

Public user documentation must ship in both English and Simplified Chinese. The release checker fails when the paired onboarding, attribution, or integration documentation is missing.

### Project reference documents

- Repository Skill: [English](../.agents/skills/career-journal/SKILL.md) · [简体中文](../.agents/skills/career-journal/SKILL.zh-CN.md)
- Product requirements: [English](superpowers/specs/2026-09-19-job-search-ops-prd-design.en.md) · [简体中文](superpowers/specs/2026-09-19-job-search-ops-prd-design.md)

## Acknowledgements

CAREER JOURNAL integrates with and learns from third-party open-source work without claiming it as its own. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the preserved license texts in `LICENSES/`. The project name is distinct from the third-party career-ops trademark and does not imply endorsement.

## License

CAREER JOURNAL is released under the MIT License. See [LICENSE](../LICENSE).
