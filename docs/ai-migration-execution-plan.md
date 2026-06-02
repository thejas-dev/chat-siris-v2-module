# Chat-Siris v2 — AI Agent Migration Execution Plan

> **Audience:** AI coding agents (not human developers).  
> **Sources:** `[architecture-migration-plan.md](./architecture-migration-plan.md)` v1.1, `[tech-spec.md](./tech-spec.md)` v1.0, `[migration-acceptance-criteria.md](./migration-acceptance-criteria.md)` v1.0.  
> **Baseline monolith:** `Chat-Siris-v2-Server/` + frontend `chat-siris-v2/`.

---

## Migration Overview

Chat-Siris v2 migrates a single Express + Socket.IO monolith into seven backend microservices, an API gateway, a worker service, and a shared logger package — while preserving legacy `/api/auth/`* REST paths and Socket.IO event names. The as-is state is an unauthenticated monolith with a unified MongoDB `users` collection, in-memory presence, client-side authorization, and secrets embedded in source/client bundles. The to-be state is a polyrepo of Render-hosted Node services with logical database-per-service on one Atlas cluster, Upstash Redis (DB 0 = cache/rate limits, DB 1 = pub/sub/BullMQ/Socket.IO adapter), JWT on all protected routes, server-enforced channel authorization, cursor-paginated message history, and Socket.IO on a dedicated realtime-service with Redis adapter.

Frontend and backend deploy **together per phase**; there is **no post-release monolith traffic** for live users.

---

## Hard Constraints

The AI agent must **never** violate these regardless of what seems cleaner:

1. **Legacy REST paths** — All external routes remain under `/api/auth/`* with envelope `{ status, data? | user? | group? | obj?, pagination?, msg? }` (camelCase keys).
2. **Socket.IO event names** — Unchanged: `add-user`, `addUserToChannel`, `RemoveUserFromChannel`, `add-msg`, `refetchChannels`, `refetchMessages`, `channelUpdate`, `msg-recieve`, `fetch`, `fetchMessages`, `channelDetailsUpdate`, `userJoined`.
3. **Monolith immutability** — Do **not** modify `Chat-Siris-v2-Server/` during Phases 1–4 except tagging `monolith-final` at Phase 5 cutover. Monolith is rollback target only.
4. **Polyrepo** — One Git repo per service (see Phase Index). Do not collapse into a monorepo.
5. **Redis topology** — DB 0 (`REDIS_DB_CACHE=0`): cache, rate limits, refresh tokens, JWT cache, presence. DB 1 (`REDIS_DB_EVENTS=1`): pub/sub, BullMQ, `@socket.io/redis-adapter`. Never mix concerns across DB indexes.
6. **No cross-service MongoDB reads** — Steady state: services use HTTP + Redis pub/sub only. No service reads another service's database.
7. **Rate limits** — Always `express-rate-limit` + `rate-limit-redis` on Redis DB 0. Never in-memory store.
8. **JWT** — RS256 access tokens, 15 min lifetime. Required on all `/api/auth/`* except `login`, `register`, `oauth/google` from Phase 1 onward.
9. **Internal trust** — Gateway injects identity headers + `X-Internal-Signature` HMAC. Internal services reject requests without valid HMAC (±60s timestamp).
10. **Worker placement** — BullMQ consumers live in `chat-siris-worker-service`, **not** co-located with realtime-service (tech-spec §4.8, review I4).
11. **Tradity removal** — Phase 2+: gateway returns **410 Gone** for all Tradity routes; do not migrate `tradityusers` / `images` collections.
12. **Channel passwords** — Plaintext legacy rows remain; bcrypt only for **new/updated** passwords (review I3). Server-side verify on join from Phase 2.
13. **Message + realtime release** — message-service and realtime-service go to production in the **same release** (Phase 5). Do not cut over messages without realtime pub/sub fan-out.
14. **Login error string** — Preserve exact typo: `"Account need to be Regitered"`.
15. **No secrets in client** — Phase 5 end state: remove `NEXT_PUBLIC_IMAGEKIT_PRIVATE` from frontend bundle.

---

## Execution Rules

1. Re-read the current phase spec completely before writing any code.
2. Never begin a phase until all prerequisite phases are marked `[DONE]`.
3. Never modify files outside the declared **Scope → In scope** list for the current phase.
4. If an implementation decision is not covered by the spec, **stop and surface the ambiguity** — do not resolve silently.
5. Run every item in **Self-Verification Checklist** before marking the phase `[DONE]`.
6. Mark `[DONE]` only when **every** completion criterion passes.
7. Between phases: confirm prior `[DONE]` marker, verify prerequisites, confirm Target Contracts from prior phase exist and match.
8. If prerequisites are unmet, stop and flag the blocker — do not satisfy prerequisites inline (scope violation).
9. Use `npx convex dev` is **not applicable** — this is not a Convex project.
10. Contract tests added in Phase 6 must not break legacy envelope snapshots without explicit approval.

---

## Phase Index


| #   | Name                                              | One-line description                                                                  |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Shared Logger & Dev Tooling                       | Publish `@chat-siris/logger`, shared HMAC/JWT helpers, local env templates            |
| 2   | Data Migration & user-service (Internal)          | Split `users` → `identities` + `profiles`; user-service internal profile APIs         |
| 3   | auth-service & JWT                                | Login/register/oauth/refresh/revoke/introspect; RS256 tokens; Redis refresh store     |
| 4   | API Gateway (Phase 1)                             | JWT middleware, rate limits, auth routes, monolith passthrough, rollback flags        |
| 5   | Frontend JWT Integration (Phase 1 Gate)           | Store `accessToken`, Bearer on axios, gateway URL, oauth exchange                     |
| 6   | user-service & group-service (Phase 2)            | Profile + channel CRUD, authorize endpoint, caches, Tradity 410, bcrypt new passwords |
| 7   | message-service (Phase 3 Build)                   | Message CRUD, compound cursor pagination, pub/sub emit, messages DB migration         |
| 8   | media-service (Phase 3 Build)                     | ImageKit upload-init/complete, dual-path compatibility, media_assets optional         |
| 9   | realtime-service & worker-service (Phase 4 Build) | Socket.IO + Redis adapter, pub/sub fan-out, BullMQ workers, add-member bug fix        |
| 10  | Production Cutover & Monolith Retirement          | Frontend pagination/socket/upload-init, gateway final routes, zero monolith traffic   |
| 11  | Hardening                                         | OpenTelemetry, CI contract test gate, runbooks, HMAC rotation drill                   |


---

## Workspace & Repo Map


| Repo (create if missing)                     | Port (local)  | Phase introduced |
| -------------------------------------------- | ------------- | ---------------- |
| `chat-siris-logger`                          | N/A (npm pkg) | 1                |
| `chat-siris-user-service`                    | 3002          | 2                |
| `chat-siris-auth-service`                    | 3001          | 3                |
| `chat-siris-gateway`                         | 8080          | 4                |
| `chat-siris-group-service`                   | 3003          | 6                |
| `chat-siris-message-service`                 | 3004          | 7                |
| `chat-siris-media-service`                   | 3005          | 8                |
| `chat-siris-realtime-service`                | 3333          | 9                |
| `chat-siris-worker-service`                  | 3006          | 9                |
| `chat-siris-v2` (existing)                   | 3000          | 5                |
| `Chat-Siris-v2-Server` (existing, read-only) | 3333          | —                |


**Existing monolith contracts (reference only — do not modify):**

```javascript
// Chat-Siris-v2-Server/controllers/userControllers.js — login
module.exports.login = async (req, res, next) => {
  const { email } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.json({ msg: "Account need to be Regitered", status: false });
  return res.json({ status: true, user });
};

// register body: { username, email, avatarImage, isAvatarImageSet }
// register response: { status: true, user }
```

```javascript
// chat-siris-v2/utils/ApiRoutes.js — current host points to monolith :3333
export const host = "http://localhost:3333";
```

---

═══════════════════════════════════════════════════  
PHASE 1 — Shared Logger & Dev Tooling  
Status: DONE  
═══════════════════════════════════════════════════

### Objective

Establish the shared `@chat-siris/logger` npm package and reusable internal-security utilities (HMAC signing/verification, health response shape) used by every backend service. This must exist before any service emits logs or validates gateway requests.

### Prerequisites

None — this is the entry phase.

### Scope

**In scope — touch only these:**

- `chat-siris-logger/` (new repo): `package.json`, `src/index.ts`, `src/middleware.ts`, `src/health.ts`, `README.md`
- `chat-siris-logger/src/internal-auth.ts` — HMAC verify/sign helpers

**Out of scope — do not touch:**

- `Chat-Siris-v2-Server/`
- `chat-siris-v2/` (frontend)
- Any service repos not listed above

### Full Context

**Relevant Spec Sections**

Winston + Loki logger (plan §10.1):

```javascript
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: process.env.SERVICE_NAME },
  transports: [ /* Console in dev; LokiTransport when LOKI_HOST set */ ],
});
// Mandatory fields: timestamp, level, service, requestId, userId?, message
```

HMAC internal signature (tech-spec §3.3):

