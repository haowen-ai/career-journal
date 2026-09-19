# Job Search Ops Alpha Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public `v0.1.0-alpha.1` release that a new user can clone, configure, use to track applications, run a local dashboard, configure daily tasks, and extend through CareerOps and provider adapters.

**Architecture:** A zero-runtime-dependency Node.js 24 CLI owns deterministic workflows and a built-in SQLite database. Repo-local Skills route agent work into the CLI and an optional CareerOps installation, while adapters isolate email, model, Jev, document, and scheduler capabilities. The same HTTP API serves the local dashboard and non-Codex clients.

**Tech Stack:** Node.js 24 ESM, `node:sqlite`, Node test runner, built-in HTTP/fetch/crypto/fs modules, HTML/CSS/vanilla JavaScript, shell launchers, launchd/cron/Task Scheduler adapters, GitHub Releases.

**Spec:** `docs/superpowers/specs/2026-09-19-job-search-ops-prd-design.md`

## Global Constraints

- No personal email, local absolute path, real credential, Cookie, Token, or candidate record may enter the repository.
- JD text is selection context, never candidate evidence.
- Draft and submitted artifacts remain distinct; only explicit user confirmation creates a submitted artifact.
- Email integrations are optional and read-only by default; a failed account never advances its cursor.
- Jev is experimental and optional; users without approved access use deterministic and structured-LLM fallbacks.
- Main Skill orchestrates; CareerOps, PDF, Documents, email, automation, Wiki, and TypeSafe capabilities remain explicit dependencies.
- Third-party projects and Skills must retain attribution, source links, versions, authors, and licenses.
- Every production behavior is implemented through a red-green-refactor test cycle.
- Every public release is verified from a clean clone of the remote tag and from an upgrade copy of the previous release when one exists.

## Review Focus

- A second setup run must preserve user configuration and must not duplicate scheduled tasks.
- Unknown event dates must remain null rather than inheriting observation or record dates.
- Re-importing an identical email/event must be a no-op, while the same identity with different content must raise a conflict.
- Missing CareerOps, email, provider, or Jev access must produce actionable health output without disabling core tracking.
- Updating or migrating must preserve applications, artifacts, schedule IDs, and secret references without copying secrets into backups.

---

### Task 1: Repository shell, version contract, and CLI dispatch

**Files:**
- Create: `package.json`
- Create: `VERSION`
- Create: `bin/jobops.mjs`
- Create: `jobops`
- Create: `jobops.cmd`
- Create: `src/cli/parse-args.mjs`
- Create: `src/cli/main.mjs`
- Create: `test/cli/version.test.mjs`
- Create: `.gitignore`

**Interfaces:**
- Produces: `parseArgs(argv): {command:string, subcommand:string|null, options:Record<string,string|boolean>, positionals:string[]}`
- Produces: `runCli(argv, io, runtime): Promise<number>`

- [ ] **Step 1: Write the failing CLI version tests**

```js
test('prints the repository version', async () => {
  const io = memoryIO();
  assert.equal(await runCli(['--version'], io, runtime), 0);
  assert.equal(io.stdout.trim(), '0.1.0-alpha.1');
});

test('rejects an unknown command', async () => {
  const io = memoryIO();
  assert.equal(await runCli(['unknown'], io, runtime), 2);
  assert.match(io.stderr, /Unknown command: unknown/);
});
```

- [ ] **Step 2: Run `node --test test/cli/version.test.mjs` and confirm both tests fail because CLI modules do not exist**
- [ ] **Step 3: Implement argument parsing, version output, help output, executable shell launchers, and command dispatch stubs**
- [ ] **Step 4: Run the targeted test, then `node --test`, and confirm a clean pass**
- [ ] **Step 5: Commit exact Task 1 files with `feat: scaffold jobops cli`**

### Task 2: Versioned configuration and setup workflow

**Files:**
- Create: `src/config/defaults.mjs`
- Create: `src/config/store.mjs`
- Create: `src/commands/setup.mjs`
- Create: `src/commands/doctor.mjs`
- Create: `config/jobops.example.json`
- Create: `test/config/setup.test.mjs`
- Create: `test/config/doctor.test.mjs`

