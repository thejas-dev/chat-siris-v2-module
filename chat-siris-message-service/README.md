# chat-siris-message-service

Message persistence, paginated history, deletion, Redis pub/sub events, and BullMQ notification producer for Chat-Siris v2.

This service owns the `chat_messages` database (`messages` collection). External clients reach it through the API gateway on legacy `/api/auth/*` message routes. Before every send or delete, the service calls **group-service** to authorize the user.

**Local port:** `3004`

> **Production note:** Keep `MESSAGE_SERVICE_ENABLED=false` on the gateway until Phase 10 cutover (realtime-service must be live for socket delivery). See [Gateway configuration](#gateway-configuration).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js** | 20+ recommended |
| **MongoDB** | Atlas or local; database `chat_messages` |
| **Redis** | Single instance, two logical DB indexes (see below) |
| **chat-siris-logger** | Built locally: `cd ../chat-siris-logger && npm install && npm run build` |
| **chat-siris-group-service** | Required — channel lookup + authorize before send/delete (`http://localhost:3003`) |
| **chat-siris-gateway** | Required for external/legacy REST calls (`http://localhost:8080`) |
| **Shared secret** | `INTERNAL_HMAC_SECRET` must match gateway and group-service |

Optional (notification jobs are enqueued but not required for REST to work):

| Requirement | Notes |
|-------------|-------|
| **chat-siris-worker-service** | Consumes `notification-queue` (log stub in current phase) |
| **Redis DB 1 subscriber** | realtime-service (Phase 9+) consumes `message.created` / `message.deleted` |

### Redis topology

| DB index | Env var | Usage |
|----------|---------|-------|
| `0` | `REDIS_DB_CACHE=0` | Latest message page cache, send rate limits |
| `1` | `REDIS_DB_EVENTS=1` | Pub/sub (`message.created`, `message.deleted`), BullMQ producer |

Never mix cache and pub/sub across DB indexes.

---

## Quick start

```bash
# 1. Install dependencies
npm install --legacy-peer-deps

# 2. Configure environment
cp .env.example .env
# Edit MONGODB_URI, REDIS_URL, GROUP_SERVICE_URL, INTERNAL_HMAC_SECRET

# 3. Ensure group-service is running (authorize + channel lookup)
# cd ../chat-siris-group-service && npm run dev

# 4. One-time migration from monolith (optional)
npm run migrate:messages
npm run create:indexes

# 5. Build and run
npm run build
npm run dev            # hot reload
# or
npm start
```

Verify health:

```bash
curl http://localhost:3004/health
```

Expected:

```json
{
  "status": "ok",
  "service": "message-service",
  "uptime": 12.4,
  "redis": "ok",
  "mongo": "ok",
  "version": "1.0.0"
}
```

Run tests:

```bash
npm test
```

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3004` | HTTP listen port |
| `SERVICE_NAME` | No | `message-service` | Log label |
| `MONGODB_URI` | Yes | — | MongoDB connection string |
| `MONGODB_DB_NAME` | No | `chat_messages` | Database name |
| `LEGACY_MONGODB_URI` | Migration | — | Monolith URI for `migrate:messages` |
| `REDIS_URL` | Yes | — | Redis connection URL |
| `REDIS_DB_CACHE` | No | `0` | Cache + rate limit DB index |
| `REDIS_DB_EVENTS` | No | `1` | Pub/sub + BullMQ DB index |
| `GROUP_SERVICE_URL` | Yes | — | group-service base URL (e.g. `http://localhost:3003`) |
| `GROUP_SERVICE_TIMEOUT_MS` | No | `5000` | Authorize HTTP timeout (fail closed on timeout) |
| `INTERNAL_HMAC_SECRET` | Yes | — | HMAC secret (must match gateway) |
| `LOG_LEVEL` | No | `info` | Winston log level |

---

## Gateway configuration

Add to `chat-siris-gateway/.env`:

```env
MESSAGE_SERVICE_URL=http://localhost:3004
MESSAGE_SERVICE_ENABLED=false   # set true only at Phase 10 cutover
INTERNAL_HMAC_SECRET=<same secret as message-service>
GROUP_SERVICE_ENABLED=true
GROUP_SERVICE_URL=http://localhost:3003
```

| Flag | When `false` | When `true` |
|------|--------------|-------------|
| `MESSAGE_SERVICE_ENABLED` | Gateway proxies `sendMessage`, `getMessages`, `deleteMessage` to **monolith** | Gateway routes to message-service |

Rollback: set `MESSAGE_SERVICE_ENABLED=false` — message routes return to monolith within one deploy.

---

## Authentication

### Production path (via gateway)

Clients call legacy `/api/auth/*` on the gateway with a JWT:

```
Authorization: Bearer <accessToken>
```

The gateway validates JWT, injects identity headers, signs the internal request, and forwards to message-service.

### Internal routes (direct)

All `/internal/*` routes require **HMAC + gateway identity**:

```
X-Internal-Signature: <hex>
X-Internal-Timestamp: <unix seconds>
X-User-Id: <JWT sub>
X-Request-Id: <uuid>          # optional but recommended
```

HMAC is computed over: `HMAC-SHA256(secret, "${timestamp}.${method}.${path}")` where `path` is the full internal path **including query string** for GET-style authorize calls on other services; for message-service POST routes, path is e.g. `/internal/messages`.

For local debugging, prefer calling through the gateway with a valid Bearer token rather than hand-signing HMAC.

---

## Legacy route mapping

| Legacy gateway route | Internal route | Method |
|----------------------|----------------|--------|
| `POST /api/auth/sendMessage` | `/internal/messages` | POST |
| `POST /api/auth/getMessages` | `/internal/messages/history` | POST |
| `POST /api/auth/deleteMessage` | `/internal/messages/delete` | POST |

---

## Endpoints

### Public

#### `GET /health`

Liveness check — pings MongoDB and Redis DB 0.

```bash
curl http://localhost:3004/health
```

---

### `POST /internal/messages`

Send a message to a channel. Maps from legacy `sendMessage`.

**Authorization flow:**

1. Resolve channel by name via group-service lookup
2. Call group-service `authorize?action=send`
3. If allowed → persist → invalidate cache → pub/sub → notification queue

**Rate limit:** `60` messages per user per minute (`chat:rl:msg:send:{userId}`) → `429` on exceed.

**Request body:**

```json
{
  "group": "general",
  "message": "Hello everyone!",
  "byUserName": "johndoe",
  "byUserImage": "https://cdn.example.com/avatar.png"
}
```

Also accepts structured message (same as tech-spec):

```json
{
  "group": "general",
  "message": { "text": "Hello everyone!" },
  "byUserName": "johndoe",
  "byUserImage": "https://cdn.example.com/avatar.png"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `group` | Yes | Channel **name** (not ObjectId) |
| `message` | Yes | Plain string or `{ "text": "..." }` — text or CDN URL |
| `byUserName` | Yes | Sender display name |
| `byUserImage` | Yes | Sender avatar URL |

**Example (via gateway — recommended):**

```bash
export ACCESS_TOKEN="<jwt from login>"

curl -X POST http://localhost:8080/api/auth/sendMessage \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "group": "general",
    "message": "Hello everyone!",
    "byUserName": "johndoe",
    "byUserImage": ""
  }'
