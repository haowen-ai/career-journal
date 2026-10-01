# CareerOps JSON Bridge Contract

[English](careerops-bridge.md) | [简体中文](careerops-bridge.zh-CN.md)

The API-mode CareerOps adapter invokes a separately installed, pinned `career-ops` checkout. CAREER JOURNAL does not copy CareerOps source code or claim its work as its own.

## Availability

The configured CareerOps root must contain `career-journal-adapter.mjs`. The pinned upstream release does not currently ship this bridge, so API-mode material generation remains unavailable until the user installs a compatible bridge. Codex-native users can still follow the repo-local `careerops-materials` Skill against CareerOps directly. Missing bridge health is a warning and never becomes a fabricated success.

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

Roles without a company, title, or http(s) link are ignored. A missing bridge skips this source; a failed or malformed scan is reported as a source error and the other sources still run.
