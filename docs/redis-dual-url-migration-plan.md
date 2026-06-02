# Redis dual-URL migration plan (Upstash)

**Audience:** Implementation agent  
**Goal:** Replace “one `REDIS_URL` + `REDIS_DB_CACHE` / `REDIS_DB_EVENTS`” with **two Upstash instances** and env vars `REDIS_CACHE_URL` + `REDIS_EVENTS_URL`.  
**Status:** Implementation complete (Phases 0–4). Phase 5 is operator deployment — see §5.

---

## 1. Problem statement

### 1.1 What the tech spec assumed

- Single Redis host (`REDIS_URL`)
- Logical separation via **database index**: `0` = cache, `1` = events (pub/sub, BullMQ, Socket.IO adapter)

This works on **local Docker Redis** (`redis://127.0.0.1:6379`).

### 1.2 What Upstash actually does

- **One Upstash database = one URL = one keyspace**
- `SELECT` / multiple DB indexes are **not supported** (no real isolation with `REDIS_DB_EVENTS=1` on the same URL)
- Production must use **two Upstash Redis databases**:
  - **Cache instance** — JWT cache, refresh tokens, rate limits, read caches, presence
  - **Events instance** — pub/sub, BullMQ, `@socket.io/redis-adapter`

### 1.3 Current breakage (user-service)

After switching `chat-siris-user-service` to **ioredis** and setting `REDIS_URL` to Upstash:

1. `**startChannelEventSubscriber()`** still uses the `**redis` (node-redis)** package with `database: eventsDb()` (`REDIS_DB_EVENTS=1`). On Upstash, `SELECT 1` does nothing useful; connection/subscribe behavior is inconsistent.
2. Startup `**await startChannelEventSubscriber()`** runs **before** `app.listen()` with **no try/catch** — any connect/subscribe failure **crashes the whole process**.
3. **Mixed clients:** ioredis for cache, node-redis for subscriber (only user-service).

**Immediate mitigation (until migration lands):** wrap subscriber start in try/catch and log `channel_subscriber_degraded`, or set `REDIS_EVENTS_URL` once migration adds it. Do not block HTTP on pub/sub.

---

## 2. Target architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  REDIS_CACHE_URL  →  Upstash "chat-siris-cache" (DB index 0)   │
│  Keys: chat:jwt:*, chat:refresh:*, chat:user:*, chat:rl:*, …   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  REDIS_EVENTS_URL →  Upstash "chat-siris-events" (DB index 0)    │
│  Pub/sub channels, BullMQ queues, Socket.IO adapter              │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 Environment variables (canonical)


| Variable           | Required (prod)              | Purpose                                                                  |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------ |
| `REDIS_CACHE_URL`  | Yes                          | TCP URL (`rediss://…`) for cache instance                                |
| `REDIS_EVENTS_URL` | Yes (if service uses events) | TCP URL for events instance                                              |
| `REDIS_URL`        | Deprecated                   | Fallback for **local dev only** when dual URLs unset                     |
| `REDIS_DB_CACHE`   | Local only                   | Default `0`; ignored when `REDIS_CACHE_URL` is set                       |
| `REDIS_DB_EVENTS`  | Local only                   | Default `1` on single host; **force `0`** when `REDIS_EVENTS_URL` is set |


**Rule for implementation agent:** If `REDIS_CACHE_URL` or `REDIS_EVENTS_URL` is set → use that URL and **always `db: 0`** (node-redis `database: 0` / ioredis `{ db: 0 }`).

### 2.2 Paste Upstash URLs here (operator — do not commit secrets)

```bash
# ─── Cache instance (Upstash console → Redis URL, TLS) ───
REDIS_CACHE_URL="rediss://default:gQAAAAAAAhp8AAIgcDFkNTdmZDFiNDQ0OGU0MDc1YjI0MDk0ODc5MWQzMzI1Yw@summary-salmon-137852.upstash.io:6379"


# ─── Events instance (Upstash console → Redis URL, TLS) ───
REDIS_EVENTS_URL="rediss://default:gQAAAAAAAbsoAAIgcDE1OWM5NTJlNTdmZTY0ZGIxOTk2ZmM4M2U5Y2YxNTMyMA@fresh-eel-113448.upstash.io:6379"
```

Copy the same pair into each service’s deployment env (Render/Fly/etc.). Services that only need cache get **only** `REDIS_CACHE_URL`.

---

## 3. Shared helper (implement once)

