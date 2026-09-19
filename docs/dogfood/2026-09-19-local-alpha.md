# Local Alpha Dogfood Run

- Date: 2026-09-19
- Host: macOS, isolated temporary checkout and HOME
- Node: 24.19.0
- Repository source: local Git worktree
- Target: `v0.1.0-alpha.1` candidate

## Fresh clone

**PASS** at commit `259de25862ce828653bee10691e96413200b4b48`.

Verified setup, doctor, application creation, automation configuration and dry-run, dashboard health API, secret-free backup, repeated setup, and persisted application data. Optional CareerOps, email, and Jev capabilities correctly remained warnings.

## Upgrade

First run from `e9996fa` exposed one script bug: checking out `HEAD` after the older revision kept the checkout on that older detached commit, so `jobops update` was unavailable.

The script now resolves the target commit before switching to the older revision. The rerun **passed** from `e9996fa` to `b530a16ca2013c07fbb198904899f8781536ec31`, preserving the application through update inspection, backup, migration dry-run, and migration apply.

## Isolation and privacy

- Existing developer HOME and Job Search Ops data were not reused
- All test records used synthetic companies and roles
- Temporary checkouts, data, logs, and backups were deleted after each run
- No email account or credential was configured
