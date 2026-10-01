# Getting Started

[Product overview](../README.md) | [简体中文](getting-started.zh-CN.md)

## Requirements

- Node.js 24 or newer
- Git for installation and updates
- A real read-only mailbox connection. Agent-managed setup can use accounts already signed in to the host mail app; standalone setup can use IMAPS over TLS
- An AI Agent or scheduler that can create the two required schedules
- The user's choice of which discovered account or accounts are used for job search
- For assisted applying only: a browser capability in the host Agent, such as Claude in Chrome or the Codex browser

## One-line Agent setup

Paste this one sentence into Codex, Claude Code, Cursor, or another repository-aware coding Agent:

```text
Get the latest version of CAREER JOURNAL from https://github.com/haowen-ai/career-journal and set it up automatically; if an existing checkout is present, fast-forward it safely or use a fresh isolated clone, then read the latest AGENTS.md and complete onboarding.
```

The Agent first obtains a current checkout, then reads [`AGENTS.md`](../AGENTS.md) and the repository Skill, detects the computer's IANA time zone, configures the selected read-only mailboxes, creates the two required schedules, verifies them, runs them once, and finishes with `doctor`. In Codex it uses one shared Codex heartbeat for both times; in Claude Code desktop it uses one shared scheduled task. The Agent itself acts as the host mail connector: it reads every message received in each selected account during the previous 24 hours without keyword prefiltering, generates a bounded read-only host sync batch, and imports it with `email sync-host`; it does not wait for a separate Apple Mail adapter. It then asks the user whether they want to import existing applications. The user only handles an unavoidable login, authorization, account choice, or confirmation of proposed history records.

On macOS, the Agent attempts discovery before asking any mailbox setup question. In Apple Mail it raises the main Mail window, shows the sidebar, expands `All Inboxes`, and enumerates every top-level account; the selected message's mailbox is not the complete account inventory. When labels hide addresses, it reads Mail Settings > Accounts without changing settings. If the account counts disagree, it must not report discovery complete. The Agent then asks only which one or more discovered accounts the user uses for job search. If none are accessible, it asks the user to sign in to Apple Mail or another supported mail app and then resumes. Jev does not block core setup: reuse an already configured Jev capability when present; otherwise use the current coding Agent. After core onboarding passes `doctor`, the Agent makes one optional Jev offer and asks whether the user wants to enable Jev now. If the user declines, skips it, or has no access, `host-agent` remains active. If the user chooses Jev, the Agent helps with the official TypeSafe console and Skill, but never asks the user to paste, send, or provide an API key or secret in chat or an Agent prompt. On macOS, the Agent stores a newly created key in Keychain and passes only `keychain:career-journal-typesafe:<local-account>` to CAREER JOURNAL. IMAPS and external model credentials belong only to the standalone CLI/API path below.

### Optional history import

After technical onboarding passes, the Agent asks the user whether they want to import existing applications. The user may choose a bounded read-only mailbox review, a file or spreadsheet, a short guided interview, or skip the step. The Agent prepares candidate records and asks the user to confirm them before writing. It does not infer missing dates, statuses, rejection reasons, or submitted materials, and it does not treat an old draft as the file actually submitted.

### Profile interview

After `doctor` passes and the Jev and history-import questions are answered or skipped, the Agent runs a short profile interview with `profile status`, `profile questions`, `profile set`, and `profile answer`. It asks at most 4 questions per round, each with options plus "Other", and every question can be skipped; a skipped question is asked the first time it is needed. Anything the resume already shows is pre-filled and only confirmed.

| Round | Asks about | Used for |
|---|---|---|
| 1 | Job type and season, primary and secondary directions, locations in order and remote, degree and graduation date, work authorization, hard exclusions | Which roles to scan and which to skip |
| 2 | The one resume to upload, an optional transcript, LinkedIn, GitHub, and website, and each education and work entry read from the resume | What to upload and enter |
| 3 | Common form answers: contact details, voluntary disclosures (each may be "prefer not to say"), languages, availability, salary wording, and similar | The user's own answers sheet |
| 4 | Batch size, daily scan time and notification, and the fixed hard rules | Pace; the hard rules are shown and cannot be turned off |

