# CAREER JOURNAL 2.0 design: ask first, then help you apply

[English](2026-10-01-career-journal-2.0-design.en.md) | [简体中文](2026-10-01-career-journal-2.0-design.md)

**Status:** Draft for review
**Date:** 2026-10-01
**Target version:** 2.0.0
**Builds on:** 1.1.0 (Assessments & interviews, invitation links, Claude Code scheduler)

## 1. In one sentence

1.x only records what was applied to, which stage it reached, and when things are due. 2.0 also does the work from finding roles to filling in application forms, leaving only sign-in, verification codes, consent, signatures, and the final submit to the user. Because every person targets different roles and gives different answers, 2.0 first interviews the user on first use, and every later scan and form uses only that profile.

## 2. Why

In late September 2026 the author used Agents to submit about 80 Summer 2027 internship applications. The flow works:

- Scan newly opened roles every day, filter by direction, location, degree, and work authorization, and queue them by fit.
- An Agent takes 5 roles at a time and fills each form in its own tab of the user's Chrome, stopping before submit.
- The user signs in, enters codes, ticks consent boxes, signs, and clicks submit.
- The Agent checks confirmation emails and marks the application as applied. Assessment invitations are recorded with their deadline and link.

All of this lives only on the author's machine: the filling rules, answers sheet, per-site tips, and scan scripts hard-code the author's personal details. Nobody who clones the project can use them. 2.0 turns them into a general feature.

## 3. Goals and non-goals

### 3.1 Goals

1. **First-run interview**: after cloning, the Agent asks the user, over a few short rounds, about their search goals, materials, and common form answers, and stores them on the user's machine.
2. **Daily scan**: find new roles using the user's own criteria, verify each official posting, and queue them on the dashboard.
3. **Batch form filling**: the Agent fills applications in the user's browser from the answers sheet and stops before submit.
4. **Post-submit check**: confirm each submission from the confirmation email; assessment and interview invitations go to Assessments & interviews automatically.
5. **Ask as you go**: ask the user only when a form has a question the answers sheet does not cover, and save the answer for next time.
6. **Seamless upgrade**: existing 1.x records and settings carry over; only missing information is asked.

### 3.2 Non-goals (same as 1.x, not relaxed)

- **Never click the final submit** for the user. Any button labelled Submit is the user's.
- **Never sign in, create accounts, or type passwords or verification codes** for the user, and never bypass a CAPTCHA.
- **Never tick consent, attestation, or arbitration boxes, and never sign an e-signature** for the user.
- **Never write essays** (why-us, cover letters, and similar). Only organise what the user said in their own words.
- Never take assessments or attend interviews.
- Never put personal data in the repository or logs, or send it to third parties.

## 4. Participants

| Role | Responsible for |
|---|---|
| User | First-run interview; sign-in, codes, consent, signature, submit; answering new questions |
| Agent (Codex, Claude Code, ...) | Interview, scan, queue, dispatch fill tasks, check email, update records |
| Fill sub-agent | One role each, in its own browser tab |
| Browser capability | Claude in Chrome, the Codex browser, or whatever the host provides |
| Jev (optional) | Fit scoring, picking one of several roles, uncertain questions; without Jev the current Agent decides |
| CAREER JOURNAL core | Stores the profile, role queue, applications, and assessment tasks; dashboard |

## 5. Overall flow

```
First-run interview ──> profile (local)
                 │
Daily scan ──> filter by profile, verify postings, score fit ──> dashboard "Preparing" queue
                 │
User says "start" ──> batches of N (default 5) ──> sub-agents fill forms in their own tabs
                 │                                   │
                 │                 Needs the user: tab title 🔑 sign in / ❓ question / 👆 click
                 │                                   │
                 │                 Done: tab title ✅ ready to submit, stopped before submit
                 │
User signs in, enters codes, consents, signs, submits
                 │
Check confirmation email ──> applied; assessment invitation ──> Assessments & interviews (deadline + link)
```

## 6. First-run interview

Runs after the existing onboarding (mailbox, schedules, doctor) passes. Each round asks at most 4 questions as options plus "Other". Every question can be skipped; a skipped question is asked the first time it is needed. Anything that can be read from the resume is pre-filled and only confirmed.

### Round 1: what to look for (decides what to scan)

| Question | Used for | Example |
|---|---|---|
| Internship or full-time, which season | Scan only this season | Summer 2027 internship |
| Directions, primary vs secondary | Filtering and fit | Primary: AI / ML / data; secondary: quant |
| Locations in order; remote OK? | Filtering and office choice | NYC > Seattle > Bay Area > US remote |
| Degree, major, graduation date | Drop undergrad-only, PhD-only, or out-of-window roles | MS, graduating December 2027 |
| Work authorization | Drop citizenship or clearance roles; answer sponsorship questions | Green card, no sponsorship |
| Hard exclusions | Filtering | Roles that explicitly offer no return offer |

### Round 2: materials

- Resume file. One file for every role by default; per-role versions go through the existing `careerops-materials` Skill.
- Transcript (optional). **Uploaded only when a site makes the transcript a required field**, never into "other attachments".
- LinkedIn, GitHub, personal site.
- Education and each job (company, title, location, start and end month, each bullet) are read from the resume and confirmed one by one. Job descriptions are entered one bullet per line, each starting with "• ".

### Round 3: common form questions

Ask the most common set first to create the user's own answers sheet:

- Name, preferred name, email, phone, address
- Voluntary disclosures: gender, race and ethnicity, veteran status, disability. Each allows "prefer not to say"
- Languages and levels
- Availability, full-time availability, notice period
- How to answer expected salary (for example "in line with the posted range", no number)
- First-generation status, relatives in government or at the company, non-compete or confidentiality agreements
- Certifications and awards