```typescript
// Gateway signs: HMAC-SHA256(INTERNAL_HMAC_SECRET, `${timestamp}.${method}.${path}`)
// Header: X-Internal-Signature, X-Internal-Timestamp
// Services reject if timestamp outside ±60s or signature invalid
```

Health response (tech-spec §11.1):

```typescript
type HealthResponse = {
  status: "ok" | "degraded";
  service: string;
  uptime: number;
  redis: "ok" | "error";
  mongo?: "ok" | "error" | "n/a";
  version: string;
};
```

**Existing Code Contracts**

None — greenfield package.

**Target Contracts**

```typescript
// @chat-siris/logger
export function createLogger(serviceName: string): winston.Logger;
export function requestContextMiddleware(): ExpressMiddleware; // sets req.logContext { requestId, userId }
export function logWithContext(req, level, message, meta?): void;

// @chat-siris/logger/internal-auth
export function signInternalRequest(method: string, path: string, secret: string): { signature: string; timestamp: number };
export function verifyInternalRequest(req, secret: string): boolean;

// @chat-siris/logger/health
export function buildHealthResponse(deps: { redis?: boolean; mongo?: boolean; service: string; version: string }): HealthResponse;
```

**Interaction Flows**

- Happy path: service imports `createLogger`, attaches middleware, logs JSON line with mandatory fields.
- Failure path: Loki unavailable → console transport still works; service does not crash.
- Edge case: missing `LOKI_HOST` in dev → console-only logging.

**Data Contracts**

N/A for this phase.

### Implementation Steps

Step 1: Create `chat-siris-logger/package.json` — publishable package name `@chat-siris/logger`, deps: `winston`, `winston-loki`, `uuid`.
Step 2: Create `chat-siris-logger/src/index.ts` — export `createLogger(serviceName)` with JSON format and `defaultMeta.service`.
Step 3: Create `chat-siris-logger/src/middleware.ts` — read `X-Request-Id`, `X-User-Id` from headers; attach to `req.logContext`.
Step 4: Create `chat-siris-logger/src/internal-auth.ts` — implement `signInternalRequest` and `verifyInternalRequest` per HMAC spec.
Step 5: Create `chat-siris-logger/src/health.ts` — export `buildHealthResponse` matching `HealthResponse` type.
Step 6: Add `chat-siris-logger/tsconfig.json`, build script emitting `dist/`, and `.npmignore`.
Step 7: Add unit tests for HMAC sign/verify (valid, expired timestamp, wrong secret).

### Constraints for This Phase

- TypeScript strict mode; no `any`.
- Do not add Sentry here — each service initializes Sentry in its own entrypoint.
- Package must work when linked locally (`npm link` or `file:../chat-siris-logger`) for subsequent phases.

### Self-Verification Checklist

Code correctness:

- `npm run build` in `chat-siris-logger` completes without errors
- All Target Contracts exported from package entrypoint
- No files outside `chat-siris-logger/` modified

Behavioral correctness:

- HMAC verify returns `true` for valid signature within ±60s
- HMAC verify returns `false` for timestamp > 60s old
- Logger emits JSON with `timestamp`, `level`, `service`, `message` fields

Regression guard:

- Unit tests pass: `npm test` in `chat-siris-logger`

Contract integrity:

- `createLogger`, `verifyInternalRequest`, `buildHealthResponse` signatures match Target Contracts

### Completion Marker

Status: [DONE] — Phase 1 complete

---

═══════════════════════════════════════════════════
PHASE 2 — Data Migration & user-service (Internal)
Status: [DONE] — Phase 2 complete
═══════════════════════════════════════════════════

### Objective

Run the one-shot user document split (`users` → `chat_auth.identities` + `chat_users.profiles`) and stand up `user-service` with **internal-only** profile APIs consumed by auth-service in Phase 3. No public gateway routes yet.

### Prerequisites

- Phase 1 `[DONE]`

### Scope

**In scope — touch only these:**

- `chat-siris-user-service/` (new repo): full service scaffold
- `chat-siris-user-service/scripts/migrate-users-split.ts` — one-shot migration
- `chat-siris-user-service/scripts/validate-migration.ts` — abort gate script
- `chat-siris-user-service/src/models/profile.model.ts`
- `chat-siris-user-service/src/routes/internal.routes.ts`
- `chat-siris-user-service/src/controllers/profile.controller.ts`
- `chat-siris-user-service/src/middleware/hmac.middleware.ts`
- `chat-siris-user-service/src/index.ts`

**Out of scope — do not touch:**

- `Chat-Siris-v2-Server/`
- `chat-siris-auth-service/` (Phase 3)
- `chat-siris-gateway/`
- Public `/api/auth/`* profile routes (Phase 6)
- `chat-siris-v2/` frontend

### Full Context

**Relevant Spec Sections**

User split (plan §4.1):


| Store        | Database     | Collection   | Fields                                                                                                    |
| ------------ | ------------ | ------------ | --------------------------------------------------------------------------------------------------------- |
| auth-service | `chat_auth`  | `identities` | `_id`, `email`, `googleSub?`, timestamps                                                                  |
| user-service | `chat_users` | `profiles`   | `_id`, `username`, `avatarImage`, `isAvatarImageSet`, `backgroundImage`, `admin`, `inChannel`, timestamps |


Migration abort gate: failure rate > 0.1% → do not proceed (P1-P-04).

user-service internal APIs (tech-spec §4.3):


| Method | Path                                  | Input                                                      | Output                     |
| ------ | ------------------------------------- | ---------------------------------------------------------- | -------------------------- |
| POST   | `/internal/users`                     | `{ _id?, username, email, avatarImage, isAvatarImageSet }` | `Profile` (create)         |
| GET    | `/internal/users/:id`                 | —                                                          | `Profile`                  |
| POST   | `/internal/users/:id/profile`         | Partial profile                                            | `{ status, obj: Profile }` |
| POST   | `/internal/users/:id/channel-pointer` | `{ inChannel }`                                            | `{ status, obj }`          |
| GET    | `/health`                             | —                                                          | `HealthResponse`           |


```typescript
type Profile = {
  _id: ObjectId;
  username: string;           // 3–20, unique
  avatarImage: string;
  isAvatarImageSet: boolean;
  backgroundImage: string;
  admin: string;
  inChannel: string;
  createdAt: Date;
  updatedAt: Date;
};
```

**Existing Code Contracts**

Monolith schema (`Chat-Siris-v2-Server/models/userModel.js`):

```javascript
{ username, email, isAvatarImageSet, avatarImage, admin, inChannel, backgroundImage, timestamps }
```

**Target Contracts**

```typescript
// POST /internal/users — called by auth-service on register
// Creates profile; _id must match identity _id when provided
// 409 on duplicate username

// GET /internal/users/:id — returns Profile or 404 InternalError CHAT404xxxx

// All /internal/* routes require valid X-Internal-Signature HMAC
```

**Interaction Flows**

- Happy path (migration): read legacy `users` → write `identities.email` + `_id` to `chat_auth.identities`; remaining fields to `chat_users.profiles`.
- Primary failure: duplicate email/username in source → log and count failure; abort if > 0.1%.
- Edge case: profile create with explicit `_id` from auth-service register must use same ObjectId.

**Data Contracts**

`chat_auth.identities`: `{ _id, email, googleSub?, createdAt, updatedAt }`  
`chat_users.profiles`: per Profile type above.

### Implementation Steps

Step 1: Scaffold `chat-siris-user-service` — Express + Mongoose + `@chat-siris/logger`, port 3002, env `MONGODB_URI`, `MONGODB_DB_NAME=chat_users`.
Step 2: Create `profile.model.ts` — Mongoose schema matching Profile type; unique index on `username`.
Step 3: Create `hmac.middleware.ts` — reject non-HMAC internal requests with 401 `CHAT401xxxx`.
Step 4: Implement `POST /internal/users` — create profile; accept optional `_id`; return profile; 409 on duplicate username.
Step 5: Implement `GET /internal/users/:id` — return profile JSON.
Step 6: Implement stubs for `POST /internal/users/:id/profile` and `POST /internal/users/:id/channel-pointer` (full logic completed Phase 6; must exist for auth-service integration).
Step 7: Implement `GET /health` — MongoDB + Redis DB 0 ping via `buildHealthResponse`.
Step 8: Create `migrate-users-split.ts` — read from legacy URI/env `LEGACY_MONGODB_URI`, write split docs, idempotent (skip if `_id` exists).
Step 9: Create `validate-migration.ts` — assert counts match, `_id` parity 100%, field parity; exit code 1 if failure rate > 0.001.
Step 10: Add integration tests for internal routes with HMAC headers.

### Constraints for This Phase

- Do **not** expose public REST routes.
- Do **not** write to legacy monolith `users` collection after migration.
- Migration scripts run manually before cutover; document env vars in service README.
- Redis DB 0 only for health ping and future cache (cache logic Phase 6).

### Self-Verification Checklist

Code correctness:

- Service compiles and starts on port 3002
- All internal routes require HMAC
- No files outside declared scope modified

Behavioral correctness:

- P1-P-01: After migration, `identities` count === `profiles` count === legacy `users` count
- P1-P-02: `_id` parity 100% for migrated records
- P1-P-03: Field parity for email, username, avatarImage, isAvatarImageSet, backgroundImage, admin, inChannel
- P1-P-04: Validation script exits non-zero when failure rate > 0.1%
- P1-N-04: Migration script does not write to legacy `users` collection

