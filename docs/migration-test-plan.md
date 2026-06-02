# Chat-Siris v2 — Migration Test Plan

> **Document type:** Phase-gated test plan for architecture migration QA sign-off  
> **Sources:** [`tech-spec.md`](./tech-spec.md) v1.0, [`migration-acceptance-criteria.md`](./migration-acceptance-criteria.md) v1.0, [`tech-spec-old.md`](./tech-spec-old.md) (monolith baseline)  
> **Generated:** 2026-05-28  
> **Principle:** No production cutover until all P0 tests for the phase pass in staging and rollback is validated.

---

## 1. Test Strategy Overview

### 1.1 Testing Philosophy

This migration uses a **risk-based, phase-gated** strategy:

| Layer | Purpose | When it runs |
|-------|---------|--------------|
| **Unit** | Prove component contracts in isolation | Every PR; required before merge to phase branch |
| **Integration** | Prove boundary contracts (A → B) | Nightly + pre-cutover gate |
| **Migration** | Prove data integrity, idempotency, rollback | Staging dry-run before each cutover |
| **Contract / Parity** | Prove legacy envelope and monolith behavioral equivalence | Pre-cutover + CI gate (Phase 3+4 onward) |
| **E2E** | Prove user-visible flows across frontend + gateway + services | Staging sign-off; production smoke (30 min post-cutover) |
| **Load / Performance** | Prove NFR thresholds and regression budgets | Staging only; baseline captured pre-Phase 1 |
| **Chaos / Failure** | Prove degraded-mode and recovery for high-risk dependencies | Staging; mandatory before Phase 3+4 |
| **Rollback** | Prove env-flag and DNS rollback restores pre-cutover behavior | Staging drill before every phase; quarterly full drill |

**Coverage rule:** Every acceptance criterion in [`migration-acceptance-criteria.md`](./migration-acceptance-criteria.md) maps to ≥1 test ID in this document. Criteria without a mapped test are listed in §10 (Coverage Gaps).

**Not gold-plating:** Tests are written only to satisfy acceptance criteria or explicit verification-gap remediations from that document.

### 1.2 Manual vs Automated by Phase

| Phase | Fully automated (CI) | Manual / staging-only | Definition of "test complete" |
|-------|----------------------|------------------------|-------------------------------|
| **Pre-Phase 1** | Monolith baseline snapshot capture script | Manual Playwright walkthrough of login/register/createChannel/sendMessage | Baseline artifacts stored; monolith response snapshots committed |
| **Phase 1** | Unit + integration (auth, gateway, migration validation); contract tests for auth routes; secret scan | OAuth Google (test Google project); Loki log field audit; Sentry injected exception | All P1-* P0 criteria pass in staging; rollback drill ≤5 min; migration validation ≤0.1% failure; production smoke 30 min |
| **Phase 2** | Unit + integration (user, group, channel-sync); authorize contract tests; cache invalidation tests | getAllChannels sort-order snapshot comparison; inChannel audit script | All P2-* P0 criteria pass; per-service rollback drills; no open Critical verification gaps |
| **Phase 3+4** | Full contract suite; socket integration; pub/sub schema tests; pagination property tests; bundle secret scan | Cross-instance socket fan-out; quarterly rollback drill; 48h monolith traffic audit | All P34-* P0 criteria pass; load test ≥2× peak sockets; monolith zero-traffic 48h |
| **Phase 5** | OTel span assertions; CI contract gate timing; HMAC rotation staging test | Quarterly rollback RTO evidence; trace PII scan | All P5-* criteria pass; Phase 1–4 P0 regression green |

### 1.3 Priority Classification

| Priority | Meaning | Gate behavior |
|----------|---------|---------------|
| **P0** | Blocks phase cutover | Must pass in staging + production smoke |
| **P1** | Blocks merge to phase branch | CI required check |
| **P2** | Run nightly; waivable with documented risk | Does not block cutover |

All acceptance criteria tagged in the source document are treated as **P0** unless explicitly marked as verification-gap remediation (P1 until gap closed).

### 1.4 Environments

| Environment | Purpose |
|-------------|---------|
| **Local (docker-compose)** | Developer unit/integration; Testcontainers for MongoDB + Redis |
| **Staging (Render + Vercel preview)** | Full phase gate; load, chaos, rollback drills |
| **Production** | Smoke only (30 min post-cutover); synthetic canaries; no destructive migration tests |

### 1.5 Current Baseline (from tech-spec-old)

- **No existing automated tests** in monolith or frontend (`npm test` placeholder).
- **No CI pipeline** in workspace today.
- This plan assumes greenfield test infrastructure built incrementally per phase tooling requirements (§9).

---

## 2. Unit Test Contracts

Each section defines **behavior contracts** (what, not how). Minimum coverage target: **≥80% line coverage** on business-logic modules per service (controllers/services); 100% on authz, rate-limit, and cursor encode/decode utilities.

---

### 2.1 API Gateway (`chat-siris-gateway`)

**Framework:** Jest + supertest (HTTP layer mocked upstream with nock).

| Contract | Scenarios | Mock vs real |
|----------|-----------|--------------|
| Route dispatch | login/register → auth; profile → user; channel → group; message → message; Tradity → 410 | Mock all upstream HTTP |
| JWT gate | Public routes exempt; protected routes require Bearer; invalid/expired → 401 legacy envelope | Mock introspect; real JWT decode with test keys |
| Identity header injection | Valid JWT → `X-User-Id`, `X-User-Email`, `X-User-Role`, `X-Auth-Jti` | Real JWT; mock upstream |
| Client header spoof rejection | `X-User-Id` without valid JWT → 401 before forward | No upstream call |
| Request ID | Every proxied request gets UUID v4 `X-Request-Id` | Assert on mock capture |
| Rate limiting | Keys `chat:rl:gw:ip`, login, register limits; 429 legacy mapping | Real Redis (Testcontainers) or ioredis-mock with contract tests |
| Redis unavailable | Fail-open + log contains `rate_limit_degraded` | Mock Redis failure |
| JWT cache | Introspect result cached in `chat:jwt:{jti}`; TTL ≤840s | Real Redis |
| Rollback flags | `AUTH_SERVICE_ENABLED=false` → monolith URL for login/register | Mock monolith |
| Error mapping | Internal `CHAT409xxxx` → external `{ status: false, msg }` | Mock upstream 409 |
| Health | `/health` aggregates Redis + auth-service | Mock dependencies |

