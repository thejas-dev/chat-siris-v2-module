# chat-siris-auth-service

Identity issuance for Chat-Siris v2: login, register, Google OAuth, JWT access tokens (RS256), and refresh-token rotation. Owns `chat_auth.identities` in MongoDB.

**Port:** `3001` (default)  
**Phase 3 scope:** Internal routes only (`/internal/*`). Public `/api/auth/*` paths are exposed via **chat-siris-gateway** (Phase 4).

---

## Prerequisites

| Requirement | Purpose |
|-------------|---------|
| **Node.js** 20+ | Runtime |
| **MongoDB** | `chat_auth` database (`identities` collection) |
| **Redis** (TCP, DB 0) | Refresh tokens (`chat:refresh:{id}`), rate limits |
| **chat-siris-user-service** (port `3002`) | Profile create/fetch on register, login, OAuth |
| **@chat-siris/logger** | Built locally (`npm run build` in `../chat-siris-logger`) |

### Optional

| Requirement | Purpose |
|-------------|---------|
| **Google Cloud OAuth client** | `GOOGLE_CLIENT_ID` for `/internal/oauth/google` |
| **Sentry** | `SENTRY_DSN` for error tracking |

### Local Redis (Docker)

```bash
docker run -d --name chat-redis -p 6379:6379 redis:7-alpine
```

Use Upstash or another Redis provider in production; set `REDIS_URL` to the TCP connection string (not the REST URL used by user-service).

---

## Quick start

### 1. Generate JWT keys (one-time per environment)

```bash
openssl genrsa -out jwt-private.pem 2048
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
```

- **`JWT_PRIVATE_KEY`** — contents of `jwt-private.pem` (sign tokens; **auth-service only**)
- **`JWT_PUBLIC_KEY`** — contents of `jwt-public.pem` (verify tokens; shared with gateway/realtime later)

Never commit private keys or put them in the frontend.

### 2. Start user-service first

auth-service calls user-service over HTTP with HMAC. Both must share the same `INTERNAL_HMAC_SECRET`.

```bash
cd ../chat-siris-user-service
npm install && npm run build && npm run dev
```

Confirm: `GET http://localhost:3002/health`

### 3. Configure auth-service