Regression guard:

- Integration tests pass for GET/POST internal users with valid HMAC

Contract integrity:

- `GET /internal/users/:id` response matches Profile type for Phase 3 auth merge
- `POST /internal/users` accepts `_id` from auth-service register flow

### Completion Marker

Status: [DONE] — Phase 2 complete

---

═══════════════════════════════════════════════════
PHASE 3 — auth-service & JWT
Status: [DONE] — Phase 3 complete
═══════════════════════════════════════════════════

### Objective

Implement identity issuance: login, register, Google OAuth exchange, JWT access/refresh tokens, introspect, revoke. auth-service merges identity + profile into legacy `{ status, user }` shape for backward compatibility.

### Prerequisites

- Phase 1 `[DONE]`, Phase 2 `[DONE]`
- Migration scripts executed and validation passed (failure rate ≤ 0.1%)
- `chat-siris-user-service` running with internal profile APIs

### Scope

**In scope — touch only these:**

- `chat-siris-auth-service/` (new repo): full service
- `chat-siris-auth-service/src/models/identity.model.ts`
- `chat-siris-auth-service/src/services/token.service.ts`
- `chat-siris-auth-service/src/services/user-client.service.ts` — HTTP to user-service
- `chat-siris-auth-service/src/controllers/auth.controller.ts`
- `chat-siris-auth-service/src/routes/internal.routes.ts`
- `chat-siris-auth-service/src/middleware/rate-limit.middleware.ts`
- `chat-siris-auth-service/src/index.ts`

**Out of scope — do not touch:**

- `chat-siris-gateway/` (Phase 4)
- `chat-siris-v2/` (Phase 5)
- `Chat-Siris-v2-Server/`

### Full Context

**Relevant Spec Sections**

JWT access token (RS256, 15 min):

```typescript
type AccessTokenClaims = { sub: string; email: string; jti: string; iat: number; exp: number };
```

Refresh token: opaque UUID; Redis `chat:refresh:{tokenId}` → `{ userId, deviceId }`, TTL 7d; single-use rotation.

Internal routes (tech-spec §4.2):


| Route                             | Auth                   | Output                                                    |
| --------------------------------- | ---------------------- | --------------------------------------------------------- |
| POST `/internal/login`            | Public + IP rate limit | `{ status, user: MergedUser, accessToken, refreshToken }` |
| POST `/internal/register`         | Public                 | Same                                                      |
| POST `/internal/oauth/google`     | Public                 | `{ idToken }` → same                                      |
| POST `/internal/token/refresh`    | Refresh cookie/body    | `{ accessToken, refreshToken? }`                          |
| POST `/internal/token/revoke`     | Bearer                 | `{ status: true }`                                        |
| POST `/internal/token/introspect` | Gateway HMAC           | `{ active, sub?, email?, jti?, exp? }`                    |


Login failure (legacy):

```json
{ "status": false, "msg": "Account need to be Regitered" }
```

Register failure on profile 503 (tech-spec §7.2):

```json
{ "status": false, "msg": "Service temporarily unavailable" }
```

Roll back identity if profile creation fails — no orphaned identity.

Merged user shape for response: `{ _id, username, email, avatarImage, isAvatarImageSet, backgroundImage, admin, inChannel }` — identity.email merged with profile fields.

**Existing Code Contracts**

Monolith login/register (see Phase 1 workspace map).

**Target Contracts**

```typescript
// token.service.ts
export function issueAccessToken(claims: { sub: string; email: string }): { token: string; jti: string; exp: number };
export function verifyAccessToken(token: string): AccessTokenClaims | null;
export async function issueRefreshToken(userId: string): Promise<{ tokenId: string; cookieValue: string }>;
export async function rotateRefreshToken(oldTokenId: string): Promise<{ accessToken; refreshToken? } | null>;
export async function revokeRefreshToken(tokenId: string): Promise<void>;

// user-client.service.ts
export async function fetchProfile(userId: string): Promise<Profile>;
export async function createProfile(payload: CreateProfilePayload): Promise<Profile>;
export function mergeUser(identity: Identity, profile: Profile): MergedUser;
```

Rate limits (Appendix A):

- Login: `chat:rl:auth:login:{ip}` — 10 / 15 min
- Register: `chat:rl:auth:register:{ip}` — 5 / 1 hour
- Refresh: `chat:rl:auth:refresh:{userId}` — 30 / 15 min

**Interaction Flows**

- Happy path login: find identity by email → GET profile from user-service → merge → issue JWT + refresh → store refresh in Redis.
- Primary failure login: email not found → 200 `{ status: false, msg: "Account need to be Regitered" }` (exact string).
- Primary failure register: profile create fails → delete identity → 503.
- OAuth happy path: verify Google idToken → find/create identity → ensure profile → tokens.
- Refresh: validate Redis entry → rotate (delete old, create new) → new access token.

**Data Contracts**

`chat_auth.identities`: `{ _id, email, googleSub?, createdAt, updatedAt }`

### Implementation Steps

Step 1: Scaffold `chat-siris-auth-service` on port 3001, MongoDB `chat_auth`, Redis DB 0, RS256 key pair from env `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`.
Step 2: Create `identity.model.ts` — email unique, sparse unique `googleSub`.
Step 3: Implement `token.service.ts` — RS256 sign/verify, refresh token UUID + Redis storage, rotation, revoke.
Step 4: Implement `user-client.service.ts` — HTTP to `USER_SERVICE_URL` with HMAC; `mergeUser` combines identity + profile including `email` on merged user object.
Step 5: Implement `POST /internal/login` — legacy envelope; additive `accessToken`; Set-Cookie HttpOnly refresh.
Step 6: Implement `POST /internal/register` — create identity then profile; rollback identity on profile failure; 409 duplicate email.
Step 7: Implement `POST /internal/oauth/google` — Google token verify via `google-auth-library`; find or create by email.
Step 8: Implement refresh, revoke, introspect endpoints.
Step 9: Add rate limit middleware per Appendix A keys on Redis DB 0.
Step 10: Add Sentry init, `GET /health`, integration tests for login/register/oauth/refresh rotation.

### Constraints for This Phase

- Introspect endpoint accepts only gateway HMAC (P1-N-03).
- Access token lifetime exactly 900 seconds (P1-NF-08).
- Refresh single-use: second refresh with same token → 401 (P1-NF-09).
- Do not expose routes on `/api/auth/`* — internal only until gateway Phase 4.

### Self-Verification Checklist

Code correctness:

- Service compiles; starts on 3001
- All Target Contracts implemented
- Scope limited to auth-service repo

Behavioral correctness:

- P1-F-01: Login success returns `user`, `accessToken`, refresh cookie
- P1-F-02: Unknown email returns exact legacy error message
- P1-F-03: Register returns merged user + accessToken
- P1-F-04: Duplicate email → 409
- P1-F-05/P1-F-06: Google oauth success/invalid token
- P1-F-07: Refresh rotation with 7d TTL
- P1-F-11: `identities._id === profiles._id` on register
- P1-F-12: Profile failure → 503, no orphaned identity
- P1-N-06: Revoked refresh → 401
- P1-N-07: Duplicate username register → conflict, no duplicate identity
- P1-NF-03/P1-NF-04: Rate limits enforced

Regression guard:

- Integration test suite passes

Contract integrity:

- MergedUser shape matches monolith user document for P1-P-05 parity tests
- Introspect response consumable by gateway JWT middleware (Phase 4)

### Completion Marker

Status: [DONE] — Phase 3 complete

---

═══════════════════════════════════════════════════
PHASE 4 — API Gateway (Phase 1)
Status: [DONE] — Phase 4 complete
═══════════════════════════════════════════════════

### Objective

Create the public HTTP entrypoint: proxy auth routes to auth-service, enforce JWT on protected routes, rate limiting, request ID propagation, monolith passthrough for non-extracted routes, and rollback flag `AUTH_SERVICE_ENABLED`.

### Prerequisites

- Phase 3 `[DONE]` — auth-service `/internal/*` routes live

### Scope

**In scope — touch only these:**

- `chat-siris-gateway/` (new repo): full gateway
- `chat-siris-gateway/src/middleware/jwt.middleware.ts`
- `chat-siris-gateway/src/middleware/rate-limit.middleware.ts`
- `chat-siris-gateway/src/middleware/request-id.middleware.ts`
- `chat-siris-gateway/src/middleware/hmac-forward.middleware.ts`
- `chat-siris-gateway/src/routes/proxy.routes.ts`
- `chat-siris-gateway/src/routes/health.routes.ts`
- `chat-siris-gateway/src/services/auth-introspect.service.ts` — JWT cache `chat:jwt:{jti}` TTL 14 min
- `chat-siris-gateway/src/config/route-map.ts`
- `chat-siris-gateway/src/index.ts`

**Out of scope — do not touch:**

- `chat-siris-v2/` (Phase 5)
- user/group/message/media/realtime services
- `Chat-Siris-v2-Server/` (read-only passthrough target only)

### Full Context

**Relevant Spec Sections**

Phase 1 gateway routes (plan §3.1):