**Key test IDs:** `UT-GW-01` … `UT-GW-20` → maps P1-F-08, P1-F-09, P1-F-10, P1-F-14, P1-F-15, P1-N-02, P1-NF-05, P1-NF-10, P2-F-18, P2-F-27, P2-F-28, P2-F-29, P34-N-08.

---

### 2.2 auth-service (`chat-siris-auth-service`)

**Framework:** Jest; MongoDB Memory Server or Testcontainers; Redis Testcontainers.

| Contract | Scenarios | Mock vs real |
|----------|-----------|--------------|
| Login | Found email → merged user + accessToken; not found → exact legacy msg typo | Real Mongo identities; mock user-service GET |
| Register | Creates identity + profile via user-service; duplicate email → 409 | Mock user-service POST; real Mongo |
| Register failure rollback | user-service 503 → 503 envelope; no orphan identity | Mock user-service failure; assert Mongo count |
| ID invariant | `identities._id === profiles._id` | Integration with mock user-service returning same id |
| OAuth Google | Valid idToken → 200; invalid → 401 | Mock `google-auth-library` |
| JWT issuance | RS256; `exp - iat = 900` | Decode without verify |
| Refresh | Rotation; TTL 604800; single-use (second call → 401) | Real Redis |
| Revoke | `/internal/token/revoke` → subsequent refresh 401 | Real Redis |
| Introspect | HMAC required; ±60s timestamp; returns active claims | Real HMAC util |
| Rate limits | login 10/15min; register 5/hr per IP | Real Redis |
| Health | mongo readyState 1 + Redis PING → ok | Mock mongoose connection state |

**Key test IDs:** `UT-AUTH-01` … `UT-AUTH-25` → maps P1-F-01 through P1-F-07, P1-F-11, P1-F-12, P1-F-16, P1-N-03, P1-N-06, P1-N-07, P1-NF-03, P1-NF-04, P1-NF-08, P1-NF-09.

---

### 2.3 user-service (`chat-siris-user-service`)

| Contract | Scenarios | Mock vs real |
|----------|-----------|--------------|
| Profile CRUD | updateName, updateAvatar, deleteBackground, updateUser for own id | Real Mongo profiles |
| Authorization | `:id !== X-User-Id` → 403; no mutation | Real middleware |
| Validation | username length 3–20 → 400; unchanged on fail | Real Mongo |
| Channel pointer | `inChannel` update via internal route | Real Mongo |
| Subscribe | Creates `subscribes` document with `gmail` | Real Mongo |
| Cache | Update invalidates `chat:user:{userId}` within 1s | Real Redis + clock |
| Internal HMAC | Missing/invalid signature → 401 | Real HMAC middleware |
| Health | Mongo + Redis ok | Testcontainers |

**Key test IDs:** `UT-USER-01` … `UT-USER-15` → maps P2-F-01 through P2-F-04, P2-F-17, P2-N-04, P2-N-05, P2-N-08, P2-F-25.

---

### 2.4 group-service (`chat-siris-group-service`)

| Contract | Scenarios | Mock vs real |
|----------|-----------|--------------|
| createChannel | Valid name → persisted; duplicate → 409; length validation → 400 | Real Mongo |
| getAllChannels | Returns only `privacy === false` | Real Mongo seed |
| findChannelRoute | Substring match includes private channels | Real Mongo seed |
| fetchUserRoom | Found → 200; not found → 404 | Real Mongo |
| Join | Correct plaintext password; wrong → 403 exact "Password Wrong" | Real Mongo |
| Bcrypt | New channel password starts with `$2`; verify via bcrypt.compare | Real bcrypt |
| Legacy plaintext | Existing plaintext channel join succeeds | Seed plaintext password |
| channelAdminUpdate | adminId match → 200; else → 403 | Real Mongo |
| authorize | NOT_MEMBER, ADMIN_ONLY, delete admin/non-admin matrix | Real Mongo + cache |
| inChannel sync | HTTP to user-service before response; enqueue on failure | Mock user-service |
| Cache invalidation | On channel.updated / member.changed → correct keys deleted | Real Redis |
| Cross-DB | No reads of chat_auth, chat_messages, monolith DB | Static analysis + unit boundary test |

**Key test IDs:** `UT-GRP-01` … `UT-GRP-30` → maps P2-F-05 through P2-F-24, P2-F-26, P2-N-01, P2-N-02, P2-N-03, P2-N-07, P2-N-09.

---

### 2.5 message-service (`chat-siris-message-service`)

| Contract | Scenarios | Mock vs real |
|----------|-----------|--------------|
| sendMessage | Authorized → persist + pub/sub; denied → 403 no write | Mock group authorize |
| authorize fail closed | group-service 503/timeout → 503 no Mongo write | Mock authorize failure |
| getMessages | Default limit 50; max cap 100; unknown channel → 404 | Real Mongo |
| Pagination cursor | `before` decodes base64url `{createdAt,_id}`; older page strict ordering | Real Mongo seed |
| No duplicates across pages | Property test on seeded data | Real Mongo |
| Cache | Latest page (no `before`) may hit `chat:messages:{channel}`; `before` skips cache | Real Redis |
| pub/sub payload | `message.created` / `message.deleted` schema | Mock Redis publish capture |
| Rate limit | 61st send in 60s → 429 | Real Redis |
| Index | Compound index exists (migration test or schema test) | Mongo integration |

**Key test IDs:** `UT-MSG-01` … `UT-MSG-25` → maps P34-F-01 through P34-F-14, P34-N-06, P34-N-07, P34-NF-12, P34-NF-13.

---

### 2.6 realtime-service (`chat-siris-realtime-service`)

| Contract | Scenarios | Mock vs real |
|----------|-----------|--------------|
| Handshake JWT | Valid token → `socket.userId`; invalid/missing → reject | Real JWT test keys |
| SOCKET_AUTH_REQUIRED=false | Connection without JWT succeeds (drill mode) | Env flag |
| add-user | Matching userId → Redis presence TTL 60s; mismatch → reject | Real Redis |
| Room join/leave | Member → join + channelUpdate; non-member → reject | Mock group-service |
| Pub/sub handlers | message.created → msg-recieve shape; deleted → fetchMessages | Mock Redis subscriber |
| Client events | refetchChannels → fetch; refetchMessages; channelUpdate → channelDetailsUpdate | Socket.io-client |
| add-member fix | Emits userJoined to channelName room (no undefined room) | Socket.io-client |
| add-msg anti-spoof | In cache → relay; not in cache → ignore | Real Redis cache |
| No MongoDB writes | Spy that zero write calls in steady state | Mock mongoose (should not load) |

