---
name: job-search-ops
description: Use when tracking job applications, reviewing recruiting updates, checking deadlines, or coordinating application materials in this repository
---

# Job Search Ops

Keep job-search facts, evidence, and artifacts auditable. Run `jobops doctor` before capability-dependent work and continue with core local tracking when optional capabilities are unavailable.

## Route the request

- Application, event, deadline, status, or dashboard: use the `jobops` CLI
- Resume or cover letter: read `careerops-materials`; CareerOps is required for verified generation, and the built-in plus configured personal material rules must be loaded
- Rendered PDF inspection: use the host PDF capability when available
- DOCX work: use the host Documents capability when available
- Recruiting email: use only a configured read-only email adapter; manual EML remains valid
- Scheduled checks: use `jobops automation`; install OS scheduling only when requested
- Durable cross-project knowledge: use the host Wiki capability when requested
- Jev: optional decision support only; respect access state and keep rules/model fallbacks

## Evidence rules

Append events instead of rewriting history. Distinguish observed, occurred, and recorded time. If the actual event time is unknown, store `occurred_at = null`; never substitute the email or current date. A user statement that an application was sent supports a submitted-status event for an unambiguous application, but it does not identify the submitted artifact. If several roles could match, obtain the application ID instead of guessing. Keep every generated file as a draft until the exact uploaded file is known and explicitly recorded as a submitted artifact. Never infer rejection from silence or turn a recruiting newsletter into an application update.

## Capability failure

State which check is unavailable and what remains unverified. Do not invent a successful email check, CareerOps run, rendered-file audit, or Jev decision. Never include credentials in records, logs, exports, or prompts.
