# Two-minute apply — design

Status: approved for screening scope, 2026-10-26.

## Intent

CAREER JOURNAL is open source. Each user installs it on their own Mac and runs it with their own coding agent (Claude Code or Codex) and their own browser. The product promise:

> When a busy job seeker decides to apply, they say "prepare 10". The agent fills the forms for the ten best eligible roles in their own browser and stops before Submit; the user reviews each tab and submits all ten in about two minutes of their own time.

Finding roles, reading each official posting, judging eligibility and ranking happen unattended in the background on the user's chosen cadence. Filling happens **on demand**, when the user asks — never ahead of time, so forms never sit and expire. The user's time is the review and the click.

Why now: the maintainer's own season showed that (a) the scan silently missed many matching roles (disabled source, stale board tags, narrow keyword and city lists, title-similarity dedupe), (b) roles reached the queue on inferred eligibility and were wrong when the posting was read, and (c) unattended runs stalled on permission prompts. Those failures, not missing features, are what stand between today's tool and the promise.

## This release (decided 2026-10-26)

This release upgrades **role screening only**: collect → certain exclusions → official read → escalation → rank, plus the review queue, source health, budgets, retention and the evaluation gate that keep screening correct and bounded.

The apply flow stays exactly as it works today: when the user asks, the agent fills the chosen roles in the user's Chrome, one tab each, and stops before Submit. The user creates accounts and signs in themselves. **Each tab's title says what the user still has to do** (for example: ready to submit; create account / sign in first; essay to write; transcript or references needed; assessment link), so the user can work through the tabs without opening notes. No new browser machinery is built.

Deferred to a later release (described below for direction, not built now): the first-run wizard (§3), configurable cadence and the controller (§4 — the existing 21:00 launchd job stays), readiness re-check tooling, and packaging for other users' search types. Goals 1, 4 and 5 belong to that later release.

## Goals

1. **On-demand ready tabs.** When the user asks ("prepare N", default 10), the agent fills the top N eligible roles in the user's Chrome, one tab each, stopped before Submit. Before announcing them it re-checks each form (page still loaded, fields and upload present). Roles that need a sign-in, account creation, verification code, consent or an essay are listed separately in a **needs-you lane** and are not counted in the two-minute set.
2. **High recall within configured sources.** A role that matches the user's settings is not lost to metadata quirks. Uncertain cases are checked against the official posting, never silently dropped.
3. **Correct eligibility before a role is queued.** Every queued role was judged from the full official posting with verbatim quotes for degree, term, location, work authorization, and required qualifications.
4. **One-time setup.** A first-run wizard completes every login, permission and preference in one sitting (about 10 minutes) and proves the whole chain once. After that, scheduled runs never wait on a prompt.
5. **User-chosen cadence** for background discovery/judgment: daily, weekdays, weekly, or custom. A lightweight daily deadline check (no discovery) alerts when a ready-to-apply role closes before the next run.
6. **Bounded data and runtime.** Storage and per-run work stay flat over a season regardless of cadence.

## Non-goals

- Windows or Linux support. macOS only (launchd, Apple Mail, Chrome).
- A hosted service, shared server, or central account. All data stays on the user's Mac.
- Writing essays, cover letters, or "why us" answers in the user's place.
- Taking assessments or attending interviews.

## Anti-goals (failure even if it "works")

- Submitting anything without the user's own click, or applying twice to the same posting.
- Queuing a role the user is not eligible for, or hiding one they are eligible for, without a quoted reason.
- Typing passwords, creating accounts, entering verification codes, or solving CAPTCHAs by an AI agent.
- Storing credentials or personal data in the repository, logs or prompts.
- A run that stalls on a prompt nobody sees, or a data folder that grows every day.

## Constraints

- Safety: the agent (any Claude- or Codex-driven agent) never signs in, creates accounts, types passwords or codes, ticks consent boxes, or clicks Submit. This is fixed, not configurable.
- Accounts: the agent never creates accounts or signs in (a fixed safety boundary of Claude-based agents, not a product setting). Account creation and sign-in are made fast instead: the user fills the sign-up/sign-in page and the Mac's Passwords app or 1Password generates/fills the password (about 30 seconds per site, once per employer system). After the user signs in, the agent continues filling the rest of that form.
- Hosts: works with whichever agent the user has (Claude Code or Codex); judgments go through an adapter so the model can be swapped.
- Privacy (disclosed at setup): profile, answers, resume, transcript, mail and application history are stored only on the user's Mac, in a data home outside the code checkout. Each judgment or fill sends only the fields it needs (posting text, relevant profile facts) to the model provider the user chose (Anthropic or OpenAI). Credentials are never sent or stored by the product.
- Jev is removed from the product (README, onboarding, mail pipeline, decision routing).

## Decided

- **Audience and setup:** open source, each user on their own Mac.
- **Search scope:** internships, co-ops and full-time (new grad and experienced) are all supported; the onboarding interview collects directions, locations, terms, degree, authorization and company preferences. Nothing is hard-coded to one user's search.
- **Cadence:** configurable; deadline-aware extra alert.
- **Platform:** macOS only.
- **Apply flow:** unchanged from today — the user asks, the agent fills, the user reviews and submits; tab titles state what the user must still do (sign up, essay, etc.).
- **Accounts:** user creates/signs in with their password manager; agent continues afterwards.
- **Jev:** removed.
- **Privacy:** local storage; only needed fields go to the user's chosen model provider, disclosed at setup.

