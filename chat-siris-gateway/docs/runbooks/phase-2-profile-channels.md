# Phase 2 Rollback — Profile & Channels

## When to use

Channel join, profile update, or `getAllChannels` failures after user/group-service deploy.

## Rollback steps

1. `USER_SERVICE_ENABLED=false` — profile routes passthrough to monolith.
2. `GROUP_SERVICE_ENABLED=false` — channel routes passthrough to monolith.
3. Redeploy gateway.

## Verification

- `POST /api/auth/updateName/:id` succeeds with valid JWT.
- `POST /api/auth/addUserToChannel/:id` returns legacy `{ status, obj }`.
- Wrong password still returns exact `Password Wrong` string.
- Tradity routes return **410** regardless of flags.

## Restore

Enable flags `true`, redeploy gateway, run Phase 2 contract tests (`tests/phase2.contract.test.ts`).
