#!/usr/bin/env bash
# Runs the dev-only frame-timing benchmark (src/bench.js) on a copy of a
# project and prints the result as JSON. Needs the Vite dev server running
# (`npx vite`) and the native module built (`npm run native`).
#
#   scripts/bench.sh <label> <project-dir> [extra-css]
#
# Each run uses a throwaway Electron profile, so the real app's state is
# untouched.
set -euo pipefail

label=${1:?usage: bench.sh <label> <project-dir> [extra-css]}
project=$(realpath "${2:?project dir}")
css=${3:-}
out=/tmp/galley-bench
cd "$(dirname "$0")/.."

data=$(mktemp -d)
cleanup() {
  # Electron spawns GPU, renderer and utility processes; end the whole group.
  [ -n "${pid:-}" ] && kill -- "-$pid" 2>/dev/null
  rm -rf "$data" "$out/request.json"
}
trap cleanup EXIT

# Work on a copy: the typing scenario edits the document and the app autosaves.
cp -r "$project" "$data/project"
mkdir -p "$out"
rm -f "$out/result.json"
python3 -c 'import json, sys; print(json.dumps({"label": sys.argv[1], "project": sys.argv[2], "css": sys.argv[3]}))' \
  "$label" "$data/project" "$css" > "$out/request.json"

GALLEY_DEV_URL=http://localhost:1420 setsid env -u ELECTRON_RUN_AS_NODE \
  node_modules/.bin/electron . --user-data-dir="$data/profile" > "$data/log" 2>&1 &
pid=$!

for _ in $(seq 240); do
  [ -f "$out/result.json" ] && break
  kill -0 "$pid" 2>/dev/null || { echo "galley exited early:"; cat "$data/log"; exit 1; }
  sleep 0.25
done
[ -f "$out/result.json" ] || { echo "timed out"; cat "$data/log"; exit 1; }
cat "$out/result.json"