Create `.env` in this directory (see [Environment variables](#environment-variables)).

### 4. Install and run

```bash
cd chat-siris-auth-service
npm install
npm run build
npm run dev    # development (watch)
# or
npm start      # production (compiled dist/)
```

Confirm: `GET http://localhost:3001/health` → `"status": "ok"` when MongoDB and Redis are reachable.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | HTTP listen port |
| `SERVICE_NAME` | No | `auth-service` | Logger / health label |
| `LOG_LEVEL` | No | `info` | Winston log level |
| `MONGODB_URI` | **Yes** | — | MongoDB connection string |
| `MONGODB_DB_NAME` | No | `chat_auth` | Database name |
| `REDIS_URL` | **Yes** | — | Redis TCP URL (DB 0: cache, refresh, rate limits) |
| `REDIS_DB_CACHE` | No | `0` | Redis logical database index |
| `USER_SERVICE_URL` | **Yes** | — | Base URL of user-service (e.g. `http://localhost:3002`) |
| `INTERNAL_HMAC_SECRET` | **Yes** | — | Shared secret for outbound calls to user-service; must match user-service |
| `JWT_PRIVATE_KEY` | **Yes** | — | RSA private key PEM (sign access tokens) |
| `JWT_PUBLIC_KEY` | **Yes** | — | RSA public key PEM (verify access tokens) |
| `GOOGLE_CLIENT_ID` | For OAuth | — | Google OAuth client ID (audience for ID token verify) |
| `SENTRY_DSN` | No | — | Sentry DSN (optional) |
| `NODE_ENV` | No | `development` | Set to `production` for secure refresh cookies |

### Example `.env` (local)

```env
PORT=3001
SERVICE_NAME=auth-service

MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB_NAME=chat_auth

REDIS_URL=redis://127.0.0.1:6379
REDIS_DB_CACHE=0

USER_SERVICE_URL=http://localhost:3002
INTERNAL_HMAC_SECRET=your-shared-secret

JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----"

JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----"

GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

Multi-line PEM in `.env` can use `\n` for line breaks; the service converts `\\n` to newlines.

---

## Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Run with `tsx watch` |
| `npm start` | Run compiled `dist/index.js` |
| `npm test` | Run integration tests |

---

## Architecture notes

- **Identities** live in MongoDB `chat_auth.identities` (`_id`, `email`, optional `googleSub`).
- **Profiles** live in user-service (`chat_users.profiles`). `_id` is the same ObjectId on register.
- **Access token:** JWT RS256, 15 minutes (`exp - iat = 900`).
- **Refresh token:** Opaque UUID in Redis `chat:refresh:{tokenId}`, TTL 7 days, single-use rotation.
- **Merged user** in responses matches legacy monolith shape: `_id`, `username`, `email`, `avatarImage`, `isAvatarImageSet`, `backgroundImage`, `admin`, `inChannel`.

### Gateway mapping (Phase 4+)

When using **chat-siris-gateway** on port `8080`:

| Public path | Proxied to |
|-------------|------------|
| `POST /api/auth/login` | `POST /internal/login` |
| `POST /api/auth/register` | `POST /internal/register` |
| `POST /api/auth/oauth/google` | `POST /internal/oauth/google` |
| `POST /api/auth/token/refresh` | `POST /internal/token/refresh` |

During Phase 3 testing, call auth-service directly at `http://localhost:3001/internal/...`.

---

## Rate limits (Redis DB 0)

| Route | Key pattern | Limit | Window |
|-------|-------------|-------|--------|
| Login | `chat:rl:auth:login:{ip}` | 10 | 15 min |
| Register | `chat:rl:auth:register:{ip}` | 5 | 1 hour |
| Refresh | `chat:rl:auth:refresh:{userId}` | 30 | 15 min |

Exceeded limits return HTTP **429** with `{ "status": false, "msg": "..." }`.

---

## Endpoints

Base URL: `http://localhost:3001`

All JSON bodies use `Content-Type: application/json`.

Responses use the legacy envelope: `{ status, user?, accessToken?, refreshToken?, msg? }` unless noted.

---

### `GET /health`

Public health check (no auth).

**Example**

```http
GET http://localhost:3001/health
```

**Success (200)**

```json
{
  "status": "ok",
  "service": "auth-service",
  "uptime": 123.45,
  "mongo": "ok",
  "redis": "ok",
  "version": "1.0.0"
}
```

Returns **503** with `"status": "degraded"` if MongoDB or Redis is down.

---

### `POST /internal/register`

Create identity + profile (via user-service), issue tokens.

**Auth:** None (IP rate limited)

**Body**

```json
{
  "username": "alice",
  "email": "alice@example.com",
  "avatarImage": "https://cdn.example.com/avatar.png",
  "isAvatarImageSet": true
}
```

**Success (200)**

```json
{
  "status": true,
  "user": {
    "_id": "674a1b2c3d4e5f6789012345",
    "username": "alice",
    "email": "alice@example.com",
    "avatarImage": "https://cdn.example.com/avatar.png",
    "isAvatarImageSet": true,
    "backgroundImage": "",
    "admin": "",
    "inChannel": ""
  },
  "accessToken": "eyJhbGciOiJSUzI1NiIs...",
  "refreshToken": "550e8400-e29b-41d4-a716-446655440000"
}
```

Also sets HttpOnly cookie `refreshToken`.

**Errors**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "status": false, "msg": "username, email, ..." }` | Missing fields |
| 409 | `{ "status": false, "msg": "An account with this email already exists" }` | Duplicate email |
| 409 | `{ "status": false, "msg": "Username is already taken" }` | Duplicate username (identity rolled back) |
| 503 | `{ "status": false, "msg": "Service temporarily unavailable" }` | user-service down or error (no orphan identity) |
| 429 | `{ "status": false, "msg": "Too many registration attempts..." }` | Rate limit |

**curl**

```bash
curl -X POST http://localhost:3001/internal/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "email": "alice@example.com",
    "avatarImage": "https://cdn.example.com/avatar.png",
    "isAvatarImageSet": true
  }'
```

---

### `POST /internal/login`

Login by email; merge identity + profile.

**Auth:** None (IP rate limited)

**Body**

```json
{
  "email": "alice@example.com"
}
```

**Success (200)** — same shape as register (`status`, `user`, `accessToken`, `refreshToken` + cookie).

**Unknown email (200)** — legacy behavior (not 404):

```json
{
  "status": false,
  "msg": "Account need to be Regitered"
}
```

Note the exact typo **Regitered** (preserved for backward compatibility).

**Errors**

| Status | Cause |
|--------|-------|
| 400 | Missing `email` |
| 503 | user-service unavailable |
| 429 | Login rate limit |

**curl**

```bash
curl -X POST http://localhost:3001/internal/login \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'
```

---

### `POST /internal/oauth/google`

Exchange a Google ID token for app tokens. Verifies token with Google using `GOOGLE_CLIENT_ID`.

**Auth:** None

**Body**

```json
{
  "idToken": "<Google ID token from NextAuth / Google Sign-In>"
}
```

**Success (200)** — same as login/register.

**Invalid token (401)**

```json
{
  "status": false,
  "msg": "Authentication required"
}
```

**curl**

```bash
curl -X POST http://localhost:3001/internal/oauth/google \
  -H "Content-Type: application/json" \
  -d '{"idToken": "YOUR_GOOGLE_ID_TOKEN"}'