**Interfaces:**
- Produces: `loadConfig(home): Promise<JobOpsConfig>`
- Produces: `saveConfig(home, config): Promise<void>`
- Produces: `setup(home, answers): Promise<SetupResult>`
- Produces: `doctor(home, capabilities): Promise<DoctorReport>`

- [ ] **Step 1: Write failing tests for a setup with no email, a setup with an explicit email adapter, and an idempotent second setup**

```js
test('does not invent an email account', async () => {
  const result = await setup(home, { timezone: 'America/Chicago', email: { mode: 'skip' } });
  assert.deepEqual(result.config.email.accounts, []);
  assert.equal(result.config.email.setupState, 'skipped');
});
```

- [ ] **Step 2: Run setup tests and confirm failure from missing configuration implementation**
- [ ] **Step 3: Implement schema version 1 config, atomic writes, IANA timezone validation, secret-reference-only fields, setup answer validation, and repeat-run preservation**
- [ ] **Step 4: Write failing doctor tests for missing Node version, missing optional CareerOps, waitlisted Jev, and configured core storage**
- [ ] **Step 5: Implement doctor checks with `pass`, `warn`, and `fail` severity; optional capabilities may warn but core failures return nonzero**
- [ ] **Step 6: Run targeted tests and full suite**
- [ ] **Step 7: Commit with `feat: add idempotent setup and doctor`**

### Task 3: SQLite schema, migrations, and evidence-safe records

**Files:**
- Create: `src/storage/database.mjs`
- Create: `src/storage/migrations/001-initial.mjs`
- Create: `src/domain/status-machine.mjs`
- Create: `src/domain/events.mjs`
- Create: `src/domain/artifacts.mjs`
- Create: `test/storage/migrations.test.mjs`
- Create: `test/domain/events.test.mjs`
- Create: `test/domain/artifacts.test.mjs`

**Interfaces:**
- Produces: `openDatabase(path): DatabaseSync`
- Produces: `migrate(db, {dryRun=false}): MigrationReport`
- Produces: `recordEvent(db, input): {created:boolean,eventId:string}`
- Produces: `archiveArtifact(db, input): ArtifactRecord`

- [ ] **Step 1: Write a failing migration test that creates schema version 1 with application, event, artifact, email account, automation, decision trace, and migration tables**
- [ ] **Step 2: Run the migration test and confirm the missing module failure**
- [ ] **Step 3: Implement transactional migration, schema-version recording, foreign keys, uniqueness constraints, and dry-run planning**
- [ ] **Step 4: Write failing event tests for nullable occurred time, three distinct timestamps, idempotent replay, conflict detection, and no status regression on replay**
- [ ] **Step 5: Implement the status machine and append-only event writer**
- [ ] **Step 6: Write failing artifact tests for draft/submitted separation, SHA-256 immutable archive, and same-hash idempotence**
- [ ] **Step 7: Implement content-addressed artifact storage and explicit submitted confirmation**
- [ ] **Step 8: Run targeted tests and full suite**
- [ ] **Step 9: Commit with `feat: add versioned local data store`**

### Task 4: Application, event, artifact, and export CLI

**Files:**
- Create: `src/commands/application.mjs`
- Create: `src/commands/event.mjs`
- Create: `src/commands/artifact.mjs`
- Create: `src/commands/export.mjs`
- Create: `test/cli/application.test.mjs`
- Create: `test/cli/export.test.mjs`

**Interfaces:**
- Consumes: Task 2 config and Task 3 database APIs
- Produces CLI commands: `application add|list|show`, `event record`, `artifact add`, `export json|markdown|csv`

