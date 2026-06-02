# chat-siris-user-service

Profile CRUD, newsletter subscribe, and `inChannel` pointer updates for Chat-Siris v2.

This service owns the `chat_users` database (`profiles`, `subscribes` collections). It is **not** called directly by the browser — the API gateway proxies legacy `/api/auth/*` profile routes here after JWT validation.

**Local port:** `3002`

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js** | 20+ recommended |
| **MongoDB** | Atlas or local; database `chat_users` |
| **Redis (DB 0)** | `REDIS_URL` + `REDIS_DB_CACHE=0`; profile cache `chat:user:{userId}` |
| **Redis (DB 1)** | `REDIS_URL` + `REDIS_DB_EVENTS=1`; pub/sub `channel.member.changed` |
| **chat-siris-logger** | Built locally: `cd ../chat-siris-logger && npm install && npm run build` |
| **chat-siris-gateway** | Required for external/legacy REST calls (JWT + HMAC forwarding) |
| **Shared secret** | `INTERNAL_HMAC_SECRET` must match gateway and auth-service |

Optional for full join flow:

| Requirement | Notes |
|-------------|-------|
| **chat-siris-group-service** | Updates `inChannel` via HTTP on channel join/leave |
| **chat-siris-worker-service** | Retries `inChannel` sync when user-service is temporarily unavailable |

---

## Quick start

```bash
# 1. Install dependencies (logger package must exist at ../chat-siris-logger)
npm install

# 2. Copy and edit environment
cp .env.example .env   # or create .env manually — see table below

# 3. Build and run
npm run build
npm run dev            # hot reload
# or
npm start              # production (dist/)
```

Verify health:

```bash
curl http://localhost:3002/health
```

Expected:

```json
{
  "status": "ok",
  "service": "user-service",
  "uptime": 12.3,
  "redis": "ok",
  "mongo": "ok",
  "version": "1.0.0"
}
```

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3002` | HTTP listen port |
| `MONGODB_URI` | Yes | — | MongoDB connection string |
| `MONGODB_DB_NAME` | No | `chat_users` | Database name |
| `INTERNAL_HMAC_SECRET` | Yes | — | HMAC secret (must match gateway) |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection URL |
| `REDIS_DB_CACHE` | No | `0` | Redis DB index for profile cache |
| `REDIS_DB_EVENTS` | No | `1` | Redis DB index for pub/sub subscriber |
| `PROFILE_CACHE_TTL_SEC` | No | `300` | Profile cache TTL (5 min) |
| `SERVICE_NAME` | No | `user-service` | Log label |
| `LOG_LEVEL` | No | `info` | Winston log level |

### Migration scripts

| Variable | Description |
|----------|-------------|
| `LEGACY_MONGODB_URI` | Monolith MongoDB URI (read-only) |
| `MONGODB_AUTH_DB_NAME` | Target auth DB for user split (default `chat_auth`) |
| `MONGODB_USERS_DB_NAME` | Target users DB (default `chat_users`) |

```bash
npm run migrate:split       # one-shot users → identities + profiles
npm run migrate:validate    # abort if failure rate > 0.1%
npm run migrate:subscribes  # copy legacy subscribes → chat_users.subscribes
```

---

## Authentication

Two auth modes on `/internal/*`:

### 1. HMAC only (service-to-service)

Used by **auth-service** and **group-service**.

Headers (required on every request):

```
X-Internal-Signature: <hex hmac-sha256>
X-Internal-Timestamp: <unix seconds>
```

Signature payload: `{timestamp}.{METHOD}.{path}` (path includes `/internal` prefix, no query string).

Generate headers for manual testing:

```bash
npm run sign -- /internal/users/507f1f77bcf86cd799439011
npm run sign -- /internal/users POST
```

### 2. Gateway (HMAC + identity)

Used when the **API gateway** forwards a JWT-authenticated client request.

Additional headers injected by gateway:

```
X-User-Id: <JWT sub>
X-User-Email: <email>
X-User-Role: user|admin
X-Auth-Jti: <token jti>
X-Request-Id: <uuid>
```

Routes with `:id` in the path require `X-User-Id === :id` (403 otherwise).

---

## Endpoints

### Public

#### `GET /health`

Health check (no auth).

```bash
curl http://localhost:3002/health
```

---

### Internal — HMAC only

#### `POST /internal/users`

Create a profile. Called by auth-service on register/OAuth.

**Body:**

```json
{
  "_id": "507f1f77bcf86cd799439011",
  "username": "johndoe",
  "avatarImage": "https://cdn.example.com/avatar.png",
  "isAvatarImageSet": true
}
```

`_id` is optional but must match the auth `identities._id` when provided.

**Success (201):** returns `Profile` JSON directly (not legacy envelope).

```json
{
  "_id": "507f1f77bcf86cd799439011",
  "username": "johndoe",
  "avatarImage": "https://cdn.example.com/avatar.png",
  "isAvatarImageSet": true,
  "backgroundImage": "",
  "admin": "",
  "inChannel": "",
  "createdAt": "2026-05-30T12:00:00.000Z",
  "updatedAt": "2026-05-30T12:00:00.000Z"
}
```

**Errors:** `409` duplicate username, `400` validation.

**Example:**

```bash
SIG=$(npm run sign -- /internal/users POST 2>/dev/null | tail -1)
curl -X POST http://localhost:3002/internal/users \
  -H "Content-Type: application/json" \
  -H "X-Internal-Signature: $(echo $SIG | jq -r .headers.\"X-Internal-Signature\")" \
  -H "X-Internal-Timestamp: $(echo $SIG | jq -r .headers.\"X-Internal-Timestamp\")" \
  -d '{"username":"johndoe","avatarImage":"","isAvatarImageSet":false}'
```

---

#### `GET /internal/users/:id`

Fetch profile by ID. Called by auth-service to merge login/register responses.

**Success (200):** `Profile` JSON.

**Errors:** `404` profile not found, `401` invalid HMAC.

**Example:**

```bash
npm run sign -- /internal/users/507f1f77bcf86cd799439011
# Use printed headers with curl -X GET ...
```

---

#### `POST /internal/users/:id/channel-pointer`

Update the user's current channel pointer (`inChannel`). Called by **group-service** (or worker fallback) after join/leave — not by the browser directly.

**Body:**

```json
{
  "inChannel": "general"
}
```

Use `""` when leaving a channel.

**Success (200):**

```json
{
  "status": true,
  "obj": { "...profile fields..." }
}
```

**Example:**

```bash
npm run sign -- /internal/users/507f1f77bcf86cd799439011/channel-pointer POST
```

---

### Internal — Gateway (via API gateway)

These map from legacy `/api/auth/*` paths. Call through gateway (`http://localhost:8080`) with `Authorization: Bearer <accessToken>` in normal use.

| Legacy gateway route | Internal route |
|----------------------|----------------|
| `POST /api/auth/updateUser/:id` | `POST /internal/users/:id/profile` |
| `POST /api/auth/deleteBackground/:id` | `POST /internal/users/:id/profile` (clears background) |
| `POST /api/auth/updateName/:id` | `POST /internal/users/:id/profile` |
| `POST /api/auth/updateAvatar/:id` | `POST /internal/users/:id/profile` |
| `POST /api/auth/addChannelToUser/:id` | `POST /internal/users/:id/profile` |
| `POST /api/auth/subscribe` | `POST /internal/subscribe` |

Rollback: set `USER_SERVICE_ENABLED=false` on gateway to passthrough to monolith.

---

#### `POST /internal/users/:id/profile`

Partial profile update. Caller must own the profile (`X-User-Id === :id`).

**Fields (any subset):** `username`, `avatarImage`, `isAvatarImageSet`, `backgroundImage`, `admin`, `inChannel`

**Username:** 3–20 characters.

**Success (200):**

```json
{
  "status": true,
  "obj": {
    "_id": "507f1f77bcf86cd799439011",
    "username": "newname",
    "avatarImage": "",
    "isAvatarImageSet": false,
    "backgroundImage": "",
    "admin": "",
    "inChannel": "general",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**Via gateway — update display name:**

```bash
curl -X POST http://localhost:8080/api/auth/updateName/507f1f77bcf86cd799439011 \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"newname"}'
```

**Via gateway — set current channel:**

```bash
curl -X POST http://localhost:8080/api/auth/addChannelToUser/507f1f77bcf86cd799439011 \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inChannel":"general"}'
```

**Errors:** `403` wrong user, `400` username length, `404` not found.

---

#### `POST /internal/subscribe`

Legacy newsletter signup. Creates a document in `subscribes`.

**Body:**

```json
{
  "gmail": "user@gmail.com"
}
```

**Success (200):**

```json
{
  "status": true,
  "subscribe": {
    "_id": "...",
    "gmail": "user@gmail.com",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**Via gateway:**

```bash
curl -X POST http://localhost:8080/api/auth/subscribe \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"gmail":"user@gmail.com"}'
```

---

## Caching

| Key | TTL | Invalidated when |
|-----|-----|------------------|
| `chat:user:{userId}` | 5 min (configurable) | Profile update, channel-pointer update, `channel.member.changed` pub/sub |

Cache misses fall through to MongoDB; cache failures never fail the request.

---

## Development

```bash
npm test                 # unit + integration tests
npm run build            # compile TypeScript → dist/
```

Typical local stack for Phase 2:

```text
auth-service     :3001
user-service     :3002  ← this service
group-service    :3003
worker-service   :3006
api-gateway      :8080
frontend         :3000
monolith socket  :3333  (messages/realtime until Phase 10)
```

Ensure gateway has:

```env
USER_SERVICE_URL=http://localhost:3002
USER_SERVICE_ENABLED=true
INTERNAL_HMAC_SECRET=<same as this service>
```