Add `**chat-siris-logger/src/redis-env.ts`** and export from `chat-siris-logger/src/index.ts`:

```typescript
const LOCAL_DEFAULT = "redis://127.0.0.1:6379";

export function resolveCacheRedisUrl(): string {
  return (
    process.env.REDIS_CACHE_URL?.trim() ||
    process.env.REDIS_URL?.trim() ||
    LOCAL_DEFAULT
  );
}

export function resolveEventsRedisUrl(): string {
  return (
    process.env.REDIS_EVENTS_URL?.trim() ||
    process.env.REDIS_URL?.trim() ||
    LOCAL_DEFAULT
  );
}

/** DB index for cache client. Upstash dual-URL mode → always 0. */
export function resolveCacheDbIndex(): number {
  if (process.env.REDIS_CACHE_URL?.trim()) return 0;
  return Number.parseInt(process.env.REDIS_DB_CACHE ?? "0", 10);
}

/** DB index for events client. Upstash dual-URL mode → always 0. */
export function resolveEventsDbIndex(): number {
  if (process.env.REDIS_EVENTS_URL?.trim()) return 0;
  return Number.parseInt(process.env.REDIS_DB_EVENTS ?? "1", 10);
}

export function isDualUrlMode(): boolean {
  return Boolean(
    process.env.REDIS_CACHE_URL?.trim() && process.env.REDIS_EVENTS_URL?.trim(),
  );
}
```

Rebuild `chat-siris-logger` (`npm run build`) before touching services.

**BullMQ connection helper** (use in every `getBullMqConnection()`):

```typescript
import { resolveEventsRedisUrl, resolveEventsDbIndex } from "@chat-siris/logger";

export function getBullMqConnection(): {
  host: string;
  port: number;
  db: number;
  password?: string;
  username?: string;
  tls?: Record<string, never>;
} {
  const url = resolveEventsRedisUrl();
  const parsed = new URL(url);
  const connection: {
    host: string;
    port: number;
    db: number;
    password?: string;
    username?: string;
    tls?: Record<string, never>;
  } = {
    host: parsed.hostname,
    port: Number.parseInt(parsed.port || "6379", 10),
    db: resolveEventsDbIndex(),
  };
  if (parsed.password) connection.password = decodeURIComponent(parsed.password);
  if (parsed.username) connection.username = decodeURIComponent(parsed.username);
  if (parsed.protocol === "rediss:") connection.tls = {};
  return connection;
}
```

**ioredis options (Upstash-friendly):**

```typescript
import Redis from "ioredis";
import { resolveCacheRedisUrl, resolveCacheDbIndex } from "@chat-siris/logger";

export function createCacheIoredis(): Redis {
  return new Redis(resolveCacheRedisUrl(), {
    db: resolveCacheDbIndex(),
    maxRetriesPerRequest: null, // required for BullMQ workers; safe for cache
    lazyConnect: true,
    tls: resolveCacheRedisUrl().startsWith("rediss://") ? {} : undefined,
  });
}
```

**node-redis options:**

```typescript
import { createClient } from "redis";
import { resolveCacheRedisUrl, resolveCacheDbIndex } from "@chat-siris/logger";

export function createCacheRedisClient() {
  return createClient({
    url: resolveCacheRedisUrl(),
    database: resolveCacheDbIndex(),
  });
}
```

---

## 4. Service-by-service checklist

Legend: **C** = cache URL, **E** = events URL, **—** = not used.


| Service                       | C   | E   | Files to change                                                                                    | Notes                                                            |
| ----------------------------- | --- | --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `chat-siris-gateway`          | ✓   | —   | `src/redis.ts`, `.env.example`, README                                                             | `rate-limit-redis` + node-redis only                             |
| `chat-siris-auth-service`     | ✓   | —   | `src/redis.ts`, `.env.example`, README                                                             | Refresh tokens critical path                                     |
| `chat-siris-user-service`     | ✓   | ✓   | `src/redis.ts`, `src/services/channel-events.subscriber.ts`, `src/index.ts`, tests, `.env.example` | **Priority fix** — ioredis only, drop `redis` pkg for subscriber |
| `chat-siris-group-service`    | ✓   | ✓   | `src/redis.ts`, `src/services/queue.service.ts`, tests, `.env.example`                             | `getBullMqConnection` → events URL                               |
| `chat-siris-message-service`  | ✓   | ✓   | `src/redis.ts`, tests, `.env.example`                                                              |                                                                  |
| `chat-siris-media-service`    | ✓   | ✓   | `src/redis.ts`, tests, `.env.example`                                                              |                                                                  |
| `chat-siris-realtime-service` | ✓   | ✓   | `src/redis.ts`, `.env.example`                                                                     | 3 connections on E: pub, adapter sub, subscriber                 |
| `chat-siris-worker-service`   | ✓   | ✓   | `src/redis.ts`, `src/workers/connection.ts`, `.env.example`                                        | Cache = idempotency; BullMQ = events URL                         |


