# expensebackend — sync API (offline-first) для Expense Manager

Лёгкий backend для синхронизации между устройствами:
- `POST /v1/sync/push` — push локальных изменений (outbox -> server)
- `GET  /v1/sync/changes` — pull change feed (cursor -> client)
- PostgreSQL хранит версии сущностей (`sync_entities`), change feed (`sync_change_events`) и идемпотентность (`sync_applied_mutations`)

## Требования
- Node.js (для локального запуска)
- PostgreSQL (контейнер рядом в Caprover)
- JWT secret для `Authorization: Bearer <token>`

## Параметры окружения (ENV)

### Обязательные
- `DATABASE_URL`  
  Строка подключения к PostgreSQL.  
  Пример:  
  `postgres://USER:PASSWORD@HOST:5432/DBNAME`

- `JWT_SECRET`  
  Секрет для проверки JWT (алгоритм HS256).

### Рекомендуемые (опциональные)
- `PORT`  
  Порт HTTP сервера. По умолчанию: `3000`.

- `MAX_MUTATIONS_PER_REQUEST`  
  Ограничение на размер batch в `POST /v1/sync/push`. По умолчанию: `100`.

- `PG_POOL_MAX`  
  Максимальное число подключений в пуле pg. По умолчанию: `5`.

- `PG_IDLE_TIMEOUT_MS`  
  idleTimeoutMillis для pg. По умолчанию: `30000`.

- `PG_CONN_TIMEOUT_MS`  
  connectionTimeoutMillis для pg. По умолчанию: `10000`.

## Endpoints

### Healthcheck
- `GET /health`  
  Возвращает `{ ok: true }`

### Push (батч мутаций)
- `POST /v1/sync/push`
- Заголовок: `Authorization: Bearer <token>`
- Body:
  ```json
  {
    "mutations": [
      {
        "mutationId": "uuid",
        "entityType": "TRANSACTION|CATALOG_ITEM|...",
        "entityId": "uuid-or-canonical",
        "action": "UPSERT|DELETE",
        "baseVersion": 12,
        "payload": { }
      }
    ]
  }
  ```
- Response:
  ```json
  {
    "results": [
      { "mutationId": "...", "status": "APPLIED|IDEMPOTENT|CONFLICT|INVALID" }
    ],
    "nextCursor": "optional"
  }
  ```

### Pull (change feed)
- `GET /v1/sync/changes?cursor=<cursor>&limit=<n>`
- Заголовок: `Authorization: Bearer <token>`
- Ответ:
  ```json
  {
    "changes": [
      {
        "cursorEventId": "evt_123",
        "entityType": "TRANSACTION",
        "entityId": "uuid",
        "action": "UPSERT|DELETE",
        "version": 13,
        "updatedAt": "2026-05-22T08:00:00Z",
        "deletedAt": null,
        "payload": { }
      }
    ],
    "nextCursor": "evt_124"
  }
  ```

## JWT формат
Backend ожидает JWT с полями:
- `sub` (предпочтительно) или `userId`

Пример payload:
```json
{ "sub": "user-uuid" }
```

## Caprover (быстрый старт)
1. Создай приложение в CapRover для backend.
2. Привяжи Docker image:
   - либо build из репозитория (Dockerfile присутствует),
   - либо используйте prebuilt image (если вы так настроите).
3. Укажи ENV:
   - `DATABASE_URL`
   - `JWT_SECRET`
   - (опционально) `PORT`, `MAX_MUTATIONS_PER_REQUEST`
4. Убедись, что backend контейнер сети может достучаться до PostgreSQL (HOST в `DATABASE_URL` должен быть доступен внутри сети Caprover).

## Документация sync-контракта
Смотри:
- `expensemanager/docs/sync-api-requirements.md`
- `expensemanager/docs/sync-model.md`
- `expensemanager/docs/sync-conflicts-and-catalog-rules.md`
- `expensemanager/docs/sync-plan.md`
