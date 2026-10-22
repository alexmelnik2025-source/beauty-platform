# Beauty Platform

Платформа онлайн-записи для барбершопов и салонов красоты в Польше.
Сейчас реализован каркас проекта (задача 1): API с проверкой состояния, база данных в Docker, тесты и CI.

Спецификация MVP и план — в [docs/README.md](docs/README.md).

## Что нужно на компьютере

| Инструмент | Версия | Проверка |
| --- | --- | --- |
| Node.js | 24 LTS (через fnm) | `node --version` |
| pnpm | 12 (через corepack) | `pnpm --version` |
| Docker (Colima на Mac) | любая текущая | `docker compose version` |
| Git | любая текущая | `git --version` |

## Первый запуск

Все команды — в Терминале, по одной.

```bash
# 1. Скачать проект (один раз)
cd ~
git clone https://github.com/alexmelnik2025-source/beauty-platform.git
cd beauty-platform

# 2. Запустить Docker (после каждой перезагрузки Mac)
colima start

# 3. Создать файл настроек (один раз)
cp apps/api/.env.example apps/api/.env

# 4. Установить зависимости
pnpm install

# 5. Запустить базу данных
docker compose up -d

# 6. Применить миграции базы
pnpm db:deploy

# 7. Запустить API
pnpm dev
```

Проверка: открой в браузере <http://localhost:4000/v1/health>.
Ожидаемый ответ: `{"status":"ok","checks":{"database":"up"},...}`.

Остановить API — `Control + C` в Терминале. Остановить базу — `docker compose down` (данные сохраняются).

## Ежедневная работа

```bash
cd ~/beauty-platform
git pull            # получить новый код
colima start        # если Mac перезагружался
docker compose up -d
pnpm install        # если изменились зависимости
pnpm db:deploy      # если появились новые миграции
pnpm dev
```

## Проверки

```bash
pnpm test        # автотесты (на отдельной тестовой базе beauty_test)
pnpm lint        # линтер
pnpm typecheck   # проверка типов
pnpm format      # автоформатирование
```

Те же проверки автоматически запускаются в GitHub Actions при каждой отправке кода.

## Структура

```
apps/
  api/              REST API (NestJS 12, Prisma 7, PostgreSQL 17)
packages/
  config/           общие настройки TypeScript и ESLint
docker/             скрипты инициализации базы
docs/               спецификация и решения
```

Следующие приложения (`owner-web`, `owner-mobile`, `client-mobile`) появятся в своих задачах.

## Частые проблемы

- **`Cannot connect to the Docker daemon`** — Docker не запущен: `colima start`.
- **`port 5432 is already allocated`** — порт занят другой PostgreSQL. Останови её или напиши в чат проекта.
- **`Invalid environment configuration — DATABASE_URL`** — нет файла `apps/api/.env`: шаг 3 первого запуска.
- **Тесты падают с ошибкой подключения к `beauty_test`** — база создана старой версией проекта: `docker compose down -v && docker compose up -d` (удалит локальные данные).