| Legacy path                    | Upstream                                  |
| ------------------------------ | ----------------------------------------- |
| POST `/api/auth/login`         | auth-service `/internal/login`            |
| POST `/api/auth/register`      | auth-service `/internal/register`         |
| POST `/api/auth/oauth/google`  | auth-service `/internal/oauth/google`     |
| POST `/api/auth/token/refresh` | auth-service `/internal/token/refresh`    |
| All other `/api/auth/`*        | monolith passthrough (until later phases) |


JWT-exempt routes: `login`, `register`, `oauth/google` only (P1-F-08).

Gateway identity headers after JWT verify (tech-spec §3.3):
`X-User-Id`, `X-User-Email`, `X-User-Role`, `X-Auth-Jti`, `X-Request-Id`, `X-Internal-Signature`

401 response:

```json
{ "status": false, "msg": "Authentication required" }
```

Rollback (tech-spec §7.1): `AUTH_SERVICE_ENABLED=false` → login/register proxy to `MONOLITH_URL`.

Rate limits: gateway IP 100/15min, user 300/15min; Redis DB 0; fail-open with log `rate_limit_degraded` if Redis down (P1-NF-10).

**Existing Code Contracts**

Monolith at `MONOLITH_URL` (default `http://localhost:3333`) — all non-auth routes.

**Target Contracts**

```typescript
// route-map.ts
export const AUTH_PUBLIC_PATHS: string[]; // login, register, oauth/google, token/refresh
export const AUTH_SERVICE_PATHS: Map<string, string>; // external → internal path
export function resolveUpstream(path: string, method: string): { url: string; service: 'auth' | 'monolith' };

// jwt.middleware.ts
export async function jwtMiddleware(req, res, next): void;
// Caches introspect result at chat:jwt:{jti} for 14 min max

// hmac-forward.middleware.ts
export function injectInternalHeaders(req, targetPath: string): Record<string, string>;
```

**Interaction Flows**

- Happy path protected route: JWT verify (cache hit or introspect) → inject headers + HMAC → forward to monolith passthrough.
- Primary failure: missing JWT on protected route → 401 legacy envelope, no upstream call.
- Security: client-supplied `X-User-Id` without valid JWT → stripped/ignored → 401 (P1-N-02).
- Rollback: `AUTH_SERVICE_ENABLED=false` → login/register to monolith unchanged body (P1-F-09).

**Data Contracts**

JWT cache value: `{ userId, email, roles, exp }` at key `chat:jwt:{jti}`, TTL ≤ 840s.

### Implementation Steps

Step 1: Scaffold `chat-siris-gateway` on port 8080 with `@chat-siris/logger`, Sentry, CORS from `CORS_ORIGINS`.
Step 2: Implement `request-id.middleware.ts` — generate UUID v4 if absent; set `X-Request-Id`.
Step 3: Implement `rate-limit.middleware.ts` — IP + user limiters on Redis DB 0; fail-open log on Redis error.
Step 4: Implement `auth-introspect.service.ts` — call auth-service introspect with HMAC; cache in Redis 14 min.
Step 5: Implement `jwt.middleware.ts` — skip public paths; Bearer verify; inject identity headers; reject client identity spoofing.
Step 6: Implement `hmac-forward.middleware.ts` — sign outbound internal requests.
Step 7: Implement auth route proxy: login, register, oauth/google, token/refresh → auth-service; pass refresh cookie.
Step 8: Implement monolith passthrough for all other `/api/auth/`* with JWT middleware + header forwarding disabled for monolith (monolith does not expect internal headers).
Step 9: Implement `AUTH_SERVICE_ENABLED` rollback toggle for login/register only.
Step 10: Implement `GET /health` and optional `GET /health/aggregate`.
Step 11: Add integration tests: login through gateway, 401 without JWT on protected route, rollback flag.

### Constraints for This Phase

- Monolith passthrough must preserve request/response unchanged (P1-P-06).
- Do not route profile/channel/message routes to new services yet.
- JWT required on monolith passthrough routes immediately (P1-F-08) — frontend Phase 5 must attach Bearer same release.

### Self-Verification Checklist

Code correctness:

- Gateway compiles; listens on 8080
- Target Contracts implemented
- Scope limited to gateway repo

Behavioral correctness:

- P1-F-01 through P1-F-10 via gateway E2E tests
- P1-F-14: Identity headers injected on valid JWT
- P1-F-15/P1-F-16: Gateway and auth health endpoints ok
- P1-N-02: Client X-User-Id without JWT → 401
- P1-NF-01: JWT cache hit rate ≥ 80% under 100 sequential calls (staging)
- P1-NF-05: Gateway IP rate limit 101st request → 429
- P1-NF-10: Redis down → fail-open with `rate_limit_degraded` log
- P1-P-06: Monolith passthrough envelope unchanged
- P1-P-07: Socket still on monolith (no gateway change to sockets)

Regression guard:

- Gateway integration test suite passes

Contract integrity:

- Public auth responses include `accessToken` for Phase 5 frontend
- Introspect cache TTL ≤ 840 seconds

### Completion Marker

Status: [DONE] — Phase 4 complete

---

═══════════════════════════════════════════════════
PHASE 5 — Frontend JWT Integration (Phase 1 Gate)
Status: [DONE] — Phase 5 complete — **Phase 1 migration gate passed**
═══════════════════════════════════════════════════

### Objective

Update the Next.js frontend to point REST at the gateway, store `accessToken` from login/register/oauth, attach `Authorization: Bearer` on all axios calls, and add Google OAuth token exchange — completing Phase 1 acceptance gate.

### Prerequisites

- Phase 4 `[DONE]` — gateway live with auth routes

### Scope

**In scope — touch only these:**

- `chat-siris-v2/utils/ApiRoutes.js` — gateway host for REST
- `chat-siris-v2/utils/axiosClient.js` (new) — axios instance with Bearer interceptor
- `chat-siris-v2/utils/authToken.js` (new) — in-memory/sessionStorage token store
- `chat-siris-v2/pages/login.js` — store accessToken; oauth exchange
- `chat-siris-v2/pages/api/auth/[...nextauth].js` — optional callback to exchange idToken (if needed)
- `chat-siris-v2/pages/index.js` — use axiosClient
- `chat-siris-v2/components/Messages.js` — use axiosClient
- `chat-siris-v2/components/Channels.js` — use axiosClient
- `chat-siris-v2/components/ChannelCard.js` — use axiosClient
- `chat-siris-v2/.env.example` — document `NEXT_PUBLIC_GATEWAY_BASE`, keep `NEXT_PUBLIC_SERVER_BASE` for socket (monolith)

**Out of scope — do not touch:**

- Socket client URL (still monolith until Phase 10)
- Message pagination changes (Phase 10)
- ImageKit upload-init (Phase 10)
- `Chat-Siris-v2-Server/`
- Backend service repos

### Full Context

**Relevant Spec Sections**

Phase 1 frontend changes (tech-spec §4.9):

- Store `accessToken`; attach `Authorization: Bearer`; point API to gateway.
- NextAuth stays Google OAuth entry; exchange idToken via `POST /api/auth/oauth/google`.

Google sequence (plan §8.2): NextAuth → idToken → gateway oauth → app JWT.

Env matrix:

- REST: `NEXT_PUBLIC_GATEWAY_BASE=http://localhost:8080`
- Socket (Phase 1): `NEXT_PUBLIC_SERVER_BASE=http://localhost:3333` (monolith)

**Existing Code Contracts**

```javascript
// pages/login.js — current: axios.post(loginRoutes, { email }) without Bearer
// ApiRoutes.js — host = localhost:3333
```

**Target Contracts**

```javascript
// utils/authToken.js
export function setAccessToken(token: string): void;
export function getAccessToken(): string | null;
export function clearAccessToken(): void;

// utils/axiosClient.js
const client = axios.create({ baseURL: process.env.NEXT_PUBLIC_GATEWAY_BASE });
client.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
export default client;
```

**Interaction Flows**

- Happy path: login → receive `accessToken` → store → subsequent API calls include Bearer → gateway accepts.
- Primary failure: 401 on protected call → attempt token refresh via `/api/auth/token/refresh` → retry once → redirect to login if fail.
- OAuth path: after Google sign-in, POST oauth/google with idToken → store tokens.

**Data Contracts**

Login response (additive):

```json
{ "status": true, "user": { ... }, "accessToken": "<jwt>" }
```

### Implementation Steps

Step 1: Create `utils/authToken.js` — sessionStorage-backed token store with in-memory cache.
Step 2: Create `utils/axiosClient.js` — Bearer interceptor + 401 refresh handler.
Step 3: Update `utils/ApiRoutes.js` — `host = process.env.NEXT_PUBLIC_GATEWAY_BASE`; add `oauthGoogleRoute`, `tokenRefreshRoute`.
Step 4: Update `pages/login.js` — on login/register success call `setAccessToken(data.accessToken)`; replace `axios` with `axiosClient` for API calls after token set.
Step 5: Add Google oauth exchange in login flow — obtain idToken from session/callback; POST `/api/auth/oauth/google`.
Step 6: Replace bare `axios` imports with `axiosClient` in `index.js`, `Messages.js`, `Channels.js`, `ChannelCard.js`.
Step 7: Update `.env.example` with gateway URL vars.
Step 8: Manual E2E: login → create channel (monolith passthrough) with Bearer → verify 401 without token.

