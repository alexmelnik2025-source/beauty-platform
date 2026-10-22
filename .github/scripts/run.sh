#!/usr/bin/env bash
# Runs a command; on failure, publishes the last lines of its output as a
# GitHub Actions error annotation, so the failure is visible in the run summary.
set -uo pipefail

log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ]; then
  tail -n 60 "$log" \
    | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/%/%25/g' \
    | awk 'BEGIN { ORS = "%0A" } { print }' \
    | { read -r body; echo "::error title=Failed: $*::${body}"; }
fi

exit "$status"
