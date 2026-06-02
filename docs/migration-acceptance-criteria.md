# Chat-Siris v2 — Migration Acceptance Criteria

> **Document type:** Phase-gated acceptance criteria for QA sign-off  
> **Sources:** [`architecture-migration-plan.md`](./architecture-migration-plan.md) v1.1, [`tech-spec.md`](./tech-spec.md) v1.0, [`tech-spec-old.md`](./tech-spec-old.md) (monolith baseline)  
> **Generated:** 2026-05-28  
> **Release model:** Frontend and backend deploy together per phase; no post-release monolith traffic (§14 review resolutions).

Each criterion is tagged: **Functional (F)**, **Non-Functional (NF)**, **Parity (P)**, or **Security (S)**.

---

## Phase 1: Extract auth-service + API Gateway + User Split Migration

**Scope:** auth-service, API Gateway skeleton, one-shot `users` → `identities` + `profiles` migration, Redis DB 0 for refresh tokens and rate limits, Winston/Loki + Sentry baseline, frontend JWT storage and Bearer attachment on login/register/oauth.

**Rollback lever:** `AUTH_SERVICE_ENABLED=false` → gateway proxies `POST /api/auth/login` and `POST /api/auth/register` to monolith.

---

### Functional Criteria

1. **[F]** GIVEN a registered user exists in `chat_auth.identities` with matching `chat_users.profiles` row WHEN client sends `POST /api/auth/login` with body `{ "email": "<valid-email>" }` without `Authorization` header THEN response HTTP status is 200 AND body contains `status: true` AND `user` object AND `accessToken` string AND `Set-Cookie` header containing HttpOnly refresh token cookie.

2. **[F]** GIVEN email is not found in `chat_auth.identities` WHEN client sends `POST /api/auth/login` with `{ "email": "<unknown-email>" }` THEN response HTTP status is 200 AND body equals `{ "status": false, "msg": "Account need to be Regitered" }` (exact legacy string including typo).

3. **[F]** GIVEN email is not registered WHEN client sends `POST /api/auth/register` with body `{ "username", "email", "avatarImage", "isAvatarImageSet" }` matching monolith register contract THEN response HTTP status is 200 AND body contains `status: true`, merged `user` object, and `accessToken`.

4. **[F]** GIVEN duplicate email already exists in `chat_auth.identities` WHEN client sends `POST /api/auth/register` with same email THEN response HTTP status is 409 AND body contains `status: false` with human-readable duplicate message (gateway maps internal `CHAT409xxxx` to legacy envelope).

5. **[F]** GIVEN valid Google ID token in request body WHEN client sends `POST /api/auth/oauth/google` with `{ "idToken": "<token>" }` without JWT THEN auth-service verifies token with Google AND returns HTTP 200 with `status: true`, merged `user`, `accessToken`, and refresh cookie.

6. **[F]** GIVEN invalid or expired Google ID token WHEN client sends `POST /api/auth/oauth/google` THEN response HTTP status is 401 AND body contains `{ "status": false, "msg": "Authentication required" }`.

7. **[F]** GIVEN valid refresh token cookie WHEN client sends `POST /api/auth/token/refresh` THEN response HTTP status is 200 AND body contains new `accessToken` string AND refresh token is rotated in Redis key `chat:refresh:{tokenId}` with TTL 604800 seconds (7 days).

8. **[F]** GIVEN access token issued at login WHEN client sends any protected `/api/auth/*` request (excluding login, register, oauth/google) without `Authorization: Bearer` header THEN gateway returns HTTP 401 AND body `{ "status": false, "msg": "Authentication required" }`.

9. **[F]** GIVEN `AUTH_SERVICE_ENABLED=false` WHEN client sends `POST /api/auth/login` or `POST /api/auth/register` THEN gateway forwards request to monolith URL AND returns monolith response body unchanged (passthrough contract §7.1).

10. **[F]** GIVEN gateway receives any proxied request WHEN request is forwarded to auth-service THEN gateway sets header `X-Request-Id` to UUID v4 AND header is present on auth-service log line for that request.

11. **[F]** GIVEN register succeeds WHEN auth-service creates identity THEN `identities._id` equals `profiles._id` for the same user AND both documents exist before response is returned (no partial identity without profile).

12. **[F]** GIVEN profile creation fails after identity insert on register WHEN user-service returns 503 THEN auth-service returns HTTP 503 with `{ "status": false, "msg": "Service temporarily unavailable" }` AND no orphaned identity remains without matching profile (identity rolled back or transaction aborted).

13. **[F]** GIVEN frontend Phase 1 deploy WHEN user completes login, register, or Google oauth exchange THEN frontend stores `accessToken` in memory/session storage AND attaches `Authorization: Bearer <accessToken>` on all subsequent axios REST calls in the same session.

14. **[F]** GIVEN gateway receives JWT on protected route WHEN token is valid THEN gateway injects headers `X-User-Id`, `X-User-Email`, `X-User-Role`, `X-Auth-Jti`, and `X-Request-Id` on upstream auth-service introspect or downstream passthrough request.

15. **[F]** GIVEN `GET /health` on gateway WHEN all gateway dependencies (Redis DB 0 ping, auth-service `/health`) are reachable THEN response body contains `"status": "ok"` AND `"service": "api-gateway"` (or configured service name).

16. **[F]** GIVEN `GET /health` on auth-service WHEN MongoDB `chat_auth` connection readyState is 1 AND Redis DB 0 PING succeeds THEN response body contains `"status": "ok"`, `"mongo": "ok"`, `"redis": "ok"`.

---

### Non-Functional Criteria

1. **[NF]** Gateway JWT introspect cache hit rate must be ≥ 80% under steady-state login-then-API workflow (100 sequential protected calls per user) as measured by Redis key existence check on `chat:jwt:{jti}` before auth-service introspect call.

2. **[NF]** P95 latency for `POST /api/auth/login` (gateway → auth-service → user-service merge) must be ≤ 500 ms under 10 concurrent requests as measured by k6 or equivalent load test against staging.

3. **[NF]** Auth login rate limit must reject the 11th login attempt from the same IP within 15 minutes with HTTP 429 as measured by repeated `POST /api/auth/login` calls keyed `chat:rl:auth:login:{ip}`.

4. **[NF]** Auth register rate limit must reject the 6th register attempt from the same IP within 1 hour with HTTP 429 as measured by repeated `POST /api/auth/register` calls keyed `chat:rl:auth:register:{ip}`.

5. **[NF]** Gateway global IP rate limit must reject the 101st request from the same IP within 15 minutes with HTTP 429 as measured by key `chat:rl:gw:ip:{ip}`.

6. **[NF]** 100% of auth-service and gateway log lines for authenticated requests must include fields `timestamp`, `level`, `service`, `requestId`, and `message` as measured by LogQL query `{app="chat-app",service=~"auth-service|api-gateway"} | json` sampling 100 lines post-cutover.

7. **[NF]** Unhandled exceptions in auth-service and gateway must appear in Sentry within 60 seconds with tag `service` matching deploy name as measured by injected test exception in staging.

8. **[NF]** Access token JWT must use algorithm RS256 with claim `exp - iat = 900` seconds (15 minutes) as measured by decoding issued token without verification of signature only for claim inspection in contract test.

9. **[NF]** Refresh token must be single-use: second `POST /api/auth/token/refresh` with same refresh token value must return HTTP 401 as measured by sequential refresh calls in integration test.

10. **[NF]** Gateway rate-limit store must never use in-memory fallback: Redis DB 0 unavailable must trigger fail-open with alert log line containing `"rate_limit_degraded"` AND must not silently disable rate limiting without log (§3.5 degraded mode).

---

### Parity Criteria

1. **[P]** GIVEN existing monolith user document in legacy `users` collection WHEN one-shot migration script completes THEN count of `chat_auth.identities` equals count of migrated users AND count of `chat_users.profiles` equals same count.

2. **[P]** GIVEN migrated user WHEN comparing legacy `users._id` to split stores THEN `identities._id === profiles._id === legacy users._id` for 100% of migrated records as measured by migration validation script.

3. **[P]** GIVEN migrated user WHEN comparing field values THEN `identities.email` equals legacy `users.email` AND `profiles.username`, `avatarImage`, `isAvatarImageSet`, `backgroundImage`, `admin`, `inChannel` equal legacy values for 100% of records.

4. **[P]** GIVEN migration validation script reports failure rate WHEN failure count divided by total source records exceeds 0.001 (0.1%) THEN migration cutover must not proceed (abort gate §4.1, §6.1).

5. **[P]** GIVEN successful login for migrated user WHEN response `user` object is compared to monolith login response for same email THEN all legacy fields present: `_id`, `username`, `email`, `avatarImage`, `isAvatarImageSet`, `backgroundImage`, `admin`, `inChannel` with identical values (plus additive `accessToken` at root).

6. **[P]** GIVEN Phase 1 deploy with routes not yet extracted WHEN client calls monolith-owned endpoints (e.g. `POST /api/auth/createChannel`) through gateway passthrough THEN response envelope remains `{ status, data | user | group | obj }` camelCase keys unchanged.

7. **[P]** GIVEN Socket.IO client unchanged in Phase 1 WHEN client connects to monolith socket URL THEN all legacy socket events (`add-user`, `addUserToChannel`, `msg-recieve`, etc.) continue to function identically to pre-migration baseline (monolith still owns realtime).

---

### Negative Criteria