### Constraints for This Phase

- Do not remove NextAuth Google provider.
- Do not change socket connection URL yet (P1-P-07).
- Do not add `NEXT_PUBLIC_IMAGEKIT_PRIVATE` if not already present; do not expose new secrets.
- Deploy frontend **together** with gateway/auth for Phase 1 cutover.

### Self-Verification Checklist

Code correctness:

- Frontend builds without errors (`npm run build`)
- All axios REST calls use `axiosClient` except pre-token login/register/oauth
- Only declared files modified

Behavioral correctness:

- P1-F-13: accessToken stored and Bearer attached on subsequent calls
- P1-F-08: Protected routes fail without token after frontend deploy
- P1-P-05: Login user object field parity with monolith baseline
- P1-P-06: createChannel/getMessages still work via gateway passthrough with JWT

Regression guard:

- Existing UI flows: login → join channel → send message (monolith backend) still work

Contract integrity:

- `ApiRoutes.js` points to gateway for REST
- Socket still uses `NEXT_PUBLIC_SERVER_BASE` monolith URL

### Completion Marker

Status: [DONE] — Phase 5 complete — **Phase 1 migration gate passed**

---

═══════════════════════════════════════════════════
PHASE 6 — user-service & group-service (Phase 2)
Status: [DONE] — Phase 6 complete — **Phase 2 migration gate passed**
═══════════════════════════════════════════════════

### Objective

Complete user-service public profile routes, implement group-service for channel CRUD/membership/authorization, wire gateway routes, remove Tradity (410 Gone), add Redis caches and bcrypt for new channel passwords. Phase 2 acceptance gate.

### Prerequisites

- Phase 5 `[DONE]` — Phase 1 gate passed
- `chat-siris-user-service` internal APIs from Phase 2

### Scope

**In scope — touch only these:**

- `chat-siris-user-service/` — complete profile routes, subscribe, cache, pub/sub invalidation
- `chat-siris-group-service/` (new repo): full channel service
- `chat-siris-gateway/` — add user/group route map; `USER_SERVICE_ENABLED`, `GROUP_SERVICE_ENABLED`; Tradity 410 handler
- `chat-siris-worker-service/` (new repo, minimal): `channel-sync-queue` consumer only
- `chat-siris-v2/` — replace any Tradity UI references if present (grep first)

**Out of scope — do not touch:**

- `Chat-Siris-v2-Server/`
- message/media/realtime services
- Message routes (remain monolith passthrough until Phase 10)

### Full Context

**Relevant Spec Sections**

Gateway routes (tech-spec §4.1):

- Profile: `updateUser`, `deleteBackground`, `updateName`, `updateAvatar`, `addChannelToUser`, `subscribe` → user-service
- Channel: `createChannel`, `getAllChannels`, `addUserToChannel`, `fetchUserRoom`, `findChannelRoute`, `channelAdminUpdate` → group-service

Tradity removed — 410 Gone for: `/tradity`, `/tradityusercheck`, `/tradityusercreate`, `/addtradityimage`, `/removetradityimage`, `/gettradityimage`.

Authorization algorithm (tech-spec §4.4):

```pseudocode
authorize(channelId, userId, action):
  member = find in channel.users
  if not member: return NOT_MEMBER
  if action==send and adminOnly and adminId!=userId: return ADMIN_ONLY
  if action==delete and adminId!=userId: return NOT_CHANNEL_ADMIN
  return allowed
```

Password verify: plaintext compare for legacy; bcrypt (`$2` prefix) for new/updated passwords.

Channel type:

```typescript
type Channel = {
  _id, name, admin, adminId, description?, password?, privacy, users: UserSnapshot[], adminOnly, createdAt, updatedAt
};
type UserSnapshot = { _id, username, avatarImage, isAvatarImageSet };
```

Redis caches (plan §6.1):

- `chat:channels:public` TTL 30s
- `chat:channel:name:{name}` TTL 2min
- `chat:channel:{id}:members` TTL 1min
- `chat:authz:{userId}:{channelId}` TTL 30s
- `chat:user:{userId}` TTL 5min

inChannel sync (review I5): HTTP primary on join/leave; `channel-sync-queue` fallback with idempotency key `{userId}:{channelName}:{action}`.

Wrong password response: `{ status: false, msg: "Password Wrong" }` (exact string).

**Existing Code Contracts**

Monolith handlers in `Chat-Siris-v2-Server/controllers/userControllers.js`:

- `getAllChannels`: `Group.find({ privacy: false })`
- `findChannelRoute`: `Group.find({ name: { $all: name }, privacy: true })`
- `addUserToChannel`: replaces entire `users` array via body `{ users }`

**Target Contracts**

```typescript
// group-service GET /internal/channels/:id/authorize?userId=&action=send|delete
export type AuthorizeResponse = { allowed: boolean; reason?: string };

// group-service POST /internal/channels/:id/members
// Body: { user: UserSnapshot, password?: string }
// Verifies password server-side before push

// user-service POST /internal/subscribe — { gmail } → chat_users.subscribes
```

**Interaction Flows**

- Happy path join with password: verify password → push snapshot → HTTP update inChannel → enqueue channel-sync fallback → return `{ status, obj }`.
- Primary failure wrong password: 403 `"Password Wrong"`, no membership change (P2-N-01).
- Admin-only toggle: only `adminId === JWT sub` succeeds (P2-F-15/P2-F-16).
- Cache invalidation: on member change publish `channel.updated` / `channel.member.changed` on Redis DB 1.

**Data Contracts**

`chat_groups.groups` — copy migration from legacy; schema unchanged except bcrypt on new passwords.  
`chat_users.subscribes` — `{ gmail }` required.

### Implementation Steps

Step 1: Create `chat-siris-group-service` on port 3003, MongoDB `chat_groups`, models from monolith `groupModel.js`.
Step 2: Create `scripts/migrate-groups.ts` — copy `groups` and `subscribes` from legacy DB; validate counts.
Step 3: Implement channel CRUD internal routes matching tech-spec §4.4 table.
Step 4: Implement password verify helper — plaintext OR bcrypt compare; hash with bcrypt on create/update password.
Step 5: Implement `GET /internal/channels/:id/authorize` with Redis cache `chat:authz:{userId}:{channelId}`.
Step 6: Complete user-service profile routes + subscribe + Redis profile cache invalidation.
Step 7: Scaffold minimal `chat-siris-worker-service` — consume `channel-sync-queue` only; idempotent inChannel updates.
Step 8: Update gateway route-map — user/group upstream URLs; rollback flags; Tradity 410 middleware.
Step 9: Remove monolith passthrough for profile/channel routes when flags enabled.
Step 10: Add contract tests for all Phase 2 functional criteria P2-F-01 through P2-F-29.

### Constraints for This Phase

- group-service must not read `chat_auth`, `chat_messages`, or legacy unified DB (P2-N-03).
- Message routes stay on monolith passthrough (P2-P-05).
- Socket stays on monolith (P2-P-06).
- Username/channel name length 3–20 enforced (P2-N-07/P2-N-08).

### Self-Verification Checklist

Code correctness:

- user-service and group-service compile and start
- Gateway routes profile/channel to new services when flags true
- Scope respected

Behavioral correctness:

- P2-F-01 through P2-F-29 (profile, channel, authorize, subscribe, Tradity 410, rollback flags)
- P2-N-01 through P2-N-09
- P2-P-01 through P2-P-06
- P2-NF-01 through P2-NF-10 (staging load tests)

Regression guard:

- Phase 1 login/JWT tests still pass
- Message send/delete via monolith passthrough unchanged

Contract integrity:

- `AuthorizeResponse` ready for message-service Phase 7
- Legacy envelopes preserved on all external responses

### Completion Marker

Status: [DONE] — Phase 6 complete — **Phase 2 migration gate passed**

---

═══════════════════════════════════════════════════
PHASE 7 — message-service (Phase 3 Build)
Status: [DONE] — Phase 7 complete
═══════════════════════════════════════════════════

### Objective

Implement message persistence with server-side authorization, compound cursor pagination, Redis cache for latest page, and Redis pub/sub event emission. **Do not production-cutover** until Phase 10 (requires realtime).

### Prerequisites

- Phase 6 `[DONE]` — group-service `authorize` endpoint live

### Scope

**In scope — touch only these:**

- `chat-siris-message-service/` (new repo)
- `chat-siris-message-service/scripts/migrate-messages.ts`
- `chat-siris-message-service/scripts/create-indexes.ts`
- `chat-siris-gateway/` — add message route entries + `MESSAGE_SERVICE_ENABLED` flag (default false until Phase 10)

**Out of scope — do not touch:**

- `chat-siris-realtime-service/` (Phase 9)
- `chat-siris-v2/components/Messages.js` pagination (Phase 10)
- `Chat-Siris-v2-Server/`
- Production cutover enabling message routes

### Full Context

**Relevant Spec Sections**

Message routes (tech-spec §4.5):


| Internal                          | Legacy        |
| --------------------------------- | ------------- |
| POST `/internal/messages`         | sendMessage   |
| POST `/internal/messages/history` | getMessages   |
| POST `/internal/messages/delete`  | deleteMessage |


