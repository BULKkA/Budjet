# ExpenseBackend — подробная документация по работе

## 1) Что это за сервис
`expensebackend` — backend для синхронизации данных **offline-first** между устройствами приложения.

Он хранит:
- актуальное состояние версионированных сущностей в `sync_entities`
- append-only журнал изменений (change feed) в `sync_change_events`
- кэш применённых мутаций для идемпотентности в `sync_applied_mutations`

Основные endpoints:
- `POST /v1/sync/push` — получить batch мутаций от клиента
- `GET  /v1/sync/changes` — отдать изменения из change feed, начиная с cursor

Синхронизация по контракту описана в документах:
- `expensemanager/docs/sync-api-requirements.md`
- `expensemanager/docs/sync-model.md`
- `expensemanager/docs/sync-conflicts-and-catalog-rules.md`

---

## 2) Как запустить локально

### 2.1 Установить зависимости
Из папки `expensebackend`:
- `npm install`

### 2.2 Настроить ENV
Создайте `.env` (или передайте env переменные в окружении):

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — секрет для проверки JWT (HS256)
- (опционально) `PORT` (default `3000`)
- (опционально) `MAX_MUTATIONS_PER_REQUEST` (default `100`)

> Пример формата `DATABASE_URL`:
> `postgres://USER:PASSWORD@HOST:5432/DBNAME`

### 2.3 Запуск
- `npm start`

Проверьте:
- `GET /health` → `{ "ok": true }`

---

## 3) Deployment на Caprover (общий сценарий)
1. Создайте App в Caprover для backend.
2. Привяжите build из репозитория (Dockerfile в `expensebackend/`):
   - контейнер собирается и запускает `node src/server.js`
3. Укажите ENV у приложения Caprover:
   - `DATABASE_URL`
   - `JWT_SECRET`
   - (опционально) `PORT`, `MAX_MUTATIONS_PER_REQUEST`
4. Убедитесь, что backend контейнер внутри сети Caprover может достучаться до PostgreSQL-контейнера по хосту из `DATABASE_URL`.

---

## 4) Аутентификация (JWT)

### 4.1 Заголовок
Все sync endpoints требуют:
- `Authorization: Bearer <token>`

### 4.2 Какая структура JWT ожидается
Сервер ожидает, что внутри токена есть поле:
- `sub` (предпочтительно) **или**
- `userId`

Ожидается, что это значение можно привести к строке и использовать как `user_id`.

> Примечание: текущая реализация backend не создаёт пользователям токены — предполагается, что токены выдаются отдельным механизмом/сервисом или на уровне тестов вы сможете зафиксировать любой стабильный `user_id` в `sub`.

---

## 5) Формат синк-данных (важно для клиента)

### 5.1 Mutation (request body для push)
Каждая мутация:
- `mutationId: string` — UUID клиента (нужен для идемпотентности)
- `entityType: string` — тип сущности (пример: `TRANSACTION`, `CATALOG_ITEM`, `BUDGET`…)
- `entityId: string` — id сущности (для catalog standard/user-created есть правила ниже)
- `action: "UPSERT" | "DELETE"`
- `baseVersion: number | null`
- `payload: object | null`

`POST /v1/sync/push` принимает:
```json
{
  "mutations": [
    {
      "mutationId": "uuid",
      "entityType": "TRANSACTION",
      "entityId": "uuid-or-id",
      "action": "UPSERT",
      "baseVersion": 12,
      "payload": { "amount": 10, "currency": "USD" }
    }
  ]
}
```

### 5.2 Response (push)
Server возвращает:
- `results[]` по каждой мутации:
  - `status: "APPLIED" | "IDEMPOTENT" | "CONFLICT" | "INVALID"`
  - для `APPLIED` есть `appliedVersion`
  - для `CONFLICT` есть `currentVersion`, `remoteUpdatedAt`, `conflictType`

Пример:
```json
{
  "results": [
    { "mutationId": "…", "status": "APPLIED", "appliedVersion": 13 }
  ],
  "nextCursor": "123"
}
```

### 5.3 Pull / changes
`GET /v1/sync/changes?cursor=<cursor>&limit=<n>`

- `cursor` — cursorEventId из предыдущего ответа
- `limit` — максимум 500 по схеме backend

