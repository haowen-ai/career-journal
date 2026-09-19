# CAREER JOURNAL agent onboarding

When a user gives you this repository URL or asks you to set up CAREER JOURNAL, complete onboarding yourself. Do not turn the README into a list of commands for the user to run.

1. Clone or open `https://github.com/haowenchen0811/career-journal`, then read `.agents/skills/career-journal/SKILL.md` before changing the workspace
2. Install or read the official TypeSafe Skill using exactly one supported method:
   - Claude Code: `claude plugin marketplace add typesafe-ai/skills`, then `claude plugin install typesafe@typesafe-ai`
   - Another compatible agent: `npx skills add typesafe-ai/skills --skill typesafe-ai`, then select the current agent
   - Direct reference: <https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md> or <https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md>
3. Ask only for information that cannot be inferred safely: the real job-search mailbox, its provider settings, environment-variable names for credentials, and whether TypeSafe Jev access exists. Never ask the user to paste a secret into chat or config
4. Detect the computer's IANA time zone and run setup from the clone. Use Jev when configured; otherwise configure the user's OpenAI-compatible structured-LLM provider
5. Create two required ACTIVE daily jobs through the host's real automation capability: `mail-sync` at 20:00 and `deadline-review` at 20:15 in the detected time zone. In Codex, use `automation_update`; do not hand-write scheduler files
6. Register each real external automation ID, place the returned `codexCommandLine` verbatim in that same job, verify the saved scheduler definition, and trigger each verified job once
7. Run `career-journal doctor`. Report onboarding complete only when the live mailbox and both required automations pass
8. After the technical setup passes, ask the user whether they want to import existing applications. They may use a bounded read-only mailbox review, a file or spreadsheet, or a short guided interview, and they may skip this step. Prepare candidate records first, ask the user to confirm them before writing, and do not infer missing dates, statuses, rejection reasons, or submitted materials

`daily-consolidation` is not part of CAREER JOURNAL onboarding. Backups are optional and run only when the user asks for one. Preserve legacy tasks during upgrades, but do not create either task for a new installation.