**Key test IDs:** `UT-RT-01` … `UT-RT-25` → maps P34-F-16 through P34-F-31, P34-F-34, P34-N-01, P34-N-04, P34-N-05, P34-N-10.

---

### 2.7 media-service (`chat-siris-media-service`)

| Contract | Scenarios | Mock vs real |
|----------|-----------|--------------|
| upload-init | Valid folder enum → signature response; invalid folder → 400 | Mock ImageKit SDK |
| Size limits | Video >16MB → 413; other >25MB → 413 | No ImageKit call |
| upload-complete | Known uploadId → 200; unknown → 404 | Real Mongo optional media_assets |
| Rate limit | 21st upload-init/hr → 429 | Real Redis |
| Secrets | Private key only from env (static scan in CI) | — |

**Key test IDs:** `UT-MED-01` … `UT-MED-12` → maps P34-F-35 through P34-F-41, P34-F-44.

---

### 2.8 worker-service (`chat-siris-worker-service`)

| Contract | Scenarios | Mock vs real |
|----------|-----------|--------------|
| notification-queue | Consumes job; logs messageId; no FCM call | BullMQ test queue |
| media-queue | Retries 5×; DLQ on failure; message URL unchanged in Mongo | Mock Mongo |
| channel-sync | Idempotency key duplicate → no-op second run | BullMQ + mock user-service |
| requestId | Every job payload includes requestId | Assert on enqueue |
| Health degraded | Queue depth >1000 for 5min → status degraded | Mock queue metrics |
| SIGTERM | Finish current job ≤60s or requeue | Process test |

**Key test IDs:** `UT-WRK-01` … `UT-WRK-12` → maps P34-F-45 through P34-F-50, P34-N-12, P34-NF-11.

---

### 2.9 Next.js Frontend (`chat-siris-v2`)

| Contract | Scenarios | Mock vs real |
|----------|-----------|--------------|
| Token storage | Login/register/oauth → accessToken in memory/sessionStorage | Jest + MSW mock API |
| Bearer attachment | axios interceptor adds Authorization on subsequent calls | Jest |
| Phase 2 JWT | All `/api/auth/*` except public include Bearer | Jest |
| Pagination | Scroll-up sends `before: nextCursor`; merge without duplicates | Playwright / RTL |
| Delete refetch | Admin delete → refetch latest page only | Playwright |
| Socket URL Phase 4 | Connects to realtime-service with auth.token | Playwright |
| Bundle secrets | No `NEXT_PUBLIC_IMAGEKIT_PRIVATE`, MongoDB URI, JWT keys | CI `grep`/trufflehog |

**Key test IDs:** `UT-FE-01` … `UT-FE-12` → maps P1-F-13, P2-F-29, P34-F-32, P34-F-33, P34-F-42, P34-F-43, P34-N-02, P34-N-03, P1-N-01.

---

### 2.10 @chat-siris/logger (shared package)

| Contract | Scenarios | Mock vs real |
|----------|-----------|--------------|
| Mandatory fields | Every log line includes timestamp, level, service, requestId, message | Unit snapshot |
| Sentry integration | Unhandled exception captured with service tag | Mock Sentry transport |

**Key test IDs:** `UT-LOG-01` … `UT-LOG-04` → maps P1-NF-06, P1-NF-07.

---

## 3. Integration Test Matrix

Boundaries that change during migration. Test IDs format: `IT-{FROM}-{TO}-{nn}`.