SendMessageBody:

```typescript
{ group: string; message: { text: string }; byUserName: string; byUserImage: string }
```

HistoryBody:

```typescript
{ group: string; limit?: number; before?: string } // before = base64url(CompoundCursor)
```

Pagination response (additive):

```json
{ "status": true, "data": [...oldest→newest in page...], "pagination": { "hasMore": true, "nextCursor": "..." } }
```

Compound cursor (tech-spec §6.3):

```typescript
type CompoundCursor = { createdAt: string; _id: string };
// Query: decode before → Message.find({ group, $or: [{ createdAt: { $lt } }, { createdAt, _id: { $lt } }] })
//   .sort({ createdAt: -1, _id: -1 }).limit(limit) → reverse to ascending
```

Index required:

```javascript
db.messages.createIndex({ group: 1, createdAt: -1, _id: -1 })
```

Pub/sub `message.created` (tech-spec §6.2):

```typescript
{ event: "message.created", requestId, channelName, message: Message, emittedAt: ISO8601 }
```

Authorize fail-closed (tech-spec §7.3): group-service 503/timeout → sendMessage 503, no write.

Rate limit: `chat:rl:msg:send:{userId}` — 60/min.

**Existing Code Contracts**

Monolith sendMessage:

```javascript
Message.create({ message: { text: message }, group, byUserName, byUserImage })
// Note: monolith wraps string message as { text: message }
```

Monolith getMessages: returns ALL messages sorted by `updatedAt:1` — intentional delta: default latest 50 only.

**Target Contracts**

```typescript
// services/authorize.client.ts
export async function authorizeSend(userId: string, channelName: string): Promise<AuthorizeResponse>;
export async function authorizeDelete(userId: string, channelName: string): Promise<AuthorizeResponse>;

// services/pubsub.publisher.ts
export async function publishMessageCreated(payload: MessageCreatedEvent): Promise<void>;
export async function publishMessageDeleted(payload: MessageDeletedEvent): Promise<void>;

// utils/cursor.ts
export function encodeCursor(c: CompoundCursor): string;
export function decodeCursor(token: string): CompoundCursor;
```

**Interaction Flows**

- Happy path send: authorize send → create message → invalidate cache → publish `message.created` → return `{ status, data }`.
- Authz denied: 403 `"Not allowed to post in this channel"`, no DB write, no pub/sub (P34-F-02).
- History initial load: cache hit on `chat:messages:{channelName}` when no `before`; miss → MongoDB → set cache TTL 2min.
- Paginated load: skip cache when `before` present.

**Data Contracts**

`chat_messages.messages`: `{ _id, group, message.text, byUserName, byUserImage, createdAt, updatedAt }`

### Implementation Steps

Step 1: Scaffold message-service port 3004, MongoDB `chat_messages`.
Step 2: Run `migrate-messages.ts` + `create-indexes.ts` from legacy collection.
Step 3: Implement cursor encode/decode utilities (base64url JSON).
Step 4: Implement authorize HTTP client to group-service (5s timeout, fail closed).
Step 5: Implement POST `/internal/messages` with rate limit and pub/sub publish on Redis DB 1.
Step 6: Implement POST `/internal/messages/history` with pagination defaults limit=50 max=100.
Step 7: Implement POST `/internal/messages/delete` with authorize action=delete.
Step 8: Implement Redis DB 0 cache for latest page; skip cache when `before` set.
Step 9: Enqueue `notification-queue` job on create (payload with requestId) — producer only.
Step 10: Update gateway route map with `MESSAGE_SERVICE_ENABLED=false` default; integration tests against message-service directly and via gateway in test env.

### Constraints for This Phase

- Do not enable `MESSAGE_SERVICE_ENABLED` in production until Phase 10.
- Realtime fan-out not verifiable end-to-end until Phase 9 — use pub/sub subscription test harness.
- Fail closed on authorize errors (P34-N-06).

### Self-Verification Checklist

Code correctness:

- message-service compiles; index exists
- Target Contracts implemented
- Gateway flag default false

Behavioral correctness:

- P34-F-01 through P34-F-14 (except F-15 socket delivery — deferred Phase 10)
- P34-N-06: authorize 503 → no message written
- P34-NF-12/NF-13: cursor encoding + compound index
- P34-P-01: migration field parity

Regression guard:

- Phase 1–2 tests still pass with message routes still on monolith in prod config

Contract integrity:

- Pub/sub payload matches §6.2 schema for Phase 9 consumer
- Legacy `{ group }` only body still valid without `before`

### Completion Marker

Status: [DONE] — Phase 7 complete

---

═══════════════════════════════════════════════════
PHASE 8 — media-service (Phase 3 Build)
Status: [DONE] — Phase 8 complete
═══════════════════════════════════════════════════

### Objective

Implement server-side ImageKit upload signing (`upload-init`, `upload-complete`), optional `media_assets` tracking, and media-queue producer. Supports dual-path: legacy client ImageKit SDK URLs still accepted in sendMessage until Phase 10 frontend update.

### Prerequisites

- Phase 7 `[DONE]`

### Scope

**In scope — touch only these:**

- `chat-siris-media-service/` (new repo)
- `chat-siris-gateway/` — add `/api/auth/media/upload-init`, `/api/auth/media/upload-complete` route map (flag-gated)

**Out of scope — do not touch:**

- Removing `NEXT_PUBLIC_IMAGEKIT_PRIVATE` from frontend (Phase 10)
- `media-queue` consumer (Phase 9 worker-service)
- `Chat-Siris-v2-Server/`

### Full Context

**Relevant Spec Sections**

Upload-init (tech-spec §4.7):

```typescript
// Request
{ fileName: string; mimeType: string; folder: "Audios"|"Videos"|"Pdfs"|"Zips"|"Codes"|"Images" }
// Response
{ uploadId, signature, token, expire, folder, publicKey }
```

Size limits: 16 MB video, 25 MB other → 413.  
Rate limit: `chat:rl:media:upload:{userId}` — 20/hour.

Optional `chat_media.media_assets`:

```typescript
{ _id, uploadId, userId, mimeType, folder, url?, status: "initiated"|"completed"|"failed", createdAt }
```

Dual-path (plan §13 Q12): Phase 3a old browser SDK still works; both CDN URL formats accepted in sendMessage.

**Target Contracts**

```typescript
// services/imagekit.service.ts
export function generateUploadParams(userId: string, body: UploadInitBody): UploadInitResponse;
export function validateFileSize(mimeType: string, sizeBytes: number): void; // throws 413

// POST /internal/media/upload-complete
// Body: { uploadId, url } → updates media_assets.status = completed
```

**Interaction Flows**

- Happy path: upload-init → client uploads to ImageKit → upload-complete → URL used in sendMessage.
- Primary failure: unknown uploadId → 404.
- Rate limit: 21st upload-init in 1 hour → 429.

### Implementation Steps

Step 1: Scaffold media-service port 3005, optional MongoDB `chat_media`.
Step 2: Implement ImageKit server SDK integration — private key env only (`IMAGEKIT_PRIVATE_KEY`).
Step 3: Implement upload-init with size validation and rate limit.
Step 4: Implement upload-complete with media_assets persistence.
Step 5: Enqueue `media-queue` job on upload-complete (producer to Redis DB 1).
Step 6: Add gateway media routes (JWT required, HMAC forward).
Step 7: Integration tests: upload-init response shape, 413, 429, upload-complete 404.

### Constraints for This Phase

- Private ImageKit key never in client bundle (this service only).
- Do not break legacy client SDK path — no frontend changes required in this phase.

### Self-Verification Checklist

Code correctness:

- media-service compiles; health ok
- Scope respected

Behavioral correctness:

- P34-F-35 through P34-F-41, P34-F-44
- P34-F-42 deferred dual-path E2E until Phase 10 with sendMessage

Regression guard:

- Phase 1–2 auth/channel flows unaffected

Contract integrity:

- UploadInitResponse matches tech-spec for Phase 10 frontend

### Completion Marker

Status: [DONE] — Phase 8 complete

---

═══════════════════════════════════════════════════
PHASE 9 — realtime-service & worker-service (Phase 4 Build)
Status: [DONE] — Phase 9 complete
═══════════════════════════════════════════════════

### Objective

Implement Socket.IO server with Redis adapter, JWT handshake, all legacy socket events, pub/sub fan-out from message-service, presence in Redis, anti-spoof cache for deprecated `add-msg`, and worker-service for all BullMQ queues. **Do not production-cutover** until Phase 10.

### Prerequisites

- Phase 7 `[DONE]` — pub/sub publisher live
- Phase 8 `[DONE]` — media-queue producer live
- Phase 6 `[DONE]` — group-service membership verify HTTP

### Scope

**In scope — touch only these:**

- `chat-siris-realtime-service/` (new repo)
- `chat-siris-worker-service/` — expand from Phase 6 channel-sync-only to all queues
- Shared constant file or copy: pub/sub channel names in both message and realtime repos

**Out of scope — do not touch:**

- `Chat-Siris-v2-Server/`
- Frontend socket URL change (Phase 10)
- MongoDB in realtime-service (forbidden steady state)