1. **[S]** GIVEN production auth-service deployment WHEN repository scan and client bundle scan run THEN zero occurrences of `MONGODB_URI`, `JWT_PRIVATE_KEY`, `IMAGEKIT_PRIVATE_KEY`, or legacy hardcoded MongoDB URI from monolith exist in frontend bundle or committed source outside env injection.

2. **[S]** GIVEN protected REST route WHEN request includes `X-User-Id` header set by client but no valid JWT THEN gateway must not trust client-supplied identity headers AND must return 401 before upstream forward.

3. **[S]** GIVEN auth-service internal route `/internal/token/introspect` WHEN request lacks valid gateway HMAC signature (`X-Internal-Signature` within ±60s) THEN auth-service returns HTTP 401.

4. **[F]** GIVEN Phase 1 cutover WHEN monolith legacy unified MongoDB `users` collection receives write attempt THEN write must be rejected or collection is read-only (no dual-write to monolith DB post-release).

5. **[F]** GIVEN user split complete WHEN query against legacy monolith `users` from application code in auth-service or gateway THEN zero runtime reads occur (split DBs are sole write path for identity/profile).

6. **[S]** GIVEN refresh token stored in Redis WHEN token is revoked via `POST /internal/token/revoke` THEN subsequent refresh attempt with same token returns HTTP 401.

7. **[F]** GIVEN duplicate username on register WHEN username already exists in `profiles` THEN register fails with conflict response AND no duplicate identity created.

---

### Rollback Criteria

1. **[NF]** Rollback must be initiated WHEN login success rate drops below 95% of pre-cutover 15-minute baseline for 5 consecutive minutes as measured by gateway access logs or synthetic login probe.

2. **[NF]** Rollback must be initiated WHEN auth-service error rate (`level=error` logs or HTTP 5xx) exceeds 5% of auth-route requests for 5 consecutive minutes.

3. **[F]** Rollback must be initiated WHEN migration validation script reports any failure rate > 0.1% before cutover (pre-release abort, not post-release rollback).

4. **[F]** Rollback must be initiated WHEN merged login response missing `accessToken` on successful login for any tested account in staging sign-off checklist (JWT day-one requirement §14 C2).

5. **[F]** Rollback execution WHEN ops sets `AUTH_SERVICE_ENABLED=false` THEN 100% of login/register traffic routes to monolith within 5 minutes of env propagation as measured by monolith access log receipt.

6. **[S]** Rollback must be initiated WHEN Sentry reports ≥ 10 unhandled auth-service exceptions within 5 minutes attributable to JWT issuance or user merge logic.

---

### Out-of-Scope

- user-service and group-service live traffic (Phase 2).
- message-service, media-service, realtime-service extraction.
- JWT enforcement on monolith passthrough routes beyond gateway auth check (monolith handlers remain unauthenticated until replaced).
- Server-side channel password verification (Phase 2).
- Cursor pagination for `getMessages` (Phase 3+4).
- ImageKit server-side upload signing (Phase 3+4).
- Socket.IO migration off monolith (Phase 3+4).
- Tradity route removal (Phase 2 gateway returns 410).
- BullMQ workers and pub/sub message delivery (Phase 3+4).
- OpenTelemetry distributed tracing (Hardening).
- Formal cost/SLO document (deferred I9).
- Bcrypt for channel passwords (new channels only in Phase 2 per review I3).

---

### Verification Gaps

| Gap | Remediation |
|-----|-------------|
| No pre-migration automated E2E baseline exists (tech-spec-old §10.2) | Record manual or Playwright baseline scripts against monolith before Phase 1; store response snapshots for login/register parity. |
| Peak production login RPS unknown | Instrument gateway request counters in staging; set Phase 1 load test targets after 7 days staging traffic. |
| "Grafana receiving logs" exit criterion lacks pass threshold | Define LogQL success: ≥ 1 log line per service per minute with valid JSON mandatory fields for 30 minutes post-deploy. |
| Frontend Bearer attachment not server-verifiable without client instrumentation | Add optional `X-Client-JWT-Attached: true` debug header in staging builds only; or verify via gateway 401 rate drop post-deploy. |

---

## Phase 2: Extract user-service + group-service

**Scope:** user-service on `chat_users`, group-service on `chat_groups`, gateway routes for profile and channel paths, JWT required on all `/api/auth/*` except login/register/oauth/google, Tradity routes return 410 Gone, server-side password verify, Redis caches for channels/membership/authz, bcrypt for new/updated channel passwords only, `inChannel` sync via HTTP + channel-sync-queue fallback.

**Rollback levers:** `USER_SERVICE_ENABLED=false`, `GROUP_SERVICE_ENABLED=false` per route family.

---

### Functional Criteria

1. **[F]** GIVEN valid JWT for user A WHEN client sends `POST /api/auth/updateName/:id` with `:id` equal to JWT `sub` and `{ "username": "newname" }` (3–20 chars) THEN HTTP 200 AND `{ "status": true, "obj": { ...profile with updated username } }`.

2. **[F]** GIVEN valid JWT for user A WHEN client sends `POST /api/auth/updateName/:id` with `:id` not equal to JWT `sub` THEN HTTP 403 AND `{ "status": false, "msg": ... }` (gateway or user-service rejects).

3. **[F]** GIVEN valid JWT WHEN client sends `POST /api/auth/deleteBackground/:id`, `POST /api/auth/updateAvatar/:id`, `POST /api/auth/updateUser/:id` for own `:id` THEN each returns HTTP 200 with `{ "status": true, "obj": ... }` matching legacy field updates.

4. **[F]** GIVEN valid JWT WHEN client sends `POST /api/auth/addChannelToUser/:id` with `{ "inChannel": "<channelName>" }` THEN HTTP 200 AND profile `inChannel` field updated in `chat_users.profiles`.

5. **[F]** GIVEN valid JWT WHEN client sends `POST /api/auth/createChannel` with valid CreateChannelBody (`name` 3–20 chars) THEN HTTP 200 AND `{ "status": true, "group": <Channel document> }` persisted in `chat_groups.groups`.

6. **[F]** GIVEN channel name already exists WHEN client sends `POST /api/auth/createChannel` with duplicate name THEN HTTP 409 AND `{ "status": false, ... }`.

7. **[F]** GIVEN valid JWT WHEN client sends `GET /api/auth/getAllChannels` THEN HTTP 200 AND `{ "status": true, "data": [ ... ] }` containing only channels where `privacy === false`.

8. **[F]** GIVEN valid JWT and `{ "name": "<substring>" }` WHEN client sends `POST /api/auth/findChannelRoute` THEN HTTP 200 AND returned channels match legacy behavior: substring match on name AND `privacy === true` channels included in search results.

9. **[F]** GIVEN valid JWT WHEN client sends `POST /api/auth/fetchUserRoom` with `{ "name": "<existing-channel>" }` THEN HTTP 200 AND `{ "status": true, "data": <Channel> }`.

10. **[F]** GIVEN channel name not found WHEN client sends `POST /api/auth/fetchUserRoom` THEN HTTP 404 AND `{ "status": false, "msg": ... }`.

11. **[F]** GIVEN password-protected channel with legacy plaintext password WHEN member joins via `POST /api/auth/addUserToChannel/:id` with correct `{ "password": "<plaintext>" }` THEN HTTP 200 AND user snapshot appended to `groups.users` AND user-service `inChannel` updated via HTTP.

12. **[F]** GIVEN password-protected channel WHEN join request includes wrong password THEN HTTP 403 AND `{ "status": false, "msg": "Password Wrong" }` (exact legacy UX string per tech-spec §5.6).

13. **[F]** GIVEN channel created in Phase 2 with new password WHEN password is stored THEN MongoDB `groups.password` field starts with bcrypt prefix `$2` AND successful join verifies via bcrypt compare.

14. **[F]** GIVEN legacy plaintext password channel WHEN user joins with correct password THEN join succeeds without requiring password rehash (lazy rehash optional, not required for Phase 2 sign-off).

15. **[F]** GIVEN channel admin (adminId matches JWT sub) WHEN client sends `POST /api/auth/channelAdminUpdate/:id` with `{ "adminOnly": true }` THEN HTTP 200 AND channel `adminOnly` field updated.

16. **[F]** GIVEN non-admin member WHEN client sends `POST /api/auth/channelAdminUpdate/:id` THEN HTTP 403.

17. **[F]** GIVEN valid JWT WHEN client sends `POST /api/auth/subscribe` with `{ "gmail": "<email>" }` THEN HTTP 200 AND document created in `chat_users.subscribes` with legacy schema.

18. **[F]** GIVEN any Tradity legacy path (`/api/auth/tradity`, `/tradityusercheck`, `/tradityusercreate`, `/addtradityimage`, `/removetradityimage`, `/gettradityimage`) WHEN client sends request through gateway THEN HTTP 410 Gone (not proxied to monolith).

19. **[F]** GIVEN group-service `GET /internal/channels/:id/authorize?userId=<id>&action=send` WHEN user is not channel member THEN response `{ "allowed": false, "reason": "NOT_MEMBER" }`.

20. **[F]** GIVEN channel with `adminOnly: true` WHEN non-admin member requests authorize with `action=send` THEN `{ "allowed": false, "reason": "ADMIN_ONLY" }`.

21. **[F]** GIVEN channel admin WHEN authorize with `action=delete` and userId equals adminId THEN `{ "allowed": true }`.

22. **[F]** GIVEN non-admin member WHEN authorize with `action=delete` THEN `{ "allowed": false, "reason": "NOT_CHANNEL_ADMIN" }`.