| Boundary | Test Type | Scenario | Expected Outcome | Priority | Criterion IDs |
|----------|-----------|----------|------------------|----------|---------------|
| Client → Gateway | E2E | POST login valid email | 200, user, accessToken, refresh cookie | P0 | P1-F-01 |
| Client → Gateway | E2E | POST login unknown email | 200, exact legacy msg typo | P0 | P1-F-02 |
| Client → Gateway | E2E | POST register new user | 200, status true, user, accessToken | P0 | P1-F-03 |
| Client → Gateway | E2E | POST register duplicate email | 409, status false | P0 | P1-F-04 |
| Client → Gateway | E2E | POST oauth/google valid/invalid token | 200 / 401 | P0 | P1-F-05, P1-F-06 |
| Client → Gateway | E2E | POST token/refresh valid cookie | New accessToken; refresh rotated in Redis | P0 | P1-F-07, P1-NF-09 |
| Client → Gateway | E2E | Protected route without JWT | 401 Authentication required | P0 | P1-F-08 |
| Gateway → Monolith | Integration | AUTH_SERVICE_ENABLED=false login/register | Passthrough body unchanged | P0 | P1-F-09 |
| Gateway → auth-service | Integration | Any proxied auth request | X-Request-Id on auth log line | P0 | P1-F-10 |
| auth-service → user-service | Integration | Register success | identities._id === profiles._id | P0 | P1-F-11 |
| auth-service → user-service | Integration | Register; user-service 503 | 503; no orphan identity | P0 | P1-F-12 |
| Gateway → auth-service | Integration | Valid JWT protected route | Identity headers injected | P0 | P1-F-14 |
| Gateway → auth-service | Integration | GET /health deps up | status ok | P0 | P1-F-15, P1-F-16 |
| Gateway → Monolith | Parity | createChannel passthrough Phase 1 | Legacy envelope preserved | P0 | P1-P-06 |
| Client → Monolith Socket | Manual E2E | Phase 1 socket unchanged | Legacy events work | P0 | P1-P-07 |
| Migration script → MongoDB | Migration | users → identities + profiles | Count parity; field parity; _id parity | P0 | P1-P-01, P1-P-02, P1-P-03 |
| auth-service → user-service | Parity | Migrated user login response | user object field match vs monolith snapshot | P0 | P1-P-05 |
| Gateway → user-service | E2E | updateName own id / other id | 200 / 403 | P0 | P2-F-01, P2-F-02 |
| Gateway → user-service | E2E | Profile mutation routes | 200 obj envelope | P0 | P2-F-03, P2-F-04 |
| Gateway → group-service | E2E | createChannel / duplicate | 200 group / 409 | P0 | P2-F-05, P2-F-06 |
| Gateway → group-service | E2E | getAllChannels / findChannelRoute | Public only / substring incl private | P0 | P2-F-07, P2-F-08 |
| Gateway → group-service | E2E | fetchUserRoom found/not found | 200 / 404 | P0 | P2-F-09, P2-F-10 |
| Gateway → group-service | E2E | Join password correct/wrong | 200 / 403 "Password Wrong" | P0 | P2-F-11, P2-F-12 |
| group-service → MongoDB | Unit+IT | New channel password stored | bcrypt $2 prefix | P0 | P2-F-13 |
| Gateway → group-service | E2E | channelAdminUpdate admin/non-admin | 200 / 403 | P0 | P2-F-15, P2-F-16 |
| Gateway → user-service | E2E | subscribe | subscribes document created | P0 | P2-F-17 |
| Gateway → (none) | E2E | Tradity paths | 410 Gone | P0 | P2-F-18 |
| message-service → group-service | Integration | authorize matrix | NOT_MEMBER, ADMIN_ONLY, delete rules | P0 | P2-F-19–22 |
| group-service → user-service | Integration | Join completes HTTP sync first | inChannel set before 200 | P0 | P2-F-23 |
| group-service → worker-service | Integration | user-service down on join | channel-sync-queue eventual consistency | P0 | P2-F-24, P2-NF-10 |
| group-service → Redis | Integration | Channel/member change | Cache keys invalidated | P0 | P2-F-26 |
| Gateway → Monolith | Integration | USER/GROUP_SERVICE_ENABLED=false | Passthrough unchanged | P0 | P2-F-27, P2-F-28 |
| Migration → MongoDB | Migration | groups copy | Field-for-field parity | P0 | P2-P-01 |
| Migration → MongoDB | Migration | subscribes copy | Schema unchanged | P0 | P2-P-02 |
| Gateway → group-service | Parity | getAllChannels ordering | Matches monolith snapshot fixture | P0 | P2-P-03 |
| Client → Monolith | Parity | Message routes Phase 2 | Unchanged vs baseline | P0 | P2-P-05 |
| Client → Monolith Socket | Manual | Channel join events | channelUpdate, userJoined unchanged | P0 | P2-P-06 |
| Gateway → message-service | E2E | sendMessage member/non-member | 200 persist / 403 no write | P0 | P34-F-01, P34-F-02 |
| Gateway → message-service | E2E | getMessages pagination | pagination object; before cursor pages | P0 | P34-F-03, P34-F-04 |
| Gateway → message-service | E2E | getMessages limits | default 50; cap 100 | P0 | P34-F-05, P34-F-06 |
| Gateway → message-service | E2E | getMessages unknown channel | 404 | P0 | P34-F-07 |
| Gateway → message-service | E2E | deleteMessage admin/non-admin | 200 delete / 403 unchanged | P0 | P34-F-08, P34-F-09 |
| message-service → Redis DB1 | Integration | create/delete message | pub/sub schema correct | P0 | P34-F-10, P34-F-11 |
| message-service → Redis DB0 | Integration | Latest page cache hit/miss | Same content as Mongo | P0 | P34-F-12, P34-F-13 |
| Client → realtime-service | Socket E2E | Full connect-join-send-receive | msg-recieve within 2s | P0 | P34-F-15, P34-F-23 |
| realtime-service ↔ Redis DB1 | Integration | Two instances | Cross-instance msg-recieve | P0 | P34-F-31 |
| Client → Gateway → ImageKit | E2E | upload-init → upload → complete → sendMessage | CDN URL in message | P0 | P34-F-35–37, P34-F-42 |
| message-service → worker-service | Integration | sendMessage | notification-queue log stub | P0 | P34-F-45 |
| media-service → worker-service | Integration | media-queue failure | DLQ; message URL unchanged | P0 | P34-F-46, P34-F-47 |
| Gateway → Monolith | Integration | MESSAGE_SERVICE_ENABLED=false | Message routes passthrough | P0 | P34-F-54 |
| All → Observability | Integration | HTTP sendMessage path | OTel spans gateway→msg→grp | P0 | P5-F-01 |
| Redis pub/sub → realtime | Integration | message.created | Span linked via requestId | P0 | P5-F-02 |
| worker → OTel | Integration | Job complete | queueName, jobId, requestId tags | P0 | P5-F-03 |
| **Gateway → auth-service** | Integration | Introspect timeout (5s) | 503 or 401; no hang | P1 | P2-NF-09 |
| **Gateway → user-service** | Integration | Upstream timeout (10s) | 503 legacy envelope | P1 | P2-NF-08 |
| **group-service → user-service** | Integration | CRUD timeout (10s) | Circuit opens; graceful error | P1 | P2-NF-08 |
| **message-service → group-service** | Integration | Authorize timeout (5s) | 503; no message write | P0 | P34-N-06, P2-NF-09 |
| **Any internal route** | Security | No HMAC from public | 401 before logic | P0 | P1-N-03, P2-N-04, P34-N-08 |
| **Gateway** | Security | X-User-Id spoof without JWT | 401 | P0 | P1-N-02 |
| **Client → Gateway** | Degraded | Malformed JSON body | 400 legacy or structured | P1 | — |
| **Gateway → upstream** | Degraded | Upstream 503 | Mapped 503 msg | P1 | P1-F-12 |
| **Redis DB0** | Degraded | Unavailable during JWT check | Direct introspect; log jwt_cache_degraded | P0 | P34-NF-09 |
| **Redis DB1** | Degraded | Unavailable during send | Persist OK; 200; log pub/sub error | P0 | P34-NF-08 |
| **MongoDB** | Degraded | auth mongo down | /health 503; login 503 | P1 | P1-F-16 |

---

## 4. Migration-Specific Tests

### 4.1 Data Integrity Checks

| Test ID | Phase | Description | Pass criteria | Criterion IDs |
|---------|-------|-------------|---------------|---------------|
| MIG-P1-01 | 1 | Pre/post count: `users` → `identities` + `profiles` | Counts equal | P1-P-01 |
| MIG-P1-02 | 1 | _id parity all records | 100% match legacy _id | P1-P-02 |
| MIG-P1-03 | 1 | Field parity spot-check + full scan | email, username, avatar*, background, admin, inChannel | P1-P-03 |
| MIG-P1-04 | 1 | Failure rate gate | ≤0.1% or abort cutover | P1-P-04, P1-R-03 |
| MIG-P2-01 | 2 | groups collection copy | Count + field-for-field | P2-P-01 |
| MIG-P2-02 | 2 | subscribes copy | Schema unchanged | P2-P-02 |
| MIG-P2-03 | 2 | Tradity collections NOT copied | tradityusers, images absent in new DBs | P2-N-06 |
| MIG-P34-01 | 3+4 | messages collection copy | Count + field parity | P34-P-01 |
| MIG-P34-02 | 3+4 | Compound index on messages | Index exists pre-cutover | P34-NF-13 |
| MIG-ALL-01 | All | Checksum sample | SHA256 of JSON export 1% sample match | P1-P-03 (extended) |

