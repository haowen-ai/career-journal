# CareerOps JSON Bridge Contract

The API-mode CareerOps adapter invokes a separately installed, pinned `career-ops` checkout. Job Search Ops does not copy CareerOps source code or claim its work as its own.

## Availability

The configured CareerOps root must contain `jobops-adapter.mjs`. The pinned upstream release does not currently ship this bridge, so API-mode material generation remains unavailable until the user installs a compatible bridge. Codex-native users can still follow the repo-local `careerops-materials` Skill against CareerOps directly. Missing bridge health is a warning and never becomes a fabricated success.

## Invocation

Job Search Ops runs:

```text
node <careerops-root>/jobops-adapter.mjs material prepare|verify
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
  "requestedOutput": "/path/to/output.pdf"
}
```

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

Job Search Ops rejects a missing file, a different application ID, a submitted lifecycle, malformed JSON, or an unsuccessful exit. A valid file is copied into the immutable draft artifact store and hashed before success is reported.
