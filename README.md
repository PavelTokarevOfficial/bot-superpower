# Бот «Суперспособность + дебафф»

Telegram-бот на Bun и TypeScript. Он придумывает смешной недостаток для суперспособности,
работает через ProxyAPI, хранит лимиты и адресованные ему сообщения в PostgreSQL и принимает
оплату Telegram Stars.

## Что реализовано

- 5 бесплатных AI-запросов на пользователя в сутки; значение меняется через env.
- Купленные запросы расходуются только после бесплатных и не сгорают.
- `/balance` показывает остаток, `/buy` выставляет счёт в Stars.
- Платёж начисляется строго один раз по `telegram_payment_charge_id`.
- `/diag` и `/reset_limit` доступны только ID из `ADMIN_IDS`.
- `/reset_limit <user_id>` или `/reset_limit @username` сбрасывает сегодняшний лимит пользователя.
- `/reset_limit all` сбрасывает сегодняшние лимиты всех пользователей.
- `/payments` показывает баланс Stars, общую сумму и последние платежи.
- `/withdraw_stars` показывает баланс и безопасную инструкцию вывода через Fragment.
- В БД сохраняются только текстовые сообщения, адресованные боту: все личные сообщения,
  команды, mention и reply боту в группах.
- Для каждого сообщения сохраняется Telegram username, если он есть, и успешный ответ
  нейросети. Старые записи после миграции остаются на месте с пустыми новыми полями.
- Критические события пишутся в stdout как JSON: запуск, ошибки, счета, pre-checkout,
  платежи, сбросы лимитов.

## Настройка

Создайте `.env`:

```bash
cp .env.example .env
```

Обязательные и основные параметры:

```env
TELEGRAM_BOT_TOKEN=...
PROXYAPI_API_KEY=...
PROXYAPI_MODEL=qwen/qwen3.8-omni-flash
DATABASE_URL=postgres://bot:change_me@localhost:5432/bot_superpower
ADMIN_IDS=832766702
DAILY_FREE_REQUESTS=5
STARS_PACKAGES=5:10,15:28,50:85
POSTGRES_PASSWORD=change_me
```

Несколько администраторов задаются через запятую: `ADMIN_IDS=832766702,123456789`.
Картинку для команды `/start` положите в `assets/start.png`. Она копируется в Docker-образ,
отправляется как локальный файл, а приветственный текст размещается в подписи. Если файла
нет или Telegram не сможет его отправить, бот автоматически отправит обычный текст.
Картинка `assets/pay.png` аналогично используется в меню `/buy`: тарифы выводятся в подписи,
а кнопки выбора пакета прикрепляются к изображению.
`assets/balance.png` используется командой `/balance`, а `assets/paysupport.png` — командой
`/paysupport`. Контакт поддержки зафиксирован как `@sa1nt_paul`.
Перед production-запуском замените `POSTGRES_PASSWORD` и такой же пароль пропишите в
локальном `DATABASE_URL`, если запускаете Bun вне Compose. `.env` исключён из Git.

## Docker Compose — рекомендуемый запуск

```bash
docker compose up -d --build
docker compose logs -f bot
```

PostgreSQL хранит данные в именованном volume `postgres_data`, поэтому обычные перезапуски
и пересборки контейнеров данные не удаляют. Не выполняйте `docker compose down -v`, если
хотите сохранить пользователей, лимиты, сообщения и платежи.

Контейнеры ограничены 0.5 CPU и 256 МБ памяти каждый. PostgreSQL доступен только локально
на `127.0.0.1:5432`, а не из внешней сети.
Бот запускается непривилегированным пользователем и использует long polling, поэтому
публичный HTTP-порт ему не нужен.

Остановка без удаления данных:

```bash
docker compose down
```

### Подключение через DataGrip

Для локального Docker Compose:

```text
Host: 127.0.0.1
Port: 5432
Database: bot_superpower
User: bot
Password: change_me
URL: jdbc:postgresql://127.0.0.1:5432/bot_superpower
```

Драйвер: PostgreSQL. Для локального подключения SSL не требуется. Значение пароля берётся
из `POSTGRES_PASSWORD` в `.env`; после его изменения нужно пересоздать volume либо отдельно
изменить пароль уже созданного пользователя PostgreSQL.

## Локальная разработка

Нужны Bun 1.2+ и доступный PostgreSQL из `DATABASE_URL`:

```bash
docker compose up -d db
bun install
bun run dev
```

Проверки и сборка:

```bash
bun run typecheck
bun run lint
bun test
bun run build
```