### 4.2 Dual-Write Consistency

**Note:** Spec mandates **no dual-write to monolith DB post-release** (P1-N-04). Dual-write tests apply only to **staging rehearsal** and **inChannel sync** (HTTP primary + queue fallback):

| Test ID | Description | Pass criteria | Criterion IDs |
|---------|-------------|---------------|---------------|
| DW-P2-01 | Join: groups.users vs profiles.inChannel | Match within 1s on happy path | P2-F-23 |
| DW-P2-02 | Join: user-service down → queue fallback | inChannel eventually consistent ≤ retry budget | P2-F-24, P2-R-03 |
| DW-P1-01 | Post-cutover monolith users write attempt | Rejected or read-only | P1-N-04 |
| DW-P34-01 | Post-cutover monolith unified DB writes | Zero application writes | P34-F-53 |

### 4.3 Idempotency Tests

| Test ID | Script/Component | Action | Pass criteria | Criterion IDs |
|---------|------------------|--------|---------------|---------------|
| IDEM-P1-01 | users split migration | Run script twice | Second run no duplicates; counts stable | P1-P-01 |
| IDEM-P2-01 | groups copy migration | Run twice | No duplicate channels | P2-P-01 |
| IDEM-P34-01 | messages copy migration | Run twice | No duplicate messages | P34-P-01 |
| IDEM-P2-02 | channel-sync-queue worker | Duplicate job same idempotency key | Second processing no-op | P34-F-48, P2-F-24 |

### 4.4 Rollback Smoke Tests

Executed in staging **before** each production cutover (see §7). Each verifies system returns to **pre-phase behavior** for routes not yet extracted or full monolith path when flags disabled.

| Test ID | Phase | Trigger | Verify | Criterion IDs |
|---------|-------|---------|--------|---------------|
| RB-SMOKE-P1 | 1 | AUTH_SERVICE_ENABLED=false | login/register via monolith; same response snapshots | P1-F-09, P1-R-05 |
| RB-SMOKE-P2 | 2 | USER+GROUP flags false | profile + channel routes monolith | P2-F-27, P2-F-28, P2-R-05 |
| RB-SMOKE-P34 | 3+4 | All flags false + socket URL monolith | REST messages + socket events | P34-F-54, P34-R-07 |
| RB-SMOKE-P5 | 5 | Disable OTel exporter | Latency returns to pre-OTel baseline | P5-R-01 |

---

## 5. Load & Performance Test Plan

### 5.1 Baseline Benchmark (Pre-Phase 1)

Capture against **monolith staging** before any migration work:

| Metric | Tool | Scenario | Store as |
|--------|------|----------|----------|
| Login P95 | k6 | 10 VUs, 5 min, POST /api/auth/login | `baseline-monolith-login-p95.json` |
| getAllChannels P95 | k6 | 50 VUs JWT (manual token), 5 min | `baseline-monolith-channels-p95.json` |
| sendMessage P95 | k6 | 50 VUs, 5 min | `baseline-monolith-send-p95.json` |
| Concurrent sockets | k6 socket / Artillery | 50 connections, 10 min | `baseline-monolith-sockets.json` |

**Remediation for gap:** Peak production RPS unknown — instrument staging gateway 7 days pre-Phase 1; set load targets at **2× measured peak** (per acceptance criteria verification gaps).

### 5.2 Per-Phase Benchmarks & Regression Thresholds

| Phase | Endpoint / scenario | Target P95 | Regression fail threshold | Criterion IDs |
|-------|---------------------|------------|---------------------------|---------------|
| 1 | POST login (gateway→auth→user) | ≤500 ms | >750 ms (+50% over target) | P1-NF-02 |
| 1 | JWT cache hit rate | ≥80% | <70% | P1-NF-01 |
| 2 | GET getAllChannels (warm cache) | ≤200 ms | >300 ms | P2-NF-01 |
| 2 | POST addUserToChannel | ≤500 ms | >750 ms | P2-NF-02 |
| 2 | chat:channels:public hit rate | ≥70% | <60% | P2-NF-03 |
| 2 | chat:authz hit rate | ≥60% | <50% | P2-NF-04 |
| 3+4 | sendMessage E2E (REST→pub/sub→socket) | ≤300 ms | >1000 ms for 15 min triggers rollback | P34-NF-01, P34-R-03 |
| 3+4 | pub/sub → msg-recieve | ≤500 ms | >750 ms | P34-NF-02 |
| 3+4 | 100 concurrent sockets, 2 RT instances | ≥99% success | <95% | P34-NF-03 |
| 3+4 | Pagination under concurrent inserts | No skip/duplicate ids | Any duplicate in merged list | P34-N-11 |

### 5.3 Load Test Scenarios (k6)

```
Scenario LT-P1-LOGIN: 10 VUs × 15 min → POST /api/auth/login
Scenario LT-P1-JWT:    1 login → 100 sequential protected GETs (cache hit measurement)
Scenario LT-P1-RL:     11 logins same IP in 15 min (expect 429 on 11th)
Scenario LT-P2-CH:     50 VUs × 10 min → GET getAllChannels (30s think time)
Scenario LT-P2-JOIN:   20 VUs × 5 min → POST addUserToChannel
Scenario LT-P34-SEND:  50 VUs × 10 min → POST sendMessage + socket listener
Scenario LT-P34-SOCK:  100 connections × 2 RT instances × 15 min
Scenario LT-P34-PAGE:  10 VUs paginate while 5 VUs send messages
```

Rate-limit scenarios double as functional tests: P1-NF-03, P1-NF-04, P1-NF-05, P34-F-14, P34-F-41, P34-NF-06, P34-NF-07.

### 5.4 Production Smoke (Not Load)

Post-cutover only: synthetic login probe every 60s; canary sendMessage + socket receive every 2 min (P34-R-04).

---

## 6. Chaos & Failure Test Plan

High-risk phases: **1** (auth cutover), **3+4** (socket big-bang, pub/sub).

### 6.1 Phase 1 — Auth Cutover

