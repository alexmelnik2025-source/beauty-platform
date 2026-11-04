#!/usr/bin/env bash
# Updates the app on the server: new code from Git, a backup, migrations, new containers,
# then the post-launch check. Usage (in the app folder): ./scripts/update.sh
# Nothing is deleted; if a step fails, the script stops and the running app stays as it was
# until the "up" step.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose --env-file .env -f compose.production.yml)

echo "1/5 New code from Git (main)"
git fetch --quiet origin main
git merge --ff-only origin/main
git log -1 --format='    %h %s (%cd)' --date=short

echo "2/5 Building images"
"${COMPOSE[@]}" build --quiet

echo "3/5 Backup before migrations"
./scripts/backup.sh

echo "4/5 Migrations"
"${COMPOSE[@]}" --profile maintenance run --rm migrate

echo "5/5 Starting the new version"
"${COMPOSE[@]}" up -d api web
./scripts/check.sh
