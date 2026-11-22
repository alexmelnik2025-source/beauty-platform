# Codex — очередь, работа, запросы к API

Правила — в `AGENTS.md`. Codex делает мобильные приложения (`apps/mobile-client`, `apps/mobile-business`), Claude — API, веб и магазин.

## Очередь Codex (одобрено владельцем, делать по порядку)

1. **Бизнес-приложение — минимализм (Q6, одобрено 21–22.11.2026).**
   - Меню не обрезается: нижняя панель из 4–5 главных пунктов (Kalendarz, Klienci, Sklep, Więcej) — остальное в «Więcej».
   - Шапка календаря на телефоне — одна строка (дата ◀ ▶, «Dziś», мастер), ничего не переносится.
   - Отдельный раздел **«Sklep»** (товары не внутри «Usługi»): вкладки «Produkty» / «Sprzedaż online» / «Integracje»; список как в админке Shopify: поиск, фильтры, строка = фото, название, статус, остаток, цена; одна кнопка «+ Dodaj produkt»; форма добавления короткая (название, цена, остаток), остальное — «Więcej ▸».
   - Пункт **«Promocje»** вместо «Happy hours». «Usługi» — в том же стиле, что «Sklep».
   - «Ustawienia» — список разделов (значок, название, одна строка), страницы-карточки, полоса «Niezapisane zmiany — Odrzuć / Zapisz».
   - Язык — компактный выбор «PL ▾», «UA» вместо «UK».
2. **Клиентское приложение — минимализм (Q5, одобрено 21–22.11.2026).** Как на веб-странице записи: у салона выбор услуги виден сразу, описание/часы/карта/«Poleć»/QR свёрнуты в «O salonie ▸»; фильтр языка мастеров свёрнут; на шаге кода кнопка «Potwierdź wizytę» сразу под кодом; на «Do zobaczenia!» одна главная кнопка «Dodaj do kalendarza»; поиск салонов — одна строка фильтров («Język obsługi ▾», «Kategoria ▾», «Otwarte teraz», «W pobliżu»); ошибки форм у поля; «UA».
3. **После того как Claude сделает API (смотри «Запросы к API» — «готово»):**
   - Q7 «Promocje» в бизнес-приложении: «+ Dodaj promocję» → «Godziny / dni» (процент, дни, часы) или «Last Minute» (процент, за сколько часов до визита); в клиентском — зачёркнутая цена «−20 %» у времени.
   - Q8 лист ожидания: в клиентском переключатель «Zapisz mnie automatycznie, gdy zwolni się termin»; в бизнес-приложении пометка «Auto».
   - Q9 защита от отмен: в карточке клиента бизнес-приложения «Zasady dla klienta» (według zasad salonu / zaufany / najpierw opłata zaległych / tylko z potwierdzeniem / tylko telefonicznie); в клиентском — уведомление «zapłacisz za poprzednią i tę wizytę w salonie» перед подтверждением.
4. Ошибки, тесты, скорость в обоих мобильных приложениях.

## В работе у Codex

(Codex пишет сюда: задача — ветка — дата.)

## Сделано Codex

(PR — что сделано — дата.)

## Запросы к API (Codex → Claude)

(Что нужно экрану — какой запрос/поля — статус: «ждёт» / «готово: …».)

- **Q7 «Promocje» — Last Minute** — готово (Claude, 22.11.2026): `GET/PUT /v1/organizations/:org/locations/:id/happy-hours`,
  у правила новые поля `kind: 'hours' | 'lastMinute'` и `lastMinuteHours: number | null` (1–72, только для
  `lastMinute`; для него `weekdays`/`start`/`end` можно не передавать — тогда каждый день, весь день). Процент 1–90,
  дни и часы — как раньше. Скидка Last Minute — только при онлайн-записи; клиенту её показывают
  `discountPercent` в `GET /v1/public/locations/:slug/availability` и `happyHourPercent`/`listPriceGrosze` в брони.
  **Важно для экранов:** список сохраняется целиком (PUT) — передавайте `kind` и `lastMinuteHours` каждого правила
  обратно (в `apps/mobile-business/src/happyHours.ts` → `rulesToSave` это уже добавлено, иначе Last Minute
  превращался бы в скидку на весь день). Экраны «+ Dodaj promocję» в мобильных приложениях можно начинать.

- **Q8 лист ожидания — «Zapisz mnie automatycznie»** — готово (Claude, 22.11.2026; влито, когда CI зелёный — ветка
  `agent/636-q8-auto-waitlist-api`): `POST /v1/client/waitlist/locations/:slug` принимает `autoBook: boolean`
  (по умолчанию `false`; при `true` нужен `phone`, иначе 400 `VALIDATION_ERROR` с `path: phone`). Только для
  вошедшего клиента (страница записи без входа это поле не принимает). Когда время освобождается и такой клиент первый
  в очереди, визит записывается сразу (статус записи в листе — `booked`, клиенту обычное письмо-подтверждение).
  `autoBook` есть в `GET /v1/client/waitlist` (клиентское приложение) и в `GET …/locations/:id/waitlist` (бизнес:
  пометка «Auto»). Экраны можно начинать.
  Claude поправил одну строку в `apps/mobile-business/test/waitlist.test.ts` (в тестовую запись добавлено
  `autoBook: false`), иначе typecheck падал из-за нового обязательного поля — сами экраны не тронуты.

## Предложения Codex (ждут решения владельца)

(Новые идеи — не программировать без «да» владельца.)
