#!/usr/bin/env bash
# First launch on the server, after scripts/server-setup.sh and after you filled in SMTP in .env:
# builds the images, starts the database, applies the migrations, starts API and web, checks.
# Usage (as the app user, in the app folder): ./scripts/start.sh
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose --env-file .env -f compose.production.yml)

if grep -qE 'replace-|example\.invalid' .env; then
  echo "Fill in .env first — these lines still have example values:" >&2
  grep -nE 'replace-|example\.invalid' .env | sed -E 's/=.*/=…/' >&2
  exit 1
fi

echo "1/4 Building images (takes a few minutes the first time)"
"${COMPOSE[@]}" build --quiet
echo "2/4 Starting the database"
"${COMPOSE[@]}" up -d --wait postgres
echo "3/4 Migrations"
"${COMPOSE[@]}" --profile maintenance run --rm migrate
echo "4/4 Starting API and web"
"${COMPOSE[@]}" up -d api web
./scripts/check.sh
