# Architecture Migration Review — Chat-Siris v2 Microservices

**Reviewed document:** [`architecture-migration-plan.md`](./architecture-migration-plan.md) (v1.0)  
**Baseline reference:** [`tech-spec.md`](./tech-spec.md)  
**Review date:** 2026-05-28  
**Reviewer role:** Independent architecture review (critical assessment)

---

## Executive Summary

The plan is unusually strong for a planning-only document: bounded contexts are well reasoned, the strangler-fig phasing is logical, and backward-compatible REST/socket contracts are explicitly preserved. It is **not ready to execute as-is**, however, because critical execution mechanics—dual-write/single-source-of-truth during data splits, frontend JWT cutover timing, and Phase 3–4 realtime straddle—are underspecified and can cause auth outages or message delivery gaps. **Proceed with conditions** after resolving the critical issues below. The single biggest concern is **Phase 1’s user-document split combined with a monolith straddle period**: without a documented consistency model and validation gates, login/register can succeed against split databases while the monolith (or gateway passthrough) still reads stale unified `users` data.

---

## Strengths

- **As-is state is grounded in evidence.** Problems are tied to `tech-spec.md` findings (no server auth, in-memory presence, client-side authorization, secrets in frontend env), not generic microservices rhetoric.
- **To-be topology is concrete.** Seven services + gateway with per-service owns/does-not-own, database boundaries, internal vs external routes, and sequence diagrams for send-message and media-upload flows.
- **Correct strangler-fig sequencing.** Auth → user/group → message/media → realtime defers the highest-risk cutover (Socket.IO + Redis adapter) to Phase 4.
- **Backward compatibility is a first-class constraint.** Legacy `/api/auth/*` paths, response envelopes, and socket event names are preserved; breaking changes (ImageKit upload-init, cursor pagination) are flagged with dual-path rollout for media.
- **Data ownership matrix is explicit.** Split of `users` into `chat_auth.identities` + `chat_users.profiles`, logical DB-per-service on one Atlas cluster, and a clear rule against cross-service DB reads in steady state.
- **Per-phase rollback hooks exist.** Env toggles (`AUTH_SERVICE_ENABLED`, `USER_SERVICE_ENABLED`, etc.) and a `monolith-final` branch for Phase 4 DNS rollback show reversibility intent.
- **Observability baseline is defined.** Shared Winston→Loki logger, Sentry per service, health checks with dependency status, and `X-Request-Id` propagation enable cross-service debugging.
- **Caching strategy documents today vs planned.** §6.0 honestly states the monolith has no server-side cache, avoiding false assumptions about existing Redis behavior.
- **Resolved decision log (§13).** Closed questions (JWT scope, NextAuth role, Tradity removal, pagination) reduce ambiguity during implementation.

---

## Critical Issues

### Issue: User split migration lacks a documented consistency model during straddle

- **Risk:** **Critical**
- **Recommendation:** Before Phase 1 cutover, document and implement one of: (a) **freeze writes** to monolith `users` during one-shot migration + validation, or (b) **dual-write** from auth-service to both split DBs and monolith `users` until parity checks pass, or (c) **read-through gateway** that merges split reads for any monolith passthrough routes. Add a migration validation script that compares document counts, `_id` sets, and field-level checksums between source and split targets. Define an **abort condition**: if >0.1% of records fail validation, do not enable gateway routing.

### Issue: Frontend JWT adoption timing is incompatible with Phase 2 gateway enforcement

- **Risk:** **High**
- **Recommendation:** Phase 2 states “JWT required on all except login/register” while Phase 1 says “frontend unchanged initially.” Specify an explicit **Phase 1b** deliverable: frontend stores `accessToken` from login/register/oauth responses and attaches `Authorization: Bearer` on all axios calls *before* Phase 2 gateway enforcement goes live. Add a gateway **shadow mode** (log missing JWT but do not reject) for 1 release to measure client readiness. Abort Phase 2 enforcement if >5% of authenticated API calls lack JWT in shadow logs.

### Issue: Phase 3 realtime straddle is ambiguous (“pub/sub → monolith or parallel realtime”)

- **Risk:** **High**
- **Recommendation:** Decide explicitly: while sockets remain on the monolith, message-service must either (a) **HTTP callback** to monolith to emit `msg-recieve`, or (b) run a **thin bridge subscriber** on the monolith that listens to `message.created` Redis events, or (c) **dual-emit** during transition. Document the chosen path in Phase 3 with a sequence diagram. Without this, messages will persist in `chat_messages` but never reach connected clients until Phase 4—a silent functional regression.

### Issue: Single Upstash Redis instance carries excessive blast radius

- **Risk:** **High**
- **Recommendation:** Upstash Redis backs rate limits, JWT cache, pub/sub fan-out, BullMQ, *and* `@socket.io/redis-adapter`. Redis outage = auth cache miss storm + no realtime fan-out + queue stall + socket scaling break. Define **degraded-mode behavior** per dependency (e.g., gateway falls back to auth-service introspect without cache; realtime fails closed vs open). For production, evaluate **Redis tier sizing**, connection limits, and whether pub/sub + BullMQ should use a separate Redis database/index or instance. Add Redis latency and error-rate alerts before Phase 1.