Core onboarding does not depend on the profile; assisted applying stays unavailable until rounds 1 and 2 are complete. When upgrading from 1.x, the Agent first infers what it can from existing applications, configuration, and the resume, asks the user to confirm every inferred value, and then asks only what is still missing.

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

Give the repository URL and one-line setup request to Codex, Claude Code, Cursor, or another repository-aware coding Agent. The Agent discovers signed-in mail accounts, asks which one or more are used for job search, and configures those accounts without asking for IMAP details. In Codex it creates one shared ACTIVE heartbeat containing both required times, binds the same scheduler ID to both exact commands, reads the saved definition, and runs both commands once. In Claude Code desktop it does the same with one shared scheduled task and the `claude-code` driver. The Agent itself acts as the host mail connector and produces the bounded `email sync-host` input from every message received in the selected mailbox during the previous 24 hours. After core onboarding passes `doctor`, it offers optional Jev configuration once. If the user declines or has no access, `host-agent` remains active without another model credential. Resume and cover-letter work routes through the separate `careerops-materials` Skill.

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
career-journal task add --home ~/job-search --id example-engineer --kind assessment --title "Online assessment" --platform "HackerRank" --due-at 2026-10-01T23:59:00-07:00 --link https://example.com/invite
career-journal task list --home ~/job-search --status open
career-journal email list --home ~/job-search
career-journal automation list --home ~/job-search
career-journal export json --home ~/job-search --output applications.json
career-journal profile status --home ~/job-search --json
career-journal profile answer --home ~/job-search --question "Preferred name" --answer "Alex" --source user
career-journal scan run --home ~/job-search --dry-run
career-journal queue list --home ~/job-search --json
career-journal start --home ~/job-search
```

### Profile and answers sheet

Scans and assisted applying read a private profile that the Agent builds through a short interview after `doctor` passes. `setup` creates nothing, and the CLI never prompts: the Agent reads the questions, asks them in your language, and saves each answer.

```sh
career-journal profile questions --json
career-journal profile questions --missing --json --home ~/job-search
career-journal profile set --home ~/job-search --key search.jobType --value internship
career-journal profile set --home ~/job-search --key search.locations --value '[{"label":"New York, NY","match":["new york","nyc"]}]'
career-journal profile set --home ~/job-search --key materials.resumePath --value ~/job-search/resume.pdf
career-journal profile answer --home ~/job-search --key legal-name --answer "Alex Example"
career-journal profile answer --home ~/job-search --question "How did you hear about us?" --answer "Company careers page"
career-journal profile status --json --home ~/job-search
career-journal profile show --home ~/job-search
```

- `profile questions` lists the four rounds (search target, materials, common form answers, pace) with English and Chinese prompts, options, whether each item is required, and where the answer is stored. `--round N` narrows to one round; `--missing` lists only required items that are still unanswered, marking the ones you skipped.
- `profile set` writes `.career-journal/profile/profile.json`, creating it on the first write. `--key` takes a dot-path such as `search.season` or a question key such as `season`; `--value` is JSON or plain text, and `--value null` clears an optional field. Every write is validated, and resume and transcript paths must be absolute (or start with `~/`) and point to a readable file.
- `profile answer` writes `.career-journal/profile/answers.md` with the source (default `user`) and date. With `--key`, a common form answer from round 3 keeps one row under "Common form answers" and is updated in place; with `--question`, the row is appended under "Learned while applying".
- `profile status` shows which rounds are complete and whether scans and applying are ready. `doctor` adds `profile` and `apply` lines as warnings: core onboarding passes without a profile, and `apply` stays `incomplete` until rounds 1 and 2 are complete and the resume file is readable.
- Both files are owner-only (`0600`, directory `0700`), stay on your computer, and never belong in a Git repository. Blank templates are in `config/profile.template.json` and `config/answers.template.md`.
## Profile, role scans, and assisted applying

### Where the profile lives

- `<home>/.career-journal/profile/profile.json` holds the structured answers from rounds 1, 2, and 4
- `<home>/.career-journal/profile/answers.md` holds form answers from round 3 and every new question answered while applying, appended under `## Learned while applying` with the date and source
- Resumes and transcripts are referenced by path, not copied. Profile files are private to the user (file mode `0600`, folder `0700`) and never belong in the repository

