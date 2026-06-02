# chat-siris-worker-service

BullMQ job consumers for Chat-Siris v2. Workers run in a **separate process** from realtime-service (Hard Constraint #10).

Port **3006** serves health + queue depth metrics only.

---

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Node.js** | 20+ recommended |
| **Redis** | DB **1** (`REDIS_DB_EVENTS=1`) for BullMQ; DB **0** for idempotency keys |
| **user-service** | Required for `channel-sync-queue` (`USER_SERVICE_URL`) |
| **INTERNAL_HMAC_SECRET** | Must match gateway / user-service |

### Redis topology

| DB | Env | Purpose |
|----|-----|---------|
| `0` | `REDIS_DB_CACHE=0` | Idempotency keys `chat:worker:idempotency:*` |
| `1` | `REDIS_DB_EVENTS=1` | BullMQ queues |

---

## Quick start (local)

```bash
cd chat-siris-worker-service
cp .env.example .env
# Edit REDIS_URL, USER_SERVICE_URL, INTERNAL_HMAC_SECRET

npm install
npm run build
npm run dev
```

Health:

```bash
curl -s http://localhost:3006/health | jq .
curl -s http://localhost:3006/health/queues | jq .
```

---

## Queues

| Queue | Producer | Consumer behavior |
|-------|----------|-------------------|
| `notification-queue` | message-service | **Log-only stub** (logs `messageId`, no FCM) |
| `media-queue` | media-service | Processes upload jobs; retries 5×; DLQ on final failure |
| `read-receipt-queue` | realtime (future) | **Scaffold** — logs payload only |
| `channel-sync-queue` | group-service | Idempotent `inChannel` sync to user-service |

Failed jobs after max attempts move to `{queue-name}-dlq` and are logged (configure `SENTRY_DSN` in Phase 11 for external capture).

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3006` | Health HTTP port |
| `REDIS_URL` | — | **Required** |
| `REDIS_DB_CACHE` | `0` | Idempotency store |
| `REDIS_DB_EVENTS` | `1` | BullMQ |
| `USER_SERVICE_URL` | — | **Required** for channel-sync |
| `INTERNAL_HMAC_SECRET` | — | **Required** |
| `QUEUE_LAG_THRESHOLD` | `1000` | Health `degraded` if any queue pending count exceeds this |
| `SIGTERM_DRAIN_MS` | `60000` | SIGTERM job drain window |
| `SENTRY_DSN` | — | Optional; failures logged structurally when unset |
| `MEDIA_WORKER_SIMULATE_FAILURE` | — | Set `true` to test media retry/DLQ locally |

---

## HTTP endpoints

### `GET /health`

```bash
curl -s http://localhost:3006/health
```

Returns `buildHealthResponse` plus `queues` depth map. Status is `degraded` when Redis is down or any queue depth exceeds `QUEUE_LAG_THRESHOLD`.

Example:

```json
{
  "status": "ok",
  "service": "worker-service",
  "uptime": 42.1,
  "redis": "ok",
  "mongo": "n/a",
  "version": "1.0.0",
  "queues": {
    "notification-queue": 0,
    "media-queue": 2,
    "read-receipt-queue": 0,
    "channel-sync-queue": 0
  }
}
```

### `GET /health/queues`

Queue depths and configured threshold only.

```bash
curl -s http://localhost:3006/health/queues
```

---

## Job payload examples

### notification-queue (from message-service)

```json
{
  "messageId": "674a1b2c3d4e5f6789012345",
  "channelName": "general",
  "senderId": "507f1f77bcf86cd799439011",
  "senderName": "alice",
  "previewText": "Hello world",
  "requestId": "req-uuid"
}
```

### media-queue (from media-service)

```json
{
  "uploadId": "upload-abc",
  "sourceUrl": "https://ik.imagekit.io/...",
  "mimeType": "image/png",
  "targetFolder": "Images",
  "userId": "507f1f77bcf86cd799439011",
  "messageId": "optional-msg-id",
  "requestId": "req-uuid"
}
```

On permanent failure the original message URL in message-service is **unchanged** (P34-F-47).

### channel-sync-queue (from group-service)

```json
{
  "userId": "507f1f77bcf86cd799439011",
  "channelName": "general",
  "action": "join",
  "requestId": "req-uuid"
}
```

Idempotency key: `{userId}:{channelName}:{action}` — duplicate jobs are skipped.

### read-receipt-queue (scaffold)

```json
{
  "userId": "507f1f77bcf86cd799439011",
  "channelName": "general",
  "messageIds": ["674a1b2c3d4e5f6789012345"],
  "readAt": "2026-05-31T12:00:00.000Z",
  "requestId": "req-uuid"
}
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start workers + health server |
| `npm run build` | Compile TypeScript |
| `npm start` | Production entry |
| `npm test` | Unit tests (idempotency, lag threshold) |

---

## Architecture note

Realtime socket fan-out lives in **chat-siris-realtime-service** (`:3333`). This service only processes background jobs — do not colocate BullMQ consumers in the realtime entrypoint.