## Design

### 1. Two layers: code moves data, written rules drive judgment

- **Data layer (code, deterministic):** collect listings from the configured sources, store observations, establish posting identity, apply only certain exclusions, prune old data. Fast, cheap, testable, identical every run.
- **Judgment layer (agent + Markdown rules):** read the official posting and decide eligibility, fit, and how to fill each form. Rules live in editable Markdown (screening rules, fit rules, answer rules, apply brief). Users change behavior by editing those files or answering onboarding questions — not by changing code. Code validates the agent's output (quotes must appear in the fetched text; whole AND/OR clauses; required vs preferred sections) and owns all state changes.

### 2. Funnel

| Stage | Owner | Drops only when | Otherwise |
|---|---|---|---|
| Collect | code | — | every listing becomes an observation with source provenance; inactive/unlisted kept |
| Certain exclusions | code | user-excluded company or exact posting; all known locations non-US with complete location data; exact requisition already submitted | pass |
| Official read | code fetch + cheap model | — | eligible / not eligible (quoted) / unclear |
| Escalation | stronger model | — | every "not eligible" and "unclear" from the cheap model is rechecked |
| Rank | code | never drops | fit, deadline, location preference, company load; low fit stays visible as low priority |
| Prepare (on demand) | one browser coordinator agent, sequential | — | top N eligible roles filled when the user asks, stopped before Submit; final re-check before announcing; needs-you lane for sign-in/new account/consent/essay |
| Confirm | mail sync + user | — | each prepared role moves ready → submitted-unconfirmed (user says or site shows) → confirmed (receipt); never refilled while unconfirmed; assessments/interviews become tasks |

Unclear items wait in a durable review queue that every run drains first (including zero-discovery days), with retry and a maximum wait; items needing the user are listed in the run summary.

### 3. First-run wizard (one sitting) — later release

1. Install, then `career-journal setup` walks through: Chrome + extension sign-in; Apple Mail access for the job-search inboxes; the agent's tool permissions written as a scoped allowlist (product folder, product database, read-only mail, browser reading) after the user approves once; profile interview (directions, locations, terms, degree, authorization, companies, cadence, N); resume and answer sheet.
2. The wizard ends with a live dry run: one scan, one official-text judgment, one form filled to the ready state. Setup is "done" only when each step passed.
3. Mechanical jobs (collect, prune, notify) run from launchd and never prompt. Agent jobs run with the pre-approved allowlist.
4. Every run starts with `doctor`; a broken permission or expired login produces one notification naming the item and the fix, instead of a silent stall.

### 4. Cadence and notifications — later release

- One launchd-woken controller claims due work and runs it in order (mail catch-up → collect → judge → prune), so overlapping schedules cannot collide. Discovery cadence is a profile setting (daily / weekdays / weekly / custom); mail catch-up uses a durable watermark, so multi-day gaps are covered.
- Health checks follow the chosen cadence (next due time + grace), not a fixed 36 hours.
- A daily deadline check (cheap, no discovery) notifies when a ready-to-apply role closes before the next run.
- One notification per run: "M new eligible roles; K deadlines this week". Preparing never runs on a schedule.

### 5. Pre-mortem: what will go wrong, and the guard built in now

| Risk | Guard |
|---|---|
| Data folder grows daily (raw listings, fetched pages, model outputs) | Retention policy (§6) run by launchd every night; raw scan output kept 14 days; size reported in the run summary |
| A run takes hours (thousands of listings, slow sites) | Collect is code-only; official reads only for listings that pass certain exclusions and are new or changed; per-run budget with deadline-first order and aging; content-hash cache so unchanged postings are not re-read |
| Model quota exhausted mid-run | Budget reserved before each call; stop cleanly, carry work to next run; fall back to the second configured agent if the user has one |
| Agent context overflow on long batches | One role per agent call with a fixed small brief; batch results written to the database, not kept in context |
| Source silently disabled or broken | Per-source counts with 7-day baseline; zero or a >50% drop is an alert |
| Board metadata wrong (tags, degree, term, rolled-up locations) | Metadata never rejects; only the official text does |
| Duplicate applications | Identity by requisition / canonical URL with aliases; title similarity only links for review; submitted history always checked before preparing |
| Wrong eligibility from one model | Cheap model + stronger-model recheck of every negative/unclear; quote validation; a frozen evaluation set run before any rule or model change |
| Permission prompt stalls unattended run | Wizard pre-approves; launchd for mechanical work; `doctor` first; notification on failure |
| Browser extension disconnects / tabs closed | Prepare step re-opens its own tab; drafts on Workday-type sites resume; never reloads a half-filled page |
| Form expired / tab discarded between fill and review | Fill on demand; final re-check right before announcing; a tab that lost its page or session is refilled or moved to the needs-you lane |
| CAPTCHA / bot checks | Never bypassed; tab marked for the user |
| Posting closes or changes after queuing | Freshness re-check before prepare; changed or closed roles leave the ready set |
| Personal data leaks into the public repo | Release check scans for personal data; fixtures are synthetic |
| Machine asleep at run time | Background work only; controller resumes on wake in order and reports lateness; nothing user-facing depends on it |
| Agent clicks a submit-like control (Enter, renamed/non-English buttons, auto-submit scripts) | Fill only through constrained operations; unknown transitions stop the tab; adversarial and non-English flows in acceptance tests |
| Page text tries to instruct the agent | Posting and page content treated as data; never followed |
| User submitted but no receipt yet | submitted-unconfirmed state; never refilled; reconciled when mail or the site confirms |