### Issue: Phase 4 socket cutover is effectively a big-bang DNS flip

- **Risk:** **High**
- **Recommendation:** Decompose Phase 4 into **4a shadow** (realtime-service receives duplicated events but clients still connect to monolith), **4b canary** (percentage of clients or internal users on new socket URL via feature flag), **4c full cutover**. The current rollback (repoint `NEXT_PUBLIC_SERVER_BASE` to monolith) is valid but slow to execute under incident pressure—pre-provision rollback env vars and run a **quarterly rollback drill**. Load test criteria (100 concurrent sockets) is a smoke test, not production confidence; define target concurrency based on actual peak usage from analytics or Render metrics.

---

## Improvement Suggestions

### Issue: No distributed tracing; request ID alone is insufficient for multi-hop failures

- **Risk:** **Medium**
- **Recommendation:** Add OpenTelemetry or Sentry performance tracing with span propagation across gateway → message-service → group-service → Redis publish. LogQL `requestId` queries help but miss async pub/sub and BullMQ paths where the originating HTTP request has already returned.

### Issue: Internal service trust model relies on gateway-injected headers without mTLS

- **Risk:** **Medium**
- **Recommendation:** Document Render private network isolation assumptions explicitly. Internal services must **reject** requests with `X-User-Id` from non-gateway source IPs. Plan mTLS or signed internal service tokens before any service is exposed beyond Render private network. Until then, never expose internal `/internal/*` routes on public URLs.

### Issue: Plaintext channel passwords deferred indefinitely

- **Risk:** **Medium**
- **Recommendation:** Server-side compare is an improvement over client-only check, but plaintext in MongoDB remains a database-leak exposure. Schedule bcrypt migration as **Phase 2.5** with lazy rehash on successful join (compare plaintext OR bcrypt hash). Do not treat “same as today” as acceptable long-term for a security-motivated migration.

### Issue: BullMQ workers co-located on realtime-service couples scaling dimensions

- **Risk:** **Medium**
- **Recommendation:** Scaling socket instances also scales media/notification workers, which can starve the event loop under load. Split workers to a dedicated **worker process/service** (even on same Render service as a second process type) with independent autoscaling metrics (queue depth vs connection count).

### Issue: `inChannel` pointer sync between group-service and user-service is underspecified

- **Risk:** **Medium**
- **Recommendation:** Choose sync vs async explicitly. §7.4 proposes `channel-sync-queue` but consumer is “user-service worker (or realtime-service).” Pick one owner, define idempotency keys (`userId + channelName + action`), and specify conflict resolution if HTTP sync and queue both fire.

### Issue: Cursor pagination may break clients expecting full history

- **Risk:** **Medium**
- **Recommendation:** Default `limit=50` changes behavior for any client that assumed `getMessages` returned all messages. Add a **compat mode**: if client omits `limit` and sends legacy body only, log deprecation warning but return full history (capped at e.g. 500) for one release. Document frontend Phase 3 as **required** before enabling pagination-only responses.

### Issue: Testing strategy lacks parity/shadow comparison tooling

- **Risk:** **Medium**
- **Recommendation:** For each phase, run **shadow traffic** or **contract tests** comparing monolith vs new service responses for the same inputs (status codes, envelope shape, field values). Exit criteria mention “E2E tests pass” but do not define test suite location, CI gate, or who writes/maintains tests.

### Issue: Decommission plan stops at monolith code, not data

- **Risk:** **Low**
- **Recommendation:** After Phase 4, document retirement of the monolith’s unified MongoDB database (archive snapshot, drop schedule, legal retention if applicable). Clarify whether `chat_messages` migration in Phase 3 is copy-once or ongoing sync from monolith DB.

### Issue: No cost, SLO, or alerting thresholds

- **Risk:** **Low**
- **Recommendation:** Render × 8 services + Upstash + Grafana Cloud + Sentry + Atlas will materially increase monthly cost vs single monolith. Estimate cost per phase. Define SLOs (e.g., p99 send-message latency < 500ms, socket reconnect success > 99%) and wire Grafana/Sentry alerts to those thresholds before Phase 1 prod cutover.

---

## Missing Information

The following gaps prevented full assessment. The plan author should answer before implementation kickoff:

