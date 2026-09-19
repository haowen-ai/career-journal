---
name: career-journal
description: Use when tracking job applications, reviewing recruiting updates, checking deadlines, configuring daily job-search routines, or coordinating application materials in this repository
---

# CAREER JOURNAL

[English](SKILL.md) | [简体中文](SKILL.zh-CN.md)

Keep job-search facts, evidence, and artifacts auditable. A read-only mailbox and two required daily tasks are the onboarding gates. A new workspace is configured only after one user-selected mailbox has completed an initial sync, `mail-sync` and `deadline-review` are truly registered in the host scheduler, both tasks have one observed run with their matching external IDs, and `career-journal doctor` passes.

## First-run contract

1. Obtain the exact email address from the user. Never infer a school, work, or personal account. Prefer the built-in live IMAPS path when the provider permits it. Store an app password or provider credential only in a secret environment variable. If IMAPS is unavailable, a host-managed connector may import read-only mail, but its JSON is self-attested and onboarding remains incomplete until an independent live verifier adapter exists; do not substitute manual EML.
2. Ask whether the user has TypeSafe access. If yes, ask only for the environment-variable name that holds the Jev key and add `--jev-secret-ref env:<VARIABLE>`; never ask for or store the literal key. Read the official [TypeSafe Agent Skill](https://github.com/typesafe-ai/skills/tree/main/skills/typesafe-ai) and current API docs before changing questions or thresholds. If TypeSafe is unavailable, ask for an OpenAI-compatible base URL, model name, and API-key environment-variable name, then configure the structured LLM fallback. Do not paste or store the literal key.
3. From the clone, run `node ./bin/career-journal.mjs setup --home <absolute-home> --email-provider imap --email-address <address> --imap-host <host> --imap-user <username> --secret-ref env:<VARIABLE>` plus either `--jev-secret-ref env:<JEV_VARIABLE>` or `--model-provider openai-compatible --model-base-url <url> --model-name <model> --model-secret-ref env:<MODEL_VARIABLE>`. Keep the computer-detected IANA time zone unless explicitly overridden. Do not use a reserved example address. Run repo commands as `node ./bin/career-journal.mjs ...` or `./career-journal ...`; do not assume a global `career-journal` command exists.
4. Run `node ./bin/career-journal.mjs email verify-imap --home <absolute-home> --account imap:<address>`. Report a real authentication or mailbox error; never replace it with connector JSON.
5. Use the host automation capability to create two required ACTIVE daily jobs in the same time zone: `mail-sync` at 20:00 and `deadline-review` at 20:15. In Codex desktop, use `automation_update` rather than hand-writing `automation.toml`. Do not create a second set when matching jobs already exist. Do not create `daily-consolidation` or a scheduled `local-backup` during onboarding.
6. After each Codex heartbeat returns its ID, run `node ./bin/career-journal.mjs automation register-external --home <absolute-home> --task <task> --driver codex --external-id <real-id>`. Read `codexCommandLine` from the JSON result. Update that same heartbeat so its prompt contains `codexCommandLine` verbatim as a standalone line and states the detected IANA time zone. Do not reconstruct the command or put any secret value in the prompt. The mail heartbeat's host environment must securely expose the variables named by its email, Jev, or model secret references.
7. Run `node ./bin/career-journal.mjs automation verify --home <absolute-home> --task <task>` for each job. Verification must read the actual saved scheduler definition and match its ACTIVE state, schedule, time zone, executable, CLI, task ID, data home, and external ID. A registration claim, generated file, screenshot, placeholder ID, or lookalike command is not verification.
8. Trigger both verified jobs once with the exact returned `codexCommandLine`. The initial IMAPS sync may contain zero relevant messages. Direct sync refreshes mailbox verification and advances the UID cursor only after all local evidence commits.
9. Run `node ./bin/career-journal.mjs doctor --home <absolute-home>`; finish only when email and automation pass. Email PASS requires live IMAPS verification and a successful read-only sync within 36 hours. Automation PASS requires a successful live scheduler probe and one matching run for both required tasks in that window.
10. After the technical setup passes, ask the user whether they want to import existing applications. They may choose a bounded read-only mailbox review, a file or spreadsheet, or a short guided interview, and they may skip history import. Build candidate records first and ask the user to confirm them before writing. Deduplicate by external application ID when available, otherwise by company and role. Do not infer missing application dates, statuses, rejection reasons, or submitted materials; keep unknown values empty. Never treat an old generated draft as the file that was actually submitted.

For API or CLI-only hosts, `automation install` may install and probe `deadline-review` with launchd, cron, or Windows Task Scheduler. Native `mail-sync` installation is deliberately blocked in the current alpha because the generated definitions do not have a secure cross-platform secret provider. Use a trusted external scheduler that injects the referenced environment variables, then register, verify, and run it through the same gate. Local backup is optional and on-demand through `backup create`; it is never a required daily task.

Manual EML is a one-off fallback. It does not replace daily access or satisfy setup. Never store mailbox credentials or literal secrets in config, batches, records, logs, exports, or prompts.

## Route the request

- Application, event, deadline, status, or dashboard: use the CLI
- Resume or cover letter: read `careerops-materials`; verified generation requires CareerOps plus built-in and personal rules
- Rendered PDF inspection: use the host PDF capability when available
- DOCX work: use the host Documents capability when available
- Email: use live IMAPS and the verified `career-journal-mail-sync` command; host `email sync-host` batches are import-only and self-attested, while manual EML is one-off fallback only
- Scheduled checks: create real host automation, record it with `automation register-external`, trigger it with the same external ID, and verify it with `doctor`
- Durable cross-project knowledge: use the host Wiki capability when requested
- Jev: use it as the primary semantic classifier when access is configured; keep explicit deterministic rules first, validate typed output, and fall back from Jev to the configured structured LLM when Jev is missing, unavailable, shadowed, malformed, unknown, or below threshold; use manual review when neither provider returns a reliable decision

CareerOps is the independently maintained MIT-licensed [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops) project. CAREER JOURNAL routes material work through the repository's `careerops-materials` adapter and must preserve upstream attribution. The TypeSafe Agent Skill is independently maintained by [TypeSafe AI](https://github.com/typesafe-ai/skills) under MIT. It guides the Jev integration but is not copied into this repository. Tracking remains available without Jev; semantic email decisions then use the configured structured LLM, with manual review as the final fallback.

## Evidence rules

Append events instead of rewriting history. Distinguish observed, occurred, and recorded time; use `occurred_at = null` when unknown. A user-reported submission supports a status event for one unambiguous application, but does not identify the submitted artifact. If roles could match, obtain the application ID. Keep generated files as a draft until the exact uploaded file is recorded. Never infer rejection from silence or treat a recruiting newsletter as progress.

## Capability failure

State the failed check and what remains unverified. Preserve the last successful cursor after a failed email batch. Never invent successful email, automation, CareerOps, rendered-file, or Jev results.

## Release discipline

Use Semantic Versioning. A public version is complete only when the same version appears in the CLI metadata and CHANGELOG, its immutable Git tag and GitHub Release exist, and the published tag passes a remote fresh-clone test plus the documented previous-version upgrade test. Never describe an unpushed commit or a dirty local checkout as published.

## Legacy upgrade compatibility

Use `jobops`, `.jobops/`, and `jobops-adapter.mjs` only for v0.1.0-alpha.5-or-earlier upgrades. Preserve legacy scheduler identities; use CAREER JOURNAL names for new workspaces.