23. **[F]** GIVEN user joins channel WHEN group-service completes join THEN HTTP call to user-service `POST /internal/users/:id/channel-pointer` completes before join response returns (synchronous primary path §review I5).

24. **[F]** GIVEN user-service HTTP failure on join WHEN group-service enqueues `channel-sync-queue` job THEN worker processes job with idempotency key `{userId}:{channelName}:join` AND eventually sets `inChannel` correctly.

25. **[F]** GIVEN profile update via user-service WHEN update succeeds THEN Redis key `chat:user:{userId}` is invalidated or updated within 1 second (cache-aside §6.1).

26. **[F]** GIVEN channel list or membership change WHEN group-service publishes `channel.updated` or `channel.member.changed` THEN Redis cache keys `chat:channels:public`, `chat:channel:name:{name}`, `chat:channel:{id}:members`, `chat:authz:{userId}:{channelId}` are invalidated per §6.1 invalidation rules.

27. **[F]** GIVEN `USER_SERVICE_ENABLED=false` WHEN client calls profile routes THEN gateway proxies to monolith AND response passes through unchanged.

28. **[F]** GIVEN `GROUP_SERVICE_ENABLED=false` WHEN client calls channel routes THEN gateway proxies to monolith AND response passes through unchanged.

29. **[F]** GIVEN frontend Phase 2 deploy WHEN client calls any `/api/auth/*` except login, register, oauth/google without Bearer token THEN gateway returns 401 (no shadow mode in production cutover per §14 C2).

---

### Non-Functional Criteria

1. **[NF]** P95 latency for `GET /api/auth/getAllChannels` with warm cache must be ≤ 200 ms under 50 concurrent JWT-authenticated requests as measured by load test against staging.

2. **[NF]** P95 latency for `POST /api/auth/addUserToChannel/:id` (including password verify + inChannel sync) must be ≤ 500 ms under 20 concurrent joins as measured by k6 staging test.

3. **[NF]** Redis cache hit rate for `chat:channels:public` must be ≥ 70% under repeated getAllChannels polling every 30 seconds for 10 minutes as measured by group-service cache metrics.

4. **[NF]** Redis cache hit rate for `chat:authz:{userId}:{channelId}` must be ≥ 60% under send-message authorization workload simulated via authorize endpoint as measured by group-service metrics.

5. **[NF]** Gateway JWT validation cache TTL must be ≤ 840 seconds (14 min) as measured by Redis TTL on `chat:jwt:{jti}` after introspect.

6. **[NF]** user-service and group-service health endpoints must report `"status": "ok"` with MongoDB and Redis checks passing as measured by synthetic probe every 60 seconds.

7. **[NF]** 100% of user-service and group-service error responses on internal routes must include structured `error.code` prefix matching HTTP class (`CHAT403xxxx` for 403, etc.) as measured by contract test suite (internal only; gateway maps to legacy externally).

8. **[NF]** Inter-service HTTP calls from group-service to user-service must timeout at 10 seconds for CRUD operations as measured by fault-injection test with delayed user-service.

9. **[NF]** Inter-service authorize calls must timeout at 5 seconds as measured by fault-injection test (message-service integration deferred to Phase 3+4 but authorize endpoint must meet timeout in isolation).

10. **[NF]** Channel-sync-queue worker must complete retry within 5 attempts for transient user-service failures as measured by integration test with user-service unavailable for first 2 attempts.

---

### Parity Criteria

1. **[P]** GIVEN legacy `groups` documents in monolith MongoDB WHEN copy migration to `chat_groups.groups` completes THEN document count matches AND for each channel: `name`, `admin`, `adminId`, `description`, `password`, `privacy`, `users[]`, `adminOnly`, timestamps preserved field-for-field.

2. **[P]** GIVEN legacy `subscribes` collection WHEN migrated to `chat_users.subscribes` THEN schema unchanged: `_id`, `gmail`, timestamps.

3. **[P]** GIVEN public channel list from monolith `GET /api/auth/getAllChannels` snapshot WHEN same data queried via group-service THEN channel `_id` set and ordering match (order by `createdAt` desc unless legacy differed — document baseline snapshot in test fixture).

4. **[P]** GIVEN join flow without password WHEN compared to monolith THEN `{ "status": true, "obj": <updated channel> }` envelope and embedded user snapshot shape `{ _id, username, avatarImage, isAvatarImageSet }` unchanged.

5. **[P]** GIVEN message routes still on monolith in Phase 2 WHEN client sends/deletes messages THEN behavior identical to pre-Phase-2 baseline (no pagination changes yet).

6. **[P]** GIVEN Socket.IO still on monolith WHEN realtime events fire for channel join THEN event names and payloads (`channelUpdate`, `channelDetailsUpdate`, `userJoined`) unchanged from baseline.

---

### Negative Criteria

1. **[S]** GIVEN non-member user WHEN attempting join without correct password on password channel THEN user snapshot must NOT appear in `groups.users` array.

2. **[S]** GIVEN client sends channel admin update for channel where JWT sub ≠ adminId THEN server must reject even if client UI would have hidden control (server enforcement — intentional security improvement over monolith).

3. **[F]** GIVEN group-service deployment WHEN direct MongoDB read of `chat_auth`, `chat_messages`, or monolith unified DB from group-service code THEN zero steady-state cross-DB reads (HTTP to user-service only).

4. **[S]** GIVEN internal user-service route WHEN request arrives without valid `X-Internal-Signature` HMAC THEN HTTP 401 before any profile mutation.

5. **[F]** GIVEN profile route with JWT for user A WHEN body attempts to set `:id` to user B THEN HTTP 403 AND no profile mutation on user B.

6. **[S]** GIVEN Tradity collections `tradityusers` and `images` WHEN Phase 2 migration runs THEN collections are not copied to new service databases AND no API exposes them.

7. **[F]** GIVEN channel name validation WHEN name length < 3 or > 20 characters THEN HTTP 400 AND no channel document created.

8. **[S]** GIVEN username update WHEN new username length < 3 or > 20 THEN HTTP 400 AND username unchanged in database.

9. **[F]** GIVEN monolith message delete without admin WHEN tested against monolith baseline monolith allowed delete THEN Phase 2 message routes still on monolith — document that server-side delete enforcement begins Phase 3+4; Phase 2 group-service authorize endpoint must still deny non-admin for `action=delete` in isolation tests.

---

### Rollback Criteria

1. **[NF]** Rollback must be initiated WHEN channel create/join E2E success rate drops below 90% of pre-cutover baseline for 10 consecutive minutes.

2. **[NF]** Rollback must be initiated WHEN profile update error rate exceeds 5% of profile-route requests for 5 consecutive minutes.

3. **[F]** Rollback must be initiated WHEN `inChannel` field mismatch detected: user is member in `groups.users` but `profiles.inChannel` differs from expected channel name for > 1% of join operations in 15-minute window (sampled audit script).

4. **[F]** Rollback must be initiated WHEN any P0 functional criterion in Phase 2 sign-off checklist fails in production smoke test within 30 minutes of cutover.

5. **[NF]** Rollback execution WHEN ops sets `USER_SERVICE_ENABLED=false` AND `GROUP_SERVICE_ENABLED=false` THEN 100% profile and channel routes hit monolith within 5 minutes.

6. **[S]** Rollback must be initiated WHEN unauthorized channel admin update succeeds (JWT sub ≠ adminId returns 200) in synthetic security test post-deploy.

---

### Out-of-Scope

- message-service REST routes (`sendMessage`, `getMessages`, `deleteMessage`) — remain monolith until Phase 3+4.
- media-service and ImageKit upload-init.
- realtime-service and Socket.IO cutover.
- Cursor pagination and `pagination` response field.
- Redis pub/sub `message.created` delivery to sockets.
- BullMQ notification and media queue processing (except channel-sync-queue consumer).
- Monolith process retirement.
- JWT on Socket.IO handshake.
- Fixing monolith `add-member` socket bug (fixed in Phase 3+4 realtime-service).
- GDPR user deletion APIs.
- mTLS between services (HMAC only).

---

### Verification Gaps

| Gap | Remediation |
|-----|-------------|
| Legacy getAllChannels sort order not formally specified | Capture monolith response order in snapshot test fixture before Phase 2; encode as deterministic assertion. |
| Cache hit rate requires instrumentation not yet defined | Add Prometheus counter or structured log `cache_hit`/`cache_miss` per entity in group-service before Phase 2 QA gate. |
| "No auth bypass on delete" references message delete in Phase 2 exit criteria but messages still on monolith | Split verification: Phase 2 tests group-service authorize endpoint only; full delete enforcement verified Phase 3+4 criterion MSG-DEL-01. |
| bcrypt detection for new passwords requires knowing create date | Tag channels created post-cutover with metadata or test only on channels created during Phase 2 E2E suite. |

---

## Phase 3+4 (Merged Release): message-service + media-service + realtime-service + worker-service + Monolith Retirement

**Scope:** Single production cutover deploying message-service, media-service, realtime-service, worker-service, frontend cursor pagination + socket URL change + optional upload-init; Redis DB 1 pub/sub and BullMQ; monolith retired (`monolith-final` tag); no post-release monolith traffic; socket big-bang with rollback env pre-provisioned.

**Rollback levers:** `MESSAGE_SERVICE_ENABLED=false`, repoint `NEXT_PUBLIC_SERVER_BASE` to monolith socket/REST, `SOCKET_AUTH_REQUIRED=false` for emergency drill, full flag set to monolith passthrough.

---

### Functional Criteria — Message Service