```

---

### `POST /internal/token/refresh`

Rotate refresh token and issue a new access token. Refresh tokens are **single-use**.

**Auth:** Refresh token via **cookie** `refreshToken` or **body** field `refreshToken`

**Body (optional if cookie is set)**

```json
{
  "refreshToken": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Success (200)**

```json
{
  "accessToken": "eyJhbGciOiJSUzI1NiIs...",
  "refreshToken": "new-uuid-after-rotation"
}
```

**Errors**

| Status | Cause |
|--------|-------|
| 401 | Missing, invalid, or already-used refresh token |
| 429 | Refresh rate limit |

**curl (body)**

```bash
curl -X POST http://localhost:3001/internal/token/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'
```

**curl (cookie from prior login)**

```bash
curl -X POST http://localhost:3001/internal/token/refresh \
  -b "refreshToken=YOUR_REFRESH_TOKEN"
```

---

### `POST /internal/token/revoke`

Revoke the current refresh token (logout).

**Auth:** `Authorization: Bearer <accessToken>`

**Body (optional)**

```json
{
  "refreshToken": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Success (200)**

```json
{
  "status": true
}
```

**curl**

```bash
curl -X POST http://localhost:3001/internal/token/revoke \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'
```

---

### `POST /internal/token/introspect`

Validate an access JWT and return claims. **Gateway-only** in production — requires HMAC headers (not Bearer).

**Auth:** HMAC internal signature

| Header | Description |
|--------|-------------|
| `X-Internal-Signature` | HMAC-SHA256 hex digest |
| `X-Internal-Timestamp` | Unix timestamp (±60s) |

Signed payload: `{timestamp}.{METHOD}.{path}` with path `/internal/token/introspect`.

Generate headers from **user-service** (same `INTERNAL_HMAC_SECRET`):

```bash
cd ../chat-siris-user-service
npm run sign -- /internal/token/introspect POST
```

**Body**

```json
{
  "token": "eyJhbGciOiJSUzI1NiIs..."
}
```

**Success (200) — active token**

```json
{
  "active": true,
  "sub": "674a1b2c3d4e5f6789012345",
  "email": "alice@example.com",
  "jti": "uuid-claim-id",
  "exp": 1717000000
}
```

**Inactive (200)**

```json
{
  "active": false
}
```

**Missing/invalid HMAC (401)**

```json
{
  "status": false,
  "msg": "Authentication required"
}
```

**curl**

```bash
# Replace SIGNATURE and TIMESTAMP from npm run sign
curl -X POST http://localhost:3001/internal/token/introspect \
  -H "Content-Type: application/json" \
  -H "X-Internal-Signature: SIGNATURE" \
  -H "X-Internal-Timestamp: TIMESTAMP" \
  -d '{"token": "YOUR_ACCESS_TOKEN"}'
```

---

## Postman workflow

1. Start **user-service** → **auth-service**.
2. **Register** or **Login** → save `accessToken` and `refreshToken` from the response.
3. Use `accessToken` as `Bearer` for **Revoke**.
4. Use `refreshToken` for **Refresh** (body or cookie).
5. For **Introspect**, run `npm run sign` in user-service and paste HMAC headers.

Enable Postman cookie jar if you want refresh to use the `Set-Cookie` from login automatically.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `503 Service temporarily unavailable` on register/login | Start user-service; check `USER_SERVICE_URL` and matching `INTERNAL_HMAC_SECRET` |
| `500 Internal server error` | Check logs; verify `JWT_*` keys, `REDIS_URL`, `MONGODB_URI` |
| `401` on introspect | Regenerate HMAC for path `/internal/token/introspect`, method `POST` |
| Redis / health degraded | Start Redis; confirm `REDIS_URL` is TCP (e.g. `redis://localhost:6379`) |
| JWT errors at startup | Ensure PEM keys are valid and newlines are escaped in `.env` |
| `429` on login/register | Wait for rate-limit window or use a different client IP |
| Register works but login says not registered | Email case mismatch — service stores lowercase emails |

---

## Related services

| Service | Port | Role |
|---------|------|------|
| chat-siris-user-service | 3002 | Profiles (required) |
| chat-siris-gateway | 8080 | Public `/api/auth/*` proxy (Phase 4) |
| chat-siris-logger | — | Shared logging and HMAC helpers |

---

## License

UNLICENSED — internal Chat-Siris v2 migration project.