### 4.1 `chat-siris-user-service` (do first)

1. `**src/redis.ts`**
  - `createRedisClient()` → use `resolveCacheRedisUrl()` + `resolveCacheDbIndex()`.
  - Export `createEventsRedisClient()` as **second ioredis** instance (duplicate connection for subscribe), or singleton `getEventsRedis()` with `lazyConnect`.
2. `**src/services/channel-events.subscriber.ts`**
  - Remove `import { createClient } from "redis"`.
  - Use ioredis: `const sub = new Redis(resolveEventsRedisUrl(), { db: resolveEventsDbIndex(), … })`.
  - Subscribe: `sub.subscribe("channel.member.changed")` + `sub.on("message", …)`.
  - Guard: `if (!process.env.REDIS_EVENTS_URL && !process.env.REDIS_URL) return`.
  - **Do not** use `REDIS_DB_EVENTS=1` when only `REDIS_URL` points at Upstash (document: local docker can keep `REDIS_URL` + `REDIS_DB_EVENTS=1` until second URL exists).
3. `**src/index.ts`**
  - Wrap `startChannelEventSubscriber()`:
  - HTTP server must start even if events Redis is down.
4. `**package.json**`
  - Remove dependency `"redis"` if no longer imported.
5. **Tests** (`tests/profile-cache.integration.test.ts`, helpers)
  - Set `REDIS_CACHE_URL` / `REDIS_EVENTS_URL` in tests or use memory mocks.
6. `**.env.example`**
  ```bash
   REDIS_CACHE_URL=rediss://REPLACE_CACHE.upstash.io:6379
   REDIS_EVENTS_URL=rediss://REPLACE_EVENTS.upstash.io:6379
   # Local single-instance fallback:
   # REDIS_URL=redis://127.0.0.1:6379
   # REDIS_DB_CACHE=0
   # REDIS_DB_EVENTS=1
  ```

### 4.2 Dual-client services (group, message, media, realtime)

For each `src/redis.ts`:


| Before                                                    | After                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `url: process.env.REDIS_URL` in `createCacheRedisClient`  | `url: resolveCacheRedisUrl()`, `database: resolveCacheDbIndex()`   |
| `url: process.env.REDIS_URL` in `createEventsRedisClient` | `url: resolveEventsRedisUrl()`, `database: resolveEventsDbIndex()` |
| Error if `!REDIS_URL`                                     | Error if `!resolveCacheRedisUrl()` (still has local default)       |


Replace `getBullMqConnection()` to parse `**resolveEventsRedisUrl()**` (not cache URL).

**realtime-service:** `getEventsSubscriber()` must call `createClient({ url: resolveEventsRedisUrl(), database: resolveEventsDbIndex() })` — not `createEventsRedisClient()` duplicate factory if that shares the pub client (keep separate subscriber connection).

### 4.3 Cache-only services (gateway, auth)

- `createRedisClient()` / `getRedis()` → `resolveCacheRedisUrl()` + `resolveCacheDbIndex()`.
- No `REDIS_EVENTS_URL` in deployment.

### 4.4 worker-service

- `createCacheRedisClient()` → cache URL (idempotency keys `chat:worker:idempotency:`*).
- `getBullMqConnection()` + `workers/connection.ts` → **events URL only**.
- Health check: optionally ping **both** URLs in `/health` (cache + events).

---

## 5. Implementation phases (agent order)

### Phase 0 — Unblock user-service (small PR) — **DONE**

- Subscriber try/catch in `index.ts` (service boots without events Redis)
- Subscriber uses `REDIS_EVENTS_URL ?? REDIS_URL` (prep for Phase 1)

### Phase 1 — Shared `redis-env` in logger — **DONE**

- Add `redis-env.ts`, export, build logger
- Unit tests for URL/db resolution (dual URL → db 0; local fallback → db 1 for events)

### Phase 2 — user-service full dual-URL + ioredis subscriber — **DONE**

- Complete §4.1
- Verify: `npm run build && npm run dev` with pasted Upstash URLs in §2.2
- `GET /health` → `redis: ok`

