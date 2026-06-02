# chat-siris-media-service

Server-side ImageKit upload signing, upload lifecycle tracking, and BullMQ `media-queue` producer for Chat-Siris v2.

This service owns the optional `chat_media` database (`media_assets` collection). External clients reach it through the API gateway on legacy `/api/auth/media/*` routes. The ImageKit **private key** lives only in this service — never in the frontend bundle.

**Local port:** `3005`

> **Production note:** Keep `MEDIA_SERVICE_ENABLED=false` on the gateway until Phase 10 cutover. Legacy browser ImageKit SDK uploads continue to work until then (dual-path).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js** | 20+ recommended |
| **MongoDB** | Atlas or local; database `chat_media` |
| **Redis** | Single instance, two logical DB indexes (see below) |
| **ImageKit account** | Public key, private key, URL endpoint |
| **chat-siris-logger** | Built locally: `cd ../chat-siris-logger && npm install && npm run build` |
| **chat-siris-gateway** | Required for external/legacy REST calls (`http://localhost:8080`) |
| **Shared secret** | `INTERNAL_HMAC_SECRET` must match gateway |

Optional (jobs are enqueued but not required for upload-init/complete to work):

| Requirement | Notes |
|-------------|-------|
| **chat-siris-worker-service** | Consumes `media-queue` (Phase 9+) |

### Redis topology

| DB index | Env var | Usage |
|----------|---------|-------|
| `0` | `REDIS_DB_CACHE=0` | Upload-init rate limits (`chat:rl:media:upload:{userId}`) |
| `1` | `REDIS_DB_EVENTS=1` | BullMQ `media-queue` producer |

Never mix cache and pub/sub across DB indexes.

---

## Quick start

```bash
# 1. Install dependencies
npm install --legacy-peer-deps

# 2. Configure environment
cp .env.example .env
# Edit MONGODB_URI, REDIS_URL, IMAGEKIT_*, INTERNAL_HMAC_SECRET

# 3. Build and run
npm run build
npm run dev            # hot reload
# or
npm start
```

Verify health:

```bash
curl http://localhost:3005/health
```

Expected:

```json
{
  "status": "ok",
  "service": "media-service",
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
| `PORT` | No | `3005` | HTTP listen port |
| `SERVICE_NAME` | No | `media-service` | Log label |
| `MONGODB_URI` | Yes | — | MongoDB connection string |
| `MONGODB_DB_NAME` | No | `chat_media` | Database name |
| `REDIS_URL` | Yes | — | Redis connection URL |
| `REDIS_DB_CACHE` | No | `0` | Rate limit DB index |
| `REDIS_DB_EVENTS` | No | `1` | BullMQ DB index |
| `IMAGEKIT_PUBLIC_KEY` | Yes | — | ImageKit public key (returned to client in upload-init) |
| `IMAGEKIT_PRIVATE_KEY` | Yes | — | ImageKit private key (**server only**) |
| `IMAGEKIT_URL_ENDPOINT` | Yes | — | ImageKit CDN base URL |
| `INTERNAL_HMAC_SECRET` | Yes | — | HMAC secret (must match gateway) |
| `LOG_LEVEL` | No | `info` | Winston log level |

---

## Gateway configuration

Add to `chat-siris-gateway/.env`:

```env
MEDIA_SERVICE_URL=http://localhost:3005
MEDIA_SERVICE_ENABLED=false   # set true only at Phase 10 cutover
INTERNAL_HMAC_SECRET=<same secret as media-service>
```

| Flag | When `false` | When `true` |
|------|--------------|-------------|
| `MEDIA_SERVICE_ENABLED` | Gateway proxies media routes to **monolith** (no upload-init) | Gateway routes to media-service |

Rollback: set `MEDIA_SERVICE_ENABLED=false`.

---

## Authentication

### Production path (via gateway)

Clients call legacy `/api/auth/media/*` on the gateway with a JWT:

```
Authorization: Bearer <accessToken>
```

The gateway validates JWT, injects identity headers, signs the internal request, and forwards to media-service.

### Internal routes (direct)

All `/internal/*` routes require **HMAC + gateway identity**:

```
X-Internal-Signature: <hex>
X-Internal-Timestamp: <unix-seconds>
X-User-Id: <userId>
```

Use `@chat-siris/logger` `signInternalRequest()` when testing locally.

---

## Upload flow

```text
Client → Gateway → media-service (upload-init)
       → ImageKit CDN (direct upload with signature)
       → Gateway → media-service (upload-complete)
       → sendMessage with CDN URL
```

**Dual-path (Phase 8):** The legacy browser ImageKit SDK path still works. Both CDN URL formats are accepted in `sendMessage` until Phase 10 removes the client private key.

---

## Endpoints

### `GET /health`

Public health check. No authentication.

**Example:**

```bash
curl http://localhost:3005/health
```

---

### `POST /internal/media/upload-init`

Returns ImageKit authentication parameters for a direct client upload.

**Gateway alias:** `POST /api/auth/media/upload-init` (JWT required)

**Request body:**

```json
{
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "folder": "Images",
  "sizeBytes": 1048576
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `fileName` | string | Yes | Original file name |
| `mimeType` | string | Yes | MIME type (e.g. `video/mp4`) |
| `folder` | string | Yes | One of: `Audios`, `Videos`, `Pdfs`, `Zips`, `Codes`, `Images` |
| `sizeBytes` | number | Yes | File size in bytes (validated before signing) |

**Success response (200):**

```json
{
  "uploadId": "550e8400-e29b-41d4-a716-446655440000",
  "signature": "<imagekit-signature>",
  "token": "<imagekit-token>",
  "expire": 1717171200,
  "folder": "Images",
  "publicKey": "<imagekit-public-key>"
}
```

**Example (via gateway):**

```bash
curl -X POST http://localhost:8080/api/auth/media/upload-init \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "photo.jpg",
    "mimeType": "image/jpeg",
    "folder": "Images",
    "sizeBytes": 1048576
  }'
```

**Errors:**

| Status | Condition |
|--------|-----------|
| `400` | Invalid folder or missing fields |
| `413` | Video > 16 MB or other file > 25 MB |
| `429` | More than 20 upload-init requests per user per hour |

**Rate limit key:** `chat:rl:media:upload:{userId}`

---

### `POST /internal/media/upload-complete`

Marks an upload as complete after the client receives the CDN URL from ImageKit. Enqueues a `media-queue` job for downstream processing (worker-service, Phase 9).

**Gateway alias:** `POST /api/auth/media/upload-complete` (JWT required)

**Request body:**

```json
{
  "uploadId": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://ik.imagekit.io/your_id/Images/photo.jpg"
}
```

**Success response (200):**

```json
{
  "status": true,
  "url": "https://ik.imagekit.io/your_id/Images/photo.jpg"
}
```

**Example (via gateway):**

```bash
curl -X POST http://localhost:8080/api/auth/media/upload-complete \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "uploadId": "550e8400-e29b-41d4-a716-446655440000",
    "url": "https://ik.imagekit.io/your_id/Images/photo.jpg"
  }'
```

**Errors:**

| Status | Condition |
|--------|-----------|
| `404` | Unknown `uploadId` or upload belongs to another user |

On success, an optional `media_assets` document is updated with `status: "completed"` and the CDN `url`.

---

## media_assets collection

Optional tracking in `chat_media.media_assets`:

| Field | Type | Notes |
|-------|------|-------|
| `uploadId` | string | Unique upload identifier |
| `userId` | string | Owner |
| `mimeType` | string | From upload-init |
| `folder` | string | ImageKit folder |
| `url` | string | Set on upload-complete |
| `status` | enum | `initiated` → `completed` |
| `createdAt` | Date | Creation timestamp |

---

## media-queue producer

On `upload-complete`, a BullMQ job is enqueued on Redis DB 1:

```typescript
{
  uploadId: string;
  sourceUrl: string;
  mimeType: string;
  targetFolder: string;
  userId: string;
  requestId?: string;
}
```

The **worker-service** (Phase 9) consumes this queue. Failures do not change the message URL in MongoDB.

---

## Size limits

| MIME type | Max size |
|-----------|----------|
| `video/*` | 16 MB |
| All other | 25 MB |

Validation runs at upload-init using client-supplied `sizeBytes`.

---

## Related services

| Service | Role |
|---------|------|
| **chat-siris-gateway** | JWT, rate limits, HMAC forward |
| **chat-siris-message-service** | Persists CDN URL in `sendMessage` |
| **chat-siris-worker-service** | Consumes `media-queue` (Phase 9) |

---

## License

UNLICENSED — internal Chat-Siris v2 migration component.
