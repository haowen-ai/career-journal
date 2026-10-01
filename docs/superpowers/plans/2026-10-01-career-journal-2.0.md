# CAREER JOURNAL 2.0 Implementation Plan

> **For agentic workers:** implement one workstream per branch. Steps use checkbox (`- [ ]`) syntax. Every workstream keeps `node --test` and `node scripts/check-release.mjs` green.

**Goal:** Ship `v2.0.0`: a first-run profile interview, profile-driven daily role scans with a verified queue, an apply Skill that fills forms in the user's browser and stops before submit, and post-submit verification, without any personal data in the repository.

**Spec:** `docs/superpowers/specs/2026-10-01-career-journal-2.0-design.md` (English: `.en.md`)

**Architecture:** unchanged. Zero-runtime-dependency Node.js 24 CLI, `node:sqlite`, vanilla dashboard, repo-local Skills. Browser work is done by the host Agent's browser capability through the new Skill; the CLI never drives a browser.

## Global constraints

- No real name, email, phone number, street address, local absolute path, credential, or candidate record in the repository. Examples use `example.com`, `school.edu`, `Alex Example`, and `+1 555 0100`.
- The hard rules from spec §3.2 are fixed text in the apply Skill and cannot be disabled by configuration.
- Profile files live in the data home with mode `0600` (directory `0700`).
- SimplifyJobs publishes its list without a licence. It is an **opt-in** source fetched on the user's machine at scan time; no Simplify data is bundled, cached in the repo, or redistributed. Default sources are official public ATS job-board APIs (Greenhouse, Lever, Ashby) for companies the user lists, plus CareerOps (MIT, already credited).
- Jev stays optional; every decision falls back through the existing router (Jev → structured LLM → rules → manual).
- English and Simplified Chinese docs and Skills stay paired.

## Shared contract: profile schema (all workstreams depend on this)

`<home>/.career-journal/profile/profile.json`:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-01T00:00:00Z",
  "search": {
    "jobType": "internship",
    "season": "Summer 2027",
    "directions": { "primary": ["ai-ml", "data-science", "data-analytics"], "secondary": ["quant"] },
    "locations": [{ "label": "New York, NY", "match": ["new york", "nyc", "manhattan"] }],
    "remoteOk": true,
    "exclusions": ["no-return-offer"]
  },
  "candidate": {
    "degree": { "level": "masters", "major": "Machine Learning and Data Science", "graduation": "2027-12" },
    "authorization": { "status": "permanent-resident", "needsSponsorship": false }
  },
  "materials": {
    "resumePath": null,
    "transcriptPath": null,
    "transcriptPolicy": "required-only",
    "links": { "linkedin": null, "github": null, "website": null },
    "experienceConfirmed": false
  },
  "pace": { "batchSize": 5, "scanTime": "08:00", "notify": "desktop" },
  "sources": {
    "atsBoards": [{ "ats": "greenhouse", "board": "examplecorp" }],
    "careerOps": false,
    "simplify": { "enabled": false, "url": null }
  },
  "interview": { "roundsCompleted": [], "skipped": [] }
}
```

`<home>/.career-journal/profile/answers.md`: free-form Markdown answers sheet. Each entry is a table row `| question | answer (source, date) |`. New answers are appended under `## Learned while applying`.

Direction ids: `ai-ml`, `data-science`, `data-analytics`, `data-engineering`, `software-engineering`, `quant`, `product`, `other`. Degree levels: `bachelors`, `masters`, `phd`, `mba`, `other`. Authorization: `citizen`, `permanent-resident`, `visa`, `other`.

## Workstream A — Profile core (branch `feat/2.0-profile`)

- [ ] `src/domain/profile.mjs`: `defaultProfile()`, `validateProfile(p)` (types, enums, `graduation` as `YYYY-MM`, `batchSize` 1–10, `scanTime` HH:MM), `readProfile(home)`, `writeProfile(home, p)` (atomic write, `0600`/`0700`), `missingItems(p)` returning the round and key of every unanswered required item, `appendAnswer(home, question, answer, source)` writing to `answers.md`.
- [ ] `src/domain/profile-questions.mjs`: the four rounds as data — for each question: `key`, round, English and Chinese prompt, options (with "Other"), `required`, and which profile path it fills. The Agent reads this to ask; the CLI never prompts interactively.
- [ ] `src/commands/profile.mjs`: `profile show [--json]`, `profile questions [--round N] [--missing] --json`, `profile set --key <dot.path> --value <json-or-text>`, `profile answer --question <text> --answer <text> [--source user]`, `profile status --json`. Register in `create-runtime.mjs` and CLI help.
- [ ] `config/profile.template.json` and `config/answers.template.md` (blank; bilingual headings), copied by `profile show` when missing? No — `setup` creates nothing; `profile set` creates the file on first write.
- [ ] `doctor`: new `profile` section. Core onboarding passes without a profile; the `apply` readiness line is `incomplete` until rounds 1 and 2 are complete (resume path set and readable).
- [ ] Tests: `test/domain/profile.test.mjs`, `test/cli/profile.test.mjs` (validation errors, atomic write, permissions, missing items, answers append, no network).

## Workstream B — Scan and queue (branch `feat/2.0-scan`)