### Role scans

- `career-journal scan run --home ~/job-search --dry-run` previews a scan without writing; without `--dry-run`, kept roles are added as leads
- The default sources are the official public job-board APIs of Greenhouse, Lever, and Ashby for companies the user lists. CareerOps portal scans and the SimplifyJobs list are opt-in. SimplifyJobs publishes no licence, so it is read live on the user's machine at scan time and is never bundled, cached in the repository, or redistributed
- Filters come only from the profile. The same requisition ID, the same link, or a near-identical company and title count as one role, which is applied to once
- The Agent reads each new lead's official posting and records `queue verify --id <application> --result ok|skip --reason <text> [--deadline <iso>]`. Every skip has a reason. `queue list` shows the queue by fit, deadline, location rank, and posted date

### Assisted applying

When the user says "start applying", the Agent follows the [`career-journal-apply`](../.agents/skills/career-journal-apply/SKILL.md) Skill:

1. Take the top N verified roles (`pace.batchSize`, default 5) and drop any role already applied to
2. Give each role to its own sub-agent, which opens its own browser tab, fills the form from the answers sheet, uploads the resume the user chose, and stops before submit
3. Tab titles show what each tab needs: 🔑 sign in or code, 🤖 CAPTCHA, ❓ question, 👆 click, ✅ ready to submit. The Agent tells the user in one sentence per tab what to do
4. A required question the answers sheet does not cover goes to the user with options; the answer is saved with `profile answer` and reused next time
5. After the user submits, the Agent confirms from the confirmation email or the site's received page and records `event add --status-after applied`. Assessment and interview invitations become `task add` entries with `--due-at`, `--due-note`, and `--link`

The hard rules are fixed text in the Skill and no setting turns them off:

- Never click any button labelled Submit*
- Never sign in, create accounts, or type passwords or verification codes, and never bypass a CAPTCHA
- Never tick consent, attestation, or arbitration boxes, and never sign
- Never write essays; only organise the user's own words
- Upload the transcript only when the field is required
- Upload the one resume the user chose
- Enter work descriptions one bullet per line prefixed "• "
- Never put personal data into the repository

Per-site technique for Workday, Oracle HCM, iCIMS, Greenhouse, Ashby, Lever, Yello, and SuccessFactors is in [`references/ats-tips.md`](../.agents/skills/career-journal-apply/references/ats-tips.md), and the brief each sub-agent receives is in [`references/fill-brief.md`](../.agents/skills/career-journal-apply/references/fill-brief.md).
### Role scan and queue

`scan run` reads the search profile at `<home>/.career-journal/profile/profile.json` (or `--profile <path>`). It fetches roles read-only from the official public Greenhouse, Lever, and Ashby job-board APIs for the boards in `sources.atsBoards`, filters them by the profile, removes duplicates, rates fit, and queues the rest as `lead` applications.

```sh
career-journal scan run --home ~/job-search --dry-run
career-journal scan run --home ~/job-search --json
career-journal queue list --home ~/job-search
career-journal queue verify --home ~/job-search --id <application> --result ok --reason "Official posting checked" --deadline 2026-10-15T23:59:00-04:00
career-journal queue verify --home ~/job-search --id <application> --result skip --reason "PhD students only"
```

