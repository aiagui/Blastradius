#!/usr/bin/env bash
# Reads GitHub Actions check runs for one commit (a stream of JSON objects with
# name, id, status, conclusion) on stdin and passes only if every required CI
# check, matched by exact name, has its latest run completed with success.
# Every other check run (CodeQL, the release job itself, ...) is ignored.
set -euo pipefail

required='[
  "typecheck, lint, test, build (Node 22)",
  "typecheck, lint, test, build (Node 24)"
]'

results="$(jq -s -r --argjson req "$required" '
  . as $runs
  | $req[] as $n
  | ([$runs[] | select(.name == $n)] | sort_by(.id) | last) as $r
  | if $r == null then "\($n)\tmissing\tnone"
    else "\($n)\t\($r.status)\t\($r.conclusion // "none")" end
')"

bad=0
while IFS=$'\t' read -r name status conclusion; do
  echo "$name: $status/$conclusion"
  if [ "$status" != "completed" ] || [ "$conclusion" != "success" ]; then
    echo "::error::Required check '$name' is $status/$conclusion, not completed/success."
    bad=1
  fi
done <<<"$results"
exit "$bad"
