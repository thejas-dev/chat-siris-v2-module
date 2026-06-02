# Chat-Siris v2 — Vercel + Render deployment plan

**Audience:** You (operator) + implementation agent (Vercel/Render config, serverless adapters)  
**Goal:** Deploy the v2 stack on **many Vercel projects** + **at most 1–2 Render services**, without touching the **legacy** frontend/monolith.  
**Prerequisite:** Redis dual-URL migration complete locally (`REDIS_CACHE_URL` + `REDIS_EVENTS_URL`) — see [redis-dual-url-migration-plan.md](./redis-dual-url-migration-plan.md).

---

## 1. Platform constraints (read first)

### 1.1 What cannot run on Vercel serverless

| Capability | Why | Must run on |
|------------|-----|-------------|
| **Socket.IO** (`realtime-service`) | Needs long-lived TCP/WebSocket connections | **Render** (always-on web service) |
| **BullMQ workers** (`worker-service`) | Needs a process always consuming Redis queues | **Render** (background worker or web service) |

Everything else is **stateless HTTP** and can run on Vercel **if** you add a small serverless entrypoint (`api/index.ts` + `vercel.json`). The repo today uses `app.listen()` — the implementation agent must add Vercel adapters per service (one-time).

### 1.2 Render free tier reality

- **~750 instance-hours/month** per workspace.
- **One** web service running 24/7 ≈ **720 h/month** → you are already at the limit.
- **Two** always-on Render services ≈ **1440 h/month** → **exceeds free tier** unless:
  - Services **spin down** when idle (Render free default), or
  - You upgrade to **Render Starter** (~$7/service/month) for always-on.

**Critical:** Spin-down breaks **Socket.IO** (connections drop; cold starts on wake). For staging/production chat, plan **always-on Render for `realtime-service`** (paid Starter recommended).

**Worker on Render:** If spun down, queues backlog until the next wake. Acceptable for early staging; not for prod chat reliability.

### 1.3 Vercel free tier (HTTP services + frontend)

- Many **separate Vercel projects** are fine (your constraint: unlimited free instances).
- Hobby **serverless timeout ~10s** — OK for most REST; watch large uploads (media uses ImageKit client upload + gateway callbacks).
- **Cold starts** on first request after idle — acceptable for auth/profile APIs.
- **`file:../chat-siris-logger` dependency:** each service deploy must **build `chat-siris-logger` first** in the install/build step (documented below).

### 1.4 Legacy isolation

| Asset | Action |
|-------|--------|
| Existing production frontend (monolith URL) | **Do not change** env or DNS |
| New v2 frontend | **New Vercel project** + new URL (e.g. `chat-siris-v2-staging.vercel.app`) |
| `MONOLITH_URL` on gateway | Keep pointed at legacy server for rollback; leave `*_SERVICE_ENABLED=true` for microservices |

---

## 2. Recommended placement (default plan)

### 2.1 Summary table

| Component | Platform | Render/Vercel project name (example) | Always-on? |
|-----------|----------|--------------------------------------|--------------|
| **Frontend** `chat-siris-v2` | **Vercel** | `chat-siris-v2-staging` | N/A (serverless) |
| **api-gateway** | **Vercel** | `chat-siris-gateway-staging` | No |
| **auth-service** | **Vercel** | `chat-siris-auth-staging` | No |
| **user-service** | **Vercel** | `chat-siris-user-staging` | No |
| **group-service** | **Vercel** | `chat-siris-group-staging` | No |
| **message-service** | **Vercel** | `chat-siris-message-staging` | No |
| **media-service** | **Vercel** | `chat-siris-media-staging` | No |
| **realtime-service** | **Render** | `chat-siris-realtime-staging` | **Yes** |
| **worker-service** | **Render** | `chat-siris-worker-staging` | **Yes** (or spin-down for staging only) |

**Render slots used: 2** (realtime + worker).

### 2.2 Alternative if you only want **1** Render service

Use **one** Render web service and run **both** processes via a wrapper script (implementation task):

```bash
# Example only — not in repo yet
node dist/index.js &          # realtime
node dist/workers/index.js &  # worker (if entry exists)
wait
```

Trade-offs: shared CPU/memory, coupled deploys, harder health checks. Use only to save instance-hours on free tier.

**Recommended:** keep **2 Render services** and accept Starter billing for realtime (and optionally spin-down worker on free for staging).

