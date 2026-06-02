# Chat-Siris v2 — Microservices

Backend platform for **Chat-Siris v2**: API gateway, domain microservices, realtime Socket.IO, and background workers. This repository is the **backend services monorepo**.

| Lives in **this repo** | Lives in **other repos** |
|------------------------|---------------------------|
| Gateway + 7 microservices + `@chat-siris/logger` | **Frontend** — Next.js (`chat-siris-v2`) |
| `docs/`, `scripts/` | **Legacy monolith** — `Chat-Siris-v2-Server` |

---

## Services overview

| Service | Port (local) | Role |
|---------|--------------|------|
| [api-gateway](chat-siris-gateway/) | 8080 | Public REST entry, JWT, rate limits, `/api/auth/*` proxy |
| [auth-service](chat-siris-auth-service/) | 3001 | Login, register, OAuth, JWT & refresh tokens |
| [user-service](chat-siris-user-service/) | 3002 | Profiles, subscribe, `inChannel` |
| [group-service](chat-siris-group-service/) | 3003 | Channels, membership, authorization |
| [message-service](chat-siris-message-service/) | 3004 | Messages, history, pub/sub publish |
| [media-service](chat-siris-media-service/) | 3005 | ImageKit upload-init / complete |
| [realtime-service](chat-siris-realtime-service/) | 3333 | Socket.IO, presence, event fan-out |
| [worker-service](chat-siris-worker-service/) | 3006 | BullMQ consumers (notification, media, channel-sync) |
| [@chat-siris/logger](chat-siris-logger/) | — | Shared logging, HMAC, health helpers |

Each service has its own `README.md` with API and env details.

---

## System architecture

Clients talk to the **gateway** for REST and to **realtime-service** for WebSockets. Services do not read each other’s MongoDB databases; they coordinate via **internal HTTP** (HMAC-signed) and **Redis** (cache + pub/sub/queues).

```mermaid
flowchart TB
  subgraph Clients["Clients"]
    FE["Next.js frontend<br/><i>separate git repo</i>"]
  end

  subgraph Edge["Edge"]
    GW["api-gateway :8080<br/>JWT · rate limit · proxy"]
  end

  subgraph HTTP["HTTP microservices"]
    AUTH["auth-service :3001"]
    USER["user-service :3002"]
    GROUP["group-service :3003"]
    MSG["message-service :3004"]
    MEDIA["media-service :3005"]
  end

  subgraph LongRunning["Realtime & async"]
    RT["realtime-service :3333<br/>Socket.IO"]
    WRK["worker-service :3006<br/>BullMQ"]
  end

  subgraph Redis["Redis"]
    RC["Cache instance<br/>REDIS_CACHE_URL"]
    RE["Events instance<br/>REDIS_EVENTS_URL<br/>pub/sub · queues · socket adapter"]
  end

  subgraph Mongo["MongoDB"]
    M1[(chat_auth)]
    M2[(chat_users)]
    M3[(chat_groups)]
    M4[(chat_messages)]
    M5[(chat_media)]
  end

  FE -->|REST Bearer JWT| GW
  FE -->|WebSocket| RT

  GW --> AUTH & USER & GROUP & MSG & MEDIA

  AUTH --> M1
  USER --> M2
  GROUP --> M3
  MSG --> M4
  MEDIA --> M5

  AUTH -->|merge profile| USER
  MSG -->|authorize| GROUP
  RT -->|membership| GROUP
  GROUP -->|inChannel sync| USER

  GW & AUTH & USER & GROUP & MSG & MEDIA & RT & WRK --> RC
  USER & GROUP & MSG & MEDIA & RT & WRK --> RE

  MSG & GROUP -->|publish| RE
  RE -->|subscribe| RT
  MSG & MEDIA & GROUP -->|enqueue| RE
  RE --> WRK
```

---

## Redis: cache and events

Two Redis URLs separate **cache/rate limits** from **pub/sub, queues, and the Socket.IO adapter** (required for Upstash; local dev can use one host with `REDIS_DB_CACHE` / `REDIS_DB_EVENTS`).

```mermaid
flowchart LR
  subgraph Cache["REDIS_CACHE_URL"]
    K1["chat:jwt:*"]
    K2["chat:refresh:*"]
    K3["chat:user:*"]
    K4["chat:channel:* · chat:authz:*"]
    K5["chat:messages:*"]
    K6["chat:presence:*"]
    K7["chat:rl:*"]
  end

  subgraph Events["REDIS_EVENTS_URL"]
    P1["pub/sub: message.* · channel.*"]
    P2["BullMQ: notification · media · channel-sync"]
    P3["Socket.IO redis-adapter"]
  end

  GW & AUTH --> Cache
  USER & GROUP & MSG & MEDIA & RT --> Cache
  USER & GROUP & MSG & MEDIA & RT & WRK --> Events
```