### Round 4: rules and pace

- Batch size (default 5)
- Daily scan time and notification (default desktop notification)
- The hard rules in section 3.2 are shown to the user and cannot be turned off

### Ask as you go

When a required question is not in the answers sheet, the sub-agent stops and sets its tab title to "❓ question". The main Agent passes the exact question and options to the user, writes the answer back to the answers sheet with the date and "confirmed by user", and reuses it next time.

## 7. Where the profile lives

- Everything is in the user's data home (for example `~/job-search/.career-journal/profile/`), **never in the Git repository**:
  - `profile.json`: structured answers from rounds 1, 2, and 4 (directions, locations, degree, authorization, batch size)
  - `answers.md`: form answers from round 3 and ask-as-you-go, in any language
  - Resume and transcript are referenced by path, not copied
- The repository only ships blank templates `config/profile.template.json` and `config/answers.template.md`, plus the question list.
- The release checker gains a rule: no real name, email, phone number, or address may appear in the repository.

## 8. Daily scan

- **Sources** (read-only):
  - Default: official public job-board APIs (Greenhouse, Lever, Ashby) for the companies the user lists
  - CareerOps company portal scans (optional dependency, MIT licence, existing attribution kept)
  - The public SimplifyJobs list: it has no open-source licence, so it is **only an opt-in source** that the user turns on, read live on the user's machine at scan time; the project never bundles, caches, or redistributes its data
- **Filters**: all from `profile.json`; nobody's criteria are hard-coded.
- **Duplicates**: the same requisition id, the same link, or a near-identical company and title count as one role and are never applied to twice.
- **Verification**: for each newly queued role, read the official posting and check degree requirements, graduation window, authorization requirements, explicit no-return-offer wording, whether it is closed, the deadline, and required essays. Roles that fail are marked "skip" with the reason.
- **Company rules**: for example "one application per candidate"; Jev or the Agent picks the best fit and marks the others "skip" with the reason.
- **Output**: the dashboard "Preparing" list, one desktop notification, and a short daily summary in the user's language.

## 9. Batch form filling

- A new `career-journal-apply` Skill (English and Chinese), based on this experience:
  - each sub-agent fills one role and uses only the tab it opened, never other tabs;
  - check for an existing application first; skip roles that exclude the user's degree or location;
  - fill from the answers sheet; always upload the resume the user chose;
  - tab title convention: 🔑 sign in, 🤖 CAPTCHA, ❓ question, 👆 click, ✅ ready to submit;
  - per-ATS tips for Workday, Oracle, iCIMS, Greenhouse, Ashby, Lever, Yello, and SuccessFactors (for example how Workday dropdowns are chosen, iCIMS forms living in an iframe, Greenhouse loading only after the page is shown);
  - the hard rules in section 3.2.
- After each sub-agent reports, the main Agent tells the user in one sentence which tab needs what.
- If the browser disconnects or tabs are closed, saved steps resume from the site's draft; unsaved steps are filled again from the start.

## 10. Post-submit check

- After the user submits, the Agent checks the confirmation email or the site's "received" page and marks the application as applied only with that evidence, recording an event that names it.
- Assessment or interview invitations are recorded with `task add`, including the deadline (with offset and how it was computed) and the invitation link.
- Duplicate records produced by scans are marked "duplicate" and point to the record that was kept.

## 11. Data and command changes (preliminary)

- New commands: `career-journal profile show|set|interview`, `career-journal scan run`, `career-journal queue list`.
- `applications` gains source id, fit, and verification fields (schema version 5). The queue is the set of applications in "Preparing"; no separate table.
- The dashboard "Preparing" list shows fit, deadline, and skip reasons.
- Exact fields are decided in the implementation plan.

## 12. Upgrading from 1.x

- Existing applications, events, and assessment tasks are kept as they are.
- On first run of 2.0 without `profile.json`, the Agent infers what it can from existing records, the resume, and config, and asks only what is missing. The user confirms every inferred item.
- The database upgrades with the existing steps: `migrate --dry-run`, backup, `migrate --apply`.

## 13. Why 2.0

The onboarding contract in AGENTS.md and the Skills gains a required profile interview, and the product moves from "record" to "record and fill in", so the major version changes under Semantic Versioning.

## 14. Done when

1. Someone who has never used the project clones it, the Agent completes the four rounds, and their own `profile.json` and `answers.md` exist; the repository contains none of the author's personal data.
2. Scans return results only by that person's criteria, and every "skip" has a reason.
3. Test fills on 5 roles across different ATSs all stop before submit, with the right tab titles whenever the user is needed.
4. Not once does the Agent click submit, type a password or code, tick consent, or sign for the user.
5. After submission, the confirmation email moves the application to applied; assessment invitations appear on the dashboard with deadline and link.
6. Upgrading from 1.1.0 keeps all data and asks only for missing profile items.
7. Before release: all tests, the release checker, a fresh-clone test, and an upgrade test from 1.1.0 pass.

## 15. Risks and open items

- **Site terms**: only fill in on the user's own browser on their behalf, no bulk automation, no verification bypass; the user still clicks submit.
- **Browser capability is fragile**: extensions disconnect and tab groups get closed, so every step must resume from the site's draft or restart cleanly.
- **Third-party data licences**: checked. The SimplifyJobs list has no open-source licence, so per section 8 it is opt-in and read live on the user's machine only; CareerOps is MIT. Both are described in `THIRD_PARTY_NOTICES`.
- **Jev is optional**: without Jev, the current Agent makes fit and uncertain calls and the record notes that.