---

## 3. Architecture after deploy

```
┌─────────────────────────────────────────────────────────────────────────┐
│  NEW Vercel: chat-siris-v2-staging.vercel.app (frontend)                 │
│  NEXT_PUBLIC_GATEWAY_BASE  → gateway Vercel URL                          │
│  NEXT_PUBLIC_REALTIME_BASE → realtime Render URL                          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Vercel: api-gateway  ──proxies──►  auth | user | group | message | media │
│         (public REST entry)         (each own Vercel project)            │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   MongoDB Atlas            Upstash cache            Upstash events
   (per-service DB)         REDIS_CACHE_URL          REDIS_EVENTS_URL
                                ▲                       ▲
                                │                       │
                    ┌───────────┴───────────┐   ┌──────┴──────┐
                    │ Render: realtime       │   │ Render:     │
                    │ Socket.IO + pub/sub    │   │ worker      │
                    └────────────────────────┘   └─────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  LEGACY (unchanged): old Vercel URL + monolith / Chat-Siris-v2-Server   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. URL registry (fill as you deploy)

Paste public HTTPS URLs here. Gateway and frontend read from this list when setting env.

```bash
# ─── Staging (operator) ─────────────────────────────────────────────

FRONTEND_URL=
GATEWAY_URL=
AUTH_SERVICE_URL=
USER_SERVICE_URL=
GROUP_SERVICE_URL=
MESSAGE_SERVICE_URL=
MEDIA_SERVICE_URL=
REALTIME_URL=
WORKER_URL=          # optional; not used by browser — health only

# Legacy rollback (unchanged)
MONOLITH_URL=

# ─── Production (later) ───────────────────────────────────────────

# FRONTEND_URL=
# GATEWAY_URL=
# ...
```

**Naming convention:** `https://<project>-<team>.vercel.app` or custom domain.

---

## 5. Shared infrastructure (deploy once per environment)

### 5.1 Upstash Redis (2 databases)

| Instance | Env var | Used by |
|----------|---------|---------|
| `chat-siris-cache-staging` | `REDIS_CACHE_URL` | gateway, auth, user, group, message, media, realtime, worker |
| `chat-siris-events-staging` | `REDIS_EVENTS_URL` | user, group, message, media, realtime, worker |

Use **staging** URLs in all staging services; separate pair for production later.

### 5.2 MongoDB Atlas

One cluster is fine; **separate database names** per service (match local `.env`):

| Service | `MONGODB_DB_NAME` (typical) |
|---------|----------------------------|
| auth | `chat_auth` |
| user | `chat_users` |
| group | `chat_groups` |
| message | `chat_messages` |
| media | `chat_media` |

**Network access:** allow **`0.0.0.0/0`** (required for Vercel serverless egress) or use Atlas **VPC / Private Link** later on paid tiers.

### 5.3 Secrets shared across all backends

| Secret | Notes |
|--------|--------|
| `INTERNAL_HMAC_SECRET` | **Same value** on gateway + every microservice |
| `JWT_PRIVATE_KEY` | auth-service only (PEM; use `\n` in Vercel/Render UI) |
| `JWT_PUBLIC_KEY` | auth, **realtime** (PEM) |
| `GOOGLE_CLIENT_ID` | auth (+ frontend NextAuth uses same client) |

Generate **new** `INTERNAL_HMAC_SECRET` for staging; do not reuse production monolith secret unless intentional.

### 5.4 Google Cloud Console (new frontend URL)

For the **new** Vercel frontend project:

1. **OAuth client** → Authorized JavaScript origins: `https://<FRONTEND_URL>`
2. **Authorized redirect URIs:** `https://<FRONTEND_URL>/api/auth/callback/google`
3. `NEXTAUTH_URL` on frontend = `https://<FRONTEND_URL>` (no trailing slash)

Legacy OAuth client stays as-is for the old site.

---

## 6. Deployment order (staging)

Deploy in this order so each step can call `/health` on dependencies.

