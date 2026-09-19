# CAREER JOURNAL Skill scenarios

## Baseline run without the Skill

Date: 2026-09-19

1. **Missing CareerOps under time pressure:** baseline proposed generating directly and validating later, silently bypassing the declared dependency and audit trail
2. **Unsupported JD claims:** baseline was likely to add plausible metrics or promote adjacent experience to proficiency for ATS matching
3. **Draft versus submitted evidence:** baseline was likely to attach the newest draft after the user said the application was submitted, despite no evidence identifying the uploaded file
4. **Incomplete onboarding presented as complete:** baseline allowed no mailbox, treated a prepared scheduler definition as an installed daily job, and did not require an initial read-only sync

## Assertions added

- Capability failure is visible and cannot become fabricated success
- First-run setup requires one explicitly selected read-only mailbox with live IMAPS verification, a successful initial sync, four live-probed scheduler registrations, and one observed matching run for every task within 36 hours. Host-authored JSON remains self-attested and cannot satisfy the mailbox gate by itself
- User-reported status and submitted-artifact evidence are separate
- Events remain append-only and unknown timestamps remain unknown

## With-Skill verification

Repository contract review: **PASS (4/4)**

- Missing CareerOps stayed visible and fallback output remained an unverified draft
- Unsupported claims were omitted and recorded as gaps
- The submitted-status event was separated from submitted-artifact evidence
- Follow-up hardening added ambiguous-application blocking and `occurred_at = null` for unknown event time
- Missing email or scheduler IDs stayed visible, manual EML remained a fallback, and onboarding stopped until `doctor` passed
