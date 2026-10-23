#!/usr/bin/env bash
# Starts everything for local development with one command:
#   ./scripts/dev.sh
# Docker (Colima) → database and Mailpit → settings → dependencies → migrations → API.
# Stops at the first problem and says what to do. Compatible with macOS bash 3.2.

cd "$(dirname "$0")/.." || exit 1

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
fail() {
  printf '\n\033[31m✘ %s\033[0m\n' "$1"
  printf '  Пришли в чат скриншот текста выше. Подробная проверка: ./scripts/doctor.sh\n'
  exit 1
}

step "1/6 Docker"
if ! docker info >/dev/null 2>&1; then
  if command -v colima >/dev/null 2>&1; then
    echo "Docker не запущен — запускаю Colima (1–3 минуты)..."
    colima start || fail "Colima не запустилась"
  else
    fail "Docker не найден. Установи: brew install colima docker docker-compose"
  fi
fi
echo "Docker работает"

step "2/6 База данных и Mailpit"
docker compose up -d --wait || fail "Контейнеры не запустились"

step "3/6 Файл настроек"
if [ ! -f apps/api/.env ]; then
  cp apps/api/.env.example apps/api/.env
  echo "Создан apps/api/.env"
else
  missing=""
  for key in $(grep -E '^[A-Z_]+=' apps/api/.env.example | cut -d= -f1); do
    grep -q "^${key}=" apps/api/.env || missing="$missing $key"
  done
  if [ -n "$missing" ]; then
    cp apps/api/.env apps/api/.env.backup
    cp apps/api/.env.example apps/api/.env
    echo "В настройках не хватало:$missing — файл обновлён (старый сохранён в apps/api/.env.backup)"
  else
    echo "apps/api/.env в порядке"
  fi
fi

step "4/6 Зависимости"
pnpm install || fail "pnpm install завершился с ошибкой"

step "5/6 Миграции базы"
pnpm db:deploy || fail "Миграции не применились"

step "6/6 API и веб-кабинет"
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Порт 4000 уже занят — возможно, сервер запущен в другом окне Терминала. Закрой его и запусти снова"
fi
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Порт 3000 уже занят — закрой другую программу или окно Терминала с сервером и запусти снова"
fi
echo "Когда в окне появится «Ready» — открывай в браузере http://localhost:3000"
echo "Документация API: http://localhost:4000/v1/docs. Письма: http://localhost:8025."
echo "Остановить: Control + C."
exec pnpm dev
