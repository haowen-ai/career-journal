# CareerOps JSON Bridge Contract

[English](careerops-bridge.md) | [简体中文](careerops-bridge.zh-CN.md)

The API-mode CareerOps adapter invokes a separately installed, pinned `career-ops` checkout. CAREER JOURNAL does not copy CareerOps source code or claim its work as its own.

## Availability

The configured CareerOps root must contain `career-journal-adapter.mjs`. The pinned upstream release does not currently ship this bridge, so API-mode material generation remains unavailable until the user installs a compatible bridge. Codex-native users can still follow the repo-local `careerops-materials` Skill against CareerOps directly. Missing bridge health is a warning and never becomes a fabricated success.

Role scans do not need that bridge. When the pinned checkout has no `career-journal-adapter.mjs`, `career-journal scan run` uses the built-in read-only bridge `src/integrations/careerops-scan-bridge.mjs` (see Read-only role scan below). It supports `scan` only.

A legacy v0.1.0-alpha.5-or-earlier config that explicitly names `jobops-adapter.mjs` remains supported. New configurations do not discover or fall back to that legacy bridge; new integrations must expose `career-journal-adapter.mjs`.

## Invocation

CAREER JOURNAL runs:

```text
node <careerops-root>/career-journal-adapter.mjs material prepare|verify
```

It sends one JSON object on standard input. Required fields are:

```json
{
  "action": "prepare",
  "applicationId": "stable-application-id",
  "materialKind": "resume",
  "lifecycle": "draft",
  "jdPath": "/path/to/jd.txt",
  "evidencePath": "/path/to/profile.md",
  "ruleFiles": [
    "/path/to/career-journal/config/material-rules/us-resume-default.md",
    "/path/to/personal-resume-skill/SKILL.md"
  ],
  "requestedOutput": "/path/to/output.pdf"
}
```

For resume requests, `ruleFiles` starts with the built-in CAREER JOURNAL resume defaults and then includes configured personal rule files. Cover-letter requests omit the resume-default file. The bridge must apply files in order, with later files taking precedence; current explicit user instructions remain the highest authority. Resume-only rules must not be applied to cover-letter prose.

The bridge must emit one JSON object on standard output:

```json
{
  "ok": true,
  "applicationId": "stable-application-id",
  "lifecycle": "draft",
  "outputPath": "/path/to/output.pdf",
  "verification": "passed",
  "verificationEvidence": { "factGate": "passed", "renderedFile": "passed" }
}
```

CAREER JOURNAL rejects a missing file, a different application ID, a submitted lifecycle, malformed JSON, or an unsuccessful exit. A valid file is copied into the immutable draft artifact store and hashed before success is reported.

## Read-only role scan

When the search profile sets `sources.careerOps` to `true` and the pinned installation with its bridge is detected, `career-journal scan run` also runs:

```text
node <careerops-root>/career-journal-adapter.mjs scan
```

Standard input is `{ "action": "scan", "readOnly": true }`. The bridge must not write to CareerOps data or contact employers, and must print one JSON object:

```json
{
  "ok": true,
  "roles": [
    { "id": "stable-id", "company": "Example Corp", "title": "Data Science Intern", "url": "https://example.com/jobs/1", "locations": ["New York, NY"], "postedAt": "2026-09-30T00:00:00Z", "description": "Plain text or HTML" }
  ]
}
```

Roles without a company, title, or http(s) link are ignored. A missing or unpinned CareerOps installation skips this source; a failed or malformed scan is reported as a source error and the other sources still run.

### Built-in scan bridge

Without a CareerOps adapter, the scan runs `node <career-journal>/src/integrations/careerops-scan-bridge.mjs scan` with the CareerOps root as its working directory. The bridge runs CareerOps's own `node scan.mjs --dry-run --json`, which writes nothing, and points `CAREER_OPS_SCAN_HISTORY` and `CAREER_OPS_PIPELINE` at a temporary folder. It reads a temporary copy of `portals.yml` (or `CAREER_OPS_PORTALS`) whose `title_filter` keeps internship and co-op titles and whose `location_filter` is removed; every other setting, including `tracked_companies`, is unchanged, and the CareerOps file itself is never edited. Roles come from the receipt's `added_urls` joined with the `+ Company | Title | Location` lines the scan prints for the same offers, so they carry no description. Portal scans have no default time limit; set `careerOps.scanTimeoutMs` to impose one. A supplied overall scan deadline still limits the scan to the remaining time.

The raw bridge (`scan-raw`) calls each `portals.yml` entry's provider itself. Entries with `enabled: false` are not fetched and leave the configured inventory, so their partition is retired instead of failing every night. Provider HTTP calls that set no timeout get 30 seconds (CareerOps's own default is 10); an entry can set `timeout_ms`. A transient failure (timeout, network error, HTTP 429 or 5xx) is retried twice in the same run, after 2 and 5 seconds; a definite answer such as HTTP 404 is not. Each partition reports its `attempts`, and the scan receipt gives `failStreak`, the number of runs in a row that a partition has ended in an error or a capped list.