- **Filters:** season and job type, direction keywords, degree (PhD-only or undergraduate-only wording; a bachelor's mention alone never drops a role), citizenship, clearance, export-control, or sponsorship requirements, explicit no-return-offer wording, and location rank from `search.locations` plus `remoteOk`. Every dropped role has a reason in the `--json` output
- **Duplicates:** the same source id, requisition id in the link, link, or company with a near-identical title. A role already applied to or skipped is never queued again; a similar title is queued with a possible-duplicate note
- **Fit:** `high`, `medium`, or `low` from Jev, then the configured structured LLM. Without either, a local rule rates a primary direction in the title high and a secondary one medium, and the note says the fit is rule-based. `--dry-run` writes nothing and calls no model
- **Queue:** `queue list` shows leads that are not skipped, ordered by fit, deadline, location rank, and posting date. `queue verify --result skip` moves the lead to `withdrawn` with an event that carries the reason
- **Dashboard:** cards for leads show fit, the deadline in the workspace time zone with days left, location, source, and whether the posting has been verified. The **Queue** filter lists the same roles as `queue list` in the same order, except that the browser does not apply the location-rank tiebreak. Skipped roles appear under **Closed** with their skip reason
- **Optional sources:** CareerOps when `sources.careerOps` is `true` and its bridge is detected. SimplifyJobs only when you set `sources.simplify.enabled` and supply `sources.simplify.url`; its list has no licence, so it is read live on your machine and never bundled or redistributed
- **Optional schedule:** `automation configure --task role-scan --enabled` defaults to the profile's `pace.scanTime`. Onboarding does not create it and `doctor` does not require it; give it its own scheduled task

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

### Claude Code scheduled task registration

In Claude Code desktop, create one shared scheduled task with the host's scheduled-tasks capability, not by writing files. Give it a stable task ID such as `career-journal-daily` and the local-time cron `0,15 20 * * *`. Register that task ID to `mail-sync` and `deadline-review` with driver `claude-code`; each command returns a `claudeCodeCommandLine`. Update the task prompt so it contains both returned strings **verbatim as standalone lines**, the detected IANA time zone, and a window branch: before 20:15 run the read-only host mailbox sync and then the mail command; from 20:15 run the deadline command, retrying mail first if that day's sync did not succeed. Use a window rather than an exact minute because recurring Claude Code runs may start a few minutes late. Run `automation verify` for both task records, then run each exact line once.

Verification reads `~/.claude/scheduled-tasks/<task-id>/SKILL.md` (or `$CLAUDE_CONFIG_DIR`) and the desktop app's schedule record. It requires a matching task name, both commands and the time zone in the prompt, an enabled daily cron covering both times, and a host time zone equal to the task time zone. When several signed-in accounts left schedule records, the most recently written record is used. Claude Code scheduled tasks run while the desktop app is open; a missed run starts on the next launch, and `doctor` still requires an observed run within 36 hours.

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

Data stays under the home you choose. `.career-journal/` contains configuration, SQLite data, immutable artifact copies, reports, backups, and prepared scheduler files. Exports omit secret references. Authentication links from imported mail are redacted. Keep temporary structured batches in a private path and delete them according to your local retention policy. The project never submits applications, sends email, or contacts recruiters. Assisted filling runs only in the user's own browser and stops before submit; the profile and answers sheet stay in the data home and are used only to fill the user's own applications.

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
- `.agents/skills` provides Agent orchestration without copying third-party workflows: `career-journal` for onboarding and tracking, `career-journal-apply` for assisted applying, and `careerops-materials` for resumes and cover letters

## Development and Releases

```sh
node --test
node scripts/check-release.mjs
```

Versions follow SemVer. Every release updates `VERSION`, `package.json`, and `CHANGELOG.md`; stable tags use `vMAJOR.MINOR.PATCH`, and prereleases add an `alpha`, `beta`, or `rc` identifier. Fresh-clone and previous-version upgrade smoke tests are release gates.

Public user documentation must ship in both English and Simplified Chinese. The release checker fails when the paired onboarding, attribution, or integration documentation is missing.

### Project reference documents

- Repository Skill: [English](../.agents/skills/career-journal/SKILL.md) · [简体中文](../.agents/skills/career-journal/SKILL.zh-CN.md)
- Apply Skill: [English](../.agents/skills/career-journal-apply/SKILL.md) · [简体中文](../.agents/skills/career-journal-apply/SKILL.zh-CN.md)
- 2.0 design: [English](superpowers/specs/2026-10-01-career-journal-2.0-design.en.md) · [简体中文](superpowers/specs/2026-10-01-career-journal-2.0-design.md)
- Product requirements: [English](superpowers/specs/2026-09-19-job-search-ops-prd-design.en.md) · [简体中文](superpowers/specs/2026-09-19-job-search-ops-prd-design.md)

## Acknowledgements

CAREER JOURNAL integrates with and learns from third-party open-source work without claiming it as its own. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the preserved license texts in `LICENSES/`. The project name is distinct from the third-party career-ops trademark and does not imply endorsement.

## License

CAREER JOURNAL is released under the MIT License. See [LICENSE](../LICENSE).