- [ ] **Step 1: Write failing end-to-end CLI tests that add two roles at one company and preserve independent records**
- [ ] **Step 2: Run the tests and confirm failure from unimplemented commands**
- [ ] **Step 3: Implement application commands with slug collision handling, nullable application dates, and configurable statuses**
- [ ] **Step 4: Write failing CLI tests for event replay/conflict and explicit submitted artifact confirmation**
- [ ] **Step 5: Implement event and artifact commands through domain APIs only**
- [ ] **Step 6: Write failing export tests that verify JSON, Markdown, and CSV omit secret references and produce stable ordering**
- [ ] **Step 7: Implement deterministic exporters**
- [ ] **Step 8: Run targeted tests and full suite**
- [ ] **Step 9: Commit with `feat: add application tracking commands`**

### Task 5: Local HTTP API and dashboard

**Files:**
- Create: `src/server/app.mjs`
- Create: `src/server/routes.mjs`
- Create: `src/commands/start.mjs`
- Create: `web/index.html`
- Create: `web/app.js`
- Create: `web/styles.css`
- Create: `test/server/api.test.mjs`
- Create: `test/server/dashboard.test.mjs`

**Interfaces:**
- Produces: `createServer({db, config, webRoot}): http.Server`
- Produces API: `GET /api/health`, `GET/POST /api/applications`, `GET /api/applications/:id`, `POST /api/applications/:id/events`

- [ ] **Step 1: Write failing API tests for health, list, create, detail, event idempotence, invalid JSON, and request-size limits**
- [ ] **Step 2: Run API tests and confirm missing server failure**
- [ ] **Step 3: Implement loopback-only server defaults, JSON schema checks, safe errors, and API routes**
- [ ] **Step 4: Write failing dashboard tests for static asset serving, path traversal rejection, and required draft/submitted labels**
- [ ] **Step 5: Implement accessible responsive dashboard with filters and application timelines using the API**
- [ ] **Step 6: Run targeted tests and full suite**
- [ ] **Step 7: Commit with `feat: add local dashboard and api`**

### Task 6: Daily automation registry and platform schedulers

**Files:**
- Create: `src/automation/tasks.mjs`
- Create: `src/automation/registry.mjs`
- Create: `src/automation/platform.mjs`
- Create: `src/automation/launchd.mjs`
- Create: `src/automation/cron.mjs`
- Create: `src/automation/windows.mjs`
- Create: `src/commands/automation.mjs`
- Create: `test/automation/registry.test.mjs`
- Create: `test/automation/platform.test.mjs`

**Interfaces:**
- Produces commands: `automation configure|list|run|update|disable|remove|install|uninstall`
- Produces: `upsertTask(db, task): AutomationRecord`
- Produces: `renderScheduler(task, runtime): SchedulerArtifact`

- [ ] **Step 1: Write failing tests for four built-in tasks, explicit enabled/disabled decisions, IANA timezone validation, and stable task IDs**
- [ ] **Step 2: Run tests and confirm missing registry failure**
- [ ] **Step 3: Implement task registry, state, success/attempt timestamps, cursor rules, and dry-run**
- [ ] **Step 4: Write failing tests proving repeated configure/install updates one task rather than duplicating it**
- [ ] **Step 5: Implement launchd plist, cron line, and Windows Task Scheduler command rendering with safe argument handling**
- [ ] **Step 6: Write failing tests for disable/remove and failed-run cursor preservation**
- [ ] **Step 7: Implement lifecycle operations and quiet unchanged output**
- [ ] **Step 8: Run targeted tests and full suite**
- [ ] **Step 9: Commit with `feat: add portable daily automations`**

### Task 7: Email configuration and manual read-only ingestion

**Files:**
- Create: `src/email/accounts.mjs`
- Create: `src/email/dedupe.mjs`
- Create: `src/email/eml.mjs`
- Create: `src/commands/email.mjs`
- Create: `test/email/accounts.test.mjs`
- Create: `test/email/eml.test.mjs`

**Interfaces:**
- Produces commands: `email configure|list|import-eml|disconnect`
- Produces: `fingerprintMessage(message): string`
- Produces: `importEml(db, path, options): EmailImportResult`