1. **Team size and skill mix** — How many engineers? Full-time vs part-time on migration? Who owns gateway, realtime, and data migration scripts?
2. **Production traffic profile** — Peak concurrent users, messages/minute, channel count, and media upload volume (needed to size Redis, Render instances, and load tests).
3. **Environment strategy** — Is staging a full Render mirror of prod, or partial? Can Phase 3 frontend changes be tested against staging before prod dual-path?
4. **Phase 1 data migration procedure** — One-shot script vs incremental? Downtime window acceptable? Who runs it and who signs off?
5. **Existing production deployment** — Is the monolith currently on Render/Vercel as assumed? What is the live MongoDB database name and document counts?
6. **OAuth/google token exchange route** — Is `POST /api/auth/oauth/google` added to gateway in Phase 1 or later? Frontend NextAuth changes are required but not phased.
7. **Abort conditions** — Under what metrics (error rate, auth failure spike, message delivery lag) does each phase halt and roll back automatically vs manually?
8. **Compliance / data residency** — Any GDPR, retention, or PII handling requirements for split databases and log aggregation to Grafana Cloud?
9. **CI/CD and repo structure** — Monorepo vs polyrepo for 7 services? Shared `@chat-siris/logger` package publishing strategy?
10. **Incident runbooks** — Who is on-call post-Phase 4? Are runbooks part of Definition of Done per phase?
11. **Dual-path media Phase 3a** — If `media-service` is live but optional, what prevents accidental exposure of signing endpoints without rate limits in staging?
12. **Message ID cursor pagination** — MongoDB `_id` ordering vs `createdAt` ordering: are ObjectIds time-ordered enough for this app’s message volume, or should cursor use `createdAt + _id` compound?

---

## Phase-by-Phase Notes

### Phase 1 — Extract auth-service (2–3 weeks)

**Assessment:** Lowest-risk entry point is sound, but this phase introduces the most data-model change (user split) relative to its scope.

- Gateway skeleton + JWT issuance + observability baseline is the right first slice.
- **Risk:** “Monolith read-only fallback” conflicts with live users still registering via monolith passthrough for non-auth routes—define whether monolith still **writes** to unified `users` during Phase 1–2.
- **Risk:** Redis introduced here becomes dependency for refresh tokens immediately; no fallback if Redis unavailable at login.
- Exit criteria (“parity tests pass”) need concrete test cases: register new user, login existing, refresh token rotation, Google oauth exchange.

### Phase 2 — Extract user + group services (3–4 weeks)

**Assessment:** Correctly front-loads authorization fixes (server-side password verify, group-service authz) before message extraction.

- JWT enforcement on all routes is the right security milestone but **depends on frontend work not listed in Phase 1 deliverables**.
- Tradity removal is clean scope reduction; confirm no hidden consumers.
- Per-route env rollback flags are good; ensure monolith handlers stay deployable for **>1 release** if Phase 2 slips.
- Cache TTLs (30s–2min) need invalidation tests on channel join/leave/admin toggle.

### Phase 3 — Extract media + message services (2–3 weeks)

**Assessment:** Highest functional regression risk due to realtime still on monolith while persistence moves.

- Cursor pagination + frontend update bundled here increases scope; consider splitting pagination into Phase 3b if frontend bandwidth is limited.
- Dual-path ImageKit rollout is well reasoned (§13 Q12).
- **Outsized risk:** pub/sub to monolith bridge undefined—**must be designed before Phase 3 starts**.
- Message cache (`chat:messages:{channelName}`) must stay consistent with pagination cursors or clients will see duplicates/gaps.

### Phase 4 — Realtime service (3–4 weeks)

**Assessment:** Appropriately last, but the largest blast radius and thinnest rollback story under fire.

- `@socket.io/redis-adapter` on Upstash requires validation of Upstash pub/sub limits and Socket.IO adapter compatibility (not all Redis providers behave identically).
- JWT socket handshake behind `SOCKET_AUTH_REQUIRED=false` flag is good; define flag removal criteria.
- `add-member` / undefined `room` bug fix is a behavior change—verify clients don’t depend on broken behavior.
- Decommission: `monolith-final` branch + 30-day artifact retention is minimal; extend to 90 days or keep hot standby if traffic is non-trivial.
- Load test “100 concurrent sockets across 2 instances” is insufficient for declaring production readiness.

---

## Final Verdict

✅ **Approved for implementation** — critical and improvement issues resolved in [`architecture-migration-plan.md` §14](./architecture-migration-plan.md#14-architecture-review-resolutions) (2026-05-28).

Original conditions (user split consistency, JWT sequencing, Phase 3 realtime bridge) are addressed by: **coordinated big-bang releases per phase**, **JWT day-one**, and **merged Phase 3+4**. Remaining items (cost/SLO, traffic sizing, runbooks) deferred to staging/hardening.

---

## Resolution session log

See migration plan **§14** for full decision table. Key choices:

| Area | Choice |
|------|--------|
| Release model | Coordinated frontend + backend; no post-release monolith |
| JWT | Required from day one of new stack |
| Phases 3+4 | Merged single release |
| Redis | One Upstash instance, DB 0 / DB 1 split |
| Socket cutover | Big-bang + rollback env pre-provisioned |
| Tracing | OpenTelemetry → Grafana |
| Internal auth | Private network + signed internal token |
| Passwords | Bcrypt new channels only |
| Workers | Separate Render worker service |
| inChannel | HTTP + queue fallback |
| Pagination | Strict 50/100; compound `createdAt+_id` cursor |
| Tests | Contract tests in CI |
| Legacy MongoDB | Read-only forever |
| Repos | Polyrepo |
| Abort | Manual on-call |
