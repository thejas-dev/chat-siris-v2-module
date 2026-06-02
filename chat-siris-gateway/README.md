# Chat-Siris API Gateway

Public HTTP entrypoint for Chat-Siris v2. Proxies legacy `/api/auth/*` routes to microservices, enforces JWT (RS256), rate limits (Redis DB 0), and signs internal requests with HMAC.

**Default port:** `8080`

## Prerequisites

| Requirement | Notes |
| ----------- | ----- |
| Node.js | 20+ (22 recommended) |
| Redis | DB `0` for rate limits + JWT introspect cache |
| `@chat-siris/logger` | Sibling repo: `npm ci && npm run build` in `../chat-siris-logger` |
| Upstream services | auth (3001), user (3002), group (3003), message (3004), media (3005) for full stack |
| JWT public key | `JWT_PUBLIC_KEY` PEM (RS256) — must match auth-service issuer |
| Shared HMAC secret | `INTERNAL_HMAC_SECRET` — must match all internal services |

## Quick start (local)

```bash
# 1. Build shared logger
cd ../chat-siris-logger && npm ci && npm run build && cd ../chat-siris-gateway

# 2. Configure environment
cp .env.example .env
# Edit REDIS_URL, JWT_PUBLIC_KEY, INTERNAL_HMAC_SECRET, *_SERVICE_URL

# 3. Install and run
npm ci
npm run build
npm run dev
```

Health check: `GET http://localhost:8080/health`

## Environment variables

| Variable | Required | Default | Description |
| -------- | -------- | ------- | ----------- |
| `PORT` | No | `8080` | Listen port |
| `REDIS_URL` | Yes | — | Redis URL (DB 0) |
| `JWT_PUBLIC_KEY` | Yes | — | RS256 public key PEM |
| `INTERNAL_HMAC_SECRET` | Yes | — | HMAC signing secret for upstream calls |
| `INTERNAL_HMAC_SECRET_PREVIOUS` | No | — | Previous secret during rotation window |
| `AUTH_SERVICE_URL` | No | `http://localhost:3001` | auth-service base URL |
| `USER_SERVICE_URL` | No | `http://localhost:3002` | user-service |
| `GROUP_SERVICE_URL` | No | `http://localhost:3003` | group-service |
| `MESSAGE_SERVICE_URL` | No | `http://localhost:3004` | message-service |
| `MEDIA_SERVICE_URL` | No | `http://localhost:3005` | media-service |
| `*_SERVICE_ENABLED` | No | `true` | Set `false` to roll back domain to monolith |
| `OTEL_ENABLED` | No | `true` | Set `false` to disable tracing |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | Grafana Tempo / OTLP HTTP endpoint |
| `CORS_ORIGINS` | No | `http://localhost:3000` | Comma-separated frontend origins |

See `.env.example` for the full list.

## Authentication

- **Public (no Bearer):** `login`, `register`, `oauth/google`, `token/refresh`
- **Protected:** all other `/api/auth/*` routes require `Authorization: Bearer <accessToken>`
- **401 envelope:** `{ "status": false, "msg": "Authentication required" }`

## API endpoints

All paths are under `/api/auth`. Responses use the legacy envelope: `{ status, data? | user? | group? | obj?, pagination?, msg?, accessToken? }`.

### Auth (public)

#### `POST /api/auth/login`

Find user by email and issue tokens.

**Request**

```json
{ "email": "user@example.com" }
```

**Success**

```json
{
  "status": true,
  "user": { "_id": "...", "username": "...", "email": "...", "avatarImage": "", "isAvatarImageSet": false, "backgroundImage": "", "admin": "", "inChannel": "" },
  "accessToken": "<jwt>"
}
```

**Failure (unknown email — exact legacy string)**

```json
{ "status": false, "msg": "Account need to be Regitered" }
```

**Example**