See [docs/redis-dual-url-migration-plan.md](docs/redis-dual-url-migration-plan.md).

---

## Request flow: send message

```mermaid
sequenceDiagram
  participant FE as Frontend
  participant GW as api-gateway
  participant MSG as message-service
  participant GRP as group-service
  participant DB as MongoDB
  participant R as Redis events
  participant RT as realtime-service

  FE->>GW: POST /api/auth/sendMessage (Bearer JWT)
  GW->>MSG: proxy + HMAC + X-User-Id
  MSG->>GRP: GET authorize (internal)
  GRP-->>MSG: allowed
  MSG->>DB: insert message
  MSG->>R: PUBLISH message.created
  R-->>RT: subscriber
  RT->>FE: emit msg-recieve (room)
  MSG-->>GW: legacy envelope
  GW-->>FE: response
```

---

## Repository layout

```
.
├── chat-siris-logger/          # Shared npm package (build first)
├── chat-siris-gateway/
├── chat-siris-auth-service/
├── chat-siris-user-service/
├── chat-siris-group-service/
├── chat-siris-message-service/
├── chat-siris-media-service/
├── chat-siris-realtime-service/
├── chat-siris-worker-service/
├── docs/                       # HLD, Redis reference
└── scripts/
    └── start-dev.js            # Local multi-service launcher
```

---

## Prerequisites

- **Node.js** 20+
- **MongoDB** (Atlas or local)
- **Redis** — local Docker **or** `REDIS_CACHE_URL` + `REDIS_EVENTS_URL`
- **Frontend** — separate repo for end-to-end UI tests

---

## Local development

### 1. Build the shared logger

```bash
cd chat-siris-logger && npm ci && npm run build && cd ..
```

### 2. Configure each service

Copy `.env.example` → `.env` in each service folder (never commit `.env`).

**Local single Redis:**

```bash
REDIS_URL=redis://127.0.0.1:6379
REDIS_DB_CACHE=0
REDIS_DB_EVENTS=1
```

**Two Redis URLs (e.g. Upstash):**

```bash
REDIS_CACHE_URL=rediss://...
REDIS_EVENTS_URL=rediss://...
```

Use the **same** `INTERNAL_HMAC_SECRET` and JWT key pair across gateway, auth, and realtime.

### 3. Install and run a service

```bash
cd chat-siris-user-service
npm ci && npm run build && npm run dev
```

### 4. Run the full backend stack

From the repo root (starts all services in this repo; **does not** start the frontend repo):

```bash
node scripts/start-dev.js
```

Optional: `node scripts/start-dev.js --only=gateway,auth-service,user-service`

Point the frontend (separate repo) at:

- `NEXT_PUBLIC_GATEWAY_BASE=http://localhost:8080`
- `NEXT_PUBLIC_REALTIME_BASE=http://localhost:3333`

---

## Environment variables (common)

| Variable | Used by | Purpose |
|----------|---------|---------|
| `REDIS_CACHE_URL` | Most services | Cache / rate limits |
| `REDIS_EVENTS_URL` | user, group, message, media, realtime, worker | Pub/sub, BullMQ, Socket.IO adapter |
| `INTERNAL_HMAC_SECRET` | All backends | Service-to-service auth |
| `MONGODB_URI` / `MONGODB_DB_NAME` | Data services | Per-service database |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | auth (+ realtime for sockets) | RS256 tokens |
| `*_SERVICE_URL` | gateway | Upstream service base URLs |

Service-specific tables are in each service’s `README.md`.

---

## Health checks

Every HTTP service exposes:

```bash
curl http://localhost:<port>/health
```

Example after local start:

```bash
curl http://localhost:8080/health   # gateway
curl http://localhost:3001/health   # auth
curl http://localhost:3333/health   # realtime
curl http://localhost:3006/health   # worker (+ queue depths)
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [docs/hld-microservices.md](docs/hld-microservices.md) | High-level design and architecture |
| [docs/redis-dual-url-migration-plan.md](docs/redis-dual-url-migration-plan.md) | Two Redis URLs, key namespaces |
| [chat-siris-gateway/README.md](chat-siris-gateway/README.md) | Routes, rate limits, rollback flags |

---

## Inter-service security

Internal routes use **HMAC** (`X-Internal-Signature`, `X-Internal-Timestamp`) via `@chat-siris/logger`. The gateway strips client identity headers and sets trusted `X-User-Id` / `X-User-Email` after JWT validation.

---

## License

UNLICENSED — private project.
