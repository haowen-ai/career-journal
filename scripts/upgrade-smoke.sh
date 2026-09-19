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
git -C "$checkout" checkout --quiet "$from_ref"
cli="$checkout/bin/jobops.mjs"
HOME="$scratch/isolated-home" "$node_bin" "$cli" setup --home "$data_home" --timezone UTC --skip-email
HOME="$scratch/isolated-home" "$node_bin" "$cli" application add --home "$data_home" --company UpgradeCo --role PreservedRole

git -C "$checkout" checkout --quiet "$to_ref"
HOME="$scratch/isolated-home" "$node_bin" "$cli" update --check
HOME="$scratch/isolated-home" "$node_bin" "$cli" backup create --home "$data_home" --output "$backup_dir"
HOME="$scratch/isolated-home" "$node_bin" "$cli" migrate --home "$data_home" --dry-run
HOME="$scratch/isolated-home" "$node_bin" "$cli" migrate --home "$data_home" --apply
HOME="$scratch/isolated-home" "$node_bin" "$cli" application list --home "$data_home" --json | grep -q 'UpgradeCo'
printf 'UPGRADE_SMOKE_OK from=%s to=%s\n' "$from_ref" "$(git -C "$checkout" rev-parse HEAD)"