| Test ID | Injection | Expected behavior | Recovery verification | Criterion IDs |
|---------|-----------|-------------------|----------------------|---------------|
| CHAOS-P1-01 | Redis DB0 down | Rate limit fail-open + `rate_limit_degraded` log; refresh 503 | Restore Redis; refresh works | P1-NF-10 |
| CHAOS-P1-02 | auth-service process kill mid-login | Gateway 503/502; no partial cookies | Restart; login succeeds | P1-R-02 |
| CHAOS-P1-03 | user-service 503 on register | 503 envelope; no orphan identity | user-service up; register succeeds | P1-F-12 |
| CHAOS-P1-04 | MongoDB auth primary step-down | /health degraded; login 503 | Failover complete; health ok | P1-F-16 |
| CHAOS-P1-05 | Network partition gateway↔auth | Timeout; no hang >30s | Partition healed | P2-NF-08 (gateway upstream) |

### 6.2 Phase 2 — Channel Join / Sync

| Test ID | Injection | Expected behavior | Recovery verification | Criterion IDs |
|---------|-----------|-------------------|----------------------|---------------|
| CHAOS-P2-01 | user-service delayed 15s on join | HTTP timeout; job enqueued | Queue worker sets inChannel | P2-F-24, P2-NF-10 |
| CHAOS-P2-02 | user-service down 2 attempts then up | Retry within 5 attempts | inChannel correct | P2-NF-10 |
| CHAOS-P2-03 | Redis DB0 flush mid-getAllChannels | Cache miss → MongoDB; slower but 200 | Cache repopulates | P2-NF-03 |

### 6.3 Phase 3+4 — Message + Realtime Big-Bang

| Test ID | Injection | Expected behavior | Recovery verification | Criterion IDs |
|---------|-----------|-------------------|----------------------|---------------|
| CHAOS-P34-01 | Redis DB1 down during send | Message persisted; HTTP 200; pub/sub error logged | Reconnect socket; getMessages reconciles | P34-NF-08, P34-N-07 |
| CHAOS-P34-02 | Redis DB0 down during JWT | Direct introspect; `jwt_cache_degraded` | Cache repopulates | P34-NF-09 |
| CHAOS-P34-03 | Kill one realtime-service instance | Surviving instance receives pub/sub; presence TTL 60s | Reconnect; presence restored | P34-NF-04, P34-F-31 |
| CHAOS-P34-04 | group-service authorize timeout | sendMessage 503; zero Mongo writes | group-service restored | P34-N-06 |
| CHAOS-P34-05 | SIGTERM realtime-service | Drain ≤30s; no accept new connections | New instance accepts | P34-NF-10 |
| CHAOS-P34-06 | SIGTERM worker mid-job | Finish or requeue ≤60s | Job completes or retries | P34-NF-11 |
| CHAOS-P34-07 | Disk full on worker (simulated) | Job to DLQ; Sentry capture | DLQ inspect no secrets | P34-F-46, P34-N-12 |
| CHAOS-P34-08 | Socket disconnect during broadcast | Client reconciles via getMessages on reconnect | Message visible after reconnect | P34-N-07 (gap remediation) |

### 6.4 Phase 5 — OTel

| Test ID | Injection | Expected behavior | Recovery verification | Criterion IDs |
|---------|-----------|-------------------|----------------------|---------------|
| CHAOS-P5-01 | OTel exporter unreachable | Core path still 200; buffer/drop spans | Exporter restored; spans appear | P5-F-01 |
| CHAOS-P5-02 | OTel overhead | P95 gateway latency | Rollback if +5% for 15 min | P5-R-01 |

---

## 7. Rollback Test Plan

Each phase: execute in **staging** ≥48h before production cutover. Record evidence (timestamp log, screenshots, log queries).

### 7.1 Phase 1 Rollback

| Step | Action | Success criteria | Test ID | Criterion IDs |
|------|--------|------------------|---------|---------------|
| 1 | Capture 15-min login success baseline | Metric stored | RB-P1-MON-01 | P1-R-01 |
| 2 | Set `AUTH_SERVICE_ENABLED=false` | Env propagated ≤5 min | RB-P1-EXEC-01 | P1-R-05 |
| 3 | Run login/register suite | 100% hit monolith logs | RB-SMOKE-P1 | P1-F-09 |
| 4 | Verify auth-service traffic | Zero login/register to auth-service | RB-P1-EXEC-02 | P1-R-05 |
| 5 | Restore flag true | Microservices path restored | RB-P1-EXEC-03 | — |
| **Automated rollback triggers (monitoring)** | Login success <95% baseline 5 min; auth 5xx >5%; Sentry ≥10 JWT exceptions/5min | Alert fires; runbook linked | RB-P1-MON-02 | P1-R-01, P1-R-02, P1-R-06 |

### 7.2 Phase 2 Rollback

| Step | Action | Success criteria | Test ID | Criterion IDs |
|------|--------|------------------|---------|---------------|
| 1 | Set `USER_SERVICE_ENABLED=false`, `GROUP_SERVICE_ENABLED=false` | Routes to monolith ≤5 min | RB-P2-EXEC-01 | P2-R-05 |
| 2 | Profile + channel E2E suite | Pass vs monolith snapshots | RB-SMOKE-P2 | P2-F-27, P2-F-28 |
| 3 | Security probe: non-admin channelAdminUpdate | Must not return 200 | RB-P2-SEC-01 | P2-R-06 |
| 4 | inChannel audit script | Mismatch rate ≤1% pre-rollback | RB-P2-AUDIT-01 | P2-R-03 |
| **Monitoring triggers** | Channel E2E <90% 10 min; profile errors >5% | Alert | RB-P2-MON-01 | P2-R-01, P2-R-02 |

### 7.3 Phase 3+4 Rollback

| Step | Action | Success criteria | Test ID | Criterion IDs |
|------|--------|------------------|---------|---------------|
| 1 | Set all `*_SERVICE_ENABLED=false` | Gateway passthrough | RB-P34-EXEC-01 | P34-F-54 |
| 2 | Repoint `NEXT_PUBLIC_SERVER_BASE` to monolith | REST + socket functional ≤15 min | RB-P34-EXEC-02 | P34-R-07 |
| 3 | Optional `SOCKET_AUTH_REQUIRED=false` | Drill connections succeed | RB-P34-DRILL-01 | P34-F-34 |
| 4 | Full E2E: send + socket receive | msg-recieve within 2s | RB-SMOKE-P34 | P34-R-04 |
| 5 | Restore microservices path | Canary green | RB-P34-EXEC-03 | — |
| **Monitoring triggers** | E2E send+socket <90%; socket fail >10%; P95 send >1000ms; pub/sub errors >5%; queue depth >5000 | Alert + manual abort authority | RB-P34-MON-01 | P34-R-01–05, P34-R-09, P34-R-10 |
| **Quarterly drill** | Full rollback RTO ≤15 min | Evidence in incident doc | RB-P34-QTR-01 | P34-R-07, P5-NF-03 |

