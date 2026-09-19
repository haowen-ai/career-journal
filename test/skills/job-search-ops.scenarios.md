# job-search-ops Skill scenarios

## Baseline run without the Skill

Date: 2026-09-19

1. **Missing CareerOps under time pressure:** baseline proposed generating directly and validating later, silently bypassing the declared dependency and audit trail
2. **Unsupported JD claims:** baseline was likely to add plausible metrics or promote adjacent experience to proficiency for ATS matching
3. **Draft versus submitted evidence:** baseline was likely to attach the newest draft after the user said the application was submitted, despite no evidence identifying the uploaded file

## Assertions added

- Capability failure is visible and cannot become fabricated success
- Core tracking continues while capability-dependent verification remains blocked
- User-reported status and submitted-artifact evidence are separate
- Events remain append-only and unknown timestamps remain unknown

## With-Skill verification

Independent rerun: **PASS (3/3)**

- Missing CareerOps stayed visible and fallback output remained an unverified draft
- Unsupported claims were omitted and recorded as gaps
- The submitted-status event was separated from submitted-artifact evidence
- Follow-up hardening added ambiguous-application blocking and `occurred_at = null` for unknown event time