1. **[F]** GIVEN valid JWT and channel membership WHEN client sends `POST /api/auth/sendMessage` with `{ "group", "message": { "text" }, "byUserName", "byUserImage" }` THEN HTTP 200 AND `{ "status": true, "data": <Message> }` AND document persisted in `chat_messages.messages`.

2. **[F]** GIVEN non-member or adminOnly violation WHEN client sends `POST /api/auth/sendMessage` THEN HTTP 403 AND `{ "status": false, "msg": "Not allowed to post in this channel" }` (or equivalent mapped message) AND zero new message documents in MongoDB for that request.

3. **[F]** GIVEN valid JWT WHEN client sends `POST /api/auth/getMessages` with `{ "group": "<channel>" }` only THEN HTTP 200 AND `{ "status": true, "data": [ ... ] }` with messages ordered oldest→newest within page AND `pagination` object present with `hasMore: boolean` and `nextCursor: string | null`.

4. **[F]** GIVEN initial page returned WHEN `pagination.hasMore === true` AND client sends second request with `{ "group", "before": "<pagination.nextCursor>" }` THEN returned messages are strictly older than first page AND no duplicate `_id` values across pages.

5. **[F]** GIVEN `limit` omitted WHEN getMessages called THEN default page size is 50 messages as measured by counting `data.length` on channel with > 50 messages.

6. **[F]** GIVEN `limit: 150` requested WHEN getMessages called THEN server caps at 100 messages maximum in `data` array.

7. **[F]** GIVEN unknown channel name WHEN getMessages called THEN HTTP 404 AND `{ "status": false, "msg": "Channel not found" }`.

8. **[F]** GIVEN channel admin JWT WHEN `POST /api/auth/deleteMessage` with `{ "id": "<messageId>" }` THEN HTTP 200 AND `{ "status": true }` AND message document removed from MongoDB.

9. **[F]** GIVEN non-admin member WHEN deleteMessage called THEN HTTP 403 AND message document unchanged in MongoDB.

10. **[F]** GIVEN message created successfully WHEN persistence completes THEN Redis pub/sub event published on DB 1 channel `message.created` with payload matching §6.2 schema (`event`, `requestId`, `channelName`, `message`, `emittedAt`).

11. **[F]** GIVEN message deleted successfully WHEN deletion completes THEN Redis pub/sub publishes `message.deleted` with `messageId` and `channelName`.

12. **[F]** GIVEN latest page request without `before` WHEN cache key `chat:messages:{channelName}` populated THEN message-service may serve from Redis DB 0 cache (cache hit logged) with same message content as MongoDB query.

13. **[F]** GIVEN paginated request with `before` cursor WHEN processed THEN cache is skipped AND compound cursor query uses decoded `{ createdAt, _id }` per §6.3.

14. **[F]** GIVEN 61st sendMessage from same user within 60 seconds WHEN rate limit enforced THEN HTTP 429 on 61st request keyed `chat:rl:msg:send:{userId}`.

15. **[F]** GIVEN message-service and realtime-service deployed together WHEN message persisted THEN connected socket clients in channel room receive `msg-recieve` event within same release (no monolith bridge).

---

### Functional Criteria — Realtime Service

16. **[F]** GIVEN valid access token in Socket.IO handshake `auth.token` WHEN client connects to realtime-service THEN connection succeeds AND `socket.userId` equals JWT `sub`.

17. **[F]** GIVEN invalid or missing JWT WHEN `SOCKET_AUTH_REQUIRED=true` AND client connects THEN connection rejected with error before any room join.

18. **[F]** GIVEN connected socket WHEN client emits `add-user` with `userId` matching JWT sub THEN Redis key `chat:presence:user:{userId}` is set with TTL 60 seconds.

19. **[F]** GIVEN connected socket WHEN client emits `add-user` with `userId` not matching JWT sub THEN server rejects event (no presence key written for mismatched id).

20. **[F]** GIVEN member of channel WHEN client emits `addUserToChannel` with `channelRef.name` THEN socket joins room named exact channel name string AND server emits `channelUpdate` to client.

21. **[F]** GIVEN non-member WHEN client emits `addUserToChannel` THEN join rejected AND socket does not enter room.

22. **[F]** GIVEN member in room WHEN client emits `RemoveUserFromChannel` THEN socket leaves room AND `channelUpdate` emitted.

23. **[F]** GIVEN pub/sub `message.created` event received WHEN realtime-service processes event THEN `io.to(channelName).emit('msg-recieve', <message payload>)` with payload shape matching legacy monolith broadcast (fields: `_id`, `group`, `message.text`, `byUserName`, `byUserImage`, timestamps).

24. **[F]** GIVEN pub/sub `message.deleted` received WHEN processed THEN room receives `fetchMessages` event with `{ "group": "<channelName>" }`.

25. **[F]** GIVEN client emits `refetchChannels` WHEN processed THEN server broadcasts `fetch` to all connected clients.

26. **[F]** GIVEN client emits `refetchMessages` with `{ "group" }` WHEN processed THEN room receives `fetchMessages` with same group.

27. **[F]** GIVEN client emits `channelUpdate` with channel object WHEN processed THEN room receives `channelDetailsUpdate` with same payload.

28. **[F]** GIVEN client emits `add-member` with `{ "channelName", "members" }` WHEN processed THEN server emits `userJoined` to room `channelName` (bug fix: must NOT reference undefined `room` variable).

29. **[F]** GIVEN message created via REST within last 60 seconds WHEN client emits deprecated `add-msg` with matching `data._id` in anti-spoof cache THEN server relays `msg-recieve` to room.

30. **[F]** GIVEN message id NOT in anti-spoof cache WHEN client emits `add-msg` THEN server does NOT broadcast (event ignored).

31. **[F]** GIVEN two realtime-service instances behind load balancer WHEN client A sends message via REST THEN client B connected to other instance receives `msg-recieve` (Redis adapter `@socket.io/redis-adapter` on DB 1).

32. **[F]** GIVEN frontend Phase 3+4 deploy WHEN user scrolls to top of message list THEN frontend requests `getMessages` with `before: pagination.nextCursor` AND prepends older messages without duplicates.

33. **[F]** GIVEN frontend delete flow WHEN admin deletes message THEN frontend triggers refetch of latest page only (not full history reload of all pages).

34. **[F]** GIVEN `SOCKET_AUTH_REQUIRED=false` flag WHEN set for rollback drill THEN connections without JWT succeed (drill mode only; production cutover requires `true`).

---

### Functional Criteria — Media Service

35. **[F]** GIVEN valid JWT WHEN client sends `POST /api/auth/media/upload-init` with `{ "fileName", "mimeType", "folder" }` where folder ∈ `{ Audios, Videos, Pdfs, Zips, Codes, Images }` THEN HTTP 200 AND response contains `uploadId`, `signature`, `token`, `expire`, `folder`, `publicKey`.

36. **[F]** GIVEN upload-init succeeds WHEN client uploads to ImageKit with returned signature THEN CDN URL returned to client.

37. **[F]** GIVEN completed upload WHEN client sends `POST /api/auth/media/upload-complete` with `{ "uploadId", "url" }` THEN HTTP 200 AND `{ "status": true, "url": "<cdn-url>" }`.

38. **[F]** GIVEN unknown uploadId WHEN upload-complete called THEN HTTP 404.

39. **[F]** GIVEN video file metadata exceeding 16 MB WHEN upload-init requested THEN HTTP 413.

40. **[F]** GIVEN non-video file metadata exceeding 25 MB WHEN upload-init requested THEN HTTP 413.

41. **[F]** GIVEN 21st upload-init from same user within 1 hour WHEN rate limit enforced THEN HTTP 429 keyed `chat:rl:media:upload:{userId}`.

42. **[F]** GIVEN Phase 3a dual-path WHEN client uses legacy browser ImageKit SDK upload AND sends CDN URL in `sendMessage` THEN message persists successfully (both URL sources accepted).

43. **[F]** GIVEN Phase 4 target state WHEN frontend deploy completes THEN `NEXT_PUBLIC_IMAGEKIT_PRIVATE` is absent from built client bundle AND all uploads use upload-init path in staging E2E.

44. **[F]** GIVEN upload-complete succeeds WHEN media asset tracking enabled THEN optional document in `chat_media.media_assets` with `status: completed` and matching `uploadId`.

---

### Functional Criteria — Worker Service

45. **[F]** GIVEN message created WHEN message-service enqueues `notification-queue` job THEN worker-service consumes job AND writes log line containing `messageId` AND does NOT send FCM/APNs (stub only).

46. **[F]** GIVEN media URL detected or upload-complete fires WHEN `media-queue` job enqueued THEN worker completes within 5 retry attempts OR job lands in DLQ with Sentry capture on final failure.

47. **[F]** GIVEN failed media-queue job after all retries WHEN inspected THEN original message in MongoDB retains original `message.text` URL unchanged.

48. **[F]** GIVEN channel-sync-queue job with idempotency key `userId:channelName:action` WHEN duplicate job delivered THEN worker applies state once only (second processing is no-op).

49. **[F]** GIVEN every BullMQ job payload WHEN enqueued THEN `requestId` field is present for trace correlation.

50. **[F]** GIVEN worker-service health endpoint WHEN queue lag exceeds threshold THEN health returns `"status": "degraded"` AND queue depth metric exposed (exact threshold defined in runbook — default: any queue > 1000 pending for 5 min).

---

### Functional Criteria — Monolith Retirement

