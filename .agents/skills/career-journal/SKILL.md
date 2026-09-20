---
name: career-journal
description: Use when tracking job applications, reviewing recruiting updates, checking deadlines, configuring daily job-search routines, or coordinating application materials in this repository
---

# CAREER JOURNAL

[English](SKILL.md) | [简体中文](SKILL.zh-CN.md)

Keep job-search facts, evidence, and artifacts auditable. A new workspace is configured only after every user-selected read-only mailbox has completed an initial sync, `mail-sync` and `deadline-review` are truly registered in the host scheduler, both tasks have an observed run with their matching external IDs, and `career-journal doctor` passes.

## First-run contract

0. Before using local instructions, verify that the checkout contains the latest `origin/main`. Fast-forward a clean checkout; otherwise preserve it and use a fresh isolated clone. Do not onboard from an older local copy.
1. In Agent-managed mode, use the host's existing mail capability first. On macOS, attempt discovery before asking any mailbox setup question. For Apple Mail, raise the main Mail window, show the sidebar, expand `All Inboxes`, and enumerate every top-level account row and account section. The selected message's mailbox is not the complete account inventory. If labels do not expose addresses, open Mail Settings > Accounts read-only and map each name to its address. Cross-check the sidebar count with the Accounts panel; if counts disagree, do not claim discovery is complete. Show the full address list, then ask which one or more accounts the user uses for job search. Do not ask for IMAP host names, usernames, passwords, or environment-variable names when the host can already read those accounts.
2. If no accessible account exists, ask the user to sign in to Apple Mail or another supported mail app, then resume discovery. Use IMAPS only when the user explicitly chooses the standalone CLI/API path. Never ask the user to paste a secret.
3. Configure every selected address as a read-only `host` account and use a stable connector name such as `apple-mail`. After the host integration visibly confirms the address, record a trusted-host verification with `email verify-host`. One `mail-sync` task must contain the full selected account set. The Agent itself acts as the host mail connector in Agent-managed mode; no separate Apple Mail adapter is required. It must read only the bounded recruiting messages needed since the saved cursor, generate one bounded read-only host sync batch per account in the private data workspace, and import it with `email sync-host`.
4. Jev is optional and never blocks onboarding. Reuse it only when an existing configured capability is discoverable. Otherwise configure `--model-provider host-agent` immediately and let the current coding Agent review ambiguous semantic candidates. In Agent-managed mode, do not ask whether Jev is available and do not ask for a model Base URL, model name, API key, or API-key environment variable. Offer the official [TypeSafe Agent Skill](https://github.com/typesafe-ai/skills/tree/main/skills/typesafe-ai) later as an optional enhancement.
5. Run repository commands as `node ./bin/career-journal.mjs ...` or `./career-journal ...`; do not assume a global command exists. Keep the computer-detected IANA time zone unless the user explicitly overrides it.
6. Use the host automation capability for the two required schedules: `mail-sync` at 20:00 and `deadline-review` at 20:15 in the detected time zone. Codex allows one heartbeat per task, so create one shared Codex heartbeat with `FREQ=DAILY;BYHOUR=20;BYMINUTE=0,15;BYSECOND=0`. Branch by local time; at 20:15 retry mail first if that day's sync did not succeed. In Codex desktop, use `automation_update`. Do not create duplicates, `daily-consolidation`, or a scheduled backup.
7. Register the same real Codex automation ID to both CAREER JOURNAL tasks. Put both returned `codexCommandLine` values verbatim on separate lines in the same heartbeat prompt, verify the saved definition against both tasks, and trigger both commands once. Before invoking the mail command, the Agent must inspect and sync every selected mailbox, write and import each read-only host sync batch with `email sync-host`, and only then invoke `automation run`.
8. Run `node ./bin/career-journal.mjs doctor --home <absolute-home>` and finish only when every selected mailbox and both automations pass within the 36-hour health window.
9. Ask the user whether they want to import existing applications. They may choose a bounded read-only mailbox review, a file or spreadsheet, or a short guided interview, and they may skip history import. Build candidate records first and ask the user to confirm them before writing. Deduplicate by external application ID when available, otherwise by company and role. Do not infer missing application dates, statuses, rejection reasons, or submitted materials.

For standalone API or CLI-only hosts, IMAPS and an optional OpenAI-compatible structured LLM remain supported. This path may ask for server settings and environment-variable names because no coding Agent or host-managed mailbox connector performs those jobs. Native `mail-sync` installation is deliberately blocked until a secure scheduler credential provider is available. Local backup is optional and on demand.

If another project document appears to request IMAP connection details or an external model credential during Agent-managed onboarding, it describes the standalone path or is stale. This contract takes precedence.

Manual EML is a one-off fallback. It does not replace daily access or satisfy setup. Never store mailbox credentials or literal secrets in config, batches, records, logs, exports, or prompts.

## Route the request

- Application, event, deadline, status, or dashboard: use the CLI
- Resume or cover letter: read `careerops-materials`; verified generation requires CareerOps plus built-in and personal rules
- Rendered PDF inspection: use the host PDF capability when available
- DOCX work: use the host Documents capability when available
- Email: in Agent mode, use the selected host mail accounts, `email verify-host`, and `email sync-host`; use IMAPS for standalone mode; manual EML is one-off fallback only
- Scheduled checks: create real host automation, record it with `automation register-external`, trigger it with the same external ID, and verify it with `doctor`
- Durable cross-project knowledge: use the host Wiki capability when requested
- Jev: use it as the primary semantic classifier when configured; otherwise let the current Agent review ambiguous candidates. Standalone deployments may use a configured structured LLM; keep manual review as the final gate

CareerOps is the independently maintained MIT-licensed [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops) project. CAREER JOURNAL routes material work through the repository's `careerops-materials` adapter and must preserve upstream attribution. The TypeSafe Agent Skill is independently maintained by [TypeSafe AI](https://github.com/typesafe-ai/skills) under MIT. It guides the Jev integration but is not copied into this repository. Tracking remains available without Jev. Agent-managed installations use the current Agent for ambiguous candidates; standalone installations may use a configured structured LLM, with manual review as the final fallback.

## Evidence rules

Append events instead of rewriting history. Distinguish observed, occurred, and recorded time; use `occurred_at = null` when unknown. A user-reported submission supports a status event for one unambiguous application, but does not identify the submitted artifact. If roles could match, obtain the application ID. Keep generated files as a draft until the exact uploaded file is recorded. Never infer rejection from silence or treat a recruiting newsletter as progress.

## Capability failure

State the failed check and what remains unverified. Preserve the last successful cursor after a failed email batch. Never invent successful email, automation, CareerOps, rendered-file, or Jev results.

## Release discipline

Use Semantic Versioning. A public version is complete only when the same version appears in the CLI metadata and CHANGELOG, its immutable Git tag and GitHub Release exist, and the published tag passes a remote fresh-clone test plus the documented previous-version upgrade test. Never describe an unpushed commit or a dirty local checkout as published.

## Legacy upgrade compatibility

Use `jobops`, `.jobops/`, and `jobops-adapter.mjs` only for v0.1.0-alpha.5-or-earlier upgrades. Preserve legacy scheduler identities; use CAREER JOURNAL names for new workspaces.