### 7.4 Phase 5 Rollback

| Step | Action | Success criteria | Test ID | Criterion IDs |
|------|--------|------------------|---------|---------------|
| 1 | Disable OTel exporter/instrumentation | P95 gateway within +5% baseline | RB-P5-EXEC-01 | P5-R-01 |
| 2 | Contract tests remain required | Cannot disable check without replacement | RB-P5-CI-01 | P5-R-02 |

---

## 8. Test Execution Order

Sequenced per migration phase. **Blockers** must pass before proceeding.

### 8.0 Pre-Phase 1 (Week 0)

1. `BASELINE-01` — Capture monolith response snapshots (login, register, createChannel, sendMessage)
2. `BASELINE-02` — k6 monolith performance baseline (§5.1)
3. `TOOL-01` — Stand up Testcontainers + Jest in auth-service repo
4. `TOOL-02` — Create shared `@chat-siris/contract-tests` package skeleton

### 8.1 Phase 1 Gate

| Order | Suite | Blocker? |
|-------|-------|----------|
| 1 | Unit: auth-service, gateway | Yes |
| 2 | Migration dry-run: MIG-P1-01–04 on staging clone | Yes — abort if >0.1% |
| 3 | Integration: IT rows for Phase 1 auth boundaries | Yes |
| 4 | Contract: login/register/oauth/refresh snapshots | Yes |
| 5 | Security: P1-N-01 secret scan; P1-N-02 spoof test | Yes |
| 6 | Load: LT-P1-LOGIN, LT-P1-JWT, LT-P1-RL | Yes |
| 7 | Observability: P1-NF-06 LogQL; P1-NF-07 Sentry inject | Yes |
| 8 | Manual: P1-P-07 socket on monolith; P1-F-13 frontend Bearer | Yes |
| 9 | Rollback: RB-SMOKE-P1 + RB-P1-EXEC-* | Yes |
| 10 | Production smoke: P1-F-01, P1-F-07, P1-F-15 (30 min) | Yes |

### 8.2 Phase 2 Gate

| Order | Suite | Blocker? |
|-------|-------|----------|
| 1 | Unit: user-service, group-service, worker channel-sync | Yes |
| 2 | Migration: MIG-P2-01–03 | Yes |
| 3 | Integration: Phase 2 IT matrix rows | Yes |
| 4 | Parity: P2-P-03 snapshot fixture for getAllChannels order | Yes |
| 5 | Cache metrics instrumentation (verification gap) | Yes |
| 6 | Load: LT-P2-CH, LT-P2-JOIN | Yes |
| 7 | Chaos: CHAOS-P2-01–02 | Yes |
| 8 | inChannel audit script: DW-P2-01, RB-P2-AUDIT-01 | Yes |
| 9 | Rollback: RB-SMOKE-P2 | Yes |
| 10 | Production smoke + P2-P-05 monolith message parity check | Yes |

### 8.3 Phase 3+4 Gate (Merged)

| Order | Suite | Blocker? |
|-------|-------|----------|
| 1 | Unit: message, realtime, media, worker | Yes |
| 2 | Migration: MIG-P34-01–02 | Yes |
| 3 | Integration: full IT matrix Phase 3+4 | Yes |
| 4 | Contract CI suite: all `/api/auth/*` snapshots (P34-NF-14) | Yes — merge gate |
| 5 | Socket E2E: P34-F-15–31 including cross-instance | Yes |
| 6 | Frontend E2E: pagination, delete refetch, upload-init (tag `@dual-path` / `@upload-init-only`) | Yes |
| 7 | Load: LT-P34-SEND, LT-P34-SOCK, LT-P34-PAGE | Yes |
| 8 | Chaos: CHAOS-P34-01–08 | Yes |
| 9 | Bundle scan: P34-N-02, P34-N-03 | Yes |
| 10 | Rollback full drill: RB-P34-* (RTO ≤15 min) | Yes |
| 11 | Cutover: deploy message+realtime+media+worker+frontend together | — |
| 12 | Post-cutover: 48h monolith traffic zero (P34-F-51); canary P34-R-04 | Yes |

### 8.4 Phase 5 Gate

| Order | Suite | Blocker? |
|-------|-------|----------|
| 1 | OTel span tests P5-F-01–03 | Yes |
| 2 | PII scan on traces P5-N-01 | Yes |
| 3 | Full Phase 1–4 P0 regression P5-P-01 | Yes |
| 4 | CI timing P5-NF-02 (≤15 min) | Yes |
| 5 | HMAC rotation staging P5-NF-04 | Yes |
| 6 | Incident runbooks exist P5-F-05 | Yes |
| 7 | Quarterly rollback calendar scheduled P5-NF-03 | Yes |

---

## 9. Tooling Requirements

Infrastructure **not currently present** (per tech-spec-old §10.2) that must be built:

| Tool | Purpose | Phase needed | Owner |
|------|---------|--------------|-------|
| **Jest + supertest** | Unit/integration HTTP tests per polyrepo | 1 | Each service repo |
| **Testcontainers** (MongoDB, Redis) | Real dependency integration locally/CI | 1 | Platform |
| **nock / MSW** | Upstream HTTP mocking | 1 | Each service |
| **@chat-siris/contract-tests** | Shared legacy envelope snapshots | 1 (auth); full gate 3+4 | Gateway repo |
| **GitHub Actions** workflows | PR checks, nightly integration, phase gates | 1 | Platform |
| **k6** (Grafana Cloud k6 or self-hosted) | Load + rate limit tests | 1 | QA |
| **Playwright** | Frontend E2E; Bearer attachment; pagination | 1 manual; 3+4 automated | QA |
| **socket.io-client test harness** | Realtime integration tests | 3+4 | realtime-service repo |
| **Artillery** (optional alt) | Socket load if k6 socket insufficient | 3+4 | QA |
| **migration-validation CLI** | MIG-P1/P2/P34 scripts with JSON report | 1 | auth/group/message repos |
| **inChannel audit script** | Sample join ops; groups.users vs profiles.inChannel | 2 | group-service |
| **trufflehog / gitleaks** | Secret scan CI (P1-N-01, P34-N-02) | 1 | CI |
| **Loki LogQL dashboards** | P1-NF-06; rate_limit_degraded alerts | 1 | Ops |
| **Sentry staging project** | P1-NF-07 injected exception test | 1 | Ops |
| **Prometheus counters** | cache_hit/cache_miss (P2 verification gap) | 2 | group-service |
| **Grafana Tempo / OTel collector** | P5 trace assertions | 5 | Ops |
| **Synthetic canary** (Checkly / Grafana synthetics) | Production smoke login + send+socket | 3+4 | Ops |
| **Monolith access log alert** | P34-F-51 zero traffic 48h | 3+4 | Ops |
| **Staging debug header** | `X-Client-JWT-Attached: true` (P1 verification gap) | 1 | Frontend staging only |

