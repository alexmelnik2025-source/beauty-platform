# Beauty Platform

Платформа онлайн-записи для барбершопов и салонов красоты в Польше.
Готово: каркас проекта (задача 1); вход владельца, организации, филиалы и роли (задача 2). Пока только API, без интерфейса.

Спецификация MVP и план — в [docs/README.md](docs/README.md).

## Что нужно на компьютере

| Инструмент             | Версия              | Проверка                 |
| ---------------------- | ------------------- | ------------------------ |
| Node.js                | 24 LTS (через fnm)  | `node --version`         |
| pnpm                   | 12 (через corepack) | `pnpm --version`         |
| Docker (Colima на Mac) | любая текущая       | `docker compose version` |
| Git                    | любая текущая       | `git --version`          |

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

# 5. Запустить базу данных и почтовый ящик Mailpit
docker compose up -d

# 6. Применить миграции базы
pnpm db:deploy

# 7. Запустить API
pnpm dev
```

Проверка: открой в браузере <http://localhost:4000/v1/health>.
Ожидаемый ответ: `{"status":"ok","checks":{"database":"up"},...}`.

| Адрес                           | Что там                                                   |
| ------------------------------- | --------------------------------------------------------- |
| <http://localhost:4000/v1/docs> | Документация API: можно вызывать запросы прямо в браузере |
| <http://localhost:8025>         | Mailpit — все письма, которые отправляет API              |

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

## Как проверить вход и организации (задача 2)

Всё делается на странице <http://localhost:4000/v1/docs>: раскрой нужный запрос → **Try it out** → поправь пример → **Execute**.

1. `POST /v1/auth/register` — укажи свой email, пароль (от 10 символов) и имя.
2. Открой <http://localhost:8025>, найди письмо и скопируй строку после «Kod:».
3. `POST /v1/auth/verify-email` — вставь код в поле `token`.
4. `POST /v1/auth/login` — тот же email и пароль. Скопируй `accessToken` из ответа.
5. Нажми **Authorize** вверху страницы, вставь токен, **Authorize**.
6. `POST /v1/organizations` — `{"name": "Мой салон"}`. Скопируй `id`.
7. `POST /v1/organizations/{orgId}/locations` — вставь `id` в `orgId`, в теле: название, адрес, город, индекс.
8. `GET /v1/me` — увидишь себя и свою организацию с ролью `owner`.

Токен доступа живёт 15 минут; после этого снова выполни шаг 4.

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
- **`Invalid environment configuration — DATABASE_URL`** или **`JWT_ACCESS_SECRET`** — нет файла `apps/api/.env` или он устарел: `cp apps/api/.env.example apps/api/.env`.
- **Письма не приходят в Mailpit** — `docker compose up -d` (запускает и базу, и Mailpit).
- **Тесты падают с ошибкой подключения к `beauty_test`** — база создана старой версией проекта: `docker compose down -v && docker compose up -d` (удалит локальные данные).
