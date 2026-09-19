#!/bin/sh
set -eu

source_repo=${1:?"usage: fresh-clone-smoke.sh <repository-url-or-path> [ref]"}
source_ref=${2:-HEAD}
node_bin=${NODE_BIN:-node}
scratch=$(mktemp -d "${TMPDIR:-/tmp}/jobops-fresh.XXXXXX")
server_pid=
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

checkout="$scratch/repository"
data_home="$scratch/data-home"
backup_dir="$scratch/backup"
git clone --quiet --no-hardlinks "$source_repo" "$checkout"
git -C "$checkout" checkout --quiet "$source_ref"
cli="$checkout/bin/jobops.mjs"

HOME="$scratch/isolated-home" "$node_bin" "$cli" setup --home "$data_home" --timezone UTC --skip-email
HOME="$scratch/isolated-home" "$node_bin" "$cli" doctor --home "$data_home"
HOME="$scratch/isolated-home" "$node_bin" "$cli" application add --home "$data_home" --company DogfoodCo --role TestEngineer
HOME="$scratch/isolated-home" "$node_bin" "$cli" automation configure --home "$data_home" --task deadline-review --time 20:00 --timezone UTC --enabled
HOME="$scratch/isolated-home" "$node_bin" "$cli" automation run --home "$data_home" --task deadline-review --dry-run

server_log="$scratch/server.log"
HOME="$scratch/isolated-home" "$node_bin" "$cli" start --home "$data_home" --port 0 >"$server_log" 2>&1 &
server_pid=$!
i=0
while [ "$i" -lt 50 ] && ! grep -q 'http://127.0.0.1:' "$server_log"; do
  sleep 0.1
  i=$((i + 1))
done
dashboard_url=$(sed -n 's/^Job Search Ops dashboard: //p' "$server_log" | head -1)
if [ -z "$dashboard_url" ]; then cat "$server_log"; exit 1; fi
"$node_bin" -e "const r=await fetch(process.argv[1]); const j=await r.json(); if(!r.ok||j.ok!==true) process.exit(1)" "$dashboard_url/api/health"
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=

HOME="$scratch/isolated-home" "$node_bin" "$cli" backup create --home "$data_home" --output "$backup_dir"
HOME="$scratch/isolated-home" "$node_bin" "$cli" setup --home "$data_home" --timezone UTC
HOME="$scratch/isolated-home" "$node_bin" "$cli" application list --home "$data_home" --json | grep -q 'DogfoodCo'
printf 'FRESH_CLONE_SMOKE_OK ref=%s\n' "$(git -C "$checkout" rev-parse HEAD)"