51. **[F]** GIVEN Phase 3+4 cutover complete WHEN synthetic probes call monolith Render URL for REST and Socket THEN zero production traffic routed to monolith for 48 consecutive hours as measured by monolith access logs and gateway routing config.

52. **[F]** GIVEN cutover complete WHEN Git tag `monolith-final` exists THEN monolith repository branch is read-only AND deploy artifact retained for ≥ 30 days.

53. **[F]** GIVEN unified legacy MongoDB WHEN cutover completes THEN no application writes occur to monolith unified database (read-only archive per §14 I8).

54. **[F]** GIVEN `MESSAGE_SERVICE_ENABLED=false` rollback flag WHEN set THEN gateway proxies sendMessage, getMessages, deleteMessage to monolith within 5 minutes.

---

### Non-Functional Criteria

1. **[NF]** P95 end-to-end latency for `POST /api/auth/sendMessage` (gateway → message-service → group-service authorize → MongoDB write → pub/sub → socket emit) must be ≤ 300 ms excluding client network as measured by OTel spans or correlated timestamps in staging load test at 50 concurrent users.

2. **[NF]** P95 latency from Redis `message.created` publish to `msg-recieve` socket emit must be ≤ 500 ms as measured by embedded timestamps in pub/sub payload vs socket emit log.

3. **[NF]** Load test must sustain ≥ 100 concurrent Socket.IO connections across 2 realtime-service instances with connection success rate ≥ 99% as measured by k6 or Artillery socket scenario before production cutover.

4. **[NF]** GIVEN one realtime-service instance terminated WHEN clients connected to surviving instance THEN presence keys expire within 60 seconds AND reconnecting users re-establish presence without manual server restart.

5. **[NF]** Gateway + auth-service availability synthetic check must succeed ≥ 99.5% over 7-day staging window prior to production cutover (§10 NFR table).

6. **[NF]** Message send rate limit must enforce 60 messages per user per minute as measured by 61st message returning HTTP 429.

7. **[NF]** Socket connect rate limit must enforce 20 connections per IP per 5 minutes keyed `chat:rl:rt:connect:{ip}`.

8. **[NF]** Redis DB 1 outage degraded mode: message-service must persist messages AND log pub/sub failure error AND return HTTP 200 to client for successful write (realtime fan-out absent) as measured by fault injection test.

9. **[NF]** Redis DB 0 outage degraded mode: gateway must fall back to direct auth introspect without cache AND log `jwt_cache_degraded` as measured by fault injection test.

10. **[NF]** realtime-service process must drain gracefully on SIGTERM: stop accepting connections AND finish in-flight events within 30 seconds as measured by deploy simulation.

11. **[NF]** worker-service must finish current job within 60 seconds on SIGTERM OR requeue job as measured by worker integration test.

12. **[NF]** Compound pagination cursor must be base64url-encoded JSON `{ "createdAt": ISO8601, "_id": ObjectId string }` as measured by decode of `pagination.nextCursor` from API response.

13. **[NF]** MongoDB index `{ group: 1, createdAt: -1, _id: -1 }` must exist on `chat_messages.messages` as measured by `db.messages.getIndexes()` before cutover.

14. **[NF]** CI contract test suite must pass as required check gating Phase 3+4 merge (review I7) with snapshot assertions on legacy envelope for all `/api/auth/*` routes in scope.

---

### Parity Criteria

1. **[P]** GIVEN legacy messages in monolith `messages` collection WHEN copy migration to `chat_messages.messages` completes THEN document count matches AND each message retains `_id`, `group`, `message.text`, `byUserName`, `byUserImage`, `createdAt`, `updatedAt`.

2. **[P]** GIVEN client ignoring `pagination` field WHEN getMessages called with `{ "group" }` only THEN `data` array contains same message documents as legacy monolith query for latest messages (legacy returned all messages sorted by `updatedAt` — Phase 3+4 returns latest 50 max by default; **document intentional change**: initial load capped at 50, not full history).

3. **[P]** GIVEN single-page channel (< 50 messages) WHEN getMessages called THEN all messages returned AND `pagination.hasMore === false`.

4. **[P]** GIVEN socket event names WHEN client uses unchanged frontend socket client code THEN all event names remain exact strings: `add-user`, `addUserToChannel`, `RemoveUserFromChannel`, `add-msg`, `refetchChannels`, `refetchMessages`, `channelUpdate`, `msg-recieve`, `fetch`, `fetchMessages`, `channelDetailsUpdate`, `userJoined`.

5. **[P]** GIVEN `msg-recieve` payload WHEN compared field-by-field to monolith broadcast THEN keys `_id`, `group`, `message`, `byUserName`, `byUserImage`, `createdAt`, `updatedAt` present with same types.

6. **[P]** GIVEN ImageKit CDN URL in `message.text` WHEN rendered in MessageCard THEN URL heuristics continue to work for both legacy client-signed and server-signed URLs (same CDN domain pattern).

7. **[P]** GIVEN REST response envelope WHEN any success response returned THEN `{ status: true, ... }` camelCase keys preserved; failures use `{ status: false, msg: string }`.

8. **[P]** GIVEN login flow WHEN unchanged from Phase 1 THEN login/register/oauth responses still include merged `user` plus `accessToken` (additive fields preserved from Phase 1).

---

### Negative Criteria

1. **[S]** GIVEN realtime-service steady state WHEN code path executes THEN zero MongoDB write operations occur in realtime-service (no message persistence in socket layer).

2. **[S]** GIVEN production frontend bundle after Phase 4 WHEN scanned THEN zero occurrences of string `NEXT_PUBLIC_IMAGEKIT_PRIVATE` in built assets.

3. **[S]** GIVEN production frontend bundle WHEN scanned THEN zero MongoDB connection strings and zero JWT private keys.

4. **[F]** GIVEN spoofed `add-msg` socket event with fabricated message body WHEN message id not in anti-spoof cache THEN no `msg-recieve` broadcast occurs.

5. **[S]** GIVEN non-member socket connection WHEN attempting to join private channel room THEN socket must not receive messages from that room.

6. **[F]** GIVEN message-service WHEN group-service authorize HTTP fails (503/timeout) THEN sendMessage returns HTTP 503 AND no message document written (fail closed §7.3).

7. **[F]** GIVEN pub/sub delivery failure WHEN message persisted THEN no automatic rollback of MongoDB write (at-most-once accepted) AND client can reconcile via getMessages on reconnect.

8. **[S]** GIVEN internal `/internal/*` routes on any service WHEN accessed from public internet without gateway HMAC THEN HTTP 401/403 before business logic.

9. **[F]** GIVEN monolith process retired WHEN production gateway config inspected THEN no upstream URL points to monolith for any `/api/auth/*` route except explicit rollback flag enabled state.

10. **[S]** GIVEN JWT expired WHEN socket handshake attempted with `SOCKET_AUTH_REQUIRED=true` THEN connection rejected AND client must refresh token via `/api/auth/token/refresh`.

11. **[F]** GIVEN duplicate message pages WHEN client paginates with same `before` cursor twice THEN second response returns identical page without skipping or duplicating messages in UI merge logic (client responsibility — verify E2E).

12. **[S]** GIVEN worker DLQ job WHEN inspected THEN no unhandled secret values (ImageKit private key, MongoDB URI) appear in job payload logs.

---

### Rollback Criteria

1. **[NF]** Rollback must be initiated WHEN message send E2E success rate (REST 200 + socket receive within 2s) drops below 90% for 10 consecutive minutes.

2. **[NF]** Rollback must be initiated WHEN socket connection failure rate exceeds 10% of connection attempts for 5 consecutive minutes with `SOCKET_AUTH_REQUIRED=true`.

3. **[NF]** Rollback must be initiated WHEN P95 sendMessage E2E latency exceeds 1000 ms for 15 consecutive minutes under normal staging-equivalent load.

4. **[F]** Rollback must be initiated WHEN any connected client fails to receive `msg-recieve` for successfully persisted message in synthetic canary test within 2 seconds for 3 consecutive test failures.

5. **[NF]** Rollback must be initiated WHEN Redis DB 1 pub/sub error rate exceeds 5% of message writes for 10 consecutive minutes.

6. **[F]** Rollback must be initiated WHEN monolith traffic detected on retired monolith URL after cutover (unexpected traffic — investigate or rollback).

7. **[NF]** Rollback execution WHEN ops repoints `NEXT_PUBLIC_SERVER_BASE` to monolith AND sets all `*_SERVICE_ENABLED=false` THEN frontend REST and socket functional against monolith within 15 minutes (quarterly drill requirement §14 C5).

8. **[S]** Rollback must be initiated WHEN security scan detects `NEXT_PUBLIC_IMAGEKIT_PRIVATE` in production frontend bundle after Phase 4 cutover claimed complete.

9. **[NF]** Rollback must be initiated WHEN worker queue depth for `media-queue` or `notification-queue` exceeds 5000 pending jobs for 15 consecutive minutes (processing stall).

10. **[F]** Manual abort authority: on-call may initiate rollback based on Grafana/Sentry judgment without automated threshold (§14 item 7) — rollback runbook must be executed and incident logged.

---

### Out-of-Scope

- FCM/APNs push notification delivery (notification-queue log stub only).
- Read receipts product feature and `read-receipt-queue` processing beyond scaffold.
- mTLS between internal services.
- Custom domain for gateway or socket URLs.
- Bulk bcrypt migration for all legacy channel passwords.
- GDPR data deletion program.
- Message full-text search.
- API versioning (`/api/v1` parallel routes).
- Formal cost/SLO documentation (Hardening/deferred).
- Auto-halt deployment pipeline (manual abort only).
- Offset-based pagination backward compatibility (cursor only).
- Tradity restoration.

