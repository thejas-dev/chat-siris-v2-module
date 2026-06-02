# chat-siris-group-service

Channel (group) CRUD, membership, server-side password verification, and message authorization for Chat-Siris v2.

This service owns the `chat_groups` database (`groups` collection). External clients reach it through the API gateway on legacy `/api/auth/*` channel routes. The **message-service** (Phase 7+) calls the authorize endpoint directly with HMAC.

**Local port:** `3003`

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js** | 20+ recommended |
| **MongoDB** | Atlas or local; database `chat_groups` |
| **Redis** | Single instance, two logical DB indexes (see below) |
| **chat-siris-logger** | Built locally: `cd ../chat-siris-logger && npm install && npm run build` |
| **chat-siris-gateway** | Required for external/legacy REST calls |
| **chat-siris-user-service** | Required for synchronous `inChannel` updates on join/leave |
| **Shared secret** | `INTERNAL_HMAC_SECRET` must match gateway and user-service |

Optional but recommended for join fallback:

| Requirement | Notes |
|-------------|-------|
| **chat-siris-worker-service** | Consumes `channel-sync-queue` when user-service HTTP sync fails |

### Redis topology

| DB index | Env var | Usage |
|----------|---------|-------|
| `0` | `REDIS_DB_CACHE=0` | Channel list cache, name cache, members cache, authz cache |
| `1` | `REDIS_DB_EVENTS=1` | Pub/sub (`channel.updated`, `channel.member.changed`), BullMQ producer |

Never mix cache and pub/sub across DB indexes.

---

## Quick start

```bash
# 1. Install dependencies
npm install --legacy-peer-deps

# 2. Configure environment
cp .env.example .env

# 3. Migrate legacy groups (one-time, from monolith DB)
npm run migrate:groups

# 4. Build and run
npm run build
npm run dev            # hot reload
# or
npm start
```

Verify health:

```bash
curl http://localhost:3003/health
```

Expected:

```json
{
  "status": "ok",
  "service": "group-service",
  "uptime": 8.1,
  "redis": "ok",
  "mongo": "ok",
  "version": "1.0.0"
}
```

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3003` | HTTP listen port |
| `MONGODB_URI` | Yes | — | MongoDB connection string |
| `MONGODB_DB_NAME` | No | `chat_groups` | Database name |
| `LEGACY_MONGODB_URI` | Migration | — | Monolith URI for `migrate:groups` |
| `REDIS_URL` | Yes | — | Redis connection URL |
| `REDIS_DB_CACHE` | No | `0` | Cache DB index |
| `REDIS_DB_EVENTS` | No | `1` | Pub/sub + BullMQ DB index |
| `USER_SERVICE_URL` | Yes | — | user-service base URL (e.g. `http://localhost:3002`) |
| `USER_SERVICE_TIMEOUT_MS` | No | `10000` | HTTP timeout for inChannel sync |
| `INTERNAL_HMAC_SECRET` | Yes | — | HMAC secret (must match gateway) |
| `SERVICE_NAME` | No | `group-service` | Log label |
| `LOG_LEVEL` | No | `info` | Winston log level |

Gateway configuration:

```env
GROUP_SERVICE_URL=http://localhost:3003
GROUP_SERVICE_ENABLED=true
USER_SERVICE_ENABLED=true
INTERNAL_HMAC_SECRET=<same secret>
```

Rollback channel routes to monolith: `GROUP_SERVICE_ENABLED=false`.

---

## Authentication

### Gateway routes (channel CRUD)

All channel CRUD/search routes require **HMAC + gateway identity headers** (injected by API gateway after JWT validation):

```
X-Internal-Signature: <hex>
X-Internal-Timestamp: <unix seconds>
X-User-Id: <JWT sub>
X-User-Email: <email>
X-Request-Id: <uuid>
```

Admin-only updates additionally verify `X-User-Id === channel.adminId` in service logic.

### HMAC-only routes (authorize)

`GET /internal/channels/:id/authorize` is called by **message-service** (and other internal services) with HMAC only — no `X-User-Id` header required.

---

## Endpoints

### Public

#### `GET /health`