- [ ] **Step 1: Write failing tests that require explicit account configuration and never create a school or personal default**
- [ ] **Step 2: Run tests and confirm failure from missing account module**
- [ ] **Step 3: Implement provider metadata with external secret references and read-only defaults**
- [ ] **Step 4: Write failing EML tests for Message-ID dedupe, fallback fingerprint dedupe, auth-link redaction, and event candidate creation without automatic final status**
- [ ] **Step 5: Implement RFC-822 header/body extraction sufficient for fixtures, minimum source retention, and pending-review decisions**
- [ ] **Step 6: Run targeted tests and full suite**
- [ ] **Step 7: Commit with `feat: add read-only email ingestion foundation`**

### Task 8: Provider-neutral model gateway and optional Jev adapter

**Files:**
- Create: `src/providers/interface.mjs`
- Create: `src/providers/openai-compatible.mjs`
- Create: `src/decision/rules.mjs`
- Create: `src/decision/structured-llm.mjs`
- Create: `src/decision/jev.mjs`
- Create: `src/decision/router.mjs`
- Create: `test/providers/gateway.test.mjs`
- Create: `test/decision/router.test.mjs`

**Interfaces:**
- Produces: `createProvider(config, fetchImpl): ModelProvider`
- Produces: `decide(input, capabilities): Promise<DecisionTrace>`

- [ ] **Step 1: Write failing provider tests for configurable base URL, bearer secret reference, structured response validation, timeout, and secret-free errors**
- [ ] **Step 2: Run tests and confirm missing provider implementation**
- [ ] **Step 3: Implement an OpenAI-compatible adapter behind the provider interface without domain imports**
- [ ] **Step 4: Write failing router tests for deterministic classification, Jev waitlisted state, shadow mode, low-confidence fallback, and schema rejection**
- [ ] **Step 5: Implement rules-first routing, optional TypeSafe `v1/systemone` adapter, shadow traces, and structured-LLM fallback**
- [ ] **Step 6: Run targeted tests and full suite**
- [ ] **Step 7: Commit with `feat: add provider and decision adapters`**

### Task 9: CareerOps adapter and repo-local Skills

**Files:**
- Create: `src/integrations/careerops.mjs`
- Create: `src/commands/material.mjs`
- Create: `config/dependency-manifest.yml`
- Create: `.agents/skills/job-search-ops/SKILL.md`
- Create: `.agents/skills/careerops-materials/SKILL.md`
- Create: `test/integrations/careerops.test.mjs`
- Create: `test/skills/job-search-ops.scenarios.md`
- Create: `test/skills/careerops-materials.scenarios.md`

**Interfaces:**
- Produces commands: `material prepare|verify|mark-submitted`
- Produces: `detectCareerOps(config): CapabilityHealth`
- Produces: `runCareerOps(request): Promise<MaterialResult>`

- [ ] **Step 1: Write failing adapter tests for missing CareerOps, pinned-version detection, structured request construction, no fabricated success, and draft-only default**
- [ ] **Step 2: Run tests and confirm failure from missing adapter**
- [ ] **Step 3: Implement CareerOps capability detection and child-process adapter with bounded arguments and JSON result validation**
- [ ] **Step 4: Create three baseline agent scenarios without the Skills: missing dependency under time pressure, JD-to-fact fabrication pressure, and draft-to-submitted pressure; record failures in scenario files**
- [ ] **Step 5: Write the minimal `job-search-ops` orchestration Skill and `careerops-materials` routing Skill with explicit required/optional dependencies and no personal paths**
- [ ] **Step 6: Re-run scenarios with each Skill, close observed gaps, and verify frontmatter, trigger descriptions, dependency names, commands, and fallback behavior**
- [ ] **Step 7: Run targeted tests and full suite**
- [ ] **Step 8: Commit with `feat: add careerops integration skills`**