---

### Verification Gaps

| Gap | Remediation |
|-----|-------------|
| Peak concurrent socket count unknown (tech-spec §15) | Pull analytics or Render metrics before load test; set production load test target at 2× measured peak. |
| "Zero monolith traffic 48h" requires monolith access log access | Ensure monolith Render service logs remain enabled read-only for 48h post-cutover; alert on any non-healthcheck hit. |
| P95 pub/sub → emit latency requires correlated instrumentation | Add `emittedAt` in pub/sub payload and `receivedAt` log in realtime handler; compute delta in Loki or OTel span. |
| At-most-once delivery not directly assertable as user-visible failure | E2E test: disconnect socket, send message, reconnect, verify getMessages reconciles missing realtime message. |
| Quarterly rollback drill not automatable in CI | Schedule calendar runbook execution; record RTO ≤ 15 minutes with evidence link in incident doc template. |
| Compound cursor stability under concurrent inserts | Load test: paginate while another client sends messages; assert no duplicate/skipped ids in merged client list. |
| Worker queue degraded threshold "defined in runbook" | Publish numeric threshold in runbook before Phase 3+4 sign-off (suggested default: > 1000 pending 5 min). |
| Phase 3a vs 3b vs Phase 4 upload path criteria overlap | Tag E2E tests `@dual-path`, `@upload-init-only`; run appropriate subset per deploy tag. |

---

## Phase 5: Hardening (Post-Migration)

**Scope:** OpenTelemetry span propagation, contract test gates enforced, optional cost/SLO documentation, incident runbooks finalized, security hardening follow-ups.

---

### Functional Criteria

1. **[F]** GIVEN HTTP request through gateway WHEN traced THEN OTel trace contains spans for gateway, upstream service, and downstream authorize call (sendMessage path) with shared `traceparent` as measured by Grafana Tempo or OTel collector export.

2. **[F]** GIVEN pub/sub `message.created` event WHEN processed by realtime-service THEN OTel span links to originating HTTP trace via `requestId` or baggage propagation as measured by trace UI search on `requestId`.

3. **[F]** GIVEN BullMQ job processed WHEN worker completes THEN span includes tags `queueName`, `jobId`, `requestId` as measured by worker trace export.

4. **[F]** GIVEN CI pipeline on main branch WHEN contract tests run THEN Jest/supertest suite covers every gateway-proxied `/api/auth/*` route with legacy envelope snapshots AND pipeline fails on snapshot mismatch.

5. **[F]** GIVEN incident runbook repository WHEN Phase 5 sign-off THEN runbook exists for each phase rollback procedure with owner, env vars list, and verification steps (document path recorded in sign-off checklist).

---

### Non-Functional Criteria

1. **[NF]** 100% of production HTTP requests through gateway must emit OTel root span within 50 ms of request receipt as measured by OTel collector sampling over 24 hours.

2. **[NF]** Contract test CI check must complete within 15 minutes AND block merge on failure as measured by GitHub required check configuration.

3. **[NF]** Quarterly rollback drill must achieve RTO ≤ 15 minutes from decision to restored monolith or restored microservices path as measured by drill timestamp log (§14 C5).

4. **[NF]** HMAC internal signature secret rotation drill must complete without service outage: rotate `INTERNAL_HMAC_SECRET` with zero-downtime dual-key validation window as measured by staging rotation test.

---

### Parity Criteria

1. **[P]** GIVEN Hardening complete WHEN functional regression suite runs THEN 100% of Phase 1–4 P0 parity criteria still pass (no behavioral drift from observability changes).

---

### Negative Criteria

1. **[S]** GIVEN OTel instrumentation WHEN enabled THEN no JWT, refresh token, channel password, or ImageKit private key values appear in span attributes or exported logs (PII/secrets scan on trace samples).

2. **[F]** GIVEN contract test snapshots WHEN compared THEN no breaking change to legacy `{ status, data/user/group/obj }` envelope without explicit version bump approval.

---

### Rollback Criteria

1. **[F]** Rollback of Hardening OTel deploy must be initiated WHEN OTel exporter failure causes > 5% increase in P95 gateway latency for 15 consecutive minutes (exporter overhead regression).

2. **[NF]** Rollback of contract test gate must NOT disable tests in production — if gate is flaky, fix tests; do not remove required check without replacement coverage.

---

### Out-of-Scope

- mTLS rollout.
- FCM/APNs implementation.
- Read receipts feature.
- GDPR erasure APIs.
- Elasticsearch/message search.
- Multi-region deployment.
- Formal cost/SLO doc (still optional in Phase 5 unless staging bills available).

---

### Verification Gaps

| Gap | Remediation |
|-----|-------------|
| OTel backend choice (Tempo vs vendor) not fixed in spec | Select collector destination before Phase 5; add pass/fail for span export success rate ≥ 99%. |
| Cost/SLO doc deferred | If not delivered, explicitly mark Phase 5 item "Cost/SLO" as waived with sign-off note. |

---

## Master Traceability Matrix

