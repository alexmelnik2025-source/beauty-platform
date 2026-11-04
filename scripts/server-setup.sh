#!/usr/bin/env bash
# Prepares a clean Ubuntu 22.04/24.04 server (VPS in the EU) for Beauty Platform:
# Docker, Caddy (automatic HTTPS), firewall, an app user, the code, .env with fresh random
# passwords, the HTTPS site for your domain and a daily database backup (kept 14 days).
# Nothing is bought or signed up for; no secrets are stored in this script or in Git.
#
# Usage, as root on the server:
#   curl -fsSLO https://raw.githubusercontent.com/<owner>/beauty-platform/main/scripts/server-setup.sh
#   bash server-setup.sh rezerwacje.example.pl
# Optional: REPO_URL=… APP_DIR=/opt/beauty-platform APP_USER=beauty bash server-setup.sh <domain>
# Safe to run again: existing .env, code and cron lines are kept.
set -euo pipefail

DOMAIN="${1:-}"
REPO_URL="${REPO_URL:-https://github.com/alexmelnik2025-source/beauty-platform.git}"
APP_DIR="${APP_DIR:-/opt/beauty-platform}"
APP_USER="${APP_USER:-beauty}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo bash server-setup.sh <domain>)." >&2
  exit 1
fi
if ! printf '%s' "$DOMAIN" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
  echo "Give the domain for the booking site, e.g.: bash server-setup.sh rezerwacje.example.pl" >&2
  exit 1
fi
# shellcheck source=/dev/null
. /etc/os-release
if [ "${ID:-}" != ubuntu ]; then
  echo "This script is written for Ubuntu (found: ${PRETTY_NAME:-unknown})." >&2
  exit 1
fi

step() { printf '\n== %s\n' "$1"; }
export DEBIAN_FRONTEND=noninteractive

step "1/8 System packages and automatic security updates"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git ufw openssl unattended-upgrades \
  debian-keyring debian-archive-keyring apt-transport-https
dpkg-reconfigure -f noninteractive unattended-upgrades

step "2/8 Docker Engine and Compose (official Docker repository)"
if ! command -v docker > /dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

step "3/8 Caddy (HTTPS certificates are issued and renewed automatically)"
if ! command -v caddy > /dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

step "4/8 Firewall: only SSH, HTTP and HTTPS are open"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

step "5/8 App user and code in $APP_DIR"
id "$APP_USER" > /dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
usermod -aG docker "$APP_USER"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

step "6/8 .env with new random passwords (kept if it already exists)"
if [ ! -f "$APP_DIR/.env" ]; then
  db_password="$(openssl rand -hex 24)"
  jwt_secret="$(openssl rand -hex 32)"
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$db_password|" \
    -e "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$jwt_secret|" \
    -e "s|^APP_WEB_URL=.*|APP_WEB_URL=https://$DOMAIN|" \
    "$APP_DIR/.env.example" > "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "Created $APP_DIR/.env — SMTP_URL, MAIL_FROM and PLATFORM_ADMIN_EMAILS still need your values."
else
  echo "$APP_DIR/.env exists — not changed."
fi

step "7/8 HTTPS site https://$DOMAIN"
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy
sed "s|booking.example.invalid|$DOMAIN|" "$APP_DIR/deploy/Caddyfile.example" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload-or-restart caddy

step "8/8 Daily database backup at 03:15 UTC, kept 14 days"
line="15 3 * * * $APP_DIR/scripts/backup.sh >> $APP_DIR/backups/backup.log 2>&1"
mkdir -p "$APP_DIR/backups"
chown "$APP_USER:$APP_USER" "$APP_DIR/backups"
chmod 700 "$APP_DIR/backups"
(crontab -u "$APP_USER" -l 2> /dev/null | grep -vF "$APP_DIR/scripts/backup.sh" || true; echo "$line") \
  | crontab -u "$APP_USER" -

cat << DONE

Server is ready. Next steps (docs/DEPLOY.md, step 4 onwards):
  1. DNS: an A record for $DOMAIN pointing to this server's IP.
  2. Fill in SMTP in .env:   sudo -u $APP_USER nano $APP_DIR/.env
  3. First launch:           sudo -u $APP_USER $APP_DIR/scripts/start.sh
DONE