Ответ:
```json
{
  "changes": [
    {
      "cursorEventId": "123",
      "entityType": "TRANSACTION",
      "entityId": "uuid",
      "action": "UPSERT",
      "version": 13,
      "updatedAt": "2026-05-22T08:00:00Z",
      "deletedAt": null,
      "payload": { }
    }
  ],
  "nextCursor": "124"
}
```

---

## 6) Конфликты: как их обрабатывать
Единственный конфликт, который сейчас детально реализован в core reconciliation — **VERSION_MISMATCH**:

Условие:
- если `baseVersion !== currentVersion` на сервере → `status = CONFLICT`, `conflictType = "VERSION_MISMATCH"`

Что делать клиенту:
1. Не считать мутацию применённой.
2. Сделать pull с `cursor`, получив remote версии.
3. На основании remote состоянии повторно применить изменения клиента:
   - либо автоматическим merge (если возможно),
   - либо показать пользователю/форме UI.

---

## 7) Catalog sync правила (CATALOG_ITEM)

### 7.1 Важная часть для отсутствия “конфликтов стандартов”
Для `entityType = "CATALOG_ITEM"` payload должен включать `kind`:

- `kind = "STANDARD"`
  - обязателен `standardId: string`
  - сервер делает normalization:
    - canonical `entityId` = `standardId`
  - payload сохраняется и отдается как STANDARD

- `kind = "USER_CREATED"`
  - payload: как в клиентской модели
  - canonical `entityId` НЕ меняется: сохраняется как пришло (`entityId`).
  - бизнес-смысл: user-created items уникальны за счет hidden phone prefix на клиенте

Пример mutation для STANDARD:
```json
{
  "mutationId": "uuid-1",
  "entityType": "CATALOG_ITEM",
  "entityId": "whatever",
  "action": "UPSERT",
  "baseVersion": null,
  "payload": {
    "kind": "STANDARD",
    "standardId": "food",
    "name": "Food"
  }
}
```

---

## 8) Ограничения по ресурсам (важно для Caprover)
- `POST /v1/sync/push` ограничен:
  - `maxItems` в схеме: `100`
  - плюс runtime guard: `MAX_MUTATIONS_PER_REQUEST` (по умолчанию `100`)

Рекомендация по клиенту:
- batch делайте небольшим (например 20–100)
- делайте retry при сетевых ошибках, используя `mutationId`.

---

## 9) Тестирование endpoints (пример curl)
> Замените `TOKEN` и данные на свои.

Healthcheck:
- `curl -s http://localhost:3000/health`

Push:
```bash
curl -s -X POST http://localhost:3000/v1/sync/push \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mutations": [
      {
        "mutationId": "00000000-0000-0000-0000-000000000001",
        "entityType": "TRANSACTION",
        "entityId": "1111",
        "action": "UPSERT",
        "baseVersion": null,
        "payload": { "amount": 10, "currency": "USD" }
      }
    ]
  }'
```

Pull:
```bash
curl -s "http://localhost:3000/v1/sync/changes?cursor=0&limit=100" \
  -H "Authorization: Bearer TOKEN"
```

---

## 10) Известные ограничения текущей реализации (важно)
1. Change feed не чистится (нет retention policy). Со временем таблица `sync_change_events` может расти.
2. Сейчас нет отдельного endpoint управления пользователями/токенами.
3. Конфликтная модель реализована через `baseVersion` (VERSION_MISMATCH). Другие стратегии merge/field-level merge не добавлены.
4. Catalog standard dedupe реализован на нормализации `entityId` по `standardId` в backend core.

---

## 11) Что нужно от клиента (кратко)
- Offline-first: любые изменения сохраняются локально и отправляются в outbox.
- Push:
  - отправляйте `mutationId` всегда уникальным
  - для update указывайте `baseVersion`, который клиент видел
- Pull:
  - применяйте изменения по `version`
  - для каждой remote сущности обновляйте локальные `version/deletedAt`

---

## 12) Где смотреть код/структуры БД
- `expensebackend/src/db.js` — таблицы:
  - `sync_entities`
  - `sync_change_events`
  - `sync_applied_mutations`
- `expensebackend/src/server.js` — endpoints и core reconciliation