| Step | What | Platform | Depends on |
|------|------|----------|------------|
| **0** | Upstash cache + events DBs | Upstash | — |
| **0** | Atlas DBs + network allowlist | Atlas | — |
| **1** | `user-service` | Vercel | Mongo, Redis cache (+ events for subscriber) |
| **2** | `auth-service` | Vercel | Mongo, Redis cache, `USER_SERVICE_URL` |
| **3** | `group-service` | Vercel | Mongo, Redis cache + events |
| **4** | `message-service` | Vercel | Mongo, Redis cache + events, `GROUP_SERVICE_URL` |
| **5** | `media-service` | Vercel | Mongo, Redis cache + events, ImageKit keys |
| **6** | `worker-service` | Render | Redis cache + events, `USER_SERVICE_URL` |
| **7** | `realtime-service` | Render | Redis cache + events, `JWT_PUBLIC_KEY`, `GROUP_SERVICE_URL` |
| **8** | `api-gateway` | Vercel | Redis cache, all `*_SERVICE_URL`, `CORS_ORIGINS` |
| **9** | `chat-siris-v2` frontend | Vercel | `NEXT_PUBLIC_GATEWAY_BASE`, `NEXT_PUBLIC_REALTIME_BASE`, NextAuth |

**Smoke test after step 9:** login → load channels → send message → socket receives → image upload.

**Do not** point legacy frontend at new gateway until you intentionally cut over.

---

## 7. Vercel setup (HTTP microservices + frontend)

### 7.1 One Git repo, many projects

Create **separate Vercel projects** linked to the same GitHub repo; set **Root Directory** per project:

| Vercel project | Root directory |
|----------------|----------------|
| gateway | `chat-siris-gateway` |
| auth | `chat-siris-auth-service` |
| user | `chat-siris-user-service` |
| group | `chat-siris-group-service` |
| message | `chat-siris-message-service` |
| media | `chat-siris-media-service` |
| frontend | `chat-siris-v2` |

### 7.2 Build command (all backend services)

Logger is a **sibling** package (`file:../chat-siris-logger`). Example install/build:

```bash
cd ../chat-siris-logger && npm ci && npm run build && cd - && npm ci && npm run build
```

Set in Vercel → **Settings → General → Build & Development Settings**.

### 7.3 Serverless adapter (implementation agent — required once per service)

Each Express service needs:

1. `api/index.ts` — export the Express `app` for Vercel (use `@vercel/node` or `serverless-http`; **do not** call `app.listen()` in serverless mode).
2. `vercel.json`:

```json
{
  "version": 2,
  "builds": [{ "src": "api/index.ts", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "api/index.ts" }]
}
```

3. Refactor `src/index.ts` so `createApp()` is importable without listening when `process.env.VERCEL` is set.

**Health check:** `GET /health` must work on the deployed URL.

### 7.4 Frontend Vercel project

| Setting | Value |
|---------|--------|
| Framework | Next.js |
| Root | `chat-siris-v2` |
| Build | `npm run build` |
| Output | Next default |

No monorepo logger build needed for frontend.

---

## 8. Render setup (realtime + worker)

### 8.1 Create two Web Services

| Setting | realtime-service | worker-service |
|---------|------------------|----------------|
| **Root directory** | `chat-siris-realtime-service` | `chat-siris-worker-service` |
| **Build command** | (same logger pattern as §7.2) | (same) |
| **Start command** | `node dist/index.js` | `node dist/index.js` |
| **Health check path** | `/health` | `/health` |
| **Port** | `3333` (or `$PORT` — Render injects `PORT`) |

Ensure services listen on `process.env.PORT` if Render assigns a different port (check `realtime-service` / `worker-service` `index.ts` — today defaults may be fixed; agent should use `PORT`).

### 8.2 Render env

Use the **full env blocks** in §10. Enable **auto-deploy** from `main` when ready.

### 8.3 CORS / Socket.IO

`realtime-service` `CORS_ORIGINS` must include:

- `https://<FRONTEND_URL>` (exact)
- Optional: `https://*.vercel.app` if you use preview deployments (already in `.env.example`)

Frontend `NEXT_PUBLIC_REALTIME_BASE` must be the **Render URL** (including `https://`, no trailing slash).

---

## 9. Environment variables — complete matrices

Use staging URLs from §4. Mark secrets in platform **Secret** stores, not git.

### 9.1 `chat-siris-v2` (frontend) — Vercel only

