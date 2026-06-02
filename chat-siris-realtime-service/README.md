# chat-siris-realtime-service

Socket.IO server for Chat-Siris v2: JWT handshake, legacy socket event names, Redis presence, pub/sub fan-out from message-service, and membership checks via group-service. **No MongoDB** — steady state uses Redis + HTTP only.

Port **3333** matches the legacy monolith socket URL so the frontend can switch with `NEXT_PUBLIC_REALTIME_BASE` only (Phase 10 cutover).

---

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Node.js** | 20+ recommended |
| **Redis** | One instance, two logical DB indexes (see below) |
| **RS256 JWT public key** | Same `JWT_PUBLIC_KEY` PEM as auth-service / gateway |
| **auth-service** | Issues access tokens the client passes in `auth.token` |
| **group-service** | `GROUP_SERVICE_URL` (default `http://localhost:3003`) — membership verify on cache miss |
| **message-service** | Publishes `message.created` / `message.deleted` on Redis DB 1 |
| **worker-service** | Optional for BullMQ; not required for socket fan-out |
| **Shared HMAC secret** | `INTERNAL_HMAC_SECRET` — must match gateway and group-service |

### Redis topology (required)

| DB index | Env | Purpose |
|----------|-----|---------|
| `0` | `REDIS_DB_CACHE=0` | Presence, connect rate limits, anti-spoof cache, membership cache |
| `1` | `REDIS_DB_EVENTS=1` | Pub/sub, `@socket.io/redis-adapter` |

Never mix cache and pub/sub across DB indexes.

### Local stack (full cutover)

Run these before realtime-service (typical ports):

| Service | Port | Command |
|---------|------|---------|
| Redis | 6379 | `redis-server` or Docker |
| auth-service | 3001 | `npm run dev` |
| user-service | 3002 | `npm run dev` |
| group-service | 3003 | `npm run dev` |
| message-service | 3004 | `npm run dev` |
| media-service | 3005 | `npm run dev` |
| worker-service | 3006 | `npm run dev` |
| **gateway** | 8080 | `npm run dev` |
| **realtime-service** | 3333 | `npm run dev` |
| frontend | 3000 | `npm run dev` in `chat-siris-v2` |

Gateway env (Phase 10): `MESSAGE_SERVICE_ENABLED=true`, `MEDIA_SERVICE_ENABLED=true`. Frontend: `NEXT_PUBLIC_GATEWAY_BASE=http://localhost:8080`, `NEXT_PUBLIC_REALTIME_BASE=http://localhost:3333`, `NEXT_PUBLIC_IMAGEKIT_ENDPOINT` set — **no** `NEXT_PUBLIC_IMAGEKIT_PRIVATE` (uploads use gateway `upload-init`). See [chat-siris-v2/README.md](../chat-siris-v2/README.md).

---

## Quick start

```bash
cd chat-siris-realtime-service
cp .env.example .env
# Set REDIS_URL, JWT_PUBLIC_KEY, INTERNAL_HMAC_SECRET, GROUP_SERVICE_URL, CORS_ORIGINS

npm install
npm run build
npm run dev
```

Verify health:

```bash
curl -s http://localhost:3333/health | jq .
```

Expected response:

```json
{
  "status": "ok",
  "service": "realtime-service",
  "uptime": 12.3,
  "redis": "ok",
  "mongo": "n/a",
  "version": "1.0.0"
}
```

### Event tester (dev UI)

Browser harness at `http://localhost:3333/test-client/` — connect with a gateway `accessToken`, emit events, watch server → client traffic.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3333` | HTTP + Socket.IO |
| `SERVICE_NAME` | `realtime-service` | Logs / health |
| `REDIS_URL` | — | **Required** |
| `REDIS_DB_CACHE` | `0` | Cache DB |
| `REDIS_DB_EVENTS` | `1` | Pub/sub + adapter |
| `JWT_PUBLIC_KEY` | — | PEM RS256 public key (`\n` in env) |
| `SOCKET_AUTH_REQUIRED` | `true` | Reject connect without valid JWT |
| `GROUP_SERVICE_URL` | `http://localhost:3003` | Membership HTTP |
| `INTERNAL_HMAC_SECRET` | — | HMAC to group-service |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated; `https://*.vercel.app` supported |
| `CONNECT_RATE_LIMIT_DISABLED` | `false` | Set `true` for local dev |
| `CONNECT_RATE_LIMIT_MAX` | `20` | Connects per IP per window |
| `CONNECT_RATE_LIMIT_WINDOW_SEC` | `300` | Window seconds |
| `SIGTERM_DRAIN_MS` | `30000` | Graceful shutdown |