```

**Success (200):**

```json
{
  "status": true,
  "data": {
    "_id": "674a1b2c3d4e5f6789012345",
    "group": "general",
    "message": { "text": "Hello everyone!" },
    "byUserName": "johndoe",
    "byUserImage": "",
    "createdAt": "2026-05-31T06:00:00.000Z",
    "updatedAt": "2026-05-31T06:00:00.000Z"
  }
}
```

**Side effects on success:**

- Redis pub/sub (DB 1) publishes `message.created`
- BullMQ job enqueued on `notification-queue`
- Cache key `chat:messages:{channelName}` invalidated

**Errors:**

| HTTP | Body | Cause |
|------|------|-------|
| `403` | `{ "status": false, "msg": "Not allowed to post in this channel" }` | Not a member, or admin-only channel |
| `404` | `{ "status": false, "msg": "Channel not found" }` | Unknown channel name |
| `429` | `{ "status": false, "msg": "Too many messages sent. Please slow down." }` | Rate limit exceeded |
| `503` | `{ "status": false, "msg": "Service temporarily unavailable" }` | group-service authorize timeout/503 (fail closed — **no DB write**) |

---

### `POST /internal/messages/history`

Paginated message history. Maps from legacy `getMessages`.

**Behavior vs monolith:** Legacy returned **all** messages sorted by `updatedAt`. This service returns the **latest page** (default 50, max 100) with a compound cursor for scrolling up to older messages.

**Request body:**

```json
{
  "group": "general",
  "limit": 50,
  "before": "<base64url compound cursor>"
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `group` | Yes | — | Channel name |
| `limit` | No | `50` | Page size (capped at `100`) |
| `before` | No | — | Omitted on initial load; set to `pagination.nextCursor` to load older messages |

**Compound cursor** (base64url-encoded JSON):

```json
{ "createdAt": "2026-05-31T05:00:00.000Z", "_id": "674a1b2c3d4e5f6789012345" }
```

**Example — initial load (via gateway):**

```bash
curl -X POST http://localhost:8080/api/auth/getMessages \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "group": "general" }'
```

**Success (200):**

```json
{
  "status": true,
  "data": [
    {
      "_id": "...",
      "group": "general",
      "message": { "text": "older message" },
      "byUserName": "jane",
      "byUserImage": "",
      "createdAt": "2026-05-31T05:00:00.000Z",
      "updatedAt": "2026-05-31T05:00:00.000Z"
    },
    {
      "_id": "...",
      "group": "general",
      "message": { "text": "newer message" },
      "byUserName": "john",
      "byUserImage": "",
      "createdAt": "2026-05-31T06:00:00.000Z",
      "updatedAt": "2026-05-31T06:00:00.000Z"
    }
  ],
  "pagination": {
    "hasMore": true,
    "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA1LTMxVDA1OjAwOjAwLjAwMFoiLCJfaWQiOiI2NzRhMWIyYzNkNGU1ZjY3ODkwMTIzNDUifQ"
  }
}
```

- `data` is ordered **oldest → newest** within the page
- `pagination.hasMore: false` and `nextCursor: null` when no older messages exist

**Example — load older page (scroll up):**

```bash
curl -X POST http://localhost:8080/api/auth/getMessages \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "group": "general",
    "limit": 50,
    "before": "eyJjcmVhdGVkQXQiOiIyMDI2LTA1LTMxVDA1OjAwOjAwLjAwMFoiLCJfaWQiOiI2NzRhMWIyYzNkNGU1ZjY3ODkwMTIzNDUifQ"
  }'
```

**Caching:**

| Condition | Behavior |
|-------------|----------|
| No `before` param | May serve from Redis `chat:messages:{channelName}` (TTL 2 min) |
| `before` present | Always queries MongoDB (cache skipped) |

**Errors:**

| HTTP | Body | Cause |
|------|------|-------|
| `400` | `{ "status": false, "msg": "Invalid pagination cursor" }` | Malformed `before` token |
| `404` | `{ "status": false, "msg": "Channel not found" }` | Unknown channel |
| `503` | `{ "status": false, "msg": "Service temporarily unavailable" }` | group-service lookup unavailable |

**Backward compatibility:** Clients that ignore `pagination` still receive `{ status, data }` with the same message document shape.

---

### `POST /internal/messages/delete`

Delete a message. Maps from legacy `deleteMessage`. Only the **channel admin** may delete (enforced server-side via group-service `authorize?action=delete`).

**Request body:**

```json
{
  "id": "674a1b2c3d4e5f6789012345"
}
```

**Example (via gateway):**

```bash
curl -X POST http://localhost:8080/api/auth/deleteMessage \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "id": "674a1b2c3d4e5f6789012345" }'
```

**Success (200):**

```json
{
  "status": true,
  "data": {
    "acknowledged": true,
    "deletedCount": 1
  }
}
```

**Side effects on success:**

- Cache invalidated for the message's channel
- Redis pub/sub publishes `message.deleted` (realtime-service emits `fetchMessages` to the room in Phase 9+)

**Errors:**

| HTTP | Body | Cause |
|------|------|-------|
| `403` | `{ "status": false, "msg": "Not allowed to delete this message" }` | Caller is not channel admin |
| `404` | `{ "status": false, "msg": "Message not found" }` | Invalid or missing message id |
| `503` | `{ "status": false, "msg": "Service temporarily unavailable" }` | group-service authorize unavailable |

---

## Pub/sub event schemas (Redis DB 1)

Published on the Redis channel named after the event (e.g. `message.created`).

### `message.created`

```json
{
  "event": "message.created",
  "requestId": "uuid",
  "channelName": "general",
  "message": { "_id": "...", "group": "general", "message": { "text": "..." }, "...": "..." },
  "emittedAt": "2026-05-31T06:00:00.000Z"
}
```

Consumed by **realtime-service** → `io.to(channelName).emit('msg-recieve', payload)` (Phase 9+).

### `message.deleted`

```json
{
  "event": "message.deleted",
  "requestId": "uuid",
  "channelName": "general",
  "messageId": "674a1b2c3d4e5f6789012345"
}
```

---

## Caching & queues

| Redis key / queue | TTL / retry | Purpose |
|-------------------|-------------|---------|
| `chat:messages:{channelName}` | 2 min | Latest history page (no `before`) |
| `chat:rl:msg:send:{userId}` | 1 min window | Send rate limit counter |
| `notification-queue` | 3 attempts | Log stub job on new message |

---

## Migration

Copy legacy monolith `messages` collection into `chat_messages.messages`:

```bash
# Set LEGACY_MONGODB_URI to monolith database in .env
npm run migrate:messages
npm run create:indexes
```

Migration is **idempotent** — skips documents whose `_id` already exists. Exits non-zero if failure rate exceeds 0.1%.

Required compound index:

```javascript
db.messages.createIndex({ group: 1, createdAt: -1, _id: -1 })
```

---

## Local development stack

Minimal stack to exercise message routes through the gateway:

```bash
# Terminal 1 — Redis
redis-server

# Terminal 2 — group-service
cd ../chat-siris-group-service && npm run dev

# Terminal 3 — message-service
npm run dev

# Terminal 4 — gateway (MESSAGE_SERVICE_ENABLED=true for testing new service)
cd ../chat-siris-gateway
# Set MESSAGE_SERVICE_ENABLED=true in .env
npm run dev

# Terminal 5 — obtain JWT via login
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "email": "user@example.com" }'
```

---

## npm scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server |
| `npm test` | Vitest integration + unit tests |
| `npm run migrate:messages` | One-shot legacy message migration |
| `npm run create:indexes` | Ensure MongoDB indexes |