При старте схема БД создаётся автоматически. Отдельный ORM и отдельный шаг миграции для
этого MVP не нужны.

## Telegram Stars

Для цифровых товаров счёт создаётся в валюте `XTR` без provider token. Бот подтверждает
`pre_checkout_query`, а запросы начисляет только после `successful_payment`. Команда
`/paysupport` выводит контакт администратора `@sa1nt_paul`.

При первой инициализации тарифы из `STARS_PACKAGES` записываются в таблицу
`star_packages`. Формат — `запросы:звёзды`, несколько тарифов разделяются запятыми.
После появления записей дальнейшие изменения тарифов выполняются в PostgreSQL; env больше
не перезаписывает таблицу. `/buy` показывает только активные строки (`is_active = TRUE`).
Каждый выставленный счёт сохраняется в `payment_invoices` со снимком цены и количества
запросов, а перед оплатой сверяется с БД.

## Группы и Privacy Mode

В группе бот отвечает только на точный mention его username или reply на сообщение бота.
Команды также сохраняются как адресованные боту. Если mention-сообщения не приходят,
выключите Privacy Mode в BotFather: `/mybots` → бот → `Bot Settings` → `Group Privacy`,
затем удалите бота из группы и добавьте снова.

## Диагностика

`/diag` показывает модель, доступность PostgreSQL, статистику, ID чата и пользователя,
Privacy Mode, Bun version, uptime и баланс ProxyAPI. Для баланса у ProxyAPI-ключа должно
быть включено разрешение «Запрос баланса». Секреты команда не выводит.

## Production-деплой через GHCR

Локальный `compose.yaml` по-прежнему собирает образ через `build: .`.
`compose.production.yaml` предназначен только для VPS и использует неизменяемый GHCR-тег,
переданный через `BOT_IMAGE`. Compose project name зафиксирован как `bot-superpower`, а
volume PostgreSQL — как `bot-superpower_postgres_data`.

Workflow `.github/workflows/deploy.yml` при push в `main` только собирает образ и публикует
его как `ghcr.io/<owner>/<repo>:<commit-sha>`. Автоматического деплоя нет. Deploy-job
запускается только через `workflow_dispatch`, требует включённый `confirm_deploy` и GitHub
Environment `production`.

Перед первым ручным деплоем на VPS:

1. Установите Docker с Compose plugin и убедитесь, что SSH-пользователь может выполнять
   `docker` без интерактивного `sudo`.
2. Создайте `/opt/telegram-bot/.env` со всеми переменными из `.env.example` и обязательно
   задайте непустой `POSTGRES_PASSWORD`. Символы пароля, специальные для URL, должны быть
   percent-encoded при использовании внутри `DATABASE_URL`.
3. Проверьте существующий volume read-only командой:

   ```bash
   docker volume inspect bot-superpower_postgres_data
   ```

   Workflow намеренно остановится, если этого volume нет. На абсолютно новом VPS его можно
   один раз создать безопасной командой `docker volume create bot-superpower_postgres_data`.
   Для переноса существующей базы новый пустой volume создавать нельзя — сначала перенесите
   или подключите исходный `bot-superpower_postgres_data`.
4. Один раз скачайте образ БД: `docker pull postgres:17-alpine`. Workflow скачивает только
   образ бота и запускает Compose с `--pull never`.
5. Создайте GitHub Environment с точным именем `production`; для дополнительной защиты
   настройте Required reviewers.

Для `SSH_KNOWN_HOSTS` получите host key из доверенного источника — например, из консоли VPS
или панели провайдера. Если используете локальный `ssh-keyscan -H <SSH_HOST>`, обязательно
сверьте fingerprint с данными провайдера через `ssh-keygen -lf`. Только после проверки
скопируйте полную строку host key в repository secret `SSH_KNOWN_HOSTS`. Workflow не вызывает
`ssh-keyscan` и использует `StrictHostKeyChecking=yes`.

Первый деплой:

1. Отправьте изменения в `main` и дождитесь успешного job `Build and push immutable image`.
2. Откройте GitHub → Actions → `Build and deploy` → `Run workflow`.
3. Выберите `main`, включите `confirm_deploy` и запустите workflow.
4. После approval в Environment job загрузит production Compose в `/opt/telegram-bot`,
   проверит `.env` и volume, скачает только SHA-образ бота, выполнит
   `docker compose up -d --no-build --pull never` и покажет `docker compose ps`.

Workflow не содержит `docker compose down`, операций `-v` или команд удаления volume.