---

## HTTP endpoints

All HTTP routes are on the same port as Socket.IO. There is **no** chat REST API here — REST goes through the gateway.

### `GET /health`

Load balancer / Render health probe. No authentication.

**Example:**

```bash
curl -s http://localhost:3333/health
```

**Response fields:**

| Field | Values | Meaning |
|-------|--------|---------|
| `status` | `ok`, `degraded` | Overall health |
| `service` | string | Service name |
| `uptime` | number | Seconds since start |
| `redis` | `ok`, `error` | Cache + events Redis ping |
| `mongo` | `n/a` | Always N/A (no MongoDB) |
| `version` | string | Build version |

### Static: `GET /test-client/`

Serves the Socket.IO event tester UI (development only).

---

## Client connection (Socket.IO)

Phase 10 frontend (`chat-siris-v2/service/socket.js`):

```javascript
import { io } from "socket.io-client";
import { getAccessToken } from "../utils/authToken";

export const socket = io(process.env.NEXT_PUBLIC_REALTIME_BASE, {
  autoConnect: false,
  auth: () => ({ token: getAccessToken() }),
  withCredentials: true,
  extraHeaders: { "my-custom-header": "abcd" },
});

socket.connect(); // after login when accessToken is set
```

Obtain `accessToken` from `POST http://localhost:8080/api/auth/login` (via gateway). Reconnect after refresh so `auth.token` stays current.

**Node test client example:**

```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:3333", {
  auth: { token: "<accessToken from gateway login>" },
  extraHeaders: { "my-custom-header": "abcd" },
});

socket.on("connect", () => console.log("connected", socket.id));
socket.on("msg-recieve", (payload) => console.log("message", payload));
socket.emit("add-user", "<userId matching JWT sub>");
socket.emit("addUserToChannel", { name: "general", _id: "..." });
```

When `SOCKET_AUTH_REQUIRED=true`, missing or invalid JWT fails the handshake.

---

## Socket events — client → server

Names are **unchanged** from the monolith.

### `add-user`

Register presence for the connected user.

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | Must equal JWT `sub` when auth is required |

**Example:**

```javascript
socket.emit("add-user", "507f1f77bcf86cd799439011");
```

**Server:** Redis key `chat:presence:user:{userId}` TTL 60s.

---

### `addUserToChannel`

Join a channel room after server-side membership check.

**Example payload:**

```javascript
socket.emit("addUserToChannel", {
  name: "general",
  _id: "674abc123def456789012345",
  users: [/* channel user snapshots */],
});
```

**Server:** HTTP authorize via group-service (or cache) → `socket.join(name)` → `channelUpdate` to room.

---

### `RemoveUserFromChannel`

Leave a channel room.

```javascript
socket.emit("RemoveUserFromChannel", { name: "general" });
```

---

### `add-member`

Join room and notify members (`userJoined` fix: targets `channelName`, not undefined `room`).

```javascript
socket.emit("add-member", {
  channelName: "general",
  members: [{ username: "alice", avatarImage: "https://..." }],
});
```

**Server → client:** `userJoined` with `members` to room `general`.

---

### `add-msg` (deprecated relay)

Legacy optimistic relay; only broadcasts if message `_id` is in anti-spoof cache (~60s after `message.created`). Prefer REST `sendMessage` through gateway.

```javascript
socket.emit("add-msg", {
  group: "general",
  data: { status: true, data: { _id: "...", message: { text: "hi" } } },
});
```

---

### `refetchChannels`

```javascript
socket.emit("refetchChannels");
```

**Server → others:** `fetch`.

---

### `refetchMessages`