| Variable | Required | Example / notes |
|----------|----------|-----------------|
| `NEXT_PUBLIC_GATEWAY_BASE` | Yes | `https://<GATEWAY_URL>` |
| `NEXT_PUBLIC_REALTIME_BASE` | Yes | `https://<REALTIME_URL>` |
| `NEXT_PUBLIC_IMAGEKIT_ENDPOINT` | Yes | CDN base from ImageKit |
| `NEXTAUTH_URL` | Yes | `https://<FRONTEND_URL>` |
| `GOOGLE_CLIENT_ID` | Yes | Same as auth Google client |
| `GOOGLE_CLIENT_SECRET` | Yes | Secret |
| `JWT_SECRET` | Yes | NextAuth session secret (random 32+ bytes) |

**Do not set** `NEXT_PUBLIC_SERVER_BASE` (legacy). **Never** `NEXT_PUBLIC_IMAGEKIT_PRIVATE`.

---

### 9.2 `api-gateway` — Vercel

| Variable | Required | Value |
|----------|----------|--------|
| `SERVICE_NAME` | No | `api-gateway` |
| `REDIS_CACHE_URL` | Yes | Upstash cache TCP URL |
| `INTERNAL_HMAC_SECRET` | Yes | Shared secret |
| `CORS_ORIGINS` | Yes | `https://<FRONTEND_URL>` (+ preview origins if needed) |
| `AUTH_SERVICE_URL` | Yes | `https://<AUTH_SERVICE_URL>` |
| `USER_SERVICE_URL` | Yes | `https://<USER_SERVICE_URL>` |
| `GROUP_SERVICE_URL` | Yes | `https://<GROUP_SERVICE_URL>` |
| `MESSAGE_SERVICE_URL` | Yes | `https://<MESSAGE_SERVICE_URL>` |
| `MEDIA_SERVICE_URL` | Yes | `https://<MEDIA_SERVICE_URL>` |
| `AUTH_SERVICE_ENABLED` | No | `true` |
| `USER_SERVICE_ENABLED` | No | `true` |
| `GROUP_SERVICE_ENABLED` | No | `true` |
| `MESSAGE_SERVICE_ENABLED` | No | `true` |
| `MEDIA_SERVICE_ENABLED` | No | `true` |
| `MONOLITH_URL` | Rollback | Legacy server URL (unchanged) |
| `RATE_LIMIT_IP_MAX` | No | `100` |
| `RATE_LIMIT_USER_MAX` | No | `300` |
| `SENTRY_DSN` | No | Optional |
| `NODE_ENV` | No | `production` |

Gateway JWT validation uses **auth introspect** + Redis cache; `JWT_PUBLIC_KEY` on gateway is optional per README — not required if introspect-only.

---

### 9.3 `auth-service` — Vercel

| Variable | Required |
|----------|----------|
| `MONGODB_URI` | Yes |
| `MONGODB_DB_NAME` | Yes (`chat_auth`) |
| `REDIS_CACHE_URL` | Yes |
| `USER_SERVICE_URL` | Yes |
| `INTERNAL_HMAC_SECRET` | Yes |
| `JWT_PRIVATE_KEY` | Yes (PEM, `\n` escaped) |
| `JWT_PUBLIC_KEY` | Yes (PEM) |
| `GOOGLE_CLIENT_ID` | Yes (if Google login used) |
| `NODE_ENV` | `production` |
| `SENTRY_DSN` | Optional |

---

### 9.4 `user-service` — Vercel

| Variable | Required |
|----------|----------|
| `MONGODB_URI` | Yes |
| `MONGODB_DB_NAME` | Yes (`chat_users`) |
| `REDIS_CACHE_URL` | Yes |
| `REDIS_EVENTS_URL` | Yes (pub/sub invalidation) |
| `INTERNAL_HMAC_SECRET` | Yes |
| `PROFILE_CACHE_TTL_SEC` | No (`300`) |

---

### 9.5 `group-service` — Vercel

| Variable | Required |
|----------|----------|
| `MONGODB_URI` | Yes |
| `MONGODB_DB_NAME` | Yes (`chat_groups`) |
| `REDIS_CACHE_URL` | Yes |
| `REDIS_EVENTS_URL` | Yes |
| `INTERNAL_HMAC_SECRET` | Yes |

---

### 9.6 `message-service` — Vercel

| Variable | Required |
|----------|----------|
| `MONGODB_URI` | Yes |
| `MONGODB_DB_NAME` | Yes (`chat_messages`) |
| `REDIS_CACHE_URL` | Yes |
| `REDIS_EVENTS_URL` | Yes |
| `INTERNAL_HMAC_SECRET` | Yes |
| `GROUP_SERVICE_URL` | Yes | `https://<GROUP_SERVICE_URL>` |