### Phase 3 — Remaining services — **DONE**

- gateway, auth (cache only)
- group, message, media, realtime, worker (cache + events)
- Update every `.env.example` and service README Redis section

### Phase 4 — Dev ergonomics — **DONE**

- `scripts/start-dev.js` — document two local URLs OR keep single `REDIS_URL` for docker with `REDIS_DB_`*
- Optional: docker-compose with two redis containers mapping to 6379 and 6380 as cache/events URLs (not added; local single `REDIS_URL` remains supported)

### Phase 5 — Deployment — **operator**

- Create two Upstash DBs per environment (staging/prod)
- Paste URLs into §2.2 and platform env
- Deploy order: **auth + gateway** → **user, group, message, media** → **realtime** → **worker**
- Smoke: login, send message → socket receives, queue depth on worker `/health`

---

## 6. `.env` templates per deployment

### Cache-only (gateway, auth)

```bash
REDIS_CACHE_URL=<paste from §2.2>
```

### Cache + events (user, group, message, media, realtime, worker)

```bash
REDIS_CACHE_URL=<paste from §2.2>
REDIS_EVENTS_URL=<paste from §2.2>
```

### Local Docker (single Redis — no Upstash)

```bash
REDIS_URL=redis://127.0.0.1:6379
REDIS_DB_CACHE=0
REDIS_DB_EVENTS=1
# Do not set REDIS_CACHE_URL / REDIS_EVENTS_URL
```

---

## 7. Verification checklist


| #   | Test                                  | Expected                                                               |
| --- | ------------------------------------- | ---------------------------------------------------------------------- |
| 1   | `redis-cli -u $REDIS_CACHE_URL PING`  | `PONG`                                                                 |
| 2   | `redis-cli -u $REDIS_EVENTS_URL PING` | `PONG`                                                                 |
| 3   | user-service `/health`                | `redis: ok`, process stays up if events down (degraded subscriber log) |
| 4   | Login + refresh                       | Keys under cache instance (`chat:refresh:*`)                           |
| 5   | Send message                          | `message.created` on events instance; realtime receives                |
| 6   | Join channel                          | `channel.member.changed` invalidates `chat:user:*` on cache instance   |
| 7   | worker `/health`                      | Queue depths; jobs consume from events instance                        |
| 8   | Upstash console                       | Command traffic on **both** instances under load                       |


**Key isolation check:** Write `SET probe:cache 1` on cache URL and `GET probe:cache` on events URL → must return `(nil)`.

---

## 8. Documentation updates (same PR series)

- `chat-siris-v2/tech-spec.md` §3.5 — add note: “Upstash: two instances, `REDIS_CACHE_URL` / `REDIS_EVENTS_URL`; DB index always 0 per instance”
- `docs/hld-microservices.md` — diagram: two Upstash boxes instead of R0/R1 on one host
- Deprecate `UPSTASH_REDIS_REST_`* in user-service README (removed)

---

## 9. Out of scope (do not block migration)

- Migrating gateway/auth from `redis` package to `ioredis` (optional consistency later)
- Implementing `messages.refetch` pub/sub
- Moving worker idempotency keys to events instance (current: cache URL is fine)

---

## 10. Acceptance criteria

1. All services start with **only** `REDIS_CACHE_URL` / `REDIS_EVENTS_URL` set (no reliance on `REDIS_DB_EVENTS=1` on Upstash).
2. Local dev still works with single `REDIS_URL` + `REDIS_DB_CACHE` / `REDIS_DB_EVENTS`.
3. user-service uses **ioredis only** (no `redis` package).
4. Pub/sub and BullMQ use **events URL**; all `chat:`* cache keys use **cache URL**.
5. §2.2 placeholders filled by operator; secrets not committed to git.

---

## 11. Quick reference — who connects where

```
gateway, auth          → REDIS_CACHE_URL only
user-service           → CACHE (profiles) + EVENTS (subscribe channel.member.changed)
group-service          → CACHE (channel/authz caches) + EVENTS (pub/sub + channel-sync-queue)
message-service        → CACHE (history, rate limit) + EVENTS (pub/sub + notification-queue)
media-service          → CACHE (rate limit) + EVENTS (media-queue)
realtime-service       → CACHE (presence, membership, rl) + EVENTS (pub/sub, socket adapter)
worker-service         → CACHE (idempotency) + EVENTS (all BullMQ workers + DLQ)
```

---

*End of migration plan.*