```javascript
socket.emit("refetchMessages", { group: "general" });
// or legacy string:
socket.emit("refetchMessages", "general");
```

**Server → room:** `fetchMessages` with channel name — frontend refetches latest page via REST.

---

### `channelUpdate`

```javascript
socket.emit("channelUpdate", { name: "general", adminOnly: false /* ... */ });
```

**Server → room:** `channelDetailsUpdate`.

---

## Socket events — server → client

| Event | When | Payload example |
|-------|------|-----------------|
| `msg-recieve` | `message.created` pub/sub or allowed `add-msg` | `{ status: true, data: { _id, group, message: { text }, byUserName, ... } }` |
| `fetchMessages` | Delete / refetch | `"general"` (channel name string) |
| `fetch` | Channel list refresh | — |
| `channelUpdate` | Join/leave | Channel ref object |
| `channelDetailsUpdate` | Client `channelUpdate` | Channel object |
| `userJoined` | `add-member` | `members` array |

**E2E flow (REST + socket):**

1. Login → `accessToken`.
2. Connect socket with `auth.token`.
3. `add-user` + `addUserToChannel` for `general` (must run when opening a channel — room join is required for `msg-recieve`).
4. `POST /api/auth/sendMessage` via gateway (message-service publishes `message.created`).
5. Within ~2s, socket receives `msg-recieve` without calling `add-msg`.

**Troubleshooting:** If messages only appear after leaving/rejoining the channel, the client likely never joined the Socket.IO room (`addUserToChannel`). Check realtime logs for `socket channel join denied`. Ensure `message-service` and `realtime-service` use the same `REDIS_URL` and `REDIS_DB_EVENTS=1` for pub/sub. Worker-service does not relay chat messages.

---

## Pub/sub (Redis DB 1)

Channels in `src/constants/pubsub-channels.ts`:

| Redis channel | Socket emit |
|---------------|-------------|
| `message.created` | `io.to(channelName).emit('msg-recieve', { status: true, data: message })` |
| `message.deleted` | `io.to(channelName).emit('fetchMessages', channelName)` |
| `channel.updated` | `io.emit('fetch')` + cache invalidation |
| `channel.member.changed` | Same as `channel.updated` |

**Simulate `message.created` (staging / local):**

```bash
redis-cli -n 1 PUBLISH message.created '{"event":"message.created","requestId":"test-1","channelName":"general","message":{"_id":"674a1b2c3d4e5f6789012345","group":"general","message":{"text":"hello"},"byUserName":"alice","byUserImage":"https://cdn.example/a.png","createdAt":"2026-05-31T12:00:00.000Z","updatedAt":"2026-05-31T12:00:00.000Z"},"emittedAt":"2026-05-31T12:00:00.000Z"}'
```

Clients in room `general` should get `msg-recieve`.

---

## Horizontal scaling

- `@socket.io/redis-adapter` on DB 1 — multiple instances behind a load balancer.
- Sticky sessions not required with adapter enabled.
- `SKIP_SOCKET_REDIS_ADAPTER=true` — local tests only, not production.

---

## Rollback (emergency)

| Env | Rollback |
|-----|----------|
| Frontend `NEXT_PUBLIC_REALTIME_BASE` | Monolith socket URL |
| `SOCKET_AUTH_REQUIRED` | `false` (drill only; restore after) |
| Gateway `MESSAGE_SERVICE_ENABLED` | `false` |

See `chat-siris-gateway/docs/ROLLBACK-PHASE10.md`.

---

## Related services

| Service | Port | Role |
|---------|------|------|
| `chat-siris-gateway` | 8080 | REST, JWT, routes to microservices |
| `chat-siris-message-service` | 3004 | Messages + pub/sub publish |
| `chat-siris-group-service` | 3003 | Channels / membership |
| `chat-siris-media-service` | 3005 | Upload-init signing |
| `chat-siris-worker-service` | 3006 | BullMQ (separate process) |

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Watch mode (`tsx`) |
| `npm run build` | Compile `dist/` |
| `npm start` | Production `node dist/index.js` |
| `npm test` | Vitest (pub/sub → `msg-recieve`) |