---

### 9.7 `media-service` — Vercel

| Variable | Required |
|----------|----------|
| `MONGODB_URI` | Yes |
| `MONGODB_DB_NAME` | Yes (`chat_media`) |
| `REDIS_CACHE_URL` | Yes |
| `REDIS_EVENTS_URL` | Yes |
| `INTERNAL_HMAC_SECRET` | Yes |
| `IMAGEKIT_PUBLIC_KEY` | Yes |
| `IMAGEKIT_PRIVATE_KEY` | Yes (secret) |
| `IMAGEKIT_URL_ENDPOINT` | Yes |

---

### 9.8 `realtime-service` — Render

| Variable | Required |
|----------|----------|
| `PORT` | Auto | Render sets `PORT` |
| `REDIS_CACHE_URL` | Yes |
| `REDIS_EVENTS_URL` | Yes |
| `JWT_PUBLIC_KEY` | Yes (PEM) |
| `INTERNAL_HMAC_SECRET` | Yes |
| `GROUP_SERVICE_URL` | Yes |
| `CORS_ORIGINS` | Yes | Include `FRONTEND_URL` |
| `SOCKET_AUTH_REQUIRED` | No | `true` |
| `CONNECT_RATE_LIMIT_DISABLED` | Staging | `false` (or `true` while load-testing) |

---

### 9.9 `worker-service` — Render

| Variable | Required |
|----------|----------|
| `REDIS_CACHE_URL` | Yes |
| `REDIS_EVENTS_URL` | Yes |
| `USER_SERVICE_URL` | Yes |
| `INTERNAL_HMAC_SECRET` | Yes |
| `QUEUE_LAG_THRESHOLD` | No | `1000` |
| `SIGTERM_DRAIN_MS` | No | `60000` |

---

## 10. Post-deploy verification checklist

| # | Check | Command / action |
|---|--------|------------------|
| 1 | Each backend `/health` | `curl https://<service>/health` |
| 2 | Gateway aggregate | `curl https://<GATEWAY_URL>/health` |
| 3 | Redis cache | Login; key `chat:refresh:*` visible in Upstash cache console |
| 4 | Redis events | Send message; pub/sub activity on events instance |
| 5 | Worker queues | `curl https://<WORKER_URL>/health` — `queues` object, low depth |
| 6 | Socket | Browser devtools → WS to `REALTIME_URL`; `msg-recieve` on send |
| 7 | CORS | No browser CORS errors on API or socket |
| 8 | Legacy | Old URL still loads monolith; no env change there |

---

## 11. Rollback strategy

| Symptom | Action |
|---------|--------|
| v2 frontend broken | Stop using new URL; legacy unchanged |
| Gateway bad | Set `AUTH_SERVICE_ENABLED=false` (etc.) → traffic to `MONOLITH_URL` |
| Single microservice bad | Disable one `*_SERVICE_ENABLED` flag |
| Full backend rollback | Point **only** new frontend `NEXT_PUBLIC_*` back to monolith (legacy), not production users on old site |

---

## 12. Implementation agent backlog (code/config, not operator)

- [ ] Add Vercel serverless entry + `vercel.json` for: gateway, auth, user, group, message, media
- [ ] Use `process.env.PORT` on realtime + worker for Render
- [ ] Document root `package.json` or script to build logger once (optional DX)
- [ ] Optional: single Render **Procfile** running realtime + worker (§2.2) for free-tier savings
- [ ] CI: deploy preview only for frontend; contract tests against staging gateway

---

## 13. Production cutover (later)

1. Duplicate entire staging setup with `prod` Upstash pair + Atlas DBs + new Vercel/Render project names.
2. Custom domains: `api-v2.example.com` → gateway, `rt-v2.example.com` → realtime, `app-v2.example.com` → frontend.
3. Load-test realtime on Render Starter (concurrent sockets).
4. Migrate users / run data migrations per tech-spec phases before DNS switch.

---

## 14. Quick reference — where each thing runs

```
Vercel  (7 projects):  frontend, gateway, auth, user, group, message, media
Render  (2 services):  realtime, worker
Upstash (2 DBs):       cache, events
Atlas:                 MongoDB cluster(s)
Legacy:                unchanged monolith + old Vercel app
```

---

*End of deployment plan.*