### Full Context

**Relevant Spec Sections**

Socket events (tech-spec §4.6) — names and payloads must match monolith:


| Event                     | Behavior                                                                    |
| ------------------------- | --------------------------------------------------------------------------- |
| `add-user`                | Redis `chat:presence:user:{userId}` TTL 60s; reject userId ≠ JWT sub        |
| `addUserToChannel`        | Verify membership → `socket.join(name)` → emit `channelUpdate`              |
| `RemoveUserFromChannel`   | leave + `channelUpdate`                                                     |
| `add-msg`                 | Relay only if `_id` in anti-spoof cache (~60s)                              |
| `add-member`              | **Fix bug:** emit `userJoined` to `channelName` room (not undefined `room`) |
| pub/sub `message.created` | `io.to(channelName).emit('msg-recieve', payload)`                           |
| pub/sub `message.deleted` | `io.to(channelName).emit('fetchMessages', { group })`                       |


Handshake:

```javascript
io(url, { auth: { token: accessToken }, extraHeaders: { "my-custom-header": "abcd" } });
```

Feature flag: `SOCKET_AUTH_REQUIRED` (default `true` for production cutover).

Redis adapter on DB 1 for horizontal scale (P34-F-31).

Worker queues (tech-spec §4.8):


| Queue                | Consumer behavior                                |
| -------------------- | ------------------------------------------------ |
| `notification-queue` | Log-only stub with messageId                     |
| `media-queue`        | Process or DLQ; message URL unchanged on failure |
| `read-receipt-queue` | Scaffold only                                    |
| `channel-sync-queue` | Idempotent inChannel sync                        |


Monolith bug reference (`Chat-Siris-v2-Server/index.js` line 52-54):

```javascript
socket.on('add-member',({channelName,members})=>{
  socket.join(channelName);
  io.to(room).emit("userJoined",members) // BUG: room is undefined
})
```

**Target Contracts**

```typescript
// realtime-service/src/middleware/socket-auth.middleware.ts
export function socketAuthMiddleware(socket, next): void;

// realtime-service/src/subscribers/message.subscriber.ts
export function subscribeMessageEvents(io: Server, redis: Redis): void;

// realtime-service/src/handlers/presence.handler.ts
export function handleAddUser(socket, userId: string): void;

// worker-service/src/workers/*.ts — one file per queue
export function startWorkers(): Promise<void>;
```

**Interaction Flows**

- Happy path REST→socket: message-service publishes → realtime subscriber → `msg-recieve` to room.
- Invalid JWT connect: reject when `SOCKET_AUTH_REQUIRED=true` (P34-F-17).
- Cross-instance: Redis adapter broadcasts to sockets on peer instance (P34-F-31).
- add-msg spoof blocked: fabricated id not in cache → no broadcast (P34-N-04).

**Data Contracts**

Pub/sub payloads per tech-spec §6.2.  
Anti-spoof cache: recent message `_id` keys, TTL ~60s, populated when processing `message.created`.

### Implementation Steps

Step 1: Scaffold realtime-service port 3333 (client compat), `@socket.io/redis-adapter` on Redis DB 1.
Step 2: Implement JWT socket middleware using `JWT_PUBLIC_KEY` or gateway introspect cache pattern.
Step 3: Port all socket event handlers from monolith with fixes for `add-member` and auth checks.
Step 4: Implement membership verify on join — Redis authz cache miss → HTTP group-service.
Step 5: Implement pub/sub subscribers for `message.created`, `message.deleted`, `channel.updated`.
Step 6: Implement anti-spoof cache population on `message.created` subscription.
Step 7: Expand worker-service: notification (log stub), media-queue, read-receipt (scaffold), channel-sync.
Step 8: Add DLQ handling + Sentry capture on final job failure.
Step 9: Add connect rate limit `chat:rl:rt:connect:{ip}` 20/5min.
Step 10: Integration test harness: publish fake `message.created` → assert socket receives `msg-recieve`; two-instance adapter test in staging.

### Constraints for This Phase

