# Dogfood Run

- Date:
- Tester:
- Host OS and architecture:
- Node version:
- Path: fresh clone / upgrade
- Source repository:
- From ref:
- To ref:
- Commit tested:

## Isolation

- Temporary checkout:
- Temporary HOME:
- Temporary CAREER JOURNAL data home:
- Existing developer configuration reused: no

## Commands

```text
Paste the exact command and redact only credentials or private application data.
```

## Checks

- [ ] Clone and checkout
- [ ] Setup and second setup
- [ ] Explicit read-only mailbox, live IMAPS verification, and successful initial sync
- [ ] Four schedules created, their returned IDs registered, and every registration live-probed
- [ ] Mail schedule receives the referenced IMAP environment variable from a secure host secret environment; no secret value appears in prompt, scheduler definition, config, logs, or Git
- [ ] Codex prompt contains the returned `codexCommandLine` verbatim as a standalone line, or the native scheduler definition has an exact argv match
- [ ] Every schedule triggered once with the matching external ID
- [ ] Doctor
- [ ] Application creation and persistence
- [ ] Automation dry-run
- [ ] Dashboard health API
- [ ] Secret-free backup with artifact index, no artifact payloads, and mailbox/scheduler health reset
- [ ] Migration dry-run and apply
- [ ] Release checker

## Findings

| Severity | Step | Expected | Actual | Fix or issue |
|---|---|---|---|---|

## Result

- PASS / FAIL:
- Blocking findings:
- Follow-up version:
