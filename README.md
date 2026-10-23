# Beauty Platform

Платформа онлайн-записи для барбершопов и салонов красоты в Польше.
Готово: каркас (задача 1); вход, организации, филиалы, роли (задача 2); услуги, мастера, график и свободные слоты (задача 3). Пока только API, без интерфейса.

Спецификация MVP и план — в [docs/README.md](docs/README.md).

## Что нужно на компьютере

| Инструмент             | Версия              | Проверка                 |
| ---------------------- | ------------------- | ------------------------ |
| Node.js                | 24 LTS (через fnm)  | `node --version`         |
| pnpm                   | 12 (через corepack) | `pnpm --version`         |
| Docker (Colima на Mac) | любая текущая       | `docker compose version` |
| Git                    | любая текущая       | `git --version`          |

## Быстрый запуск (одна команда)

```bash
cd ~/beauty-platform
git pull
./scripts/dev.sh
```

Скрипт сам запустит Docker (Colima), базу и Mailpit, создаст или обновит файл настроек,
установит зависимости, применит миграции и запустит API. Если что-то не так — остановится
и скажет, что делать. Проверка окружения без запуска: `./scripts/doctor.sh`.

## Первый запуск вручную

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

## Как проверить услуги, мастеров и свободное время (задача 3)

Продолжение предыдущего раздела, на той же странице <http://localhost:4000/v1/docs>.
`{orgId}` и `{locationId}` — из шагов 6–7.

1. `POST .../services` — `{"name": "Strzyżenie", "durationMinutes": 45, "bufferMinutes": 15, "priceGrosze": 8000}` (цена в грошах: 80 zł = 8000). Скопируй `id`.
2. `POST .../staff` — `{"displayName": "Kasia", "serviceIds": ["<id услуги>"]}`. Скопируй `id`.
3. `PUT .../staff/{staffId}/working-hours` — `{"days": [{"weekday": 1, "intervals": [{"start": "09:00", "end": "13:00"}, {"start": "14:00", "end": "18:00"}]}]}` (понедельник с перерывом 13–14).
4. `GET .../availability` — `serviceId`, `from` и `to` = ближайший понедельник (`YYYY-MM-DD`). Увидишь свободные времена.
5. `POST .../staff/{staffId}/time-off` — `{"start": "<дата>T09:00", "end": "<дата>T11:00"}` и повтори шаг 4: утренние слоты исчезнут.
6. `PATCH /v1/organizations/{orgId}/locations/{locationId}` — `{"version": <из ответа шага 7>, "onlineBookingEnabled": true}`.
   Теперь публичная страница салона доступна без входа: `GET /v1/public/locations/{slug}`.

## Как проверить запись клиента (задача 4)

Продолжение предыдущего раздела. Почта приходит в Mailpit: <http://localhost:8025>.

1. `GET /v1/public/locations/{slug}/availability` — `serviceId`, `from`, `to`. Скопируй `start` любого слота.
2. `POST /v1/public/locations/{slug}/holds` — `{"serviceId": "<id>", "start": "<start>"}`. Скопируй `holdId` и `holdToken`. Слот исчез из шага 1.
3. `POST /v1/public/holds/{holdId}/code` — `{"holdToken": "...", "name": "Anna", "phone": "+48600100200", "email": "anna@example.com", "acceptTerms": true}`.
4. Открой Mailpit, возьми 6 цифр из письма. `POST /v1/public/holds/{holdId}/confirm` — `{"holdToken": "...", "code": "123456"}`.
5. `GET /v1/organizations/{orgId}/locations/{locationId}/appointments?from=<дата>&to=<дата>` (с входом владельца) — запись в календаре.
   В Mailpit пришли письма клиенту и владельцу (очередь проверяет их раз в 2 секунды).

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

Сначала запусти `./scripts/doctor.sh` — он проверит всё сам и подскажет команду.

- **`Cannot connect to the Docker daemon`** — Docker не запущен: `colima start`.
- **`port 5432 is already allocated`** — порт занят другой PostgreSQL. Останови её или напиши в чат проекта.
- **`Invalid environment configuration — DATABASE_URL`** или **`JWT_ACCESS_SECRET`** — нет файла `apps/api/.env` или он устарел: `cp apps/api/.env.example apps/api/.env`.
- **Письма не приходят в Mailpit** — `docker compose up -d` (запускает и базу, и Mailpit).
- **Тесты падают с ошибкой подключения к `beauty_test`** — база создана старой версией проекта: `docker compose down -v && docker compose up -d` (удалит локальные данные).