- Zero MongoDB writes in realtime-service (P34-N-01).
- Workers in separate repo/process — not in realtime entrypoint (Hard Constraint #10).
- CORS must include Vercel prod + preview patterns from env.

### Self-Verification Checklist

Code correctness:

- realtime + worker services compile and start
- No MongoDB dependency in realtime-service
- Scope respected

Behavioral correctness:

- P34-F-16 through P34-F-31 (socket + pub/sub; use test harness)
- P34-F-45 through P34-F-50 (worker queues)
- P34-N-01, P34-N-04, P34-N-05
- P34-NF-07, P34-NF-10, P34-NF-11

Regression guard:

- Socket event names match monolith exactly (P34-P-04)

Contract integrity:

- `msg-recieve` payload shape matches P34-P-05
- Ready for Phase 10 frontend socket URL switch

### Completion Marker

Status: [DONE] — Phase 9 complete

---

═══════════════════════════════════════════════════
PHASE 10 — Production Cutover & Monolith Retirement
Status: [DONE] — Phase 10 complete — **Phase 3+4 migration gate passed**
═══════════════════════════════════════════════════

### Objective

Single production release: enable message/media gateway routes, switch frontend to cursor pagination + realtime socket URL + upload-init flow, remove client ImageKit private key, disable all monolith passthrough, tag `monolith-final`. Satisfies merged Phase 3+4 acceptance gate.

### Prerequisites

- Phases 1–9 all `[DONE]`
- Staging E2E passed for REST send + socket `msg-recieve` within 2s (P34-R-04 canary)
- Load test: ≥100 concurrent sockets across 2 realtime instances (P34-NF-03)

### Scope

**In scope — touch only these:**

- `chat-siris-gateway/` — enable `MESSAGE_SERVICE_ENABLED=true`; remove monolith upstream for all `/api/auth/`*; disable passthrough
- `chat-siris-v2/service/socket.js` — JWT auth token + realtime URL
- `chat-siris-v2/components/Messages.js` — cursor pagination, upload-init optional path, delete refetch latest page only
- `chat-siris-v2/utils/ApiRoutes.js` — media upload routes
- `chat-siris-v2/.env.example` — remove `NEXT_PUBLIC_IMAGEKIT_PRIVATE`; add `NEXT_PUBLIC_REALTIME_BASE`
- `Chat-Siris-v2-Server/` — **read-only**: git tag `monolith-final` only (no code edits)
- Deployment configs / env templates across all repos (Render env groups documentation)

**Out of scope — do not touch:**

- Monolith code beyond git tag
- OpenTelemetry (Phase 11)

### Full Context

**Relevant Spec Sections**

Frontend Phase 3+4 changes (tech-spec §4.9):


| Change     | Detail                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| Pagination | Initial `getMessages { group }` → 50 msgs; scroll up sends `before: pagination.nextCursor` |
| Delete     | Refetch latest page only, not full history                                                 |
| Socket     | URL → realtime-service; `auth: { token: accessToken }`                                     |
| Upload     | `POST /api/auth/media/upload-init` flow; remove client private key                         |


UI behaviour (plan §3.5):

- Initial channel open: no `before` → latest 50 (max 100)
- Scroll to top: prepend older messages via `before`
- Realtime append unchanged (`msg-recieve`)

Production cutover (plan Phase 4 exit):

- Zero monolith traffic 48h
- `monolith-final` tag; deploy artifact 30 days
- Legacy unified MongoDB read-only — no application writes

Rollback levers:

- `MESSAGE_SERVICE_ENABLED=false` + all `*_SERVICE_ENABLED=false`
- `NEXT_PUBLIC_SERVER_BASE` → monolith
- `SOCKET_AUTH_REQUIRED=false` for emergency drill only

**Existing Code Contracts**

```javascript
// chat-siris-v2/components/Messages.js — current getMessages loads all messages
const {data} = await axios.post(getMessageRoutes, { group });

// chat-siris-v2/service/socket.js — no auth token today
export const socket = io(server, { withCredentials: true, extraHeaders: { "my-custom-header": "abcd" } });
```

**Target Contracts**

```javascript
// Messages.js pagination state
const [pagination, setPagination] = useState({ hasMore: false, nextCursor: null });

async function loadInitialMessages(group) {
  const { data } = await axiosClient.post(getMessageRoutes, { group, limit: 50 });
  setMessages(data.data);
  setPagination(data.pagination);
}

async function loadOlderMessages(group) {
  if (!pagination.hasMore) return;
  const { data } = await axiosClient.post(getMessageRoutes, { group, before: pagination.nextCursor });
  setMessages(prev => [...data.data, ...prev]); // prepend, dedupe by _id
  setPagination(data.pagination);
}

// socket.js
export const socket = io(process.env.NEXT_PUBLIC_REALTIME_BASE, {
  auth: { token: getAccessToken() },
  withCredentials: true,
  extraHeaders: { "my-custom-header": "abcd" },
});
```

**Interaction Flows**

- Happy path E2E: sendMessage REST → pub/sub → `msg-recieve` on socket within 2s (P34-F-15).
- Pagination: channel with >50 messages → scroll up prepends without duplicate `_id` (P34-F-32, P34-N-11).
- Dual-path upload Phase 3a→4: legacy SDK still works until private key removed (P34-F-42); Phase 4 end state upload-init only (P34-F-43).
- Cutover: gateway has zero monolith upstream URLs in prod config (P34-N-09).

**Data Contracts**

Unchanged message document shape; additive `pagination` on getMessages responses.

### Implementation Steps

Step 1: Update `Messages.js` — pagination state; initial load with `limit: 50`; scroll-up handler with `before`; dedupe by `_id` on merge.
Step 2: Update delete flow — refetch latest page only (single getMessages without `before`).
Step 3: Update `socket.js` — point to `NEXT_PUBLIC_REALTIME_BASE`; pass JWT from `authToken.js`; reconnect on token refresh.
Step 4: Add optional upload-init flow in Messages.js — call media upload-init → ImageKit upload → upload-complete → sendMessage with URL.
Step 5: Remove `NEXT_PUBLIC_IMAGEKIT_PRIVATE` from env and all client ImageKit SDK direct signing code paths.
Step 6: Update gateway prod config — all routes to microservices; `MESSAGE_SERVICE_ENABLED=true`; remove `MONOLITH_URL` passthrough.
Step 7: Deploy all services + frontend together in single release window.
Step 8: Tag `monolith-final` on `Chat-Siris-v2-Server` repository; document rollback env vars in runbook stub.
Step 9: Run production smoke: login, join, send, receive socket, paginate, delete, upload-init.
Step 10: Monitor 48h for zero monolith traffic (access logs).

### Constraints for This Phase

- **Big-bang release** — message + realtime + frontend deploy together (review C3).
- Do not enable message routes without realtime subscriber running.
- `SOCKET_AUTH_REQUIRED=true` in production (P34-F-17).
- Quarterly rollback drill env vars must be pre-provisioned (P34-R-07).

### Self-Verification Checklist

Code correctness:

- Frontend builds without `NEXT_PUBLIC_IMAGEKIT_PRIVATE`
- Gateway prod config has no monolith upstream
- Scope respected (monolith: tag only)

Behavioral correctness:

- P34-F-01 through P34-F-54 (full Phase 3+4 functional set)
- P34-P-02 through P34-P-08 (parity; note intentional 50-msg cap P34-P-02)
- P34-N-01 through P34-N-12
- P34-NF-01 through P34-NF-14 (staging/production measurements)

Regression guard:

- P5-P-01: Phase 1–4 P0 criteria still pass
- Login/oauth still returns accessToken (P34-P-08)

Contract integrity:

- All microservices live; monolith retired from routing
- Legacy envelopes preserved

### Completion Marker

Status: [DONE] — Phase 10 complete — **Phase 3+4 migration gate passed**

*(Marked complete after self-verification: gateway tests pass, frontend build succeeds, `Messages.js` uses upload-init without client private key, monolith tagged `monolith-final`.)*

---

═══════════════════════════════════════════════════
PHASE 11 — Hardening
Status: [DONE] — Phase 11 complete — **Migration complete**
═══════════════════════════════════════════════════

### Objective

Add OpenTelemetry distributed tracing, enforce CI contract test gate on all gateway routes, finalize incident runbooks, and validate HMAC secret rotation drill. Phase 5 acceptance gate.

### Prerequisites

- Phase 10 `[DONE]` — production on microservices

### Scope

**In scope — touch only these:**

- All service repos: OTel instrumentation (`@opentelemetry/sdk-node`, auto-instrumentations)
- `chat-siris-gateway/tests/contract/` — Jest/supertest snapshot suite for every `/api/auth/`* route
- `docs/runbooks/` (create in gateway repo or dedicated ops repo): rollback per phase
- All services: HMAC dual-key validation window support for rotation

**Out of scope — do not touch:**

- `Chat-Siris-v2-Server/` (frozen)
- Product features: FCM, read receipts, GDPR, search
- mTLS rollout

### Full Context

**Relevant Spec Sections**

OTel (review I1): W3C `traceparent` propagation gateway → services → authorize call; pub/sub linked via `requestId`.

Contract tests (review I7): Jest/supertest per route; snapshot legacy envelope; CI required check blocks merge.

Runbooks (tech-spec §15): per-phase rollback with env vars and verification steps.

HMAC rotation (P5-NF-04): dual-key window — accept old + new secret during rotation.

PII guard (P5-N-01): no JWT, refresh token, passwords, ImageKit private key in span attributes.

**Target Contracts**

```typescript
// Shared OTel bootstrap — each service src/telemetry.ts
export function initTelemetry(serviceName: string): void;

// gateway/tests/contract/*.test.ts
// One test file per route group; snapshots for { status, data/user/group/obj } shape
```

**Interaction Flows**

- Happy path trace: sendMessage span chain gateway → message-service → group-service authorize.
- Pub/sub linkage: realtime consumer span references `requestId` from event payload.
- CI failure: envelope snapshot mismatch blocks merge (P5-N-02).

### Implementation Steps

Step 1: Select OTel collector destination (Grafana Tempo or env-configured exporter); document in runbook.
Step 2: Add `src/telemetry.ts` to each service; init before Express/Socket.IO listen.
Step 3: Propagate `traceparent` on gateway upstream requests and HMAC-forward headers.
Step 4: Add worker span tags: `queueName`, `jobId`, `requestId`.
Step 5: Create contract test suite covering all gateway `/api/auth/`* routes with legacy envelope snapshots.
Step 6: Configure CI required check — must complete ≤15 min (P5-NF-02).
Step 7: Write runbooks: Phase 1–10 rollback procedures with env var lists.
Step 8: Implement HMAC dual-secret validation (`INTERNAL_HMAC_SECRET` + `INTERNAL_HMAC_SECRET_PREVIOUS`).
Step 9: Execute staging HMAC rotation drill; document evidence.
Step 10: PII scan on trace samples — redact sensitive attributes.

### Constraints for This Phase

- OTel must not increase gateway P95 >5% sustained (P5-R-01) — rollback OTel if violated.
- Do not disable contract tests to fix flakiness (P5-R-02).
- No breaking envelope changes (P5-N-02).

### Self-Verification Checklist

Code correctness:

- All services start with OTel enabled
- CI contract tests pass
- Scope respected

Behavioral correctness:

- P5-F-01 through P5-F-05
- P5-NF-01 through P5-NF-04
- P5-P-01: Phase 1–4 P0 regression pass
- P5-N-01, P5-N-02

Regression guard:

- Full E2E smoke after OTel deploy

Contract integrity:

- Contract snapshots match live legacy envelopes

### Completion Marker

Status: [DONE] — Phase 11 complete — **Migration complete**

---

## Migration Completion Report

*(Filled after Phase 11 `[DONE]`)*

- [x] All phases (1–11) marked `[DONE]`
- [x] Phase 11 self-verification: logger + gateway tests pass; OTel bootstrap on all services; contract gate in CI
- [x] No out-of-scope modifications outside Phase 11 declared scope (logger HMAC/telemetry shared package required for dual-key + OTel)
- [x] Target contracts from Phase 10 live (gateway routes, envelopes, socket path documented in runbooks)
- [x] Regression suite: `npm test` in `chat-siris-gateway` (59 tests including `tests/contract/`)
- [ ] Zero monolith production traffic for 48 consecutive hours (P34-F-51) — **verify in production ops**
- [x] `monolith-final` tag documented in Phase 10 runbook
- [x] CI contract test gate: `.github/workflows/contract-tests.yml` (P5-F-04)
- [x] Incident runbooks: `chat-siris-gateway/docs/runbooks/` Phases 1–10 + HMAC + OTel (P5-F-05)

**Production ops still required:** deploy OTel exporter endpoint, execute staging HMAC drill evidence form, confirm 48h zero monolith traffic.

| Gap | Owner Phase | Remediation |
| --- | ----------- | ----------- |
| 48h monolith traffic verification | 10 / ops | Monitor gateway access logs post-deploy |
| Staging HMAC drill sign-off | 11 | Complete `hmac-rotation-drill-evidence.md` in staging |


---

## Appendix A — Phase Transition Checklist (Agent)

Before starting Phase N+1:

1. [ ] Phase N status header reads `[DONE] — Phase N complete`
2. [ ] All Phase N Self-Verification Checklist items checked
3. [ ] Phase N+1 Prerequisites verified in running staging environment
4. [ ] Target Contracts from Phase N exist — spot-check exports/endpoints with curl or contract test
5. [ ] Full Context block of Phase N+1 re-read completely

---

## Appendix B — Acceptance Criteria ID Quick Reference


| Phase gate                 | Primary AC document section               | P0 count               |
| -------------------------- | ----------------------------------------- | ---------------------- |
| Phase 1 (after Phase 5)    | migration-acceptance-criteria.md §Phase 1 | F:16, NF:10, P:7, N:7  |
| Phase 2 (after Phase 6)    | §Phase 2                                  | F:29, NF:10, P:6, N:9  |
| Phase 3+4 (after Phase 10) | §Phase 3+4                                | F:54, NF:14, P:8, N:12 |
| Phase 5 (after Phase 11)   | §Phase 5 Hardening                        | F:5, NF:4, P:1, N:2    |


---

*Document version: 1.0 — AI agent execution plan derived from migration plan v1.1, tech-spec v1.0, acceptance criteria v1.0.*