### 6. Data retention

| Data | Kept |
|---|---|
| Applications, events, user decisions, quotas | Forever (needed for duplicates and quotas) |
| Postings judged not eligible | One row (company, title, requisition, reason) forever; full text 60 days |
| Official posting text for queued roles | Until 30 days after submit or close |
| Expired / removed leads | Archived as closed 30 days after deadline; row kept for identity |
| Raw daily scan output | 14 days, then only the run summary |
| Model raw output | 14 days; decision + quotes kept in the database |
| Work folders | 30 days, then compressed |
| Database backups | Weekly, last 4 |

Pruning never touches applications, user decisions, the resume or the transcript, skips files referenced by active work, and reports what it removed.

### 7. Success measures

- User review time for N ready tabs (target ≤ 2 minutes for 10), measured separately from fill time and from needs-you lane time.
- Fill success: share of requested N actually ready, with shortfall reasons.
- Share of prepared tabs that were submitted without edits.
- Recall on a private golden set (roles the user applied to or marked as missed) — must not drop between releases.
- Zero duplicate submissions; zero unattended runs stalled on a prompt.
- Data folder size flat week over week.

## Left to the builder

- Exact schema and migration, review-queue mechanics, retry intervals, budgets (the funnel-v3 spec and tests on branch `feat/funnel-v3` are the starting point, to be reduced to this design's scope).
- Prompt wording and output schema for the official read (an evaluation harness exists from 2026-10-26: cheap model 31/33 correct, 0 false accepts; stronger-model recheck caught both errors).
- Notification wording and dashboard layout.

## Build approach (how the maintainers work on this)

- Think first: each change starts with its failure list (as in §5) before code.
- Tools: test-first for the data layer; the frozen evaluation set for any judgment change; the code graph (Graphify) for impact maps before editing shared functions; parallel sub-agents for independent work; reviews by an independent model (Codex) of every plan, skeleton and finished change, with each point judged on evidence.

## Calls made by the maintainer (from the 2026-10-26 reviews; check while reading)

1. **Background is code plus headless judgment only.** The launchd controller runs collection, pruning and mail catch-up as code, and judgment through the host CLI in non-interactive mode (`codex exec` / `claude -p`) with a structured output schema. No browser work is scheduled, so no unattended browser permissions are needed; filling always happens in a session the user started.
2. **One browser coordinator fills tabs sequentially**; parallelism is used for judgment, not for browser work.
3. **Readiness is evidence, not a title**: a tab counts as ready only after a re-check of the loaded form, required fields and uploaded resume right before the user is told.
4. **Identity and recovery guarantees from the funnel reviews carry over**: exact-posting identity with aliases (title similarity only links for review), durable review queue drained every run, versioned judgments, atomic visibility updates on every verdict, old held leads recovered, stale writers fenced, user decisions preserved. Every scan/apply consumer of the old metadata filters is replaced in the same release; geographic exclusions are relative to the user's profile, not hard-coded "non-US".
5. **Retention has byte and count budgets**, not only ages: hot data (raw scans, fetched pages, model outputs, screenshots, briefs, temp files) is capped; permanent records are compacted to one identity row; abandoned work expires; SQLite is vacuumed after pruning; backups cover profile, answers, rules and material versions; total managed storage is reported each run.
6. **Budgets cover the whole run**: model attempts including transport retries, fetches, wall-clock; old and unknown-deadline work has reserved capacity and a maximum age with a breach notice. Provider quota is not assumed knowable; hitting it ends the run cleanly and carries work forward.
7. **Source completeness per employer/partition** against an expected-source manifest (empty / partial / disabled / stale are distinct), with periodic official-board samples; cold-start rule for new sources.
8. **Judgment evaluation is a maintainer release gate**, broadened beyond one profile: other search types (full-time, co-op), unknown candidate facts, wrong/incomplete pages and confidently wrong positives; accepted decisions are sampled too. Users who edit rule files get a warning to run the bundled smoke set; it does not block them.
9. **Existing Windows, cron and standalone IMAP support stay as they are**; new features target macOS and must not break them, but are not extended there.
10. **Migration**: existing 2.x installs migrate in place (schema migration with backup, old writers paused, host task IDs re-registered to the controller); fresh installs use the wizard.
11. **Data home outside the checkout is enforced** (setup refuses a home inside the repository); logs and briefs are redacted; credentials are never collected.