```bash
curl -s -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

#### `POST /api/auth/register`

**Request**

```json
{
  "username": "alice",
  "email": "alice@example.com",
  "avatarImage": "",
  "isAvatarImageSet": false
}
```

**Success:** `{ "status": true, "user": { ... }, "accessToken": "<jwt>" }`

#### `POST /api/auth/oauth/google`

**Request:** `{ "idToken": "<google-id-token>" }`  
**Success:** same shape as login.

#### `POST /api/auth/token/refresh`

Uses refresh cookie or body. **Success:** `{ "accessToken": "<jwt>", "refreshToken": "..." }` (optional rotation).

---

### Profile (JWT required) → user-service

Replace `:id` with MongoDB user id (must match JWT `sub` for self-service routes).

| Method | Path | Body example | Success shape |
| ------ | ---- | ------------ | ------------- |
| POST | `/api/auth/updateUser/:id` | `{ "backgroundImage": "url" }` | `{ status, obj }` |
| POST | `/api/auth/deleteBackground/:id` | `{}` | `{ status, obj }` |
| POST | `/api/auth/updateName/:id` | `{ "username": "newname" }` | `{ status, obj }` |
| POST | `/api/auth/updateAvatar/:id` | `{ "avatarImage": "url", "isAvatarImageSet": true }` | `{ status, obj }` |
| POST | `/api/auth/addChannelToUser/:id` | `{ "inChannel": "general" }` | `{ status, obj }` |
| POST | `/api/auth/subscribe` | `{ "gmail": "user@gmail.com" }` | `{ status, obj }` |

**Example**

```bash
TOKEN="<accessToken>"
curl -s -X POST "http://localhost:8080/api/auth/updateName/507f1f77bcf86cd799439011" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice2"}'
```

---

### Channels (JWT required) → group-service

| Method | Path | Body example | Notes |
| ------ | ---- | ------------ | ----- |
| POST | `/api/auth/createChannel` | `{ "name": "general", "privacy": false, "password": "", "adminOnly": false, ... }` | `{ status, group }` |
| GET | `/api/auth/getAllChannels` | — | Public channels list |
| POST | `/api/auth/addUserToChannel/:channelId` | `{ "users": [...], "password": "optional" }` | Wrong password: `{ status: false, msg: "Password Wrong" }` |
| POST | `/api/auth/fetchUserRoom` | `{ "userId": "..." }` | User's channels |
| POST | `/api/auth/findChannelRoute` | `{ "name": ["private-room"] }` | Private channel lookup |
| POST | `/api/auth/channelAdminUpdate/:channelId` | `{ "adminOnly": true }` | Admin only |

**Example — create channel**

```bash
curl -s -X POST http://localhost:8080/api/auth/createChannel \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"dev-chat","privacy":false,"adminOnly":false,"password":"","description":"","users":[]}'
```

---

### Messages (JWT required) → message-service

#### `POST /api/auth/sendMessage`

```json
{
  "group": "dev-chat",
  "message": { "text": "Hello" },
  "byUserName": "alice",
  "byUserImage": ""
}
```

**Success:** `{ "status": true, "data": { ...message } }`

#### `POST /api/auth/getMessages`

```json
{ "group": "dev-chat", "limit": 50, "before": "<optional-cursor>" }
```

**Success:** `{ "status": true, "data": [...], "pagination": { "hasMore": true, "nextCursor": "..." } }`

#### `POST /api/auth/deleteMessage`

```json
{ "group": "dev-chat", "messageId": "..." }
```

---

### Media (JWT required) → media-service

#### `POST /api/auth/media/upload-init`

```json
{
  "fileName": "photo.png",
  "mimeType": "image/png",
  "folder": "Images"
}
```

**Success:** `{ "status": true, "data": { "uploadId", "signature", "token", "expire", "folder", "publicKey" } }`

#### `POST /api/auth/media/upload-complete`

```json
{ "uploadId": "...", "url": "https://ik.imagekit.io/..." }
```

---

### Removed (Tradity)

These return **410 Gone**: `/api/auth/tradity`, `tradityusercheck`, `tradityusercreate`, `addtradityimage`, `removetradityimage`, `gettradityimage`.

```json
{ "status": false, "msg": "This endpoint has been removed" }
```

---

## Health & observability

| Endpoint | Description |
| -------- | ----------- |
| `GET /health` | Gateway health + Redis |
| `GET /health/aggregate` | Optional upstream health summary |

Distributed tracing: W3C `traceparent` forwarded to all upstreams. See `docs/runbooks/opentelemetry.md`.

## Tests

```bash
npm test              # integration + contract (CI gate)
npm run test:contract # contract snapshots only
```

Contract tests live in `tests/contract/` and block envelope regressions (P5-N-02).

## Runbooks

Incident rollback procedures: `docs/runbooks/README.md`

## Related services

| Service | Port | Role |
| ------- | ---- | ---- |
| auth-service | 3001 | Login, JWT, refresh |
| user-service | 3002 | Profiles |
| group-service | 3003 | Channels |
| message-service | 3004 | Messages |
| media-service | 3005 | ImageKit uploads |
| realtime-service | 3333 | Socket.IO (not via gateway) |
| worker-service | 3006 | BullMQ consumers |

Frontend REST base URL: `NEXT_PUBLIC_GATEWAY_BASE=http://localhost:8080`