- [ ] Migration 5 (`src/storage/migrations/005-role-queue.mjs`): add to `applications` nullable `source`, `source_id`, `location`, `posted_at`, `deadline_at`, `fit`, `fit_confidence`, `fit_note`, `verified_at`, `skip_reason`; index on `(source, source_id)`.
- [ ] `src/scan/sources/ats-boards.mjs`: Greenhouse (`boards-api.greenhouse.io/v1/boards/<board>/jobs?content=true`), Lever (`api.lever.co/v0/postings/<company>?mode=json`), Ashby (`api.ashbyhq.com/posting-api/job-board/<board>`). Normalised record: `{ source, sourceId, company, title, locations[], url, postedAt, description }`. Fetch via injectable `fetch` for tests.
- [ ] `src/scan/sources/simplify.mjs`: only when `sources.simplify.enabled` and a URL is configured; read-only fetch; nothing written except normalised leads in the user's database.
- [ ] `src/scan/sources/careerops.mjs`: when `sources.careerOps` is true and CareerOps is detected, run its read-only scan through the existing integration.
- [ ] `src/scan/filter.mjs`: profile-driven filters — season/term match, direction keywords (title and category), degree eligibility (drop PhD-only / undergrad-only wording), citizenship or clearance required, explicit no-return-offer, location rank from `search.locations` and `remoteOk`. Returns `{ keep, reasons[] , locRank }`.
- [ ] `src/scan/dedupe.mjs`: requisition id in URL, `source:sourceId`, normalised company + title token similarity (≥0.9 duplicate, 0.6–0.9 `possible-duplicate`), exact company key with aliases.
- [ ] `src/commands/scan.mjs`: `scan run [--dry-run] [--json]` → fetch, filter, dedupe, score fit through the decision router (choices `high|medium|low`), insert kept roles as `lead` with the new columns, print a summary. `--dry-run` writes nothing.
- [ ] `src/commands/queue.mjs`: `queue list [--json]` (status `lead`, not skipped, ordered by fit, deadline, location rank, posted date); `queue verify --id <app> --result ok|skip --reason <text> [--deadline <iso>]` records `verified_at`/`skip_reason` and an event; `skip` moves the lead to `withdrawn`.
- [ ] Automation: optional `role-scan` task (not created by default onboarding; offered in profile round 4) at `pace.scanTime`.
- [ ] Tests with fixture JSON for each source; no live network in `node --test`.

## Workstream C — Apply Skill and onboarding contract (branch `feat/2.0-skills`)

- [ ] `.agents/skills/career-journal-apply/SKILL.md` and `SKILL.zh-CN.md`: batch flow (N from profile; one role per sub-agent; own tab only), duplicate check first, eligibility check, fill from `answers.md`, resume from `materials.resumePath`, transcript only when required, job descriptions one bullet per line prefixed `• `, tab title convention (🔑 🤖 ❓ 👆 ✅), ask-as-you-go via `profile answer`, post-submit evidence → `event add --status-after applied`, invitations → `task add --due-at --link`, recovery after browser disconnects, and the fixed hard rules.
- [ ] `.agents/skills/career-journal-apply/references/ats-tips.md` (+ `.zh-CN.md`): Workday, Oracle HCM, iCIMS, Greenhouse, Ashby, Lever, Yello, SuccessFactors — only generic, non-personal technique.
- [ ] `.agents/skills/career-journal-apply/references/fill-brief.md` (+ zh): the brief template the main Agent hands each sub-agent, with placeholders.
- [ ] `career-journal` Skill (en/zh): route "find roles", "apply", "profile" to the new commands and Skill; onboarding step: run the profile interview after `doctor` passes, asking at most 4 questions per round with options; for upgrades, infer from existing data first and confirm.
- [ ] `AGENTS.md`, `README.md`/`README.zh-CN.md`, `docs/getting-started*.md`: 2.0 onboarding step, scan and apply sections, hard rules, data locations.
- [ ] PRD (en/zh): bump version, update non-goals from "no automatic bulk applying" to "no automatic submission; assisted filling only on the user's own browser", link the 2.0 spec.
- [ ] `THIRD_PARTY_NOTICES*.md`: SimplifyJobs as an opt-in user-fetched source with no redistribution; ATS public APIs.

## Workstream D — Dashboard (branch `feat/2.0-dashboard`, after B's migration lands)

- [ ] "Preparing" cards show fit badge, deadline, location, and skip reason; a "Queue" filter ordered like `queue list`.
- [ ] Dashboard API includes the new columns (no source metadata beyond `source` name).
- [ ] Tests in `test/web/dashboard-model.test.mjs` and `test/server/api.test.mjs`.

## Workstream E — Release gates and 2.0.0 (main session)

- [ ] `scripts/check-release.mjs`: `personal-data` check — fail on email addresses outside an allowlist of example domains, phone numbers other than `555-01xx`, and `/Users/<name>/` or `C:\Users\<name>\` paths in tracked files; pair checks for the new Skill and references.
- [ ] Merge A → B → C → D, resolve CHANGELOG, run all tests.
- [ ] Version `2.0.0`, CHANGELOG (en/zh), `.github/release-notes/2.0.0.md` (en + zh).
- [ ] Fresh-clone gate: clone the tag, `node --test`, release check, first-run interview dry run with a synthetic profile, `scan run --dry-run` against fixtures.
- [ ] Upgrade gate: workspace created with v1.1.0 → migrate to 5 → existing records intact → `profile status` lists only missing items.
- [ ] Dogfood: move the author's local answers sheet and scan settings into their own data home profile (never the repo) and point the daily scan task at `scan run`.
