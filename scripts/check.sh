#!/usr/bin/env bash
# Checks the app after a launch or an update: containers healthy, the API answers through the
# web server, the public HTTPS address opens. Usage: ./scripts/check.sh
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
COMPOSE=(docker compose --env-file .env -f compose.production.yml)
problems=0
ok() { printf '  OK   %s\n' "$1"; }
bad() {
  printf '  FAIL %s\n' "$1"
  problems=$((problems + 1))
}

url="$(grep -E '^APP_WEB_URL=' .env | cut -d= -f2- | tr -d '"')"
port="$(grep -E '^WEB_PORT=' .env | cut -d= -f2- | tr -d '"')"
port="${port:-3000}"

echo "Checking Beauty Platform"
for service in postgres api web; do
  state="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.State}} {{.Health}}' | awk -v s="$service" '$1 == s')"
  case "$state" in
    *running\ healthy* | "web running "*) ok "$service: $state" ;;
    *) bad "$service is not healthy: ${state:-not running}" ;;
  esac
done

# Give a freshly started stack up to a minute.
for _ in $(seq 1 12); do
  curl -fsS "http://127.0.0.1:$port/v1/health" > /dev/null 2>&1 && break
  sleep 5
done
if curl -fsS "http://127.0.0.1:$port/v1/health" > /dev/null; then
  ok "API answers through the web server (127.0.0.1:$port/v1/health)"
else
  bad "API does not answer on 127.0.0.1:$port/v1/health — see: docker compose -f compose.production.yml logs api"
fi
if curl -fsS -o /dev/null "http://127.0.0.1:$port/pl/salons"; then
  ok "Web pages open (catalogue)"
else
  bad "Web page /pl/salons does not open — see: docker compose -f compose.production.yml logs web"
fi
if [ -n "$url" ] && curl -fsS -o /dev/null --max-time 15 "$url/v1/health"; then
  ok "Public address works: $url"
else
  bad "Public address $url does not open over HTTPS — check DNS (A record) and Caddy: journalctl -u caddy"
fi

if [ "$problems" -eq 0 ]; then
  echo "All good."
else
  echo "Problems: $problems"
  exit 1
fi