```bash
curl http://localhost:3003/health
```

---

### Gateway routes (legacy `/api/auth/*`)

| Legacy gateway route | Internal route | Method |
|----------------------|----------------|--------|
| `POST /api/auth/createChannel` | `/internal/channels` | POST |
| `GET /api/auth/getAllChannels` | `/internal/channels/public` | GET |
| `POST /api/auth/findChannelRoute` | `/internal/channels/search` | POST |
| `POST /api/auth/fetchUserRoom` | `/internal/channels/lookup` | POST |
| `POST /api/auth/addUserToChannel/:id` | `/internal/channels/:id/members` | POST |
| `POST /api/auth/channelAdminUpdate/:id` | `/internal/channels/:id/admin-only` | POST |

---

#### `POST /internal/channels`

Create a channel.

**Body:**

```json
{
  "name": "general",
  "admin": "johndoe",
  "adminId": "507f1f77bcf86cd799439011",
  "description": "Public chat",
  "password": "optional-secret",
  "privacy": false,
  "adminOnly": false,
  "users": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "username": "johndoe",
      "avatarImage": "",
      "isAvatarImageSet": false
    }
  ]
}
```

- `name`: 3–20 characters, unique
- `adminId` must match the authenticated user (`X-User-Id` / JWT `sub`) — same rule as admin-only toggle
- New passwords are stored as **bcrypt** (`$2…` prefix)
- Legacy plaintext passwords from migration remain plaintext until rotated

**Success (200):**

```json
{
  "status": true,
  "group": {
    "_id": "...",
    "name": "general",
    "admin": "johndoe",
    "adminId": "507f1f77bcf86cd799439011",
    "privacy": false,
    "users": [...],
    "adminOnly": false,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**Via gateway:**

```bash
curl -X POST http://localhost:8080/api/auth/createChannel \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "general",
    "admin": "johndoe",
    "adminId": "507f1f77bcf86cd799439011",
    "description": "Public chat",
    "privacy": false,
    "adminOnly": false,
    "users": []
  }'
```

**Errors:** `409` duplicate name, `400` name length, `403` if `adminId` ≠ logged-in user.

---

#### `GET /internal/channels/public`

List all **public** channels (`privacy: false`). Cached in Redis (`chat:channels:public`, TTL 30s).

**Success (200):**

```json
{
  "status": true,
  "data": [
    {
      "_id": "...",
      "name": "general",
      "privacy": false,
      "users": [...]
    }
  ]
}
```

**Via gateway:**

```bash
curl http://localhost:8080/api/auth/getAllChannels \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

#### `POST /internal/channels/search`

Search **private** channels (`privacy: true`) by name substring.

**Body:**

```json
{
  "name": "sec"
}
```

**Success (200):**

```json
{
  "status": true,
  "data": [
    { "_id": "...", "name": "secret-room", "privacy": true }
  ]
}
```

**Via gateway:**

```bash
curl -X POST http://localhost:8080/api/auth/findChannelRoute \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"sec"}'
```

---

#### `POST /internal/channels/lookup`

Find a channel by exact name.

**Body:**

```json
{
  "name": "general"
}
```

**Success (200):**

```json
{
  "status": true,
  "data": { "_id": "...", "name": "general", "users": [...] }
}
```

**Not found (404):**

```json
{
  "status": false,
  "msg": "Channel not found"
}
```

**Via gateway:**

```bash
curl -X POST http://localhost:8080/api/auth/fetchUserRoom \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"general"}'
```

---

#### `POST /internal/channels/:id/members`

Add or replace channel members. Verifies channel password **server-side** when provided.

Supports two body formats:

**New format (preferred):**

```json
{
  "user": {
    "_id": "507f1f77bcf86cd799439011",
    "username": "johndoe",
    "avatarImage": "",
    "isAvatarImageSet": false
  },
  "password": "channel-secret"
}
```

**Legacy format (frontend compatibility):**

```json
{
  "users": [
    { "_id": "...", "username": "...", "avatarImage": "", "isAvatarImageSet": false }
  ],
  "password": "channel-secret"
}
```

On success, group-service:

