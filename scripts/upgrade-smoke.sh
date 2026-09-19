#!/bin/sh
set -eu

source_repo=${1:?"usage: upgrade-smoke.sh <repository-url-or-path> <from-ref> <to-ref>"}
from_ref=${2:?"missing from-ref"}
to_ref=${3:?"missing to-ref"}
node_bin=${NODE_BIN:-node}
scratch=$(mktemp -d "${TMPDIR:-/tmp}/jobops-upgrade.XXXXXX")
trap 'rm -rf "$scratch"' EXIT INT TERM

checkout="$scratch/repository"
data_home="$scratch/data-home"
backup_dir="$scratch/pre-upgrade-backup"
git clone --quiet --no-hardlinks "$source_repo" "$checkout"
to_commit=$(git -C "$checkout" rev-parse "$to_ref")
git -C "$checkout" checkout --quiet "$from_ref"
cli="$checkout/bin/jobops.mjs"
HOME="$scratch/isolated-home" "$node_bin" "$cli" setup --home "$data_home" --timezone UTC --skip-email
HOME="$scratch/isolated-home" "$node_bin" "$cli" application add --home "$data_home" --company UpgradeCo --role PreservedRole
HOME="$scratch/isolated-home" "$node_bin" "$cli" event record --home "$data_home" --id upgradeco-preservedrole --event-id upgrade-event --type application_update --title Received --observed-at 2026-09-19T01:00:00Z --recorded-at 2026-09-19T02:00:00Z
printf 'draft artifact\n' >"$scratch/resume.txt"
HOME="$scratch/isolated-home" "$node_bin" "$cli" artifact add --home "$data_home" --id upgradeco-preservedrole --kind resume --lifecycle draft --file "$scratch/resume.txt"
HOME="$scratch/isolated-home" "$node_bin" "$cli" automation configure --home "$data_home" --task local-backup --time 23:00 --timezone UTC --enabled
"$node_bin" -e "const fs=require('node:fs');const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p));c.model={provider:'openai-compatible',baseUrl:'https://example.test/v1',model:'test-model',secretRef:'env:MODEL_KEY'};c.jev={accessState:'enabled',model:'jev-latest',secretRef:'env:JEV_KEY',mode:'shadow'};fs.writeFileSync(p,JSON.stringify(c,null,2)+'\\n',{mode:0o600})" "$data_home/.jobops/config.json"

git -C "$checkout" checkout --quiet "$to_commit"
HOME="$scratch/isolated-home" "$node_bin" "$cli" update --check
HOME="$scratch/isolated-home" "$node_bin" "$cli" backup create --home "$data_home" --output "$backup_dir"
HOME="$scratch/isolated-home" "$node_bin" "$cli" migrate --home "$data_home" --dry-run
HOME="$scratch/isolated-home" "$node_bin" "$cli" migrate --home "$data_home" --apply
HOME="$scratch/isolated-home" "$node_bin" "$cli" application show --home "$data_home" --id upgradeco-preservedrole >"$scratch/application.json"
grep -q 'UpgradeCo' "$scratch/application.json"
grep -q 'upgrade-event' "$scratch/application.json"
grep -q 'resume.txt' "$scratch/application.json"
HOME="$scratch/isolated-home" "$node_bin" "$cli" automation list --home "$data_home" | grep -q 'jobops-local-backup'
grep -q 'env:MODEL_KEY' "$data_home/.jobops/config.json"
grep -q 'env:JEV_KEY' "$data_home/.jobops/config.json"
grep -q 'env:MODEL_KEY' "$backup_dir/config.json"
grep -q 'env:JEV_KEY' "$backup_dir/config.json"
find "$backup_dir/artifacts" -type f -name '*resume.txt' | grep -q .
printf 'UPGRADE_SMOKE_OK from=%s to=%s\n' "$from_ref" "$(git -C "$checkout" rev-parse HEAD)"