| Criterion ID | Phase | Type | Criterion Summary | Source Document Section |
|--------------|-------|------|-------------------|-------------------------|
| P1-F-01 | 1 | F | Login success returns user + accessToken + refresh cookie | tech-spec §4.2, §5.1; plan §8.4 |
| P1-F-02 | 1 | F | Login not-found legacy error message exact | tech-spec-old §11; tech-spec §5.1 |
| P1-F-03 | 1 | F | Register creates merged user response | plan §3.2; tech-spec §4.2 |
| P1-F-04 | 1 | F | Duplicate email returns 409 | tech-spec §3.2 |
| P1-F-05 | 1 | F | Google oauth exchange success | plan §8.2; tech-spec §5.2 |
| P1-F-06 | 1 | F | Invalid Google token 401 | tech-spec §5.2 |
| P1-F-07 | 1 | F | Refresh token rotation 7d TTL | tech-spec §4.2; plan §8.1 |
| P1-F-08 | 1 | F | Missing JWT on protected route → 401 | plan §8.3; tech-spec §3.3 |
| P1-F-09 | 1 | F | AUTH_SERVICE_ENABLED rollback passthrough | plan §Phase 1; tech-spec §7.1 |
| P1-F-10 | 1 | F | X-Request-Id propagation | plan §10.5; tech-spec §11.2 |
| P1-F-11 | 1 | F | identities._id === profiles._id on register | plan §4.1; tech-spec §4.2 |
| P1-F-12 | 1 | F | Register rollback on profile failure | tech-spec §7.2 |
| P1-F-13 | 1 | F | Frontend stores and attaches Bearer token | plan §8.3; review §14 C2 |
| P1-F-14 | 1 | F | Gateway identity headers on valid JWT | plan §8.5; tech-spec §3.3 |
| P1-F-15 | 1 | F | Gateway /health ok | plan §10.4; tech-spec §11.1 |
| P1-F-16 | 1 | F | auth-service /health dependencies | plan §10.4; tech-spec §11.1 |
| P1-NF-01 | 1 | NF | JWT cache hit rate ≥ 80% | plan §6.1; tech-spec §4.1 |
| P1-NF-02 | 1 | NF | Login P95 ≤ 500ms | tech-spec §10 latency baseline |
| P1-NF-03 | 1 | NF | Login rate limit 10/15min | plan Appendix A; tech-spec §12 |
| P1-NF-04 | 1 | NF | Register rate limit 5/hr | plan Appendix A; tech-spec §12 |
| P1-NF-05 | 1 | NF | Gateway IP rate limit 100/15min | plan Appendix A |
| P1-NF-06 | 1 | NF | Mandatory log fields 100% | plan §10.1; tech-spec §11.2 |
| P1-NF-07 | 1 | NF | Sentry exception capture ≤ 60s | plan §10.3; tech-spec §11.3 |
| P1-NF-08 | 1 | NF | JWT RS256 15min lifetime | plan §8.1; tech-spec §4.2 |
| P1-NF-09 | 1 | NF | Refresh token single-use | tech-spec §4.2 |
| P1-NF-10 | 1 | NF | Rate limit Redis fail-open logged | tech-spec §3.5 |
| P1-P-01 | 1 | P | Migration count parity identities/profiles | plan §4.1; tech-spec §6.1 |
| P1-P-02 | 1 | P | Migration _id parity 100% | plan §4.1 |
| P1-P-03 | 1 | P | Migration field parity | plan §4.1; tech-spec §6.1 |
| P1-P-04 | 1 | P | Abort if migration failure > 0.1% | review §14 C1; tech-spec §6.1 |
| P1-P-05 | 1 | P | Login user object field parity | plan §4.1; tech-spec §4.2 |
| P1-P-06 | 1 | P | Monolith passthrough envelope preserved | plan §3.1; tech-spec §3.1 |
| P1-P-07 | 1 | P | Socket remains on monolith unchanged | plan Phase 1 |
| P1-N-01 | 1 | S | No secrets in client bundle | plan goals §1; tech-spec §1.2 |
| P1-N-02 | 1 | S | Client X-User-Id not trusted | review §14 I2; tech-spec §3.3 |
| P1-N-03 | 1 | S | Introspect requires HMAC | tech-spec §3.3 |
| P1-N-04 | 1 | F | Monolith users DB read-only post-cutover | review §14 I8 |
| P1-N-05 | 1 | F | No runtime read of legacy users from new services | plan §4.2 |
| P1-N-06 | 1 | S | Revoked refresh token rejected | tech-spec §4.2 |
| P1-N-07 | 1 | F | Duplicate username register fails | tech-spec §4.3 |
| P1-R-01 | 1 | NF | Rollback on login success < 95% | Derived from plan exit criteria |
| P1-R-02 | 1 | NF | Rollback on auth 5xx > 5% | Derived operability |
| P1-R-03 | 1 | F | Pre-cutover abort on migration > 0.1% | review §14 C1 |
| P1-R-04 | 1 | F | Rollback if accessToken missing | review §14 C2 |
| P1-R-05 | 1 | F | Rollback env routes to monolith ≤ 5min | plan Phase 1 |
| P1-R-06 | 1 | S | Rollback on auth exception burst | Sentry operability |
| P2-F-01 | 2 | F | updateName success own id | tech-spec §4.3; tech-spec-old §4 |
| P2-F-02 | 2 | F | updateName forbidden other id | tech-spec §4.3 |
| P2-F-03 | 2 | F | Profile mutation routes success | plan §3.3; tech-spec §4.1 |
| P2-F-04 | 2 | F | addChannelToUser updates inChannel | plan §3.3 |
| P2-F-05 | 2 | F | createChannel success | plan §3.4; tech-spec-old §4 |
| P2-F-06 | 2 | F | createChannel duplicate 409 | tech-spec §4.4 |
| P2-F-07 | 2 | F | getAllChannels public only | tech-spec-old §4; tech-spec §4.4 |
| P2-F-08 | 2 | F | findChannelRoute private substring | tech-spec-old §4 |
| P2-F-09 | 2 | F | fetchUserRoom found | tech-spec-old §4 |
| P2-F-10 | 2 | F | fetchUserRoom 404 | tech-spec §5.6 |
| P2-F-11 | 2 | F | Join with correct plaintext password | plan §4.4; tech-spec §5.6 |
| P2-F-12 | 2 | F | Wrong password "Password Wrong" | tech-spec §5.6; tech-spec-old §11 |
| P2-F-13 | 2 | F | New passwords stored bcrypt | review §14 I3; tech-spec §4.4 |
| P2-F-14 | 2 | P | Legacy plaintext join still works | review §14 I3 |
| P2-F-15 | 2 | F | channelAdminUpdate admin success | tech-spec-old §4 |
| P2-F-16 | 2 | F | channelAdminUpdate non-admin 403 | tech-spec §4.4 |
| P2-F-17 | 2 | F | subscribe legacy endpoint | plan §3.3; decision #5 |
| P2-F-18 | 2 | F | Tradity routes 410 Gone | decision #5; tech-spec §4.1 |
| P2-F-19 | 2 | F | authorize NOT_MEMBER | tech-spec §4.4 |
| P2-F-20 | 2 | F | authorize ADMIN_ONLY | tech-spec §4.4 |
| P2-F-21 | 2 | F | authorize delete admin allowed | tech-spec §4.4 |
| P2-F-22 | 2 | F | authorize delete non-admin denied | tech-spec §4.4 |
| P2-F-23 | 2 | F | inChannel sync HTTP primary | review §14 I5 |
| P2-F-24 | 2 | F | channel-sync-queue fallback | plan §7.4; tech-spec §4.8 |
| P2-F-25 | 2 | F | Profile cache invalidation | plan §6.1 |
| P2-F-26 | 2 | F | Channel cache invalidation on pub/sub | plan §6.1 |
| P2-F-27 | 2 | F | USER_SERVICE_ENABLED rollback | plan Phase 2; tech-spec §7.1 |
| P2-F-28 | 2 | F | GROUP_SERVICE_ENABLED rollback | plan Phase 2; tech-spec §7.1 |
| P2-F-29 | 2 | F | JWT required all protected routes | plan §8.3; review §14 C2 |
| P2-NF-01 | 2 | NF | getAllChannels P95 ≤ 200ms cached | tech-spec §10 |
| P2-NF-02 | 2 | NF | Join P95 ≤ 500ms | Derived NFR |
| P2-NF-03 | 2 | NF | Public channel cache hit ≥ 70% | plan §6.1 |
| P2-NF-04 | 2 | NF | Authz cache hit ≥ 60% | plan §6.1 |
| P2-NF-05 | 2 | NF | JWT cache TTL ≤ 840s | plan §6.1 |
| P2-NF-06 | 2 | NF | Health synthetic probes | plan §10.4 |
| P2-NF-07 | 2 | NF | Internal error code prefixes | tech-spec §3.2 |
| P2-NF-08 | 2 | NF | CRUD inter-service timeout 10s | tech-spec §3.4 |
| P2-NF-09 | 2 | NF | Authorize timeout 5s | tech-spec §3.4; §7.3 |
| P2-NF-10 | 2 | NF | channel-sync retries 5 attempts | tech-spec §4.8 |
| P2-P-01 | 2 | P | groups collection copy parity | plan §4.2; tech-spec §6.1 |
| P2-P-02 | 2 | P | subscribes migration unchanged | plan §4.3 |
| P2-P-03 | 2 | P | Public channel list parity | tech-spec-old §4 |
| P2-P-04 | 2 | P | Join response envelope parity | tech-spec-old §4 |
| P2-P-05 | 2 | P | Messages still monolith behavior | plan Phase 2 |
| P2-P-06 | 2 | P | Socket events unchanged on monolith | plan Phase 2 |
| P2-N-01 | 2 | S | Wrong password no membership | plan §3.4 |
| P2-N-02 | 2 | S | Server enforces admin update | plan goals; tech-spec-old §5.2 |
| P2-N-03 | 2 | F | No cross-DB reads group-service | plan §4.2 |
| P2-N-04 | 2 | S | Internal HMAC required user-service | tech-spec §3.3 |
| P2-N-05 | 2 | F | Profile id mismatch blocked | tech-spec §4.3 |
| P2-N-06 | 2 | S | Tradity collections not migrated | decision #5 |
| P2-N-07 | 2 | F | Channel name length validation | tech-spec §4.4 |
| P2-N-08 | 2 | S | Username length validation | tech-spec §4.3 |
| P2-N-09 | 2 | F | Delete authz tested at authorize endpoint | plan Phase 2 exit; tech-spec §4.4 |
| P2-R-01 | 2 | NF | Rollback channel E2E < 90% | plan Phase 2 exit |
| P2-R-02 | 2 | NF | Rollback profile errors > 5% | Derived |
| P2-R-03 | 2 | F | Rollback inChannel mismatch > 1% | review §14 I5 |
| P2-R-04 | 2 | F | P0 smoke failure rollback | Operability |
| P2-R-05 | 2 | NF | Rollback flags ≤ 5min | plan Phase 2 |
| P2-R-06 | 2 | S | Rollback on authz bypass | Security |
| P34-F-01 | 3+4 | F | sendMessage success persist | plan §5.1; tech-spec §5.3 |
| P34-F-02 | 3+4 | F | sendMessage authz 403 no write | tech-spec §5.4 |
| P34-F-03 | 3+4 | F | getMessages pagination object present | decision #6; tech-spec §3.5 |
| P34-F-04 | 3+4 | F | Pagination before cursor older page | tech-spec §6.3 |
| P34-F-05 | 3+4 | F | Default limit 50 | decision #6; tech-spec §4.5 |
| P34-F-06 | 3+4 | F | Max limit 100 cap | decision #6 |
| P34-F-07 | 3+4 | F | getMessages 404 unknown channel | tech-spec §5.5 |
| P34-F-08 | 3+4 | F | deleteMessage admin success | tech-spec-old §4; tech-spec §4.5 |
| P34-F-09 | 3+4 | F | deleteMessage non-admin 403 | plan Phase 2 authz; tech-spec §4.5 |
| P34-F-10 | 3+4 | F | pub/sub message.created schema | tech-spec §6.2 |
| P34-F-11 | 3+4 | F | pub/sub message.deleted | tech-spec §6.2 |
| P34-F-12 | 3+4 | F | Message cache latest page | plan §6.1 |
| P34-F-13 | 3+4 | F | Compound cursor query skip cache | tech-spec §6.3; review §14 |
| P34-F-14 | 3+4 | F | Send rate limit 60/min | plan Appendix A |
| P34-F-15 | 3+4 | F | Same-release REST→socket delivery | review §14 C3 |
| P34-F-16 | 3+4 | F | Socket JWT handshake success | plan §8.6; tech-spec §4.6 |
| P34-F-17 | 3+4 | F | Socket JWT handshake reject | tech-spec §4.6 |
| P34-F-18 | 3+4 | F | add-user presence Redis TTL 60s | plan §6.1 |
| P34-F-19 | 3+4 | F | add-user userId must match JWT | tech-spec §4.6 |
| P34-F-20 | 3+4 | F | addUserToChannel join room | plan §3.6 |
| P34-F-21 | 3+4 | F | addUserToChannel non-member reject | tech-spec §4.6 |
| P34-F-22 | 3+4 | F | RemoveUserFromChannel leave | plan §3.6 |
| P34-F-23 | 3+4 | F | msg-recieve from pub/sub | plan §5.1; tech-spec §4.6 |
| P34-F-24 | 3+4 | F | fetchMessages on delete event | tech-spec §4.6 |
| P34-F-25 | 3+4 | F | refetchChannels → fetch | plan §3.6 |
| P34-F-26 | 3+4 | F | refetchMessages room emit | plan §3.6 |
| P34-F-27 | 3+4 | F | channelUpdate → channelDetailsUpdate | plan §3.6 |
| P34-F-28 | 3+4 | F | add-member bug fix userJoined | plan §3.6; tech-spec-old §11 |
| P34-F-29 | 3+4 | F | add-msg anti-spoof relay | plan §5.1 |
| P34-F-30 | 3+4 | F | add-msg ignored without cache | plan §5.1 |
| P34-F-31 | 3+4 | F | Redis adapter cross-instance fan-out | plan §3.6; review §14 C4 |
| P34-F-32 | 3+4 | F | Frontend scroll pagination | plan §3.5 UI behaviour |
| P34-F-33 | 3+4 | F | Frontend delete refetch latest page | plan §3.5 |
| P34-F-34 | 3+4 | F | SOCKET_AUTH_REQUIRED drill flag | plan §8.6 |
| P34-F-35 | 3+4 | F | media upload-init success | tech-spec §5.7; plan §3.7 |
| P34-F-36 | 3+4 | F | ImageKit direct upload signed | tech-spec §5.7 |
| P34-F-37 | 3+4 | F | upload-complete success | tech-spec §4.7 |
| P34-F-38 | 3+4 | F | upload-complete 404 | tech-spec §4.7 |
| P34-F-39 | 3+4 | F | Video size 413 16MB | plan §3.7; tech-spec §4.7 |
| P34-F-40 | 3+4 | F | File size 413 25MB | plan §3.7 |
| P34-F-41 | 3+4 | F | upload-init rate 20/hr | tech-spec §12 |
| P34-F-42 | 3+4 | F | Dual-path legacy ImageKit SDK | decision #12; plan §13 Q12 |
| P34-F-43 | 3+4 | F | Phase 4 no client ImageKit private key | plan §13 Q12 end state |
| P34-F-44 | 3+4 | F | media_assets optional tracking | tech-spec §6.1 |
| P34-F-45 | 3+4 | F | notification-queue log stub | plan §7.1; decision #7 |
| P34-F-46 | 3+4 | F | media-queue retry/DLQ | plan §7.2; tech-spec §4.8 |
| P34-F-47 | 3+4 | F | DLQ preserves message URL | plan §7.2 |
| P34-F-48 | 3+4 | F | channel-sync idempotent worker | tech-spec §4.8 |
| P34-F-49 | 3+4 | F | BullMQ jobs include requestId | tech-spec §4.8 |
| P34-F-50 | 3+4 | F | Worker health degraded on queue lag | tech-spec §4.8; review I4 |
| P34-F-51 | 3+4 | F | Zero monolith traffic 48h | plan Phase 4 exit; review §14 |
| P34-F-52 | 3+4 | F | monolith-final tag artifact 30d | decision #13 |
| P34-F-53 | 3+4 | F | Legacy MongoDB read-only | review §14 I8 |
| P34-F-54 | 3+4 | F | MESSAGE_SERVICE_ENABLED rollback | plan Phase 3; tech-spec §7.1 |
| P34-NF-01 | 3+4 | NF | sendMessage P95 ≤ 300ms | tech-spec §10 |
| P34-NF-02 | 3+4 | NF | pub/sub→emit P95 ≤ 500ms | tech-spec §10 |
| P34-NF-03 | 3+4 | NF | 100 concurrent sockets 2 instances | plan Phase 4 exit |
| P34-NF-04 | 3+4 | NF | Presence TTL 60s on instance loss | plan §6.1 |
| P34-NF-05 | 3+4 | NF | 99.5% gateway+auth availability staging | tech-spec §10 |
| P34-NF-06 | 3+4 | NF | Send rate limit 60/min | tech-spec §12 |
| P34-NF-07 | 3+4 | NF | Socket connect rate 20/5min | plan Appendix A |
| P34-NF-08 | 3+4 | NF | Redis DB1 down persist OK | tech-spec §3.5 |
| P34-NF-09 | 3+4 | NF | Redis DB0 down introspect fallback | tech-spec §3.5 |
| P34-NF-10 | 3+4 | NF | realtime SIGTERM drain 30s | tech-spec §9.2 |
| P34-NF-11 | 3+4 | NF | worker SIGTERM 60s job finish | tech-spec §9.2 |
| P34-NF-12 | 3+4 | NF | Compound cursor encoding | tech-spec §6.3; review §14 |
| P34-NF-13 | 3+4 | NF | messages compound index exists | tech-spec §6.1 |
| P34-NF-14 | 3+4 | NF | Contract tests gate merge | review §14 I7 |
| P34-P-01 | 3+4 | P | messages migration field parity | plan §4.2 |
| P34-P-02 | 3+4 | P | getMessages capped 50 default (intentional delta) | decision #6; tech-spec §6.4 |
| P34-P-03 | 3+4 | P | Small channel full page hasMore false | tech-spec §3.5 |
| P34-P-04 | 3+4 | P | Socket event names unchanged | plan constraint; tech-spec §4.6 |
| P34-P-05 | 3+4 | P | msg-recieve payload shape | plan §3.6 |
| P34-P-06 | 3+4 | P | ImageKit URL render parity | plan §3.7 |
| P34-P-07 | 3+4 | P | Legacy envelope preserved | tech-spec §3.1 |
| P34-P-08 | 3+4 | P | Login additive token fields preserved | plan §8.4 |
| P34-N-01 | 3+4 | S | realtime no MongoDB writes | plan §3.6 |
| P34-N-02 | 3+4 | S | No IMAGEKIT_PRIVATE in bundle Phase 4 | plan §13 Q12 |
| P34-N-03 | 3+4 | S | No secrets in frontend bundle | tech-spec §9.3 |
| P34-N-04 | 3+4 | S | add-msg spoof blocked | plan §5.1 |
| P34-N-05 | 3+4 | S | Non-member no room messages | tech-spec §4.6 |
| P34-N-06 | 3+4 | F | Authorize fail closed 503 no write | tech-spec §7.3 |
| P34-N-07 | 3+4 | F | Pub/sub failure no DB rollback | tech-spec §7.4 |
| P34-N-08 | 3+4 | S | Internal routes not public | review §14 I2 |
| P34-N-09 | 3+4 | F | No monolith upstream post-retire | plan Phase 4 |
| P34-N-10 | 3+4 | S | Expired JWT socket rejected | plan §8.6 |
| P34-N-11 | 3+4 | F | Pagination no skip/duplicate E2E | tech-spec §6.3 |
| P34-N-12 | 3+4 | S | DLQ logs no secrets | tech-spec §9.3 |
| P34-R-01 | 3+4 | NF | Rollback E2E send+socket < 90% | Derived |
| P34-R-02 | 3+4 | NF | Rollback socket fail > 10% | Derived |
| P34-R-03 | 3+4 | NF | Rollback P95 send > 1000ms | Derived |
| P34-R-04 | 3+4 | F | Rollback canary msg-recieve miss | review §14 C3 |
| P34-R-05 | 3+4 | NF | Rollback pub/sub errors > 5% | review §14 C4 |
| P34-R-06 | 3+4 | F | Rollback unexpected monolith traffic | plan Phase 4 |
| P34-R-07 | 3+4 | NF | Rollback drill RTO ≤ 15min | review §14 C5 |
| P34-R-08 | 3+4 | S | Rollback client private key detected | plan §13 Q12 |
| P34-R-09 | 3+4 | NF | Rollback queue depth > 5000 | plan §7 |
| P34-R-10 | 3+4 | F | Manual abort authority | review §14 item 7 |
| P5-F-01 | 5 | F | OTel HTTP spans gateway→services | review §14 I1; tech-spec §3.4 |
| P5-F-02 | 5 | F | OTel pub/sub trace linkage | review §14 I1 |
| P5-F-03 | 5 | F | OTel worker spans | review §14 I1 |
| P5-F-04 | 5 | F | CI contract tests all routes | review §14 I7 |
| P5-F-05 | 5 | F | Incident runbooks per phase | tech-spec §15 item 4 |
| P5-NF-01 | 5 | NF | OTel root span 100% ≤ 50ms | review §14 I1 |
| P5-NF-02 | 5 | NF | CI gate ≤ 15min blocks merge | review §14 I7 |
| P5-NF-03 | 5 | NF | Quarterly rollback drill RTO | review §14 C5 |
| P5-NF-04 | 5 | NF | HMAC secret rotation zero downtime | review §14 I2 |
| P5-P-01 | 5 | P | No regression Phase 1–4 P0 | Hardening regression |
| P5-N-01 | 5 | S | OTel no secrets in spans | Security |
| P5-N-02 | 5 | F | No envelope breaking without approval | tech-spec §3.1 |
| P5-R-01 | 5 | NF | Rollback OTel if latency +5% | Operability |
| P5-R-02 | 5 | NF | Do not disable contract tests | review §14 I7 |

---

## Sign-Off Checklist Template

| Phase | QA Lead | Eng Lead | Date | P0 Criteria Pass | Verification Gaps Closed |
|-------|---------|----------|------|------------------|----------------------------|
| 1 | | | | ☐ | ☐ |
| 2 | | | | ☐ | ☐ |
| 3+4 | | | | ☐ | ☐ |
| 5 (Hardening) | | | | ☐ | ☐ |

**Definition of Done (global):** All P0 criteria for the phase pass in staging AND production smoke within 30 minutes of cutover; rollback runbook validated; no open Critical verification gaps without documented waiver.

---

*Document version: 1.0 — QA acceptance criteria aligned to migration plan v1.1 and tech-spec v1.0.*