### Task 10: Attribution, README, changelog, and release tooling

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `LICENSES/career-ops-MIT.txt`
- Create: `LICENSES/typesafe-ai-skills-MIT.txt`
- Create: `CHANGELOG.md`
- Create: `.github/ISSUE_TEMPLATE/bug.yml`
- Create: `.github/ISSUE_TEMPLATE/dogfood.yml`
- Create: `.github/pull_request_template.md`
- Create: `scripts/check-release.mjs`
- Create: `test/docs/readme-smoke.test.mjs`
- Create: `test/release/check-release.test.mjs`

**Interfaces:**
- Produces: `node scripts/check-release.mjs`
- Documents exact clone, setup, doctor, start, automation, update, migration, backup, and uninstall commands

- [ ] **Step 1: Write failing README smoke tests that extract and execute the Quick Start in a temporary clean home**
- [ ] **Step 2: Run tests and confirm failure because README and commands are absent**
- [ ] **Step 3: Write README with architecture, two runtime modes, exact setup paths, every Skill dependency, email/Jev states, automation by platform, privacy, update, uninstall, and acknowledgements**
- [ ] **Step 4: Write failing release tests for missing attribution, license copies, changelog sections, version consistency, tracked-file secrets, and untracked runtime dependencies**
- [ ] **Step 5: Add MIT project license, verified upstream notices/licenses, structured changelog, issue templates, and release checker**
- [ ] **Step 6: Run documentation tests, release checker, and full suite**
- [ ] **Step 7: Commit with `docs: add complete onboarding and release policy`**

### Task 11: Migration, backup, fresh-clone, and upgrade verification

**Files:**
- Create: `src/commands/update.mjs`
- Create: `src/commands/migrate.mjs`
- Create: `src/commands/backup.mjs`
- Create: `scripts/fresh-clone-smoke.sh`
- Create: `scripts/upgrade-smoke.sh`
- Create: `docs/dogfood/TEMPLATE.md`
- Create: `test/upgrade/migrate.test.mjs`
- Create: `test/upgrade/backup.test.mjs`

**Interfaces:**
- Produces commands: `update --check`, `migrate [--dry-run]`, `backup`
- Produces scripts that accept a repository URL and version refs

- [ ] **Step 1: Write failing tests for secret-free backups, dry-run no-write behavior, idempotent migration, and rollback on migration failure**
- [ ] **Step 2: Run tests and confirm missing command failure**
- [ ] **Step 3: Implement update inspection, backup manifests, migration orchestration, and restore-on-failure**
- [ ] **Step 4: Write fresh-clone and upgrade smoke scripts that create isolated HOME/data directories and never reuse the developer configuration**
- [ ] **Step 5: Run local-path smoke tests before a remote exists; confirm setup, doctor, application creation, automation dry-run, dashboard API, backup, and second setup**
- [ ] **Step 6: Run full suite and release checker**
- [ ] **Step 7: Commit with `feat: add safe update and dogfood workflow`**

### Task 12: Public GitHub alpha release and independent review

**Files:**
- Modify: `CHANGELOG.md`
- Create: `docs/dogfood/0.1.0-alpha.1.md`

**Interfaces:**
- Produces public tag `v0.1.0-alpha.1` and matching GitHub Release

- [ ] **Step 1: Run a fresh-context whole-branch code review against the PRD and implementation plan; resolve every blocking finding through a failing regression test**
- [ ] **Step 2: Run `node --test`, `node scripts/check-release.mjs`, CLI help/version/doctor, and local clean-clone smoke tests; save exact results in the dogfood record**
- [ ] **Step 3: Confirm Git status contains only intended tracked files and no secrets, personal paths, personal emails, generated database, or runtime artifacts**
- [ ] **Step 4: Create the public GitHub repository, add the remote, push `main`, create immutable tag `v0.1.0-alpha.1`, and publish matching release notes**
- [ ] **Step 5: Clone the public tag into a new directory and run `scripts/fresh-clone-smoke.sh` against the GitHub URL**
- [ ] **Step 6: Record fresh-clone evidence, discovered issues, fixes, and the next version decision in `docs/dogfood/0.1.0-alpha.1.md`**
- [ ] **Step 7: Re-run final verification and report the repository URL, tag, tested commands, known limitations, and new-user test path**