### 9.1 Proposed CI Pipeline (Greenfield)

```yaml
# Per-service repo PR
jobs:
  unit:       jest --coverage --ci
  lint:       eslint
  secret-scan: trufflehog filesystem .

# Gateway repo PR + nightly
  contract:   jest contract-tests/ --passWithNoTests=false
  integration: jest integration/ (Testcontainers)

# Phase branch merge gate (3+4)
  contract-full: all /api/auth/* snapshots
  e2e-staging:   playwright against STAGING_URL (manual dispatch + nightly)

# Pre-cutover workflow (manual)
  migration-dry-run → load-test → rollback-drill → QA sign-off artifact upload
```

---

## 10. Coverage Gaps & Traceability

### 10.1 Acceptance Criteria → Test Mapping Summary

All **882** criterion IDs in the Master Traceability Matrix ([`migration-acceptance-criteria.md`](./migration-acceptance-criteria.md) §Master Traceability Matrix) map to tests in §2–§7 via:

- **Unit tests:** `UT-{COMPONENT}-{nn}`
- **Integration tests:** `IT-*` table (§3)
- **Migration tests:** `MIG-*`, `IDEM-*`, `DW-*` (§4)
- **Load tests:** `LT-*` (§5)
- **Chaos tests:** `CHAOS-*` (§6)
- **Rollback tests:** `RB-*` (§7)

### 10.2 Criteria Requiring Manual or Staging-Only Coverage

| Criterion ID | Reason | Test ID | Remediation |
|--------------|--------|---------|-------------|
| P1-F-13 | Frontend Bearer not server-verifiable | `MAN-P1-FE-01` Playwright + optional `X-Client-JWT-Attached` | Staging debug header |
| P1-P-07 | Socket on monolith Phase 1 | `MAN-P1-SOCK-01` | Manual checklist |
| P1-NF-06 | LogQL 100% field compliance | `OBS-P1-LOG-01` | 30-min post-deploy LogQL |
| P1-NF-07 | Sentry ≤60s | `OBS-P1-SEN-01` | Injected exception staging |
| P1-R-01, P1-R-02 | Rollback **triggers** (monitoring) | `RB-P1-MON-*` | Grafana alerts — not functional tests |
| P2-P-03 | getAllChannels sort order | `PAR-P2-CH-01` | Monolith snapshot fixture |
| P2-NF-03, P2-NF-04 | Cache hit rates | `LT-P2-CACHE-01` | Prometheus counters first |
| P34-F-51 | 48h zero monolith traffic | `MON-P34-MONO-01` | Monolith log alert |
| P34-R-07, P5-NF-03 | Quarterly rollback RTO | `RB-P34-QTR-01` | Calendar runbook — not CI |
| P34-R-10 | Manual abort authority | `PROC-P34-01` | Runbook review — procedural |
| P5-NF-01 | OTel root span 100% ≤50ms | `OBS-P5-OTEL-01` | 24h collector sampling |

### 10.3 Flagged Coverage Gaps (No Test Yet — Requires Remediation Before Cutover)

| Gap | Affected criteria | Action before gate |
|-----|-------------------|-------------------|
| No pre-migration E2E baseline | P1-P-05, P2-P-03, P2-P-04 | Execute `BASELINE-01` (§8.0) |
| Peak login RPS unknown | P1-NF-02 load target | 7-day staging instrumentation |
| Grafana log threshold undefined | P1-NF-06 | Define LogQL pass: ≥1 line/service/min × 30 min |
| Frontend Bearer verification | P1-F-13 | Staging `X-Client-JWT-Attached` header |
| Cache hit instrumentation missing | P2-NF-03, P2-NF-04 | Ship Prometheus counters in group-service |
| getAllChannels sort not specified | P2-P-03 | Capture monolith snapshot |
| Peak concurrent sockets unknown | P34-NF-03 | Analytics before load test; target 2× peak |
| pub/sub→emit latency correlation | P34-NF-02 | `emittedAt` + `receivedAt` logs |
| Worker degraded threshold in runbook | P34-F-50 | Publish numeric threshold pre-sign-off |
| OTel backend not selected | P5-F-01, P5-NF-01 | Select Tempo/vendor; span export ≥99% |
| Cost/SLO doc deferred | (Phase 5 optional) | Waive with sign-off note if not delivered |

### 10.4 Rollback Criteria as Monitoring (Not Executable Tests)

These criteria define **operational alerts**, validated by configuring dashboards and firing alert drill — not by a single automated test case:

P1-R-01, P1-R-02, P1-R-06, P2-R-01, P2-R-02, P2-R-04, P34-R-01, P34-R-02, P34-R-03, P34-R-05, P34-R-06, P34-R-08, P34-R-09, P5-R-01.

**Validation approach:** `RB-*-MON-*` alert simulation in staging (inject metric/threshold breach → verify PagerDuty/runbook link).

### 10.5 Out-of-Scope Criteria (Intentionally Untested)

Per acceptance criteria Out-of-Scope sections: Tradity restoration, FCM/APNs, read receipts, mTLS, GDPR erasure, message search, API versioning, offset pagination, bulk bcrypt migration, auto-halt pipeline, formal cost/SLO (unless Phase 5 waived).

---

## 11. Sign-Off Artifacts

Each phase QA sign-off must attach:

1. CI run URL — all P0 tests green  
2. Staging load test report — thresholds met  
3. Rollback drill timestamp log — RTO evidence  
4. Migration validation JSON — failure rate ≤0.1%  
5. Open gaps table (§10.3) — all Critical closed or waived  
6. Production smoke checklist — 30 min post-cutover  

---

## 12. Document Control

| Version | Date | Author | Change |
|---------|------|--------|--------|
| 1.0 | 2026-05-28 | QA / Test Architecture | Initial plan from tech-spec v1.0 + acceptance criteria v1.0 |

---

*Every P0 acceptance criterion in [`migration-acceptance-criteria.md`](./migration-acceptance-criteria.md) traces to at least one test ID in this plan. Gaps without automated coverage are explicitly listed in §10.3 with remediation owners.*
