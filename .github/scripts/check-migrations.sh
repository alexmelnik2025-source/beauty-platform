#!/usr/bin/env bash
# Fails when prisma/schema.prisma has changes that no migration covers.
# On failure prints the exact SQL that a new migration must contain.
set -uo pipefail
cd apps/api

pnpm exec prisma migrate deploy >/dev/null || { echo "::error title=migrate deploy failed::see log"; exit 1; }

sql="$(pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script 2>&1)"
status=$?
echo "$sql"

if [ "$status" -ne 0 ]; then
  body="$(printf '%s' "$sql" | sed -e 's/%/%25/g' | awk 'BEGIN { ORS = "%0A" } { print }')"
  echo "::error title=migrate diff failed::${body}"
  exit 1
fi

# An empty diff prints only comments such as "-- This is an empty migration."
if printf '%s' "$sql" | grep -vE '^\s*(--.*)?$' >/dev/null; then
  body="$(printf '%s' "$sql" | sed -e 's/%/%25/g' | awk 'BEGIN { ORS = "%0A" } { print }')"
  echo "::error title=Schema changes without a migration::${body}"
  exit 1
fi

echo "Migrations match schema.prisma"