1. Updates `groups.users`
2. HTTP syncs `inChannel` on user-service (primary path)
3. Enqueues `channel-sync-queue` job if HTTP sync fails
4. Publishes cache invalidation events on Redis DB 1

**Success (200):**

```json
{
  "status": true,
  "obj": { "...updated channel..." }
}
```

**Wrong password (403):**

```json
{
  "status": false,
  "msg": "Password Wrong"
}
```

**Via gateway:**

```bash
curl -X POST http://localhost:8080/api/auth/addUserToChannel/CHANNEL_ID \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user": {
      "_id": "507f1f77bcf86cd799439011",
      "username": "johndoe",
      "avatarImage": "",
      "isAvatarImageSet": false
    },
    "password": "channel-secret"
  }'
```

---

#### `POST /internal/channels/:id/admin-only`

Toggle admin-only posting. Only the channel creator (`adminId`) may call this.

**Body:**

```json
{
  "adminOnly": true
}
```

**Success (200):**

```json
{
  "status": true,
  "obj": { "...channel with adminOnly: true..." }
}
```

**Via gateway:**

```bash
curl -X POST http://localhost:8080/api/auth/channelAdminUpdate/CHANNEL_ID \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"adminOnly": true}'
```

**Errors:** `403` if caller is not `adminId`.

---

### Internal — HMAC only (authorize)

#### `GET /internal/channels/:id/authorize`

Server-side authorization for message send/delete. Used by message-service before every write.

**Query parameters:**

| Param | Values | Description |
|-------|--------|-------------|
| `userId` | ObjectId string | User to authorize |
| `action` | `send` \| `delete` | Operation type |

**Authorization rules:**

| Condition | Result |
|-----------|--------|
| User not in `channel.users` | `{ "allowed": false, "reason": "NOT_MEMBER" }` |
| `action=send`, `adminOnly=true`, user ≠ adminId | `{ "allowed": false, "reason": "ADMIN_ONLY" }` |
| `action=delete`, user ≠ adminId | `{ "allowed": false, "reason": "NOT_CHANNEL_ADMIN" }` |
| Otherwise | `{ "allowed": true }` |

Cached at `chat:authz:{userId}:{channelId}` (TTL 30s).

**Example (direct — requires HMAC):**

```bash
# Generate signature for path WITHOUT query string:
# GET /internal/channels/CHANNEL_ID/authorize

curl "http://localhost:3003/internal/channels/CHANNEL_ID/authorize?userId=507f1f77bcf86cd799439011&action=send" \
  -H "X-Internal-Signature: <sig>" \
  -H "X-Internal-Timestamp: <ts>"
```

**Success:**

```json
{ "allowed": true }
```

**Denied:**

```json
{ "allowed": false, "reason": "NOT_MEMBER" }
```

---

## Caching & events

| Redis key | TTL | Purpose |
|-----------|-----|---------|
| `chat:channels:public` | 30s | Public channel list |
| `chat:channel:name:{name}` | 2 min | Lookup by name |
| `chat:channel:{id}:members` | 1 min | Member list |
| `chat:authz:{userId}:{channelId}` | 30s | Authorize result |

Invalidated on membership/admin changes via pub/sub:

- `channel.updated`
- `channel.member.changed`

---

## Migration

Copy legacy monolith `groups` collection into `chat_groups.groups`:

```bash
npm run migrate:groups
```

Requires `LEGACY_MONGODB_URI` (monolith) and `MONGODB_URI` (target). Idempotent — skips documents that already exist by `_id`.

**Not migrated:** `tradityusers`, `images` (removed from scope).

Subscribe documents are migrated by **user-service** (`npm run migrate:subscribes`).

---

## Development

```bash
npm test                 # integration tests
npm run build
npm run dev
```

Typical local stack:

```text
user-service     :3002
group-service    :3003  ← this service
worker-service   :3006  (channel-sync-queue consumer)
api-gateway      :8080
frontend         :3000
monolith         :3333  (messages + socket until Phase 10)
```

Run **worker-service** alongside this service so failed `inChannel` HTTP syncs are retried from the queue.
