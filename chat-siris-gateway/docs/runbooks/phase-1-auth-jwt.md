# Phase 1 Rollback — Auth & JWT (Gateway)

## When to use

Login/register/oauth broken after auth-service or gateway deploy; JWT validation failures across all protected routes.

## Rollback steps

1. Set `AUTH_SERVICE_ENABLED=false` on **api-gateway** (Render env group).
2. Redeploy gateway only (auth-service can stay running).
3. Confirm `MONOLITH_URL` points to live monolith (legacy `Chat-Siris-v2-Server`).

## Verification

- `POST /api/auth/login` with known email returns `{ status, user }` from monolith path.
- Protected route without Bearer → `401` `{ status: false, msg: "Authentication required" }`.
- Frontend still sends Bearer; monolith passthrough accepts JWT from gateway when re-enabled later.

## Restore forward path

1. Set `AUTH_SERVICE_ENABLED=true`.
2. Run gateway integration + contract tests.
3. Smoke login + `accessToken` in response.
