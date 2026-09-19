#!/bin/sh
set -eu

source_repo=${1:?"usage: upgrade-smoke.sh <repository-url-or-path> <from-ref> <to-ref>"}
from_ref=${2:?"missing from-ref"}
to_ref=${3:?"missing to-ref"}
node_bin=${NODE_BIN:-node}
scratch=$(mktemp -d "${TMPDIR:-/tmp}/career-journal-upgrade.XXXXXX")
trap 'rm -rf "$scratch"' EXIT INT TERM

checkout="$scratch/repository"
data_home="$scratch/data-home"
backup_dir="$scratch/pre-upgrade-backup"
git clone --quiet --no-hardlinks "$source_repo" "$checkout"
to_commit=$(git -C "$checkout" rev-parse "$to_ref")
git -C "$checkout" checkout --quiet "$from_ref"
legacy_cli="$checkout/bin/jobops.mjs"
"$node_bin" "$legacy_cli" setup --home "$data_home" --timezone UTC --skip-email
"$node_bin" "$legacy_cli" application add --home "$data_home" --company UpgradeCo --role PreservedRole
"$node_bin" "$legacy_cli" event record --home "$data_home" --id upgradeco-preservedrole --event-id upgrade-event --type application_update --title Received --observed-at 2026-09-19T01:00:00Z --recorded-at 2026-09-19T02:00:00Z
printf 'draft artifact\n' >"$scratch/resume.txt"
"$node_bin" "$legacy_cli" artifact add --home "$data_home" --id upgradeco-preservedrole --kind resume --lifecycle draft --file "$scratch/resume.txt"
"$node_bin" "$legacy_cli" automation configure --home "$data_home" --task local-backup --time 23:00 --timezone UTC --enabled
"$node_bin" -e "const fs=require('node:fs');const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p));c.model={provider:'openai-compatible',baseUrl:'https://example.test/v1',model:'test-model',secretRef:'env:MODEL_KEY'};c.jev={accessState:'enabled',model:'jev-latest',secretRef:'env:JEV_KEY',mode:'shadow'};fs.writeFileSync(p,JSON.stringify(c,null,2)+'\\n',{mode:0o600})" "$data_home/.jobops/config.json"

git -C "$checkout" checkout --quiet "$to_commit"
primary_cli="$checkout/bin/career-journal.mjs"
legacy_cli="$checkout/bin/jobops.mjs"
"$node_bin" "$primary_cli" update --check
"$node_bin" "$legacy_cli" --version >/dev/null
test -f "$data_home/.jobops/config.json"
test ! -e "$data_home/.career-journal/config.json"
"$node_bin" "$primary_cli" backup create --home "$data_home" --output "$backup_dir"
test -f "$backup_dir/jobops.db"
test -f "$backup_dir/artifacts-index.json"
test ! -d "$backup_dir/artifacts"
"$node_bin" -e "const fs=require('node:fs');const rows=JSON.parse(fs.readFileSync(process.argv[1]));if(rows.length!==1||rows[0].applicationId!=='upgradeco-preservedrole'||rows[0].fileName!=='resume.txt'||!rows[0].sha256)process.exit(1)" "$backup_dir/artifacts-index.json"
"$node_bin" "$primary_cli" migrate --home "$data_home" --dry-run
"$node_bin" "$primary_cli" migrate --home "$data_home" --apply
"$node_bin" "$primary_cli" application show --home "$data_home" --id upgradeco-preservedrole >"$scratch/application.json"
grep -q 'UpgradeCo' "$scratch/application.json"
grep -q 'upgrade-event' "$scratch/application.json"
grep -q 'resume.txt' "$scratch/application.json"
"$node_bin" "$legacy_cli" application show --home "$data_home" --id upgradeco-preservedrole >/dev/null
"$node_bin" "$primary_cli" automation configure --home "$data_home" --task local-backup --time 22:45 --timezone UTC --enabled
"$node_bin" "$primary_cli" automation run --home "$data_home" --task local-backup --dry-run >/dev/null
"$node_bin" "$primary_cli" automation run --home "$data_home" --id jobops-local-backup --dry-run >/dev/null
# Scheduler installation is covered by injected unit tests. The upgrade smoke must
# never mutate the developer's real launchd, cron, or Task Scheduler state.
"$node_bin" "$primary_cli" automation list --home "$data_home" >"$scratch/automations.json"
"$node_bin" -e "const fs=require('node:fs');const rows=JSON.parse(fs.readFileSync(process.argv[1]));if(rows.length!==1||rows[0].id!=='jobops-local-backup'||rows[0].schedule!=='22:45')process.exit(1)" "$scratch/automations.json"
grep -q 'env:MODEL_KEY' "$data_home/.jobops/config.json"
grep -q 'env:JEV_KEY' "$data_home/.jobops/config.json"
grep -q 'env:MODEL_KEY' "$backup_dir/config.json"
grep -q 'env:JEV_KEY' "$backup_dir/config.json"
printf 'UPGRADE_SMOKE_OK from=%s to=%s\n' "$from_ref" "$(git -C "$checkout" rev-parse HEAD)"
