#!/usr/bin/env bash
# Checks the local environment and says exactly what to fix.
# Usage: ./scripts/doctor.sh      (compatible with the bash 3.2 that ships with macOS)

cd "$(dirname "$0")/.." || exit 1

problems=0
ok() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✘\033[0m %s\n' "$1"
  printf '      → %s\n' "$2"
  problems=$((problems + 1))
}

echo "Проверка окружения Beauty Platform"
echo

# 1. Node.js 24
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" = "24" ]; then
    ok "Node.js $(node --version)"
  else
    bad "Node.js $(node --version), нужен 24" "fnm install 24 && fnm default 24, затем открой новое окно Терминала"
  fi
else
  bad "Node.js не найден" "brew install fnm && fnm install 24 && fnm default 24"
fi

# 2. pnpm
if pnpm --version >/dev/null 2>&1; then
  ok "pnpm $(pnpm --version 2>/dev/null | head -1)"
else
  bad "pnpm не найден или не запускается" "corepack enable pnpm"
fi

# 3. Docker (Colima)
if ! command -v docker >/dev/null 2>&1; then
  bad "docker не найден" "brew install colima docker docker-compose"
elif docker info >/dev/null 2>&1; then
  ok "Docker запущен"
else
  bad "Docker не запущен" "colima start"
fi

# 4. Containers
if docker info >/dev/null 2>&1; then
  pg_status="$(docker inspect -f '{{.State.Health.Status}}' beauty-postgres 2>/dev/null)"
  if [ "$pg_status" = "healthy" ]; then
    ok "PostgreSQL работает"
  else
    bad "PostgreSQL не запущен (${pg_status:-нет контейнера})" "docker compose up -d"
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' beauty-mailpit 2>/dev/null)" = "true" ]; then
    ok "Mailpit работает (http://localhost:8025)"
  else
    bad "Mailpit не запущен" "docker compose up -d"
  fi
fi

# 5. Settings file
env_file="apps/api/.env"
if [ ! -f "$env_file" ]; then
  bad "Нет файла настроек $env_file" "cp apps/api/.env.example apps/api/.env"
else
  missing=""
  for key in $(grep -E '^[A-Z_]+=' apps/api/.env.example | cut -d= -f1); do
    grep -q "^${key}=" "$env_file" || missing="$missing $key"
  done
  if [ -z "$missing" ]; then
    ok "Файл настроек $env_file"
  else
    bad "В $env_file не хватает:$missing" "cp apps/api/.env.example apps/api/.env"
  fi
fi

# 6. Dependencies
if [ -d node_modules ] && [ -d apps/api/node_modules ] && [ -d apps/api/src/generated/prisma ]; then
  ok "Зависимости установлены"
else
  bad "Зависимости не установлены" "pnpm install"
fi

# 7. Migrations
if [ -d apps/api/node_modules ] && docker info >/dev/null 2>&1; then
  if (cd apps/api && pnpm exec prisma migrate status >/dev/null 2>&1); then
    ok "Миграции базы применены"
  else
    bad "Миграции не применены или база недоступна" "pnpm db:deploy"
  fi
fi

# 8. Port 4000
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -fsS http://localhost:4000/v1/health >/dev/null 2>&1; then
    ok "API уже работает: http://localhost:4000/v1/docs"
  else
    bad "Порт 4000 занят другой программой" "закрой окно Терминала, где запущен старый сервер, или: kill \$(lsof -t -iTCP:4000 -sTCP:LISTEN)"
  fi
else
  ok "Порт 4000 свободен (API пока не запущен — ./scripts/dev.sh)"
fi

echo
if [ "$problems" -eq 0 ]; then
  echo "Всё в порядке."
else
  echo "Найдено проблем: $problems. Выполни команды после стрелок (→) по порядку и запусти проверку снова."
fi
exit "$problems"
